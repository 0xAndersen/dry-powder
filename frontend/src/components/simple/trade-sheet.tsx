"use client";

import { useId, useMemo, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { useConnect, useReadContract } from "wagmi";
import { useApp } from "@/components/providers";
import { Fuse } from "@/components/simple/fuse";
import { TxStatus } from "@/components/tx-status";
import { Sheet } from "@/components/ui/sheet";
import { Sparkline } from "@/components/ui/sparkline";
import { useAccountData } from "@/hooks/use-account-data";
import { useTradeContext } from "@/hooks/use-action-context";
import { useDayStats } from "@/hooks/use-day-stats";
import { useLocalStore } from "@/hooks/use-local-store";
import { useChainNow, useMarketData, useMarketPrice } from "@/hooks/use-market-data";
import { useTradingAccount } from "@/hooks/use-trading-account";
import { useTx } from "@/hooks/use-tx";
import { useAccountView, useWallet } from "@/hooks/use-wallet";
import { perpEngineAbi } from "@/lib/abi";
import { TEST_MINT_AMOUNT, submitTestMint } from "@/lib/actions";
import { UserFacingError } from "@/lib/errors";
import { openFlow } from "@/lib/flows";
import { USDC_DECIMALS, fmtBps, fmtNum, fmtPrice, fmtUsdc, parseAmount } from "@/lib/format";
import { isExpired, isSettled, type Instrument } from "@/lib/instruments";
import { BPS, DIRECT_MAX_LEVERAGE, absDiff, baseFee, liquidationPrice, maxOpenFee, needsKeeperOrders, ratio } from "@/lib/math";
import { prefs } from "@/lib/prefs";
import { AMOUNT_STEPS, leverageSteps, movePct, simpleName, simpleSubject } from "@/lib/simple";
import { tradeSettings } from "@/lib/storage";

const UNIT = 1_000_000n;

/**
 * One market, one decision: up or down, how much, how much leverage. Everything the trade can do is said in
 * words before the button: what you put in, what each 1% is worth, the most you can win, how far the price can go
 * against you (the fuse) and the fees. A keeper-filled market order underneath, like the terminal's.
 */
export function TradeSheet({
  instrument,
  lossLimit,
  onClose,
  onPlaced,
  onSetUpInstant,
}: {
  instrument: Instrument;
  /** The trader's own limit (daily loss, cool-off) when it refuses new positions. */
  lossLimit: string | null;
  onClose: () => void;
  onPlaced: (message: string) => void;
  onSetUpInstant: () => void;
}) {
  const { config: cfg, chain } = useApp();
  const { params, error: paramsError } = useMarketData();
  const price = useMarketPrice(instrument.id);
  const chainNow = useChainNow(5_000);
  const view = useAccountView();
  const wallet = useWallet();
  const trading = useTradingAccount();
  const account = useAccountData(view.address);
  const actionContext = useTradeContext();
  const tx = useTx({ autoDismissMs: 15_000 });
  const [settings] = useLocalStore(tradeSettings);
  const [preferences] = useLocalStore(prefs);
  const { connect, connectors, isPending: connecting } = useConnect();
  const day = useDayStats(instrument, price.display);
  const ids = useId();
  const sym = cfg.collateralSymbol;
  const name = simpleName(instrument);
  const subject = simpleSubject(instrument);

  const maxLev = preferences.maxLeverage !== null ? Math.max(1, Math.min(instrument.maxLeverage, preferences.maxLeverage)) : instrument.maxLeverage;
  const steps = useMemo(() => leverageSteps(maxLev), [maxLev]);
  const [dir, setDir] = useState<"up" | "down" | null>(null);
  const [amountPick, setAmountPick] = useState<number | "other">(50);
  const [otherText, setOtherText] = useState("");
  // Start at 10x where it is a preset, otherwise at the second preset (a modest step up from the lowest).
  const [lev, setLev] = useState(() => (steps.includes(10) ? 10 : (steps[1] ?? steps[0] ?? 1)));
  const [protect, setProtect] = useState(true);

  const isLong = dir !== "down";
  // Turbo (Upside fee mode): no fee to open or close, fills at the mid, keeper orders only, and the house keeps a
  // share of a winning close's profit.
  const upside = instrument.upside;
  const shareBps = upside ? (params?.profitShareBps ?? 2_000n) : 0n;
  const afterShare = (gain: bigint) => (upside ? gain - (gain * shareBps) / BPS : gain);
  const margin = amountPick === "other" ? (parseAmount(otherText, USDC_DECIMALS) ?? 0n) : BigInt(amountPick) * UNIT;
  const size = margin * BigInt(lev);
  const reference = price.reference;
  const entry = reference ? (upside ? reference.mid : isLong ? reference.ask : reference.bid) : null;
  const balance = account.data?.balance;

  // The fuse: how far the price can move against the trade before it closes on its own.
  const liq = entry && size > 0n ? liquidationPrice(entry, margin, size, isLong) : null;
  const liqMove = entry && liq !== null ? (liq === 0n ? null : ratio(absDiff(entry, liq), entry)) : null;
  const perPercent = afterShare(size / 100n);
  const maxWinGross = params ? margin * params.maxProfitMultiple : null;
  const maxWin = maxWinGross !== null ? afterShare(maxWinGross) : null;
  const capMove = maxWinGross !== null && size > 0n ? ratio(maxWinGross, size) : null;

  // "Stop at half": close once the trade has lost about half of what was put in. Offered up to 100x, where the
  // stop has room to sit inside the fuse.
  const protectable = lev <= DIRECT_MAX_LEVERAGE && !isSettled(instrument);
  const stopLoss =
    protect && protectable && entry && size > 0n
      ? (() => {
          const move = (margin * BPS) / 2n / size; // basis points of price
          return isLong ? (entry * (BPS - move)) / BPS : (entry * (BPS + move)) / BPS;
        })()
      : 0n;

  const feeQuote = useReadContract({
    abi: perpEngineAbi,
    address: cfg.perpEngine,
    chainId: cfg.chainId,
    functionName: "quoteOpenFee",
    args: [instrument.id, size, isLong, margin],
    query: { enabled: !upside && size > 0n && margin > 0n, refetchInterval: 5_000, placeholderData: keepPreviousData },
  });
  const keeperOrder = upside || cfg.oracleMode === "publisher" || (size > 0n && needsKeeperOrders(size, margin));
  const executions = (keeperOrder ? 1 : 0) + (stopLoss ? 1 : 0);
  const executionFees = params ? params.executionFee * BigInt(executions) : null;
  const openFee = upside ? 0n : (feeQuote.data ?? (params && size > 0n ? baseFee(size, params.baseFeeBps, margin) : null));
  const feeEscrow = upside || !params ? 0n : maxOpenFee(size, params.baseFeeBps, params.maxSkewFeeBps, margin);
  const required = params && executionFees !== null && size > 0n ? margin + feeEscrow + executionFees : null;
  const fees = openFee !== null && executionFees !== null ? openFee + executionFees : null;
  // A Turbo trade also closes through a keeper order: one more execution fee when you cash out.
  const closeExecution = upside && params ? params.executionFee : 0n;

  const expired = isExpired(instrument, chainNow);
  const settled = isSettled(instrument);
  const sideOi = isLong ? instrument.longOi : instrument.shortOi;
  const full = size > 0n && sideOi + size > instrument.maxOiPerSide;
  const position = account.data?.positions.find((p) => p.position.priceId.toLowerCase() === instrument.id);
  const opposite = position !== undefined && dir !== null && position.position.isLong !== isLong;
  const needsFunds = balance !== undefined && required !== null && required > balance;

  const blocking: string | null = (() => {
    if (view.watching) return "Watching someone else: trading is off";
    if (paramsError) return "Can't reach the venue right now";
    if (!params) return "Loading";
    if (params.paused) return "Trading is paused";
    if (settled || expired) return "This future has ended";
    if (!instrument.enabled) return "This market is closed to new trades";
    if (!reference) return "Waiting for a price";
    if (lossLimit) return lossLimit;
    if (dir === null) return "Choose up or down";
    if (margin === 0n) return "Choose an amount";
    if (margin < params.minMargin) return `Put in at least ${fmtUsdc(params.minMargin, 0)} ${sym}`;
    if (opposite) return `You already have a ${position!.position.isLong ? "up" : "down"} trade here: cash it out first`;
    if (full) return "Too big for this market right now: try less";
    if (view.canTrade && balance === undefined) return "Loading your balance";
    return null;
  })();

  const signIn = () => {
    const connector = connectors[0];
    if (connector) connect({ connector, chainId: chain.id });
  };

  const getPractice = () => {
    void tx.run(async (api) => {
      const ctx = actionContext(api);
      if (!ctx) throw new UserFacingError("Sign in first.");
      await submitTestMint(ctx, `Get ${fmtUsdc(TEST_MINT_AMOUNT, 0)} practice ${sym}`);
      return `${fmtUsdc(TEST_MINT_AMOUNT, 0)} practice ${sym} added.`;
    });
  };

  const place = () => {
    if (blocking || !entry || !reference || required === null || dir === null) return;
    void (async () => {
      const ok = await tx.run(async (api) => {
        const ctx = actionContext(api);
        if (!ctx) throw new UserFacingError("Sign in first.");
        await openFlow(ctx, {
          instrument,
          isLong,
          margin,
          size,
          type: "market",
          limitPrice: 0n,
          reference,
          slippageBps: settings.slippageBps,
          takeProfit: 0n,
          stopLoss,
          required,
        });
        return `${dir === "up" ? "Up" : "Down"} on ${name} with ${fmtUsdc(margin)} ${sym} at ${lev}x. A keeper fills it at the next price.`;
      });
      if (ok) onPlaced(`${dir === "up" ? "Up" : "Down"} on ${name}: you're in.`);
    })();
  };

  const change = day.change;
  const levNote =
    lev === 1
      ? "No leverage: the trade moves one for one with the price."
      : `${lev}x: every 1% ${subject} moves is ${lev}% of what you put in.`;

  let action: React.ReactNode;
  if (!view.instant && !wallet.connected) {
    action = (
      <button type="button" className="s-go" onClick={signIn} disabled={connecting || connectors.length === 0} data-testid="simple-sign-in">
        {connecting ? "Signing in…" : "Sign in to trade"}
      </button>
    );
  } else if (needsFunds && cfg.collateralIsTest && !blocking) {
    action = (
      <button type="button" className="s-go" onClick={getPractice} disabled={tx.busy} data-testid="simple-get-practice">
        {tx.busy ? "Adding…" : `Get ${fmtUsdc(TEST_MINT_AMOUNT, 0)} practice ${sym} to trade`}
      </button>
    );
  } else {
    action = (
      <button
        type="button"
        className="s-go"
        data-dir={blocking || needsFunds ? undefined : dir ?? undefined}
        disabled={blocking !== null || needsFunds || tx.busy}
        onClick={place}
        data-testid="simple-place"
      >
        {tx.busy ? "Placing…" : blocking ?? (needsFunds ? `Not enough ${sym}: ${fmtUsdc(required!)} needed` : `${dir === "up" ? "Up" : "Down"} with ${fmtUsdc(margin)} at ${lev}x`)}
      </button>
    );
  }

  return (
    <Sheet
      title={name}
      description={upside ? `Up to ${instrument.maxLeverage}x. No trading fee unless you win.` : `${instrument.symbol}, up to ${instrument.maxLeverage}x`}
      onClose={onClose}
      testId="simple-trade"
      footer={
        <div className="flex flex-col gap-2">
          {action}
          <TxStatus state={tx.state} onDismiss={tx.reset} />
          {!view.instant && wallet.connected && trading.supported ? (
            <button type="button" className="self-center text-xs text-muted underline-offset-2 hover:text-text hover:underline" onClick={onSetUpInstant}>
              Trade without a wallet pop-up each time
            </button>
          ) : null}
        </div>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="flex items-end justify-between gap-3 outline-none" tabIndex={-1} data-autofocus>
          <div className="min-w-0">
            <p className="s-display text-[2.25rem] sm:text-[2.6rem]" data-testid="simple-price">
              {price.display !== null ? fmtNum(price.display, instrument.priceDecimals) : "—"}
            </p>
            <p className={`s-num text-sm ${change === null ? "text-muted" : change >= 0 ? "text-long" : "text-short"}`}>
              {change === null ? "Today: no data yet" : `${change >= 0 ? "+" : "−"}${Math.abs(change * 100).toFixed(2)}% today`}
            </p>
          </div>
          <Sparkline values={day.closes} width={132} height={44} tone={change === null ? "flat" : change >= 0 ? "up" : "down"} label={`${name} over the last day`} />
        </div>

        <div className="grid grid-cols-2 gap-2" role="group" aria-label="Which way">
          <button type="button" className="s-dir" data-dir="up" aria-pressed={dir === "up"} onClick={() => setDir("up")} data-testid="simple-up">
            <span aria-hidden="true">▲</span> Up
          </button>
          <button type="button" className="s-dir" data-dir="down" aria-pressed={dir === "down"} onClick={() => setDir("down")} data-testid="simple-down">
            <span aria-hidden="true">▼</span> Down
          </button>
        </div>

        <div>
          <p className="mb-2 text-[0.8125rem] font-medium text-muted" id={`${ids}-amount`}>
            How much to put in, in {sym}
          </p>
          <div className="grid grid-cols-3 gap-2 sm:grid-cols-6" role="group" aria-labelledby={`${ids}-amount`}>
            {AMOUNT_STEPS.map((a) => (
              <button key={a} type="button" className="s-choice s-num" aria-pressed={amountPick === a} onClick={() => setAmountPick(a)}>
                {a}
              </button>
            ))}
            <button type="button" className="s-choice" aria-pressed={amountPick === "other"} onClick={() => setAmountPick("other")}>
              Other
            </button>
          </div>
          {amountPick === "other" ? (
            <div className="field mt-2">
              <input
                inputMode="decimal"
                autoComplete="off"
                placeholder="Amount"
                aria-label={`Amount in ${sym}`}
                value={otherText}
                onChange={(event) => setOtherText(event.target.value)}
                data-testid="simple-amount"
              />
              <span className="field-unit">{sym}</span>
            </div>
          ) : null}
        </div>

        <div>
          <div className="mb-2 flex items-baseline justify-between gap-2">
            <p className="text-[0.8125rem] font-medium text-muted" id={`${ids}-lev`}>
              Leverage
            </p>
            <p className="s-num text-sm">{lev}x</p>
          </div>
          <div className="grid grid-cols-5 gap-2" role="group" aria-labelledby={`${ids}-lev`}>
            {steps.map((x) => (
              <button key={x} type="button" className="s-choice s-num" aria-pressed={lev === x} onClick={() => setLev(x)} data-testid={`simple-lev-${x}`}>
                {x}x
              </button>
            ))}
          </div>
          <p className="mt-2 text-xs text-muted">{levNote}</p>
        </div>

        <div className="rounded-[14px] border border-line bg-raised p-3.5">
          <Fuse distance={liqMove} label={liqMove === null ? "This trade cannot close on its own" : `${subject} can move ${movePct(liqMove)} against you`} />
          <p className="mt-1.5 text-[0.8125rem]" data-testid="simple-fuse-text">
            {liqMove === null
              ? entry && liq === 0n
                ? `At 1x up, this only closes on its own if ${subject} goes to zero.`
                : "Choose an amount to see how far the price can go against you."
              : `If ${subject} ${isLong ? "falls" : "rises"} ${movePct(liqMove)}, this closes on its own and you lose the ${fmtUsdc(margin)} ${sym} you put in.`}
          </p>
          <dl className="mt-3 grid gap-1.5 text-[0.8125rem]">
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Each 1% {isLong ? "up" : "down"} is worth</dt>
              <dd className="s-num text-long">+{fmtUsdc(perPercent)} {sym}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Most you can win</dt>
              <dd className="s-num text-right">{maxWin !== null ? `${fmtUsdc(maxWin)} ${sym}${capMove !== null ? `, at a ${movePct(capMove)} ${isLong ? "rise" : "fall"}` : ""}` : "—"}</dd>
            </div>
            <div className="flex justify-between gap-3">
              <dt className="text-muted">Most you can lose</dt>
              <dd className="s-num text-short">{fmtUsdc(margin + (fees ?? 0n) + closeExecution)} {sym}</dd>
            </div>
            {upside ? (
              <>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">Fee</dt>
                  <dd className="s-num text-right" data-testid="simple-turbo-fee">
                    Only if you win: {fmtBps(shareBps)} of profit
                  </dd>
                </div>
                <div className="flex justify-between gap-3">
                  <dt className="text-muted">Keeper orders</dt>
                  <dd className="s-num text-right">{params ? `${fmtUsdc(params.executionFee)} ${sym} each, in and out` : "—"}</dd>
                </div>
              </>
            ) : (
              <div className="flex justify-between gap-3">
                <dt className="text-muted">Fees</dt>
                <dd className="s-num">{fees !== null ? `about ${fmtUsdc(fees)} ${sym}` : "—"}</dd>
              </div>
            )}
          </dl>
          {upside ? <p className="mt-2 text-xs text-muted">Wins are shown after the house&apos;s {fmtBps(shareBps)} share. Turbo fills at the mid price, both ways.</p> : null}
        </div>

        {protectable ? (
          <label className="flex items-start gap-3 text-[0.8125rem]">
            <input type="checkbox" className="check mt-0.5" checked={protect} onChange={(event) => setProtect(event.target.checked)} data-testid="simple-protect" />
            <span>
              <span className="font-medium">Stop at half</span>
              <span className="block text-xs text-muted">
                {stopLoss && entry
                  ? `Close it if ${subject} ${isLong ? "falls" : "rises"} to ${fmtPrice(stopLoss, instrument.priceDecimals)}, keeping about half of what you put in.`
                  : "Close it once it has lost about half of what you put in."}
              </span>
            </span>
          </label>
        ) : (
          <p className="text-xs text-muted">Above {DIRECT_MAX_LEVERAGE}x the fuse is too short for a stop: the trade closes on its own first. A keeper fills it at the next price.</p>
        )}

        {balance !== undefined && view.canTrade ? (
          <p className="text-xs text-muted">
            You have <span className="s-num text-text">{fmtUsdc(balance)} {sym}</span>
            {cfg.collateralIsTest ? " of practice money." : "."}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
