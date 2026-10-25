"use client";

import { useDeferredValue, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { useConfig, useReadContract, useReadContracts } from "wagmi";
import { getAddress, isAddress, type Address } from "viem";
import { AppLink } from "@/components/app-link";
import { useApp } from "@/components/providers";
import { Tip } from "@/components/tip";
import { TxStatus } from "@/components/tx-status";
import { useLocalStore } from "@/hooks/use-local-store";
import { useChainNow, useMarketData } from "@/hooks/use-market-data";
import { useAccountStrategies, useMarketAllowed, useStrategyCandles } from "@/hooks/use-strategies";
import { useTx } from "@/hooks/use-tx";
import { useWallet } from "@/hooks/use-wallet";
import { perpEngineAbi, testUSDCAbi } from "@/lib/abi";
import { runBacktest, type BtConfig, type BtFees } from "@/lib/backtest";
import { USDC_DECIMALS, fmtPercent, fmtUsdc, parseAmount, priceToNum, shortAddress, toInputString, usdcToNum } from "@/lib/format";
import { groupInstruments } from "@/lib/instruments";
import { prefs } from "@/lib/prefs";
import {
  INTERVAL_PRESETS,
  KEEP_FOR_PRESETS,
  TEMPLATES,
  bpsText,
  defaultsFor,
  entrySize,
  everyText,
  liquidationMove,
  planPolicy,
  templateOf,
  validateDraft,
  warmupReadings,
  type DraftField,
  type StrategyDraft,
  type StrategyKind,
} from "@/lib/strategies";
import { launchStrategy, launchSteps, strategyName, type LaunchPlan } from "@/lib/strategy-actions";
import { BacktestPanel } from "./backtest-panel";
import { CopyPreview } from "./copy-preview";

/** Opens the studio on the copy template, following `leader` (from the directory or a link). */
export type StudioPrefill = { leader: Address; marketId?: string | null; nonce: number };

/** The form as typed: amounts in collateral units, bands and stops in percent. */
type Form = {
  interval: number;
  margin: string;
  leverage: string;
  slippage: string;
  stop: string;
  target: string;
  period: string;
  slowPeriod: string;
  band: string;
  exit: string;
  ratio: string;
  leader: string;
  maxSize: string;
  allowShort: boolean;
};

const pct = (bps: number) => (bps ? String(Number((bps / 100).toFixed(2))) : "");
const units = (v: bigint) => toInputString(v, USDC_DECIMALS, 2);

function formFrom(d: StrategyDraft, leader = ""): Form {
  return {
    interval: d.interval,
    margin: units(d.margin),
    leverage: String(d.leverage),
    slippage: pct(d.slippageBps),
    stop: pct(d.stopLossBps),
    target: pct(d.takeProfitBps),
    period: String(d.period || ""),
    slowPeriod: String(d.slowPeriod || ""),
    band: d.kind === "trend" && d.bandBps === 0 ? "0" : pct(d.bandBps),
    exit: d.kind === "meanRevert" && d.exitBps === 0 ? "0" : pct(d.exitBps),
    ratio: pct(d.ratioBps),
    leader: leader || (d.leader ?? ""),
    maxSize: d.maxSize > 0n ? units(d.maxSize) : "",
    allowShort: d.allowShort,
  };
}

/** Percent text to basis points; "" is `empty` (0 for optional brackets), anything unreadable is NaN. */
function toBps(text: string, empty = Number.NaN): number {
  const t = text.trim().replace(",", ".");
  if (t === "") return empty;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) return Number.NaN;
  return Math.round(n * 100);
}

const toInt = (text: string) => (/^\s*\d+\s*$/.test(text) ? Number(text) : Number.NaN);

function toDraft(kind: StrategyKind, f: Form): { draft: StrategyDraft; leaderTyped: boolean } {
  const leader = f.leader.trim();
  const valid = isAddress(leader, { strict: false });
  return {
    draft: {
      kind,
      interval: f.interval,
      margin: parseAmount(f.margin, USDC_DECIMALS) ?? 0n,
      leverage: toInt(f.leverage),
      slippageBps: toBps(f.slippage),
      allowShort: f.allowShort,
      stopLossBps: toBps(f.stop, 0),
      takeProfitBps: toBps(f.target, 0),
      period: kind === "copy" ? 0 : toInt(f.period),
      slowPeriod: kind === "trend" ? toInt(f.slowPeriod) : 0,
      bandBps: kind === "copy" ? 0 : toBps(f.band),
      exitBps: kind === "meanRevert" ? toBps(f.exit) : 0,
      ratioBps: kind === "copy" ? toBps(f.ratio) : 0,
      leader: kind === "copy" && valid ? getAddress(leader) : null,
      maxSize: kind === "copy" ? (parseAmount(f.maxSize, USDC_DECIMALS) ?? 0n) : 0n,
    },
    leaderTyped: leader !== "" && !valid,
  };
}

/** The settings that make a replay meaningful, whatever the launch checks say about the rest. */
function replayable(d: StrategyDraft): boolean {
  if (d.kind === "copy") return false;
  const ints = [d.interval, d.leverage, d.period, d.bandBps, d.stopLossBps, d.takeProfitBps];
  if (!ints.every((n) => Number.isInteger(n) && n >= 0)) return false;
  if (d.interval < 60 || d.leverage < 1 || d.margin <= 0n || d.period < 2) return false;
  if (d.kind === "trend") return Number.isInteger(d.slowPeriod) && d.slowPeriod > d.period && d.slowPeriod <= 200;
  return d.period <= 200 && d.bandBps >= 1 && Number.isInteger(d.exitBps) && d.exitBps < d.bandBps;
}

function explain(d: StrategyDraft, symbol: string, sym: string): string[] {
  const every = everyText(d.interval);
  const warm = warmupReadings(d);
  const warmText = `${warm} readings (about ${everyText(warm * d.interval).replace(/^1 /, "one ")})`;
  const lines: string[] = [];
  if (d.kind === "trend") {
    lines.push(
      `Every ${every} it reads the ${symbol} price and keeps two moving averages: a fast one over the last ${d.period || "…"} readings and a slow one over ${d.slowPeriod || "…"}.` +
        ` When the fast average is more than ${bpsText(d.bandBps || 0)} above the slow one, it goes long; more than ${bpsText(d.bandBps || 0)} below, it ${d.allowShort ? "goes short" : "closes and waits (shorts are off)"}.` +
        ` In between it keeps what it holds, so small wiggles do not flip it. Its first trade comes after ${warmText}.`,
    );
  } else if (d.kind === "meanRevert") {
    lines.push(
      `Every ${every} it compares the ${symbol} price with its average over the last ${d.period || "…"} readings.` +
        ` More than ${bpsText(d.bandBps || 0)} below the average, it buys; more than ${bpsText(d.bandBps || 0)} above, it ${d.allowShort ? "sells short" : "closes any long"}.` +
        ` It takes the trade off once the price is back within ${bpsText(d.exitBps || 0)} of the average. Its first trade comes after ${warmText}.`,
    );
  } else {
    lines.push(
      `Every ${every} it looks at ${d.leader ? shortAddress(d.leader) : "the trader"}'s ${symbol} position and holds ${bpsText(d.ratioBps || 0)} of its size, never more than ${fmtUsdc(d.maxSize)} ${sym}.` +
        ` When they open, add, cut or close, the copy follows at its next check${d.allowShort ? "" : "; their shorts are ignored"}.` +
        ` If something else closes the copy (its stop, a liquidation, you), it sits out that trade of theirs and joins their next one.`,
    );
  }
  if (d.leverage >= 1 && d.margin > 0n) {
    const liq = fmtPercent(liquidationMove(d.leverage), liquidationMove(d.leverage) < 0.01 ? 2 : 1);
    lines.push(
      `${d.kind === "copy" ? "Each order puts up at most" : "Each entry puts up"} ${fmtUsdc(d.margin)} ${sym} at ${d.leverage}x (${fmtUsdc(entrySize(d))} ${sym} of exposure): a ${liq} move against it liquidates it` +
        `${d.stopLossBps ? `, and the stop-loss ${bpsText(d.stopLossBps)} from the entry closes it before that` : ""}${d.takeProfitBps ? `; a take-profit ${bpsText(d.takeProfitBps)} away banks a win` : ""}.` +
        ` The keeper fills each order at the next price, within ${bpsText(d.slippageBps || 0)} of the price when it was placed.`,
    );
  }
  return lines;
}

function Field({
  id,
  label,
  unit,
  value,
  onChange,
  invalid,
  tip,
  placeholder,
  testId,
  numeric = true,
  className = "",
}: {
  id: string;
  label: string;
  unit?: string;
  value: string;
  onChange: (v: string) => void;
  invalid?: boolean;
  tip?: ReactNode;
  placeholder?: string;
  testId?: string;
  numeric?: boolean;
  className?: string;
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="mb-[0.3rem] flex items-center gap-1">
        <label className="text-xs text-muted" htmlFor={id}>
          {label}
        </label>
        {tip ? <Tip label={`About: ${label}`}>{tip}</Tip> : null}
      </div>
      <div className="field h-9" data-invalid={invalid ? "true" : undefined}>
        <input
          id={id}
          className={numeric ? "num" : undefined}
          inputMode={numeric ? "decimal" : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={invalid || undefined}
          data-testid={testId}
        />
        {unit ? <span className="field-unit">{unit}</span> : null}
      </div>
    </div>
  );
}

function SelectField({ id, label, value, onChange, children, testId, tip }: { id: string; label: string; value: string | number; onChange: (v: string) => void; children: ReactNode; testId?: string; tip?: ReactNode }) {
  return (
    <div className="min-w-0">
      <div className="mb-[0.3rem] flex items-center gap-1">
        <label className="text-xs text-muted" htmlFor={id}>
          {label}
        </label>
        {tip ? <Tip label={`About: ${label}`}>{tip}</Tip> : null}
      </div>
      <select id={id} className="field h-9 w-full text-[0.8125rem]" value={value} onChange={(e) => onChange(e.target.value)} data-testid={testId}>
        {children}
      </select>
    </div>
  );
}

function ConnectHint() {
  return <p className="text-[0.8125rem] text-muted">Connect the wallet that will own the agent account to launch. The preview works without one.</p>;
}

/**
 * The Agent Studio: pick a template and a market, tune it in plain words, see how it would have done on recent
 * candles, and launch it on the agent account in a few explained signatures.
 */
export function AgentStudio({ account, accountKnown, prefill }: { account: Address | undefined; accountKnown: boolean; prefill: StudioPrefill | null }) {
  const { config: cfg } = useApp();
  const wagmiConfig = useConfig();
  const wallet = useWallet();
  const owner = wallet.ready ? wallet.address : undefined;
  const { instruments, prices, params } = useMarketData();
  const now = useChainNow(5_000);
  const [preferences] = useLocalStore(prefs);
  const tx = useTx();
  const id = useId();
  const sym = cfg.collateralSymbol;

  const tradable = useMemo(() => instruments.filter((i) => i.enabled && !(i.expiry !== 0 && now >= i.expiry)), [instruments, Math.floor(now / 60)]); // eslint-disable-line react-hooks/exhaustive-deps
  const [kind, setKind] = useState<StrategyKind>("trend");
  const [marketId, setMarketId] = useState<string | null>(null);
  const instrument = useMemo(() => (marketId ? tradable.find((i) => i.id.toLowerCase() === marketId.toLowerCase()) : undefined), [tradable, marketId]);
  const [form, setForm] = useState<Form | null>(null);
  const opts = { minMargin: params?.minMargin, maxLeverage: preferences.maxLeverage };

  // First market: BTC-USD where there is one.
  useEffect(() => {
    if (form || tradable.length === 0) return;
    const first = tradable.find((i) => i.symbol === "BTC-USD") ?? tradable[0]!;
    setMarketId(first.id);
    setForm(formFrom(defaultsFor(kind, first, opts)));
  }, [tradable.length]); // eslint-disable-line react-hooks/exhaustive-deps

  // "Copy this agent" and ?copy= links.
  const applied = useRef<number | null>(null);
  useEffect(() => {
    if (!prefill || applied.current === prefill.nonce || tradable.length === 0) return;
    applied.current = prefill.nonce;
    const target = (prefill.marketId && tradable.find((i) => i.id.toLowerCase() === prefill.marketId!.toLowerCase() || i.symbol === prefill.marketId)) || instrument || tradable.find((i) => i.symbol === "BTC-USD") || tradable[0]!;
    setKind("copy");
    setMarketId(target.id);
    setForm(formFrom(defaultsFor("copy", target, opts), prefill.leader));
  }, [prefill?.nonce, tradable.length]); // eslint-disable-line react-hooks/exhaustive-deps

  const chooseKind = (k: StrategyKind) => {
    if (k === kind || !instrument) return;
    setKind(k);
    setForm((f) => formFrom(defaultsFor(k, instrument, opts), f?.leader ?? ""));
  };
  const chooseMarket = (idText: string) => {
    const next = tradable.find((i) => i.id === idText);
    if (!next) return;
    setMarketId(next.id);
    // The settings carry over; leverage is held within the new market's maximum.
    setForm((f) => (f ? { ...f, leverage: String(Math.min(next.maxLeverage, toInt(f.leverage) || 1)) } : formFrom(defaultsFor(kind, next, opts))));
  };
  const set = (patch: Partial<Form>) => setForm((f) => (f ? { ...f, ...patch } : f));

  const parsed = useMemo(() => (form ? toDraft(kind, form) : null), [form, kind]);
  const draft = parsed?.draft ?? null;
  const strategies = useAccountStrategies(account);
  const issueList = useMemo(() => {
    if (!draft) return [];
    const list = validateDraft(draft, { market: instrument ?? null, minMargin: params?.minMargin ?? 0n, now, account: account ?? null, personalMaxLeverage: preferences.maxLeverage, collateralSymbol: sym });
    if (parsed?.leaderTyped) list.unshift({ field: "leader", message: "That is not an address" });
    return list;
  }, [draft, parsed?.leaderTyped, instrument, params?.minMargin, Math.floor(now / 30), account, preferences.maxLeverage, sym]); // eslint-disable-line react-hooks/exhaustive-deps
  const bad = new Set<DraftField>(issueList.map((i) => i.field));
  const defaults = instrument ? formFrom(defaultsFor(kind, instrument, opts), form?.leader ?? "") : null;
  const isDefault = !!form && !!defaults && JSON.stringify({ ...form, leader: "" }) === JSON.stringify({ ...defaults, leader: "" });

  // ── Replay ──
  const candles = useStrategyCandles(kind === "copy" ? undefined : instrument, draft?.interval ?? 900);
  const profitShare = useReadContract({ address: cfg.perpEngine, abi: perpEngineAbi, functionName: "profitShareBps", chainId: cfg.chainId, query: { staleTime: 300_000 } });
  const price = instrument ? prices.get(instrument.id) : undefined;
  const quote = price?.exec ?? price?.reference ?? null;
  const spreadBps = quote && quote.mid > 0n ? Math.max(0, priceToNum(((quote.ask - quote.bid) * 10_000n * 10n ** 18n) / quote.mid)) : 2;
  const fees: BtFees = {
    mode: instrument?.upside ? "upside" : "standard",
    baseFeeBps: Number(params?.baseFeeBps ?? 5n),
    feeCapBps: 1_000,
    spreadBps: Math.min(spreadBps, 500),
    executionFee: params ? usdcToNum(params.executionFee) : 0.1,
    profitShareBps: Number((profitShare.data as bigint | undefined) ?? 2_000n),
    maxProfitMultiple: Number(params?.maxProfitMultiple ?? 10n),
  };
  const btConfig: BtConfig | null =
    draft && draft.kind !== "copy" && replayable(draft)
      ? {
          kind: draft.kind,
          interval: draft.interval,
          margin: usdcToNum(draft.margin),
          leverage: draft.leverage,
          allowShort: draft.allowShort,
          stopLossBps: draft.stopLossBps,
          takeProfitBps: draft.takeProfitBps,
          period: draft.period,
          slowPeriod: draft.slowPeriod,
          bandBps: draft.bandBps,
          exitBps: draft.exitBps,
        }
      : null;
  const deferred = useDeferredValue(JSON.stringify({ btConfig, fees }));
  const result = useMemo(() => {
    const { btConfig: c, fees: f } = JSON.parse(deferred) as { btConfig: BtConfig | null; fees: BtFees };
    if (!c || !candles.candles || candles.candles.length < 2) return null;
    return runBacktest(candles.candles, candles.seconds, c, f);
  }, [deferred, candles.candles, candles.seconds]);

  // ── Launch ──
  const [keepFor, setKeepFor] = useState(KEEP_FOR_PRESETS[1]!.seconds);
  const [budgetText, setBudgetText] = useState<string | null>(null);
  const [depositText, setDepositText] = useState<string | null>(null);
  const balances = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: cfg.usdc, abi: testUSDCAbi, functionName: "balanceOf", args: [account ?? "0x0000000000000000000000000000000000000000"], chainId: cfg.chainId },
      { address: cfg.usdc, abi: testUSDCAbi, functionName: "balanceOf", args: [owner ?? "0x0000000000000000000000000000000000000000"], chainId: cfg.chainId },
    ],
    query: { enabled: !!owner, refetchInterval: 4_000 },
  });
  const inAccount = account ? (balances.data?.[0] as bigint | undefined) : 0n;
  const inWallet = balances.data?.[1] as bigint | undefined;
  const allowed = useMarketAllowed(account, instrument?.id, strategies.restrictMarkets);

  const policyExists = !!strategies.policy && strategies.policy.expiry > 0n;
  const currentBudget = strategies.budget?.perDay ?? 0n;
  const margin = draft?.margin ?? 0n;
  const suggestedBudget = policyExists ? (currentBudget > 0n ? units(currentBudget) : "") : margin > 0n ? units(margin * 5n) : "";
  const budgetInput = budgetText ?? suggestedBudget;
  const budget = budgetInput.trim() === "" ? 0n : parseAmount(budgetInput, USDC_DECIMALS);
  // About one entry and its keeper fees, less what the account already holds.
  const executionFee = params?.executionFee ?? 100_000n;
  const need = margin + executionFee * 3n;
  const shortfall = inAccount !== undefined && need > inAccount ? need - inAccount : 0n;
  const suggestedDeposit = shortfall > 0n ? String((shortfall + 999_999n) / 1_000_000n) : "";
  const depositInput = depositText ?? suggestedDeposit;
  const deposit = depositInput.trim() === "" ? 0n : parseAmount(depositInput, USDC_DECIMALS);

  const taken = instrument ? strategies.live.find((r) => r.marketId.toLowerCase() === instrument.id.toLowerCase()) : undefined;
  const policyPlan =
    draft && Number.isInteger(draft.leverage)
      ? planPolicy({
          current: account ? strategies.policy : null,
          need: { leverage: draft.leverage, margin: draft.margin },
          live: strategies.live.map((r) => ({ leverage: Number(r.config.leverage), margin: BigInt(r.config.margin) })),
          now,
          keepFor,
        })
      : null;
  const plan: LaunchPlan | null =
    draft && instrument && policyPlan
      ? {
          account: account ?? null,
          market: { id: instrument.id, symbol: instrument.symbol },
          draft,
          deposit: deposit ?? 0n,
          policy: policyPlan.change ? policyPlan.next : null,
          budget: budget !== null && budget !== currentBudget ? budget : null,
          allowMarket: strategies.restrictMarkets && allowed === false,
        }
      : null;
  const steps = plan ? launchSteps(plan, sym) : [];

  const problem = !cfg.strategies
    ? "This deployment has no Strategies contract"
    : !owner
      ? "Connect a wallet to launch"
      : !accountKnown || (account && strategies.loading)
        ? "Checking your agent account…"
        : (issueList[0]?.message ??
          (taken
            ? `Your account already runs a strategy on ${instrument!.symbol}: stop it first`
            : deposit === null
              ? "Deposit: an amount, or leave it empty"
              : inWallet !== undefined && deposit > inWallet
                ? `Only ${fmtUsdc(inWallet)} ${sym} in your wallet to deposit`
                : budget === null
                  ? "Daily budget: an amount, or leave it empty"
                  : budget > 0n && budget < margin
                    ? `Daily budget: at least one entry's margin (${fmtUsdc(margin)} ${sym})`
                    : strategies.restrictMarkets && allowed === undefined
                      ? "Checking the account's market list…"
                      : null));
  const after = (inAccount ?? 0n) + (deposit ?? 0n);
  const lowFunds = !!owner && !problem && after < margin + executionFee;

  const launch = () => {
    if (problem || !plan || !owner || !draft || !instrument) return;
    const name = strategyName(draft);
    void tx.run(async (api) => {
      const r = await launchStrategy({ wagmi: wagmiConfig, cfg, api, owner }, plan);
      strategies.refetch();
      setDepositText(null);
      return `${name} is live on ${instrument.symbol}${r.id !== null ? ` as strategy #${r.id}` : ""}. It acts from the next keeper check; follow it under Running strategies.`;
    });
  };

  const onTemplateKey = (e: KeyboardEvent<HTMLDivElement>) => {
    const i = TEMPLATES.findIndex((t) => t.key === kind);
    const next = e.key === "ArrowRight" || e.key === "ArrowDown" ? (i + 1) % TEMPLATES.length : e.key === "ArrowLeft" || e.key === "ArrowUp" ? (i + TEMPLATES.length - 1) % TEMPLATES.length : -1;
    if (next < 0) return;
    e.preventDefault();
    chooseKind(TEMPLATES[next]!.key);
    (e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="radio"]')[next] as HTMLButtonElement | undefined)?.focus();
  };

  const groups = groupInstruments(tradable);
  const fid = (name: string) => `${id}-${name}`;

  return (
    <section className="panel min-w-0 scroll-mt-16" id="studio" aria-labelledby={`${id}-t`} data-testid="studio">
      <div className="flex flex-wrap items-end justify-between gap-3 border-b border-line px-4 py-3">
        <div className="min-w-0">
          <h2 id={`${id}-t`} className="wide text-base leading-tight">
            Strategy studio
          </h2>
          <p className="mt-1 max-w-[64ch] text-[0.8125rem] text-muted">
            Pick a strategy, tune it, see how it would have done on recent prices, then launch it on your agent account. It runs on-chain: the keeper checks
            it, and it can only trade the account, never withdraw.
          </p>
        </div>
        <div className="w-full sm:w-56">
          <label className="field-label" htmlFor={fid("market")}>
            Market
          </label>
          <select id={fid("market")} className="field h-9 w-full text-[0.8125rem]" value={instrument?.id ?? ""} onChange={(e) => chooseMarket(e.target.value)} data-testid="studio-market">
            {groups.map((g) => (
              <optgroup key={g.kind.key} label={g.kind.label}>
                {g.items.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.symbol} (up to {i.maxLeverage}x)
                  </option>
                ))}
              </optgroup>
            ))}
          </select>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-line px-4 py-2">
        <div role="radiogroup" aria-label="Strategy" className="segmented min-w-0 flex-1 sm:max-w-[34rem]" onKeyDown={onTemplateKey}>
          {TEMPLATES.map((t) => (
            <button
              key={t.key}
              type="button"
              role="radio"
              aria-checked={kind === t.key}
              tabIndex={kind === t.key ? 0 : -1}
              className={`px-2 ${kind === t.key ? "bg-raised text-text shadow-[inset_0_0_0_1px_var(--color-line-strong)]" : "hover:text-text"}`}
              onClick={() => chooseKind(t.key)}
              data-testid={`studio-template-${t.key}`}
              title={t.line}
            >
              {t.title}
            </button>
          ))}
        </div>
        <span className="flex flex-wrap items-center gap-1.5 text-xs text-faint">
          In the order ticket:
          <AppLink route="trade" className="chip" title="Split one large market order into slices over time: Market, then tick “TWAP: split into slices over time” (with instant trading).">
            TWAP
          </AppLink>
          <AppLink route="trade" className="chip" title="A stop-loss that follows the best price and never moves back: press Trail on a position in your trading account.">
            Trailing stop
          </AppLink>
        </span>
      </div>

      {!form || !instrument || !draft ? (
        <p className="px-4 py-12 text-center text-muted">{instruments.length === 0 ? "Loading markets…" : "No market is open for new positions."}</p>
      ) : (
        <div className="grid min-w-0 xl:grid-cols-[minmax(0,25rem)_minmax(0,1fr)]">
          <div className="flex min-w-0 flex-col gap-4 border-line p-4 xl:border-r">
            <div className="flex flex-col gap-2 text-[0.8125rem] leading-relaxed text-muted" data-testid="studio-explain">
              {explain(draft, instrument.symbol, sym).map((line, i) => (
                <p key={i} className={i === 0 ? "text-text" : undefined}>
                  {line}
                </p>
              ))}
              {instrument.upside ? (
                <p className="text-xs text-accent">
                  {instrument.symbol} is an Upside market: no fee to open or close, fills at the mid, and the house keeps a share of a winning trade&rsquo;s profit.
                </p>
              ) : null}
            </div>

            <fieldset className="flex flex-col gap-2.5">
              <legend className="mb-2 flex w-full items-baseline justify-between gap-2 text-xs font-semibold text-text">
                {kind === "copy" ? "Whom to copy" : "Signal"}
                {!isDefault && defaults ? (
                  <button type="button" className="link text-2xs font-normal" onClick={() => setForm(defaults)}>
                    Defaults for {instrument.symbol}
                  </button>
                ) : null}
              </legend>
              {kind === "copy" ? (
                <>
                  <Field
                    id={fid("leader")}
                    label="Trader to copy"
                    numeric={false}
                    value={form.leader}
                    onChange={(v) => set({ leader: v })}
                    placeholder="0x… a wallet or an agent account"
                    invalid={bad.has("leader")}
                    testId="studio-leader"
                    tip="Any address that trades here. Pick one from the agent directory below, or paste one from the leaderboard."
                  />
                  <div className="grid grid-cols-2 gap-2">
                    <Field id={fid("ratio")} label="Share of their size" unit="%" value={form.ratio} onChange={(v) => set({ ratio: v })} invalid={bad.has("ratioBps")} testId="studio-ratio" tip="100% copies their size exactly; 50% holds half of it. Up to 1,000%." />
                    <Field id={fid("max")} label="Largest position" unit={sym} value={form.maxSize} onChange={(v) => set({ maxSize: v })} invalid={bad.has("maxSize")} testId="studio-max-size" tip="The copy never holds more than this, whatever they do." />
                  </div>
                </>
              ) : kind === "trend" ? (
                <div className="grid grid-cols-3 gap-2">
                  <Field id={fid("fast")} label="Fast average" unit="reads" value={form.period} onChange={(v) => set({ period: v })} invalid={bad.has("period")} testId="studio-period" tip="Readings in the fast moving average: fewer reacts sooner, and flips more." />
                  <Field id={fid("slow")} label="Slow average" unit="reads" value={form.slowPeriod} onChange={(v) => set({ slowPeriod: v })} invalid={bad.has("slowPeriod")} testId="studio-slow" tip="Readings in the slow average, up to 200. The strategy acts once it has seen this many." />
                  <Field id={fid("band")} label="Band" unit="%" value={form.band} onChange={(v) => set({ band: v })} invalid={bad.has("bandBps")} testId="studio-band" tip="How far apart the averages must be before the strategy changes side. A wider band trades less." />
                </div>
              ) : (
                <div className="grid grid-cols-3 gap-2">
                  <Field id={fid("avg")} label="Average over" unit="reads" value={form.period} onChange={(v) => set({ period: v })} invalid={bad.has("period")} testId="studio-period" tip="Readings in the moving average the price is measured against." />
                  <Field id={fid("in")} label="Enter beyond" unit="%" value={form.band} onChange={(v) => set({ band: v })} invalid={bad.has("bandBps")} testId="studio-band" tip="How far from the average the price must stretch before the strategy trades against it." />
                  <Field id={fid("out")} label="Exit within" unit="%" value={form.exit} onChange={(v) => set({ exit: v })} invalid={bad.has("exitBps")} testId="studio-exit" tip="The trade comes off once the price is back this close to the average. Inside the entry band." />
                </div>
              )}
              <SelectField id={fid("every")} label={kind === "copy" ? "Check every" : "Read the price every"} value={form.interval} onChange={(v) => set({ interval: Number(v) })} testId="studio-interval" tip="Readings are at least this far apart. An order still unfilled after one interval is cancelled and tried again.">
                {INTERVAL_PRESETS.map((p) => (
                  <option key={p.seconds} value={p.seconds}>
                    {p.label}
                  </option>
                ))}
              </SelectField>
            </fieldset>

            <fieldset className="flex flex-col gap-2.5">
              <legend className="mb-2 text-xs font-semibold text-text">Risk</legend>
              <div className="grid grid-cols-2 gap-2">
                <Field id={fid("margin")} label={kind === "copy" ? "Most margin per order" : "Margin per entry"} unit={sym} value={form.margin} onChange={(v) => set({ margin: v })} invalid={bad.has("margin")} testId="studio-margin" />
                <Field id={fid("lev")} label="Leverage" unit={`x, max ${Math.min(instrument.maxLeverage, preferences.maxLeverage ?? instrument.maxLeverage)}`} value={form.leverage} onChange={(v) => set({ leverage: v })} invalid={bad.has("leverage")} testId="studio-leverage" />
                <Field id={fid("sl")} label="Stop-loss" unit="%" placeholder="off" value={form.stop} onChange={(v) => set({ stop: v })} invalid={bad.has("stopLossBps")} testId="studio-stop" tip="Placed with each new position, this far from its entry (0.1% to 50%). Leave empty for none." />
                <Field id={fid("tp")} label="Take-profit" unit="%" placeholder="off" value={form.target} onChange={(v) => set({ target: v })} invalid={bad.has("takeProfitBps")} testId="studio-target" tip="Placed with each new position; it must be wider than the slippage bound. Leave empty for none." />
                <Field id={fid("slip")} label="Slippage bound" unit="%" value={form.slippage} onChange={(v) => set({ slippage: v })} invalid={bad.has("slippageBps")} testId="studio-slippage" tip="The worst fill an order accepts, from the price when it is placed (up to 5%)." />
                <label className="mt-5 flex items-center gap-2 text-[0.8125rem] text-muted">
                  <input type="checkbox" className="check" checked={form.allowShort} onChange={(e) => set({ allowShort: e.target.checked })} data-testid="studio-shorts" />
                  {kind === "copy" ? "Copy their shorts too" : "Can go short"}
                </label>
              </div>
              {draft.leverage >= 1 && liquidationMove(draft.leverage) < 0.02 ? (
                <p className="text-xs text-warn">
                  At {draft.leverage}x a {fmtPercent(liquidationMove(draft.leverage), 2)} move against a position liquidates it. The replay shows how often that would have
                  happened.
                </p>
              ) : null}
            </fieldset>
          </div>

          <div className="min-w-0 border-t border-line xl:border-t-0">
            {kind === "copy" ? (
              <CopyPreview leader={draft.leader} instrument={instrument} draft={draft} />
            ) : (
              <BacktestPanel
                result={result}
                fees={fees}
                kind={kind}
                bandBps={draft.bandBps}
                margin={usdcToNum(draft.margin)}
                priceDecimals={instrument.priceDecimals}
                candleLabel={candles.label}
                sym={sym}
                loading={candles.loading}
                error={
                  !candles.available
                    ? `No price history for ${instrument.symbol} here, so there is no replay.`
                    : candles.error
                      ? "Recent candles could not be loaded. The replay will retry."
                      : !btConfig
                        ? "Fix the settings marked in red to see the replay."
                        : null
                }
              />
            )}
          </div>
        </div>
      )}

      {form && instrument && draft ? (
        <div className="border-t border-line px-4 py-3" data-testid="studio-launch-panel">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <h3 className="panel-title">Launch on your agent account</h3>
            {account ? (
              <span className="num text-xs text-muted">
                {shortAddress(account)} holds {inAccount !== undefined ? fmtUsdc(inAccount) : "…"} {sym}
              </span>
            ) : null}
          </div>
          {!cfg.strategies ? (
            <p className="mt-2 text-[0.8125rem] text-muted">This deployment has no Strategies contract (STRATEGIES_ADDRESS): the studio can preview strategies but not launch them.</p>
          ) : (
            <>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                <SelectField id={fid("keep")} label="Allow it to trade for" value={keepFor} onChange={(v) => setKeepFor(Number(v))} testId="studio-keep" tip="How long the account lets the Strategies contract place orders. All your strategies share this approval; renew it under Running strategies.">
                  {KEEP_FOR_PRESETS.map((p) => (
                    <option key={p.seconds} value={p.seconds}>
                      {p.label}
                    </option>
                  ))}
                </SelectField>
                <Field
                  id={fid("budget")}
                  label="Daily margin budget"
                  unit={sym}
                  placeholder="no limit"
                  value={budgetInput}
                  onChange={setBudgetText}
                  invalid={budget === null || (budget > 0n && budget < margin)}
                  testId="studio-budget"
                  tip="The most new margin all your strategies together may put up per UTC day. Margin coming back from closes does not refill it, so it bounds a day's loss. Empty: no limit."
                />
                <Field
                  id={fid("deposit")}
                  label="Deposit now"
                  unit={sym}
                  placeholder="0"
                  value={depositInput}
                  onChange={setDepositText}
                  invalid={deposit === null || (deposit !== null && inWallet !== undefined && deposit > inWallet)}
                  testId="studio-deposit"
                  tip={`From your wallet${inWallet !== undefined ? ` (${fmtUsdc(inWallet)} ${sym})` : ""} into the account, for margin and keeper fees.`}
                />
              </div>

              {owner ? (
                <ol className="mt-3 flex flex-col gap-1.5" data-testid="launch-steps" aria-label="What you will sign">
                  {steps.map((s, i) => (
                    <li key={s.key} className="flex gap-2.5 text-[0.8125rem]">
                      <span className="num mt-px grid h-5 w-5 flex-none place-items-center rounded-full border border-line-strong text-2xs text-muted" aria-hidden="true">
                        {i + 1}
                      </span>
                      <span className="min-w-0">
                        <span className="text-text">{s.title}.</span> <span className="text-muted">{s.detail}</span>
                      </span>
                    </li>
                  ))}
                </ol>
              ) : (
                <div className="mt-3">
                  <ConnectHint />
                </div>
              )}
              {lowFunds ? (
                <p className="mt-2 text-xs text-warn" data-testid="studio-low-funds">
                  The account would hold {fmtUsdc(after)} {sym}; an entry needs {fmtUsdc(margin)} {sym} plus keeper fees. Orders are refused while it is short, and three refusals in
                  a row pause the strategy.
                </p>
              ) : null}
              <button
                type="button"
                className={`btn btn-lg mt-3 ${problem ? "" : "btn-primary"}`}
                disabled={problem !== null || tx.busy}
                onClick={launch}
                data-testid="studio-launch"
              >
                {tx.busy ? <span className="spinner" aria-hidden="true" /> : null}
                {problem ?? `Launch: ${steps.length} ${steps.length === 1 ? "signature" : "signatures"}`}
              </button>
              <TxStatus state={tx.state} onDismiss={tx.reset} className="mt-2" />
            </>
          )}
        </div>
      ) : null}
    </section>
  );
}

