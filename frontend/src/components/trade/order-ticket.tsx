"use client";

import { forwardRef, useEffect, useId, useImperativeHandle, useMemo, useRef, useState } from "react";
import { keepPreviousData } from "@tanstack/react-query";
import { useConnect, useReadContract, useSwitchChain } from "wagmi";
import { useApp } from "@/components/providers";
import { ConfirmDialog, type ConfirmLine } from "@/components/trade/confirm-dialog";
import { CostBySize } from "@/components/trade/cost-by-size";
import { TrackedOrders } from "@/components/trade/tracked-orders";
import { TxStatus } from "@/components/tx-status";
import type { AccountData, PositionView } from "@/hooks/use-account-data";
import { useTradeContext } from "@/hooks/use-action-context";
import { useLocalStore } from "@/hooks/use-local-store";
import { useMarketData, type MarketPrice } from "@/hooks/use-market-data";
import { useTradingAccount } from "@/hooks/use-trading-account";
import { useTwaps } from "@/hooks/use-twap";
import { useTx } from "@/hooks/use-tx";
import { useWallet, type AccountView } from "@/hooks/use-wallet";
import { perpEngineAbi } from "@/lib/abi";
import { marketableTrigger, type OpenRequest } from "@/lib/actions";
import { UserFacingError } from "@/lib/errors";
import { closeFlow, openFlow, waitFor } from "@/lib/flows";
import { PRICE_DECIMALS, USDC_DECIMALS, fmtAge, fmtBps, fmtPercent, fmtPrice, fmtQty, fmtUsdc, numToPrice, parseAmount, toInputString } from "@/lib/format";
import { isExpired, isSettled, type Instrument } from "@/lib/instruments";
import { BPS, DIRECT_MAX_LEVERAGE, ONE, absDiff, baseFee, ceilDiv, ladderFill, ladderPrices, liquidationPrice, maxOpenFee, mergedPosition, needsKeeperOrders, notionalOf, pricePnl, profitCapPrice, ratio, unitsOf } from "@/lib/math";
import { valuePosition } from "@/lib/position";
import { prefs } from "@/lib/prefs";
import { MAX_SCALE_ORDERS, scaleFlow, splitLadder } from "@/lib/scale";
import { MAX_SLIPPAGE_BPS, tradeSettings } from "@/lib/storage";
import { TWAP_INTERVALS, TWAP_MAX_SLICES, TWAP_MIN_SLICES, fmtInterval, planTwap, sliceLeverage, twapDuration, twapFlow } from "@/lib/twap";

type OrderKind = "market" | "limit" | "stop";
type QtyMode = "notional" | "margin" | "contracts" | "risk";
type TpUnit = "price" | "pct" | "roe" | "r";
type SlUnit = "price" | "pct" | "roe";

export type TicketDraft = { isLong: boolean; limit: number | null; takeProfit: number | null; stopLoss: number | null };

export type TicketHandle = {
  setSide: (isLong: boolean) => void;
  setKind: (kind: OrderKind) => void;
  focusSize: () => void;
  submit: () => void;
  /** Receives a price picked on the chart. */
  setPrice: (target: "limit" | "tp" | "sl", price: number) => void;
  /** Closes the position in this market, through the confirmation step unless one-click trading is on. */
  close: () => void;
};

/** Good-til-time choices for resting orders (v3.2 engines). */
const EXPIRY_CHOICES = [
  { key: "gtc", label: "Cancelled", seconds: 0 },
  { key: "1h", label: "1 hour", seconds: 3_600 },
  { key: "1d", label: "1 day", seconds: 86_400 },
  { key: "1w", label: "1 week", seconds: 604_800 },
] as const;
type ExpiryKey = (typeof EXPIRY_CHOICES)[number]["key"];

/** Kept back when "Max" is used, so later execution fees stay covered. */
const SLIPPAGE_PRESETS = [10, 30, 100] as const;
const LEVERAGE_PRESETS = [2, 5, 10, 25, 50, 100, 250, 500, 1000] as const;
/** Slider steps; above 100x max leverage the slider is logarithmic so 1x-10x keeps its resolution. */
const SLIDER_STEPS = 1000;
const levToSlider = (lev: number, max: number) =>
  max <= 100 ? lev : Math.round((Math.log(Math.max(1, lev)) / Math.log(max)) * SLIDER_STEPS);
const sliderToLev = (pos: number, max: number) => (max <= 100 ? pos : Math.max(1, Math.round(Math.exp((pos / SLIDER_STEPS) * Math.log(max)))));

/** How far price must move against the position to liquidate it, as a risk level. */
const LEGACY_QUOTE_ABI = [
  {
    type: "function",
    name: "quoteOpenFee",
    stateMutability: "view",
    inputs: [
      { name: "marketId", type: "bytes32" },
      { name: "size", type: "uint256" },
      { name: "isLong", type: "bool" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

function riskLevel(distance: number | null): { label: string; tone: "calm" | "moderate" | "high" | "extreme"; filled: number } | null {
  if (distance === null) return null;
  if (distance >= 0.1) return { label: "Low", tone: "calm", filled: 1 };
  if (distance >= 0.03) return { label: "Moderate", tone: "moderate", filled: 2 };
  if (distance >= 0.01) return { label: "High", tone: "high", filled: 3 };
  return { label: "Extreme", tone: "extreme", filled: 4 };
}
/** In risk mode the stop must trigger well before liquidation: loss at the stop may use at most this share of the 90% threshold. */
const STOP_SAFETY = 0.8;

const QTY_MODES: { key: QtyMode; label: string; hint: string }[] = [
  { key: "notional", label: "Size", hint: "Position size in the collateral token (margin x leverage)" },
  { key: "margin", label: "Margin", hint: "Collateral you put up: the most this position can lose, plus fees. Size follows from leverage" },
  { key: "contracts", label: "Contracts", hint: "Units of the underlying; fractions are fine" },
  { key: "risk", label: "Risk", hint: "Choose how much you are willing to lose at your stop; size and leverage are computed" },
];

function Row({ label, value, hint, strong, tone }: { label: React.ReactNode; value: React.ReactNode; hint?: string; strong?: boolean; tone?: "long" | "short" | "warn" }) {
  const color = tone === "long" ? "text-long" : tone === "short" ? "text-short" : tone === "warn" ? "text-warn" : "text-text";
  return (
    <div className="flex items-baseline justify-between gap-3" title={hint}>
      <dt className={strong ? "text-text" : "text-muted"}>{label}</dt>
      <dd className={`num text-right ${strong ? "font-semibold" : ""} ${color}`}>{value}</dd>
    </div>
  );
}

function priceInput(value: bigint, dp: number): string {
  return toInputString(value, PRICE_DECIMALS, dp);
}

/** Visual strip placing liquidation, stop, entry and target on one axis. */
function TradeMap({ isLong, entry, liq, stop, target, dp }: { isLong: boolean; entry: bigint; liq: bigint | null; stop: bigint | null; target: bigint | null; dp: number }) {
  const points = [
    { key: "liq", label: "Liq", value: liq, cls: "bg-accent" },
    { key: "sl", label: "Stop", value: stop, cls: "bg-short" },
    { key: "entry", label: "Entry", value: entry, cls: "bg-text" },
    { key: "tp", label: "Target", value: target, cls: "bg-long" },
  ].filter((p): p is { key: string; label: string; value: bigint; cls: string } => p.value !== null && p.value > 0n);
  if (points.length < 2) return null;
  const values = points.map((p) => Number(p.value) / 1e18);
  const min = Math.min(...values);
  const max = Math.max(...values);
  const span = max - min || 1;
  const e = Number(entry) / 1e18;
  const entryPct = ((e - min) / span) * 100;
  return (
    <div
      className="trade-map"
      role="img"
      aria-label={`${isLong ? "Long" : "Short"} trade map: ${points.map((p) => `${p.label} ${fmtPrice(p.value, dp)}`).join(", ")}`}
    >
      <div className="trade-map-track">
        <span className="trade-map-loss" style={isLong ? { left: 0, width: `${entryPct}%` } : { left: `${entryPct}%`, right: 0 }} />
        <span className="trade-map-gain" style={isLong ? { left: `${entryPct}%`, right: 0 } : { left: 0, width: `${entryPct}%` }} />
        {points.map((p, i) => (
          <span key={p.key} className={`trade-map-tick ${p.cls}`} style={{ left: `${((values[i]! - min) / span) * 100}%` }} />
        ))}
      </div>
      <div className="relative mt-1 h-7 text-2xs">
        {points.map((p, i) => {
          const pct = ((values[i]! - min) / span) * 100;
          const align = pct < 12 ? "translate-x-0" : pct > 88 ? "-translate-x-full" : "-translate-x-1/2";
          return (
            <span key={p.key} className={`absolute top-0 flex flex-col leading-tight ${align} ${pct > 88 ? "items-end" : pct < 12 ? "items-start" : "items-center"}`} style={{ left: `${pct}%` }}>
              <span className="text-faint">{p.label}</span>
              <span className="num text-muted">{fmtPrice(p.value, dp)}</span>
            </span>
          );
        })}
      </div>
    </div>
  );
}

export const OrderTicket = forwardRef<
  TicketHandle,
  {
    instrument: Instrument;
    price: MarketPrice;
    account: AccountData | undefined;
    getAccount: () => AccountData | undefined;
    view: AccountView;
    position: PositionView | undefined;
    chainNow: number;
    onDraftChange: (draft: TicketDraft) => void;
    onPickRequest: (target: "limit" | "tp" | "sl") => void;
    onShowShortcuts: () => void;
    /** Called after an order or close went through (the phone layout closes the ticket sheet). */
    onSubmitted?: () => void;
    /** Set when the trader's own daily loss limit has been reached: new positions are refused with this text. */
    lossLimitReached?: string | null;
  }
>(function OrderTicket({ instrument, price, account, getAccount, view, position, chainNow, onDraftChange, onPickRequest, onShowShortcuts, onSubmitted, lossLimitReached }, ref) {
  const { config: cfg, chain } = useApp();
  const { params, error: paramsError } = useMarketData();
  const wallet = useWallet();
  const { connect, connectors, isPending: connecting } = useConnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const tx = useTx({ autoDismissMs: 12000 });
  const actionContext = useTradeContext();
  const trading = useTradingAccount();
  const ids = useId();
  const [settings, setSettings] = useLocalStore(tradeSettings);
  const [preferences] = useLocalStore(prefs);
  const sym = cfg.collateralSymbol;
  const dp = instrument.priceDecimals;
  const publisher = cfg.oracleMode === "publisher";

  const [kind, setKind] = useState<OrderKind>("market");
  const [isLong, setIsLong] = useState(true);
  // Risk first: you type the margin you are prepared to lose; leverage sets the exposure.
  const [qtyMode, setQtyMode] = useState<QtyMode>("margin");
  const [qtyText, setQtyText] = useState("");
  const [riskText, setRiskText] = useState("");
  const [riskUnit, setRiskUnit] = useState<"usdc" | "pct">("usdc");
  const [levX10, setLevX10] = useState(50);
  const [levText, setLevText] = useState("5");
  const [limitText, setLimitText] = useState("");
  const [expiryKey, setExpiryKey] = useState<ExpiryKey>("gtc");
  // Scale: a ladder of equal limit orders from the limit price to `scaleToText`.
  const [scaleOn, setScaleOn] = useState(false);
  const [scaleToText, setScaleToText] = useState("");
  const [scaleCountText, setScaleCountText] = useState("5");
  // TWAP: a market order split into equal slices, one every `twapInterval` seconds (the TwapOrders add-on).
  const [twapOn, setTwapOn] = useState(false);
  const [twapSlicesText, setTwapSlicesText] = useState("6");
  const [twapInterval, setTwapInterval] = useState<number>(60);
  const [tpText, setTpText] = useState("");
  const [tpUnit, setTpUnit] = useState<TpUnit>("price");
  const [slText, setSlText] = useState("");
  const [slUnit, setSlUnit] = useState<SlUnit>("price");
  const [bracketsOpen, setBracketsOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [slippageText, setSlippageText] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<null | "open" | "close" | "reverse">(null);
  const sizeInputRef = useRef<HTMLInputElement>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // The market's maximum, or the trader's own lower cap from Settings.
  const maxLeverage = preferences.maxLeverage !== null ? Math.max(1, Math.min(instrument.maxLeverage, preferences.maxLeverage)) : instrument.maxLeverage;
  const sideWord = isLong ? "long" : "short";
  const expired = isExpired(instrument, chainNow);
  const settled = isSettled(instrument);

  // Links such as "copy this trade" carry ?side=long|short&lev=N&margin=M: apply once, then drop them from the URL.
  useEffect(() => {
    const query = new URLSearchParams(window.location.search);
    const side = query.get("side");
    const lev = Number(query.get("lev"));
    const marginParam = query.get("margin");
    if (!side && !query.get("lev") && !marginParam) return;
    if (side === "long" || side === "short") setIsLong(side === "long");
    if (Number.isFinite(lev) && lev >= 1) {
      const x10 = Math.max(10, Math.min(maxLeverage * 10, Math.round(lev * 10)));
      setLevX10(x10);
      setLevText(String(x10 / 10));
    }
    if (marginParam && Number(marginParam) > 0) {
      setQtyMode("margin");
      setQtyText(marginParam);
    }
    for (const key of ["side", "lev", "margin"]) query.delete(key);
    const text = query.toString();
    window.history.replaceState(null, "", text ? `?${text}` : window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Keep leverage inside the market's range when switching markets.
  useEffect(() => {
    if (levX10 > maxLeverage * 10) {
      setLevX10(maxLeverage * 10);
      setLevText(String(maxLeverage));
    }
  }, [maxLeverage, levX10]);

  // ── Entry reference ──
  const reference = price.reference;
  // The limit price, or a stop order's trigger: both are typed in the same field.
  const limitPrice = parseAmount(limitText, PRICE_DECIMALS);
  // Upside (Turbo) markets fill at the mid; the others on the adverse side of the band.
  const upside = instrument.upside;
  const marketEntry = reference ? (upside ? reference.mid : isLong ? reference.ask : reference.bid) : null;
  const limitFillsNow = kind === "limit" && limitPrice && marketEntry ? (isLong ? marketEntry <= limitPrice : marketEntry >= limitPrice) : false;
  // A stop entry fills once a long's ask is at or above the trigger (a short's bid at or below it).
  const stopFillsNow = kind === "stop" && limitPrice && marketEntry ? (isLong ? marketEntry >= limitPrice : marketEntry <= limitPrice) : false;
  const fillsNow = limitFillsNow || stopFillsNow;

  // ── Scale (a ladder of limits) ──
  const scaling = kind === "limit" && scaleOn;
  const scaleTo = scaling ? parseAmount(scaleToText, PRICE_DECIMALS) : null;
  const scaleCount = Number(scaleCountText);
  const scaleCountError = scaling && !(Number.isInteger(scaleCount) && scaleCount >= 2 && scaleCount <= MAX_SCALE_ORDERS) ? `Between 2 and ${MAX_SCALE_ORDERS} orders` : null;
  const ladder = scaling && !scaleCountError && limitPrice && limitPrice > 0n && scaleTo && scaleTo > 0n ? ladderPrices(limitPrice, scaleTo, scaleCount) : null;
  // Equal notional per order: the entry they add up to if all fill (the engine's blend, rounded against the trader).
  const ladderEntry = ladder ? (ladderFill(ladder.map((p) => ({ price: p, size: 10n ** 12n, margin: 10n ** 11n })), isLong)?.entryPrice ?? null) : null;
  const ladderNow = ladder && marketEntry ? ladder.filter((p) => (isLong ? marketEntry <= p : marketEntry >= p)).length : 0;
  const ladderHigh = ladder ? ladder.reduce((a, b) => (b > a ? b : a)) : null;
  const ladderLow = ladder ? ladder.reduce((a, b) => (b < a ? b : a)) : null;

  const entry: bigint | null =
    ladderEntry ?? (kind === "market" ? marketEntry : limitPrice && limitPrice > 0n ? (fillsNow && marketEntry ? marketEntry : limitPrice) : null);
  /** Price the engine validates brackets against when the order is created. */
  const bracketRef: bigint | null =
    kind !== "market" ? (limitPrice && limitPrice > 0n ? limitPrice : null) : reference ? (publisher || upside ? marketableTrigger(reference, isLong, settings.slippageBps, upside) : marketEntry) : null;

  // ── Stop-loss (resolved first: risk sizing and R-multiples depend on it) ──
  const slRaw = slText.trim();
  const slNumber = slRaw === "" ? null : Number(slRaw);
  const slInvalidNumber = slRaw !== "" && !(slNumber !== null && Number.isFinite(slNumber) && slNumber > 0);
  const balance = account?.balance;

  const riskAmount = (() => {
    if (qtyMode !== "risk") return null;
    if (riskUnit === "usdc") return parseAmount(riskText, USDC_DECIMALS);
    const pct = parseAmount(riskText, 4);
    if (pct === null || balance === undefined) return null;
    return (balance * pct) / 1_000_000n;
  })();

  const stopFromDistance = (fraction: number): bigint | null => {
    if (!entry || !(fraction > 0)) return null;
    const scaled = BigInt(Math.round(fraction * 1e9));
    if (isLong) return scaled >= 1_000_000_000n ? null : (entry * (1_000_000_000n - scaled)) / 1_000_000_000n;
    return (entry * (1_000_000_000n + scaled)) / 1_000_000_000n;
  };

  // In risk mode leverage depends on the stop, so a stop given as ROE (which depends on leverage) is not offered.
  const effectiveSlUnit: SlUnit = qtyMode === "risk" && slUnit === "roe" ? "pct" : slUnit;
  const stopNoLeverage: bigint | null =
    slRaw === "" || slInvalidNumber || slNumber === null
      ? null
      : effectiveSlUnit === "price"
        ? parseAmount(slRaw, PRICE_DECIMALS)
        : effectiveSlUnit === "pct"
          ? stopFromDistance(slNumber / 100)
          : null;

  // ── Size, margin, leverage ──
  const userLevX10 = levX10;
  let size: bigint | null = null;
  let margin: bigint | null = null;
  let effLevX10 = userLevX10;
  let riskNote: string | null = null;
  let riskError: string | null = null;

  if (qtyMode === "risk") {
    if (riskAmount !== null && riskAmount > 0n && entry && stopNoLeverage && params) {
      const distance = (absDiff(entry, stopNoLeverage) * ONE) / entry;
      const feeShare = params.baseFeeBps * 2n * 10n ** 14n;
      if (distance > 0n) {
        size = (riskAmount * ONE) / (distance + feeShare);
        const safeX10 = Number((BigInt(Math.round(STOP_SAFETY * 9_000)) * ONE) / (distance * 1_000n));
        effLevX10 = Math.max(10, Math.min(userLevX10, safeX10, maxLeverage * 10));
        if (effLevX10 < userLevX10) {
          riskNote =
            safeX10 < maxLeverage * 10
              ? `Leverage held at ${(effLevX10 / 10).toFixed(1)}x so the stop triggers before liquidation.`
              : null;
        }
        margin = ceilDiv(size * 10n, BigInt(effLevX10));
        if (margin < params.minMargin) {
          margin = params.minMargin;
          if (size < margin) riskError = `That risk gives a position below the ${fmtUsdc(params.minMargin)} ${sym} minimum. Risk more or tighten the stop.`;
          else effLevX10 = Math.max(10, Number((size * 10n) / margin));
        }
      }
    }
  } else {
    const qty = qtyMode === "contracts" ? parseAmount(qtyText, 18) : parseAmount(qtyText, USDC_DECIMALS);
    if (qty !== null) {
      if (qtyMode === "margin") {
        margin = qty;
        size = (qty * BigInt(userLevX10)) / 10n;
      } else {
        size = qtyMode === "notional" ? qty : entry ? notionalOf(qty, entry) : null;
        margin = size !== null ? ceilDiv(size * 10n, BigInt(userLevX10)) : null;
      }
    }
  }
  const leverage = effLevX10 / 10;
  const units = size !== null && entry ? unitsOf(size, entry) : null;
  const scalePlan = ladder && size !== null && margin !== null ? splitLadder(ladder, margin, size) : null;

  // ── TWAP ──
  const twapSupported = cfg.twapOrders !== null;
  const twapping = kind === "market" && twapOn && twapSupported;
  const twapSlices = Number(twapSlicesText);
  const twapSlicesError =
    twapping && !(Number.isInteger(twapSlices) && twapSlices >= TWAP_MIN_SLICES && twapSlices <= TWAP_MAX_SLICES) ? `Between ${TWAP_MIN_SLICES} and ${TWAP_MAX_SLICES} slices` : null;
  const twapPlan =
    twapping && !twapSlicesError && size !== null && margin !== null && size > 0n ? planTwap(margin, size, twapSlices, twapInterval, settings.slippageBps) : null;
  const twapState = useTwaps(view.instant ? view.address : undefined, twapSupported ? [instrument.id] : []);
  const runningTwap = twapState.twaps.get(instrument.id);
  // The wallet confirms once when the account's approval for the TWAP contract does not cover this plan.
  const twapNeedsApproval = (() => {
    if (!twapPlan) return false;
    const a = twapState.approval;
    if (!a) return true;
    const until = Math.floor(Date.now() / 1000) + twapDuration(twapPlan) + 3_600;
    return a.expiry < until || a.maxLeverage < sliceLeverage(twapPlan) || a.maxMargin < twapPlan.sliceMargin;
  })();

  // ── Brackets ──
  const stopLoss: bigint | null =
    slRaw === ""
      ? 0n
      : effectiveSlUnit === "roe"
        ? slInvalidNumber || slNumber === null
          ? null
          : stopFromDistance(slNumber / 100 / leverage)
        : stopNoLeverage;

  const tpRaw = tpText.trim();
  const tpNumber = tpRaw === "" ? null : Number(tpRaw);
  const tpInvalidNumber = tpRaw !== "" && !(tpNumber !== null && Number.isFinite(tpNumber) && tpNumber > 0);
  const takeProfit: bigint | null = (() => {
    if (tpRaw === "") return 0n;
    if (tpInvalidNumber || tpNumber === null) return null;
    if (tpUnit === "price") return parseAmount(tpRaw, PRICE_DECIMALS);
    if (!entry) return null;
    let fraction: number;
    if (tpUnit === "pct") fraction = tpNumber / 100;
    else if (tpUnit === "roe") fraction = tpNumber / 100 / leverage;
    else {
      if (!stopLoss) return null;
      fraction = tpNumber * ratio(absDiff(entry, stopLoss), entry);
    }
    const scaled = BigInt(Math.round(fraction * 1e9));
    if (isLong) return (entry * (1_000_000_000n + scaled)) / 1_000_000_000n;
    return scaled >= 1_000_000_000n ? null : (entry * (1_000_000_000n - scaled)) / 1_000_000_000n;
  })();
  // TWAP slices carry no brackets (the TP/SL fields are cleared and hidden while it is on).
  const brackets = twapping ? 0 : (takeProfit ? 1 : 0) + (stopLoss ? 1 : 0);

  // ── Fees and totals ──
  const feeQuote = useReadContract({
    abi: perpEngineAbi,
    address: cfg.perpEngine,
    chainId: cfg.chainId,
    functionName: "quoteOpenFee",
    args: [instrument.id, size ?? 0n, isLong, margin ?? 0n],
    query: { enabled: size !== null && size > 0n && margin !== null && margin > 0n, refetchInterval: 3_000, placeholderData: keepPreviousData },
  });
  // Engines deployed before v3 take quoteOpenFee(marketId, size, isLong), without the margin.
  const legacyFeeQuote = useReadContract({
    abi: LEGACY_QUOTE_ABI,
    address: cfg.perpEngine,
    chainId: cfg.chainId,
    functionName: "quoteOpenFee",
    args: [instrument.id, size ?? 0n, isLong],
    query: { enabled: feeQuote.isError && size !== null && size > 0n, refetchInterval: 3_000, placeholderData: keepPreviousData },
  });
  const highLeverage = size !== null && margin !== null && margin > 0n && needsKeeperOrders(size, margin);
  // Upside markets trade through keeper orders only.
  const keeperOrder = kind !== "market" || publisher || highLeverage || upside;
  // Upside markets charge no fee at open or close: the house keeps a share of a winning close's profit instead.
  const feeCeiling = upside ? 0n : params && size !== null && margin !== null ? maxOpenFee(size, params.baseFeeBps, params.maxSkewFeeBps, margin) : null;
  const feeBase = upside ? 0n : params && size !== null && margin !== null ? baseFee(size, params.baseFeeBps, margin) : null;
  const openFee = size !== null && size > 0n ? (upside ? 0n : (feeQuote.data ?? legacyFeeQuote.data ?? null)) : null;
  const profitShareBps = upside ? (params?.profitShareBps ?? 2_000n) : 0n;
  const skewFee = openFee !== null && feeBase !== null && openFee > feeBase ? openFee - feeBase : 0n;
  // A ladder escrows every order's fees; fills after the first move the brackets and refund theirs.
  const executionCount = twapPlan ? twapPlan.slices : (brackets + (keeperOrder ? 1 : 0)) * (scalePlan ? scalePlan.length : 1);
  const executionFees = params ? params.executionFee * BigInt(executionCount) : null;
  /** What the engine pulls now. Keeper orders escrow the fee ceiling and refund the difference on fill. */
  const escrowFor = (sizeOf: bigint, marginOf: bigint) => (upside || !params ? 0n : maxOpenFee(sizeOf, params.baseFeeBps, params.maxSkewFeeBps, marginOf));
  const required =
    twapPlan && params
      ? BigInt(twapPlan.slices) * (twapPlan.sliceMargin + escrowFor(twapPlan.sliceSize, twapPlan.sliceMargin) + params.executionFee)
      : scalePlan && params && executionFees !== null
      ? scalePlan.reduce((sum, o) => sum + o.margin + escrowFor(o.size, o.margin), 0n) + executionFees
      : margin !== null && feeCeiling !== null && executionFees !== null
        ? margin + feeCeiling + executionFees
        : null;
  const expectedCost = margin !== null && openFee !== null && executionFees !== null ? margin + openFee + executionFees : null;

  const liq = entry && margin !== null && size !== null && size > 0n ? liquidationPrice(entry, margin, size, isLong) : null;
  const capPrice = entry && margin !== null && size !== null && size > 0n && params ? profitCapPrice(entry, margin, size, isLong, params.maxProfitMultiple) : null;
  const maxProfit = margin !== null && params ? margin * params.maxProfitMultiple : null;
  /** In an Upside market, what a win at the cap pays after the house's share. */
  const maxProfitNet = maxProfit !== null && upside ? maxProfit - (maxProfit * profitShareBps) / BPS : maxProfit;
  const closeFeeEst = feeBase;
  const tpPnl = entry && takeProfit && size ? pricePnl(size, entry, takeProfit, isLong) : null;
  const slPnl = entry && stopLoss && size ? pricePnl(size, entry, stopLoss, isLong) : null;
  const tpCapped = tpPnl !== null && maxProfit !== null && tpPnl > maxProfit;
  const fundingPerHour = size !== null ? (size * instrument.fundingRate * 3_600n) / ONE : null;
  const fundingForSide = fundingPerHour === null ? null : isLong ? fundingPerHour : -fundingPerHour;
  /** The most this trade can cost: the whole margin (liquidation) plus open, close and execution fees. */
  const maxLoss = margin !== null && openFee !== null && executionFees !== null ? margin + openFee + executionFees + (closeFeeEst ?? 0n) : null;
  const liqDistance = entry && liq !== null ? (liq === 0n ? (isLong ? null : 0) : ratio(absDiff(entry, liq), entry)) : null;
  const level = riskLevel(liqDistance);
  const capDistance = entry && capPrice ? ratio(absDiff(entry, capPrice), entry) : null;

  // ── Field validation ──
  const qtyError = (() => {
    if (qtyMode === "risk") {
      if (riskText.trim() === "") return null;
      if (riskAmount === null) return riskUnit === "pct" && balance === undefined ? "Connect a wallet to size by % of balance" : "Enter a number";
      if (riskAmount === 0n) return "Enter an amount greater than zero";
      if (slRaw === "") return "Risk sizing needs a stop-loss below";
      return riskError;
    }
    if (qtyText.trim() === "") return null;
    if (size === null || margin === null) return qtyMode === "contracts" && !entry ? "Waiting for a price to convert contracts" : "Enter a number, for example 250";
    if (params && margin < params.minMargin) {
      return qtyMode === "margin"
        ? `Minimum margin is ${fmtUsdc(params.minMargin)} ${sym}`
        : `Too small: at ${leverage}x this needs ${fmtUsdc(margin)} ${sym} margin, the minimum is ${fmtUsdc(params.minMargin)}`;
    }
    return null;
  })();

  const levError =
    levX10 < 10
      ? "Leverage starts at 1x"
      : levX10 > maxLeverage * 10
        ? maxLeverage < instrument.maxLeverage
          ? `Your own cap is ${maxLeverage}x (Settings)`
          : `${instrument.symbol} allows up to ${maxLeverage}x`
        : null;
  const limitError = kind === "market" || limitText.trim() === "" ? null : !limitPrice ? "Enter a price greater than zero" : null;
  // Order expiry needs a v3.2 engine (which also has the Upside profit share).
  const expirySupported = params?.profitShareBps !== null && params?.profitShareBps !== undefined;
  const expirySeconds = EXPIRY_CHOICES.find((c) => c.key === expiryKey)?.seconds ?? 0;
  const expiresAt = kind !== "market" && expirySupported && expirySeconds > 0 ? chainNow + expirySeconds : undefined;

  // The engine checks each order's brackets against its own price: with a ladder, against every rung.
  const tpRef = ladder ? (isLong ? ladderHigh : ladderLow) : bracketRef;
  const slRef = ladder ? (isLong ? ladderLow : ladderHigh) : bracketRef;
  const refLabel =
    ladder
      ? "every price of the ladder"
      : kind === "limit"
      ? "your limit price"
      : kind === "stop"
        ? "your stop price"
      : publisher
        ? `${fmtPrice(bracketRef ?? 0n, dp)} (the ${isLong ? "ask" : "bid"} plus your ${(settings.slippageBps / 100).toFixed(2)}% slippage allowance, where the order rests)`
        : `the current ${isLong ? "ask" : "bid"}`;
  const tpError =
    tpRaw === ""
      ? null
      : tpInvalidNumber
        ? "Enter a positive number"
        : tpUnit === "r" && !stopLoss
          ? "An R-multiple needs a stop-loss: 1R is the distance to your stop"
          : takeProfit === null || takeProfit === 0n
            ? "That target is out of range"
            : tpRef && (isLong ? takeProfit <= tpRef : takeProfit >= tpRef)
              ? `Take-profit must be ${isLong ? "above" : "below"} ${refLabel}`
              : null;
  const slError =
    slRaw === ""
      ? null
      : slInvalidNumber
        ? "Enter a positive number"
        : stopLoss === null || stopLoss === 0n
          ? "That stop is out of range"
          : slRef && (isLong ? stopLoss >= slRef : stopLoss <= slRef)
            ? `Stop-loss must be ${isLong ? "below" : "above"} ${ladder ? "every price of the ladder" : kind === "limit" ? "your limit price" : kind === "stop" ? "your stop price" : `the ${isLong ? "ask" : "bid"}`}`
            : entry && (isLong ? stopLoss >= entry : stopLoss <= entry)
              ? `Stop-loss must be ${isLong ? "below" : "above"} the entry price`
              : null;
  const slBeyondLiq = !slError && stopLoss && liq !== null && liq > 0n ? (isLong ? stopLoss <= liq : stopLoss >= liq) : false;

  const capProblem = (() => {
    if (!params || size === null) return null;
    const sideOi = isLong ? instrument.longOi : instrument.shortOi;
    if (sideOi + size > instrument.maxOiPerSide) {
      const room = instrument.maxOiPerSide > sideOi ? instrument.maxOiPerSide - sideOi : 0n;
      return `Only ${fmtUsdc(room)} ${sym} of ${sideWord} open interest is left in this market`;
    }
    if ((params.totalOpenInterest + size) * BPS > params.vaultNav * params.maxOiToNavBps) {
      const cap = (params.vaultNav * params.maxOiToNavBps) / BPS;
      const room = cap > params.totalOpenInterest ? cap - params.totalOpenInterest : 0n;
      return `The house vault can back only ${fmtUsdc(room)} ${sym} more open interest`;
    }
    return null;
  })();

  // One position per market: an open on the side held adds to it (v3.1); the other side cannot fill while it is open.
  const sameSide = position ? position.position.isLong === isLong : false;
  const oppositeSide = position ? position.position.isLong !== isLong : false;
  const restingOpposite = account?.orders.find(
    (o) => (o.order.orderType === 0 || o.order.orderType === 4) && o.order.priceId.toLowerCase() === instrument.id && o.order.isLong !== isLong,
  );
  const merged =
    sameSide && position && entry && size !== null && margin !== null && size > 0n ? mergedPosition(position.position, size, margin, entry) : null;
  const mergedLiq = merged ? liquidationPrice(merged.entryPrice, merged.margin, merged.size, isLong, position?.fundingOwed ?? 0n) : null;
  const mergedLiqDistance = merged && mergedLiq !== null && mergedLiq > 0n && price.mark ? ratio(absDiff(price.mark, mergedLiq), price.mark) : null;

  const blocking: string | null = (() => {
    if (view.watching) return "Watching: trading is off";
    if (lossLimitReached && (!position || sameSide)) return lossLimitReached;
    if (paramsError) return "Could not read the engine. Check the RPC";
    if (!params) return "Loading market";
    if (params.paused) return "Trading is paused";
    if (settled) return "This future has settled";
    if (expired) return "This future has expired";
    if (!instrument.enabled) return `${instrument.symbol} is closed to new positions`;
    if (kind === "market" && !reference) return "Waiting for a price";
    if (kind === "market" && !publisher && price.status !== "live") return "Market closed: the price is stale";
    if (qtyMode === "risk" ? riskText.trim() === "" : qtyText.trim() === "") return qtyMode === "risk" ? "Enter how much to risk" : "Enter a size";
    if (kind === "limit" && limitText.trim() === "") return "Enter a limit price";
    if (kind === "stop" && limitText.trim() === "") return "Enter a stop price";
    if (limitError) return limitError;
    if (scaling && scaleCountError) return scaleCountError;
    if (scaling && scaleToText.trim() === "") return "Enter the last price of the ladder";
    if (scaling && !ladder) return "Enter a last price greater than zero";
    if (qtyError) return qtyError;
    if (size === null || margin === null) return qtyMode === "risk" ? "Enter a stop-loss to size by risk" : "Enter a size";
    if (levError) return levError;
    if (size < margin) return "Size cannot be smaller than margin";
    if (tpError) return tpError;
    if (slError) return slError;
    if (twapping) {
      if (!view.instant) return "TWAP runs from your trading account: turn on instant trading";
      if (twapSlicesError) return twapSlicesError;
      if (twapPlan && params && twapPlan.sliceMargin < params.minMargin) return `Each slice needs ${fmtUsdc(params.minMargin)} ${sym} margin: fewer slices or more margin`;
      if (twapPlan && trading.policy && twapPlan.sliceMargin > trading.policy.maxMargin) {
        return `Each slice is over your instant-trading limit of ${fmtUsdc(trading.policy.maxMargin)} ${sym}: use more slices`;
      }
      if (twapPlan && trading.policy && sliceLeverage(twapPlan) > trading.policy.maxLeverage) return `Over your instant-trading limit of ${trading.policy.maxLeverage}x`;
      if (twapNeedsApproval && !trading.ownerConnected) return "Connect the wallet that owns your trading account: it allows TWAP orders once";
    }
    if (oppositeSide && kind === "market") return `You hold a ${position!.position.isLong ? "long" : "short"}: close it or reverse`;
    if (capProblem) return capProblem;
    if (scalePlan && params && scalePlan.some((o) => o.margin < params.minMargin)) {
      return `Each order needs ${fmtUsdc(params.minMargin)} ${sym} margin: fewer orders or more margin`;
    }
    if (balance !== undefined && required !== null && required > balance) {
      return twapPlan ? `Not enough ${sym} for all ${twapPlan.slices} slices: ${fmtUsdc(required)} needed` : `Not enough ${sym}: ${fmtUsdc(required)} needed`;
    }
    if (view.canTrade && balance === undefined) return "Loading balance";
    return null;
  })();

  // ── Chart draft lines ──
  const draftLimit = kind !== "market" && limitPrice ? Number(limitPrice) / 1e18 : null;
  const draftTp = takeProfit && !tpError ? Number(takeProfit) / 1e18 : null;
  const draftSl = stopLoss && !slError ? Number(stopLoss) / 1e18 : null;
  useEffect(() => {
    onDraftChange({ isLong, limit: draftLimit, takeProfit: draftTp, stopLoss: draftSl });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLong, draftLimit, draftTp, draftSl]);

  // ── Helpers ──
  const changeQtyMode = (next: QtyMode) => {
    if (next === qtyMode) return;
    // Carry the current quantity over so switching units never changes the order.
    if (next !== "risk") {
      if (size !== null && size > 0n && margin !== null) {
        if (next === "notional") setQtyText(toInputString(size, USDC_DECIMALS, 2));
        else if (next === "margin") setQtyText(toInputString(margin, USDC_DECIMALS, 2));
        else if (units !== null) setQtyText(toInputString(units, 18, 6));
      } else setQtyText("");
      if (qtyMode === "risk") {
        setLevX10(effLevX10);
        setLevText(String(effLevX10 / 10));
      }
    }
    setQtyMode(next);
  };

  const setLeverage = (x10: number) => {
    const clamped = Math.max(10, Math.min(maxLeverage * 10, Math.round(x10)));
    setLevX10(clamped);
    setLevText(String(clamped / 10));
  };

  const setMax = () => {
    if (balance === undefined || !params) return;
    const fees = params.executionFee * BigInt(executionCount || 1);
    const spendable = balance > fees ? balance - fees : 0n;
    // margin + margin x leverage x feeBps / 1e4 <= spendable
    const feeBps = params.baseFeeBps + params.maxSkewFeeBps;
    const maxMargin = (spendable * 10n * BPS) / (10n * BPS + BigInt(levX10) * feeBps);
    const safe = maxMargin > 2n ? maxMargin - 2n : 0n;
    const maxSize = (safe * BigInt(levX10)) / 10n;
    if (qtyMode === "margin") setQtyText(toInputString(safe, USDC_DECIMALS, 2));
    else if (qtyMode === "contracts" && entry) setQtyText(toInputString(unitsOf(maxSize, entry), 18, 6));
    else {
      if (qtyMode !== "notional") setQtyMode("notional");
      setQtyText(toInputString(maxSize, USDC_DECIMALS, 2));
    }
  };

  const commitSlippage = () => {
    if (slippageText === null) return;
    const percent = parseAmount(slippageText, 2);
    if (percent !== null) {
      const bps = Number(percent);
      if (bps >= 0 && bps <= MAX_SLIPPAGE_BPS) setSettings((s) => ({ ...s, slippageBps: bps }));
    }
    setSlippageText(null);
  };

  // ── Actions ──
  const buildRequest = (): OpenRequest | null => {
    if (blocking || margin === null || size === null || required === null || takeProfit === null || stopLoss === null) return null;
    return {
      instrument,
      isLong,
      margin,
      size,
      type: kind,
      limitPrice: limitPrice ?? 0n,
      reference,
      slippageBps: settings.slippageBps,
      takeProfit,
      stopLoss,
      required,
      ...(expiresAt ? { expiresAt } : {}),
    };
  };

  const runOpen = async () => {
    const req = buildRequest();
    if (!req) return;
    const plan = scalePlan;
    const twap = twapPlan;
    const ok = await tx.run(async (api) => {
      const ctx = actionContext(api);
      if (!ctx) throw new UserFacingError("Connect your wallet first.");
      if (twap) {
        const result = await twapFlow(ctx, { instrument, isLong, plan: twap, owner: trading.ownerConnected ? wallet.address : undefined, session: trading.policy });
        twapState.refetch();
        return result;
      }
      if (plan) return scaleFlow(ctx, { instrument, isLong, orders: plan, takeProfit: req.takeProfit, stopLoss: req.stopLoss, required: req.required });
      return openFlow(ctx, req);
    });
    if (ok) {
      setTpText("");
      setSlText("");
      if (kind !== "market") setLimitText("");
      if (plan) setScaleToText("");
      onSubmitted?.();
    }
  };

  const runClose = () => {
    if (!position || !params) return;
    void tx.run(async (api) => {
      const ctx = actionContext(api);
      if (!ctx) throw new UserFacingError("Connect your wallet first.");
      return closeFlow(ctx, { instrument, view: position, reference, slippageBps: settings.slippageBps, executionFee: params.executionFee, balance });
    });
  };

  /** Close, wait for the keeper, then open the same size on the other side. Two orders, two confirmations. */
  const runReverse = () => {
    if (!position || !params) return;
    const pos = position.position;
    void tx.run(async (api) => {
      const ctx = actionContext(api);
      if (!ctx) throw new UserFacingError("Connect your wallet first.");
      await closeFlow(ctx, { instrument, view: position, reference, slippageBps: settings.slippageBps, executionFee: params.executionFee });
      api.preparing("Waiting for the keeper to close the position");
      await waitFor(
        () => {
          const latest = getAccount();
          return latest !== undefined && !latest.positions.some((p) => p.position.priceId.toLowerCase() === instrument.id);
        },
        60_000,
        "The close order has not been executed yet. It is still resting; open the opposite side once it fills.",
      );
      const feeBudget = upside ? 0n : maxOpenFee(pos.size, params.baseFeeBps, params.maxSkewFeeBps, pos.margin);
      return openFlow(ctx, {
        instrument,
        isLong: !pos.isLong,
        margin: pos.margin,
        size: pos.size,
        type: "market",
        limitPrice: 0n,
        reference: getReference(),
        slippageBps: settings.slippageBps,
        takeProfit: 0n,
        stopLoss: 0n,
        required: pos.margin + feeBudget + (publisher || upside ? params.executionFee : 0n),
      });
    });
  };
  const referenceRef = useRef(reference);
  referenceRef.current = reference;
  const getReference = () => referenceRef.current;

  const requestOpen = () => {
    if (blocking || tx.busy || !view.canTrade) return;
    // One-click never applies above 100x: the confirmation shows how small a move liquidates.
    if (settings.oneClick && !highLeverage) void runOpen();
    else setConfirming("open");
  };

  useImperativeHandle(ref, () => ({
    setSide: (long) => setIsLong(long),
    setKind: (k) => setKind(k),
    focusSize: () => {
      sizeInputRef.current?.focus();
      sizeInputRef.current?.select();
    },
    submit: () => requestOpen(),
    close: () => {
      if (!position || !view.canTrade || tx.busy) return;
      if (settings.oneClick || settled) runClose();
      else setConfirming("close");
    },
    setPrice: (target, value) => {
      const text = priceInput(numToPrice(value), dp);
      if (target === "limit") {
        setKind("limit");
        setLimitText(text);
      } else if (target === "tp") {
        setTwapOn(false);
        setBracketsOpen(true);
        setTpUnit("price");
        setTpText(text);
      } else {
        setTwapOn(false);
        setBracketsOpen(true);
        setSlUnit("price");
        setSlText(text);
      }
    },
  }));

  // ── Confirmation content ──
  const confirmLines: ConfirmLine[] = useMemo(() => {
    if (confirming === "open") {
      return [
        { label: "Order", value: `${twapPlan ? "TWAP" : kind === "market" ? (publisher ? "Market (keeper-filled)" : "Market") : kind === "stop" ? "Stop entry" : scalePlan ? `${scalePlan.length} limits,` : "Limit"} ${sideWord} ${instrument.symbol}` },
        ...(twapPlan
          ? [
              {
                label: "Slices",
                value: `${twapPlan.slices} of ${fmtUsdc(twapPlan.sliceSize)} ${sym} (${fmtUsdc(twapPlan.sliceMargin)} margin), one every ${fmtInterval(twapPlan.interval)}, about ${fmtInterval(Math.max(twapPlan.interval, twapDuration(twapPlan)))} in all`,
              },
              { label: "Worst fill per slice", value: `${(twapPlan.slippageBps / 100).toFixed(2)}% past the ${isLong ? "ask" : "bid"} when it is placed` },
              ...(runningTwap ? [{ label: "Replaces", value: `the running TWAP (${runningTwap.done} of ${runningTwap.slices} slices placed)` }] : []),
            ]
          : []),
        ...(scalePlan
          ? [
              {
                label: "Ladder",
                value: `${fmtPrice(scalePlan[0]!.price, dp)} to ${fmtPrice(scalePlan[scalePlan.length - 1]!.price, dp)}, ${fmtUsdc(scalePlan[0]!.margin)} ${sym} margin each${view.instant ? ", one transaction" : `, ${scalePlan.length} wallet confirmations`}`,
              },
            ]
          : []),
        ...(merged ? [{ label: "Adds to your position", value: `${fmtUsdc(position!.position.size)} → ${fmtUsdc(merged.size)} ${sym}, average entry ${fmtPrice(merged.entryPrice, dp)}` }] : []),
        { label: "Size", value: size !== null ? `${fmtUsdc(size)} ${sym}${units !== null ? ` (${fmtQty(units)} ${instrument.unitLabel})` : ""}` : "—" },
        { label: "Margin and leverage", value: margin !== null ? `${fmtUsdc(margin)} ${sym} at ${leverage.toFixed(1)}x` : "—" },
        { label: scalePlan ? "Average entry if all fill" : kind === "limit" ? "Limit price" : kind === "stop" ? "Stop price" : "Entry estimate", value: entry ? fmtPrice(entry, dp) : "—" },
        ...(kind === "market" && publisher && bracketRef ? [{ label: "Worst fill accepted", value: fmtPrice(bracketRef, dp) }] : []),
        merged
          ? { label: "Liquidation price after", value: mergedLiq === null ? "—" : mergedLiq === 0n ? "None" : `${fmtPrice(mergedLiq, dp)}${mergedLiqDistance !== null ? ` (${fmtPercent(mergedLiqDistance, mergedLiqDistance < 0.01 ? 2 : 1)} from the mark)` : ""}` }
          : { label: "Liquidation price", value: liq === null ? "—" : liq === 0n ? "None" : `${fmtPrice(liq, dp)}${liqDistance !== null ? ` (${fmtPercent(liqDistance, liqDistance < 0.01 ? 2 : 1)} move)` : ""}` },
        { label: "Most you can lose", value: maxLoss !== null ? `${fmtUsdc(maxLoss)} ${sym}` : "—" },
        ...(takeProfit ? [{ label: "Take-profit", value: fmtPrice(takeProfit, dp) }] : []),
        ...(stopLoss ? [{ label: "Stop-loss", value: fmtPrice(stopLoss, dp) }] : []),
        { label: twapPlan ? "Drawn from your trading account, slice by slice" : view.instant ? "Taken from your trading account now" : "Taken from your wallet now", value: required !== null ? `${fmtUsdc(required)} ${sym}` : "—" },
      ];
    }
    return [];
  }, [confirming, kind, publisher, sideWord, instrument.symbol, instrument.unitLabel, size, units, margin, leverage, entry, bracketRef, liq, liqDistance, maxLoss, takeProfit, stopLoss, required, sym, dp, view.instant, merged, mergedLiq, mergedLiqDistance, position, scalePlan, twapPlan, runningTwap, isLong]);

  // ── Primary button ──
  let button: React.ReactNode;
  if (view.watching) {
    button = (
      <button type="button" className="btn btn-lg" disabled>
        Watching: trading is off
      </button>
    );
  } else if (!view.instant && !wallet.connected) {
    const connector = connectors[0];
    button = (
      <button type="button" className="btn btn-primary btn-lg" disabled={connecting || !connector} onClick={() => connector && connect({ connector, chainId: chain.id })}>
        {connecting ? "Connecting" : "Connect wallet to trade"}
      </button>
    );
  } else if (!view.instant && wallet.wrongNetwork) {
    button = (
      <button type="button" className="btn btn-lg border-warn text-warn" disabled={switching} onClick={() => switchChain({ chainId: chain.id })}>
        Switch to {chain.name}
      </button>
    );
  } else {
    const action = twapping
      ? `Start TWAP ${sideWord}${twapPlan ? `: ${twapPlan.slices} slices` : ""}`
      : kind === "limit"
        ? scalePlan
          ? `Place ${scalePlan.length} limit ${sideWord}s`
          : `Place limit ${sideWord}`
        : kind === "stop"
          ? `Place stop ${sideWord}`
          : sameSide
            ? `Add to ${sideWord}`
            : `${isLong ? "Buy / Long" : "Sell / Short"} ${instrument.symbol}`;
    button = (
      <button
        type="submit"
        className={`btn btn-lg ${blocking ? "" : isLong ? "btn-long" : "btn-short"}`}
        disabled={blocking !== null || tx.busy}
        data-testid="ticket-submit"
      >
        {tx.busy ? <span className="spinner" aria-hidden="true" /> : null}
        <span className="truncate">{tx.busy ? "Working" : (blocking ?? action)}</span>
      </button>
    );
  }

  const showBrackets = bracketsOpen || qtyMode === "risk" || tpRaw !== "" || slRaw !== "";
  const positionValue = position && params ? valuePosition(position, price.mark, params.maxProfitMultiple) : null;
  const slippagePct = (settings.slippageBps / 100).toFixed(2);
  const qtyUnit = qtyMode === "contracts" ? instrument.unitLabel : sym;
  const contractsHint =
    instrument.quote === "USD"
      ? `Units of ${instrument.base}; fractions are fine`
      : `Positions are ${sym} notional even on a cross: one contract gains or loses 1 ${sym} for every 1.0 move in ${instrument.base}/${instrument.quote}`;
  const awaiting = publisher && price.status === "awaiting";

  return (
    <section className="panel" aria-label={`Order ticket for ${instrument.symbol}`}>
      <div className="flex items-center justify-between border-b border-line pr-2">
        <div role="tablist" aria-label="Order type" className="tabs border-b-0">
          {(["market", "limit", "stop"] as const).map((k) => (
            <button key={k} type="button" role="tab" aria-selected={kind === k} className="tab" onClick={() => setKind(k)} data-testid={`kind-${k}`}>
              {k === "market" ? "Market" : k === "limit" ? "Limit" : "Stop"}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1">
          <button type="button" className="chip" aria-expanded={settingsOpen} onClick={() => setSettingsOpen((v) => !v)}>
            Settings
          </button>
          <button type="button" className="chip" aria-label="Keyboard shortcuts" title="Keyboard shortcuts (?)" onClick={onShowShortcuts}>
            ?
          </button>
        </div>
      </div>

      {settingsOpen ? (
        <div className="space-y-3 border-b border-line bg-bg/40 px-3 py-3 text-[0.8125rem]">
          <div>
            <div className="flex items-center justify-between">
              <span className="text-muted">Slippage tolerance</span>
              <span className="num">{slippagePct}%</span>
            </div>
            <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
              {SLIPPAGE_PRESETS.map((bps) => (
                <button key={bps} type="button" className="chip" aria-pressed={settings.slippageBps === bps} onClick={() => { setSettings((s) => ({ ...s, slippageBps: bps })); setSlippageText(null); }}>
                  {(bps / 100).toFixed(1)}%
                </button>
              ))}
              <label className="flex items-center gap-1 text-xs text-muted">
                Custom
                <input
                  className="mini-input num w-14"
                  inputMode="decimal"
                  aria-label="Custom slippage in percent"
                  value={slippageText ?? slippagePct}
                  onChange={(event) => setSlippageText(event.target.value)}
                  onBlur={commitSlippage}
                  onKeyDown={(event) => {
                    if (event.key === "Enter") {
                      event.preventDefault();
                      commitSlippage();
                    }
                  }}
                />
                %
              </label>
            </div>
            <p className="mt-1.5 text-xs text-faint">
              How far past the current price a market order may fill. A keeper-filled market order rests at this bound, so a wider one fills
              more reliably in a fast market.
            </p>
          </div>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="check mt-0.5" checked={settings.oneClick} onChange={(event) => setSettings((s) => ({ ...s, oneClick: event.target.checked }))} />
            <span>
              <span className="text-text">One-click trading</span>
              <span className="block text-xs text-faint">Skip the confirmation step. Your wallet still asks you to sign.</span>
            </span>
          </label>
          <label className="flex items-start gap-2">
            <input type="checkbox" className="check mt-0.5" checked={settings.approveUnlimited} onChange={(event) => setSettings((s) => ({ ...s, approveUnlimited: event.target.checked }))} />
            <span>
              <span className="text-text">Approve {sym} once</span>
              <span className="block text-xs text-faint">Grants the engine a standing allowance so later orders need one signature. Off: approve the exact amount each time.</span>
            </span>
          </label>
        </div>
      ) : null}

      {position && positionValue ? (
        <div className="border-b border-line px-3 py-2.5" data-testid="ticket-position">
          <div className="flex items-center justify-between gap-2 text-[0.8125rem]">
            <span>
              <span className={position.position.isLong ? "text-long" : "text-short"}>{position.position.isLong ? "Long" : "Short"}</span>{" "}
              <span className="num">{fmtUsdc(position.position.size)} {sym}</span>{" "}
              <span className="num text-faint">{positionValue.leverage.toFixed(1)}x</span>
            </span>
            <span className={`num font-semibold ${positionValue.pnl === null ? "" : positionValue.pnl >= 0n ? "text-long" : "text-short"}`}>
              {positionValue.pnl === null ? "—" : `${fmtUsdc(positionValue.pnl, 2, { sign: true })} ${sym}`}
            </span>
          </div>
          {view.canTrade ? (
            <div className="mt-2 grid grid-cols-2 gap-2">
              <button
                type="button"
                className="btn btn-sm"
                disabled={tx.busy}
                onClick={() => (settings.oneClick || settled ? runClose() : setConfirming("close"))}
                data-testid="ticket-close"
              >
                {settled ? "Settle & close" : position.position.closeOrderId !== 0n ? "Closing…" : "Close"}
              </button>
              <button type="button" className="btn btn-sm" disabled={tx.busy || settled || expired} onClick={() => setConfirming("reverse")} title="Close this position, then open the same size on the other side">
                Reverse
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      <form
        ref={formRef}
        className="flex flex-col gap-3 p-3"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          requestOpen();
        }}
      >
        <div className="grid grid-cols-2 gap-1 rounded-md border border-line bg-bg p-1" role="group" aria-label="Direction">
          <button type="button" aria-pressed={isLong} onClick={() => setIsLong(true)} className={`h-9 rounded text-sm font-semibold transition-colors ${isLong ? "bg-long text-[#04170e]" : "text-muted hover:text-text"}`}>
            Long
          </button>
          <button type="button" aria-pressed={!isLong} onClick={() => setIsLong(false)} className={`h-9 rounded text-sm font-semibold transition-colors ${!isLong ? "bg-short text-[#2b060c]" : "text-muted hover:text-text"}`}>
            Short
          </button>
        </div>

        <p className="text-xs text-faint">
          {twapping
            ? `TWAP: the keeper places one market slice every ${fmtInterval(twapInterval)}; each fills at the next oracle price, so a large order goes in at an average price instead of all at once.`
            : kind === "market"
            ? publisher
              ? "Market (keeper-filled, ~1-2 s): a keeper fills your order at the next oracle price."
              : "Market: opens in one transaction at the current Pyth price."
            : kind === "stop"
              ? `Stop entry: a keeper fills it once the ${isLong ? "ask rises to" : "bid falls to"} your price (a breakout ${sideWord}).`
              : `Limit: a keeper fills it when the ${isLong ? "ask falls to" : "bid rises to"} your price.`}
        </p>

        {kind === "market" && twapSupported ? (
          <div data-testid="twap-controls">
            <label className="flex items-center gap-2 text-xs text-muted">
              <input
                type="checkbox"
                className="check"
                checked={twapOn}
                onChange={(event) => {
                  setTwapOn(event.target.checked);
                  if (event.target.checked) {
                    // Slices carry no brackets: clear them rather than leave a target that will not be placed.
                    setTpText("");
                    setSlText("");
                    setBracketsOpen(false);
                  }
                }}
                data-testid="twap-toggle"
              />
              TWAP: split into slices over time
              {!view.instant ? <span className="text-faint">(with instant trading)</span> : null}
            </label>
            {twapOn ? (
              <div className="mt-2 grid gap-2">
                <div className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-end gap-2">
                  <div className="min-w-0">
                    <label className="field-label" htmlFor={`${ids}-twap-n`}>
                      Slices
                    </label>
                    <div className="field" data-invalid={twapSlicesError !== null}>
                      <input
                        id={`${ids}-twap-n`}
                        inputMode="numeric"
                        autoComplete="off"
                        value={twapSlicesText}
                        onChange={(event) => setTwapSlicesText(event.target.value.replace(/[^0-9]/g, "").slice(0, 3))}
                        aria-invalid={twapSlicesError !== null}
                        data-testid="twap-slices"
                      />
                    </div>
                  </div>
                  <div className="min-w-0">
                    <span className="field-label">Every</span>
                    <div className="segmented" role="group" aria-label="Time between slices">
                      {TWAP_INTERVALS.map((sec) => (
                        <button key={sec} type="button" aria-pressed={twapInterval === sec} onClick={() => setTwapInterval(sec)} data-testid={`twap-every-${sec}`}>
                          {fmtInterval(sec)}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>
                {twapSlicesError ? <p className="text-xs text-short">{twapSlicesError}</p> : null}
                {twapPlan ? (
                  <p className="num text-xs text-muted" data-testid="twap-summary">
                    {twapPlan.slices} slices of {fmtUsdc(twapPlan.sliceSize)} {sym} ({fmtUsdc(twapPlan.sliceMargin)} margin), one every {fmtInterval(twapPlan.interval)}:
                    about {fmtInterval(Math.max(twapPlan.interval, twapDuration(twapPlan)))} in all. Each fills at most {(twapPlan.slippageBps / 100).toFixed(2)}% past the{" "}
                    {isLong ? "ask" : "bid"} when it goes out; a slice that cannot rests as a limit at that bound.
                  </p>
                ) : null}
                {runningTwap ? (
                  <p className="text-xs text-warn">
                    A TWAP is running here ({runningTwap.done} of {runningTwap.slices} slices placed): starting a new one replaces it.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        {kind !== "market" ? (
          <div>
            <div className="flex items-baseline justify-between">
              <label className="field-label" htmlFor={`${ids}-limit`}>
                {kind === "stop" ? "Stop price" : "Limit price"}
              </label>
              <span className="flex items-center gap-2 text-xs">
                <button type="button" className="link" onClick={() => onPickRequest("limit")}>
                  Pick on chart
                </button>
                <button type="button" className="num text-muted hover:text-text" disabled={!marketEntry} onClick={() => marketEntry && setLimitText(priceInput(marketEntry, dp))}>
                  {marketEntry ? `${upside ? "Mid" : isLong ? "Ask" : "Bid"} ${fmtPrice(marketEntry, dp)}` : "No price"}
                </button>
              </span>
            </div>
            <div className="field" data-invalid={limitError !== null}>
              <input id={`${ids}-limit`} inputMode="decimal" autoComplete="off" placeholder="0.00" value={limitText} onChange={(event) => setLimitText(event.target.value)} aria-invalid={limitError !== null} />
              <span className="field-unit">{instrument.quote}</span>
            </div>
            {limitError ? <p className="mt-1 text-xs text-short">{limitError}</p> : null}
            {fillsNow && !scaling ? (
              <p className="mt-1 text-xs text-warn">
                The market is already {kind === "stop" ? (isLong ? "at or above" : "at or below") : isLong ? "at or below" : "at or above"} this price, so a keeper fills it right away at about{" "}
                {marketEntry ? fmtPrice(marketEntry, dp) : "market"}.
              </p>
            ) : null}
            {expirySupported ? (
              <div className="mt-2 flex flex-wrap items-center gap-1.5 text-xs" role="group" aria-label="Order expiry">
                <span className="text-muted" title="A resting order stops being executable at this time; a keeper then removes it and refunds the escrow (one execution fee is its pay).">
                  Good until
                </span>
                {EXPIRY_CHOICES.map((c) => (
                  <button key={c.key} type="button" className="chip" aria-pressed={expiryKey === c.key} onClick={() => setExpiryKey(c.key)} data-testid={`expiry-${c.key}`}>
                    {c.label}
                  </button>
                ))}
              </div>
            ) : null}
            {kind === "limit" ? (
              <div className="mt-2">
                <label className="flex items-center gap-2 text-xs text-muted">
                  <input type="checkbox" className="check" checked={scaleOn} onChange={(event) => setScaleOn(event.target.checked)} data-testid="scale-toggle" />
                  Scale in: split into equal orders between two prices
                </label>
                {scaleOn ? (
                  <div className="mt-2 grid grid-cols-[minmax(0,1fr)_5.5rem] gap-2">
                    <div className="min-w-0">
                      <label className="field-label" htmlFor={`${ids}-scale-to`}>
                        Last price
                      </label>
                      <div className="field">
                        <input
                          id={`${ids}-scale-to`}
                          inputMode="decimal"
                          autoComplete="off"
                          placeholder="0.00"
                          value={scaleToText}
                          onChange={(event) => setScaleToText(event.target.value)}
                          data-testid="scale-to"
                        />
                        <span className="field-unit">{instrument.quote}</span>
                      </div>
                    </div>
                    <div className="min-w-0">
                      <label className="field-label" htmlFor={`${ids}-scale-n`}>
                        Orders
                      </label>
                      <div className="field" data-invalid={scaleCountError !== null}>
                        <input
                          id={`${ids}-scale-n`}
                          inputMode="numeric"
                          autoComplete="off"
                          value={scaleCountText}
                          onChange={(event) => setScaleCountText(event.target.value.replace(/[^0-9]/g, "").slice(0, 2))}
                          aria-invalid={scaleCountError !== null}
                          data-testid="scale-count"
                        />
                      </div>
                    </div>
                  </div>
                ) : null}
                {scalePlan && entry ? (
                  <p className="num mt-1 text-xs text-muted" data-testid="scale-summary">
                    {scalePlan.length} orders from {fmtPrice(scalePlan[0]!.price, dp)} to {fmtPrice(scalePlan[scalePlan.length - 1]!.price, dp)}, {fmtUsdc(scalePlan[0]!.margin)} {sym} margin each;
                    average entry {fmtPrice(entry, dp)} if all fill.{" "}
                    {view.instant ? "One transaction." : `${scalePlan.length} wallet confirmations (one with instant trading).`}
                  </p>
                ) : null}
                {ladder && ladderNow > 0 ? (
                  <p className="mt-1 text-xs text-warn">
                    {ladderNow} of the {ladder.length} prices {ladderNow === 1 ? "is" : "are"} already {isLong ? "at or above the ask" : "at or below the bid"}, so {ladderNow === 1 ? "that order fills" : "those fill"} right away.
                  </p>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}

        <div>
          <div className="flex items-center justify-between gap-2">
            <div className="flex gap-1" role="group" aria-label="Quantity entered as">
              {QTY_MODES.map((m) => (
                <button key={m.key} type="button" className="chip" aria-pressed={qtyMode === m.key} title={m.hint} onClick={() => changeQtyMode(m.key)}>
                  {m.label}
                </button>
              ))}
            </div>
            {view.canTrade && balance !== undefined ? (
              <span className="num truncate text-xs text-muted">
                {fmtUsdc(balance)} {sym}
              </span>
            ) : null}
          </div>

          {qtyMode === "risk" ? (
            <>
              <label className="sr-only" htmlFor={`${ids}-risk`}>
                Amount to risk at the stop-loss
              </label>
              <div className="field mt-1.5" data-invalid={qtyError !== null}>
                <input id={`${ids}-risk`} ref={sizeInputRef} inputMode="decimal" autoComplete="off" placeholder={riskUnit === "usdc" ? "50" : "1"} value={riskText} onChange={(event) => setRiskText(event.target.value)} aria-invalid={qtyError !== null} />
                <div className="flex gap-1" role="group" aria-label="Risk entered as">
                  <button type="button" className="chip" aria-pressed={riskUnit === "usdc"} onClick={() => setRiskUnit("usdc")}>
                    {sym}
                  </button>
                  <button type="button" className="chip" aria-pressed={riskUnit === "pct"} onClick={() => setRiskUnit("pct")}>
                    % of balance
                  </button>
                </div>
              </div>
              <p className="mt-1 text-xs text-faint">
                {size !== null && margin !== null
                  ? `Risking ${riskAmount !== null ? fmtUsdc(riskAmount) : "—"} ${sym} to your stop gives ${fmtUsdc(size)} ${sym} size on ${fmtUsdc(margin)} margin (${leverage.toFixed(1)}x), fees included.`
                  : "Set a stop-loss below (as a price or %). Size is chosen so that hitting the stop loses this amount, fees included."}
              </p>
              {riskNote ? <p className="mt-1 text-xs text-warn">{riskNote}</p> : null}
            </>
          ) : (
            <>
              <label className="sr-only" htmlFor={`${ids}-qty`}>
                {qtyMode === "notional" ? "Position size" : qtyMode === "margin" ? "Margin" : `Contracts (${instrument.unitLabel})`}
              </label>
              <div className="field mt-1.5" data-invalid={qtyError !== null}>
                <input id={`${ids}-qty`} ref={sizeInputRef} inputMode="decimal" autoComplete="off" placeholder={qtyMode === "contracts" ? "0.00" : "0.00"} value={qtyText} onChange={(event) => setQtyText(event.target.value)} aria-invalid={qtyError !== null} data-testid="ticket-qty" />
                <span className="field-unit">{qtyUnit}</span>
                <button type="button" className="chip" disabled={!view.canTrade || balance === undefined || !params} onClick={setMax}>
                  Max
                </button>
              </div>
              <p className="num mt-1 text-xs text-faint" data-testid="ticket-equivalents">
                {size !== null && margin !== null && size > 0n ? (
                  <>
                    {qtyMode !== "notional" ? `Size ${fmtUsdc(size)} ${sym}` : null}
                    {qtyMode !== "notional" && qtyMode !== "margin" ? " · " : null}
                    {qtyMode !== "margin" ? `Margin ${fmtUsdc(margin)} ${sym}` : null}
                    {qtyMode !== "contracts" && units !== null ? ` · ${fmtQty(units)} ${instrument.unitLabel}` : null}
                  </>
                ) : qtyMode === "contracts" ? (
                  contractsHint
                ) : (
                  QTY_MODES.find((m) => m.key === qtyMode)?.hint
                )}
              </p>
            </>
          )}
          {qtyError ? <p className="mt-1 text-xs text-short">{qtyError}</p> : null}
        </div>

        <div>
          <div className="flex items-baseline justify-between">
            <label className="field-label" htmlFor={`${ids}-lev-range`}>
              {qtyMode === "risk" ? "Leverage limit" : "Leverage"}
            </label>
            <div className="field h-7 w-[5.25rem] px-2">
              <input
                aria-label={qtyMode === "risk" ? "Leverage limit" : "Leverage"}
                inputMode="decimal"
                value={levText}
                onChange={(event) => {
                  setLevText(event.target.value);
                  const parsed = parseAmount(event.target.value, 1);
                  if (parsed !== null && parsed >= 10n && parsed <= BigInt(maxLeverage * 10)) setLevX10(Number(parsed));
                }}
                onBlur={() => setLevText(String(levX10 / 10))}
                className="text-right text-[0.8125rem]"
              />
              <span className="field-unit">x</span>
            </div>
          </div>
          <input
            id={`${ids}-lev-range`}
            className="slider"
            type="range"
            min={maxLeverage <= 100 ? 1 : 0}
            max={maxLeverage <= 100 ? maxLeverage : SLIDER_STEPS}
            step={1}
            value={levToSlider(levX10 / 10, maxLeverage)}
            style={
              {
                "--fill": `${maxLeverage <= 100 ? ((levX10 / 10 - 1) / Math.max(1, maxLeverage - 1)) * 100 : (levToSlider(levX10 / 10, maxLeverage) / SLIDER_STEPS) * 100}%`,
              } as React.CSSProperties
            }
            onChange={(event) => setLeverage(sliderToLev(Number(event.target.value), maxLeverage) * 10)}
            aria-valuetext={`${levX10 / 10}x`}
          />
          <div className="mt-0.5 flex flex-wrap gap-1">
            {LEVERAGE_PRESETS.filter((x) => x <= maxLeverage).map((x) => (
              <button key={x} type="button" className="chip" aria-pressed={levX10 === x * 10} onClick={() => setLeverage(x * 10)}>
                {x}x
              </button>
            ))}
          </div>
          {levError ? <p className="mt-1 text-xs text-short">{levError}</p> : null}
          {!levError && leverage > DIRECT_MAX_LEVERAGE ? (
            <p className="mt-1.5 text-xs text-warn" data-testid="high-leverage-note">
              {leverage.toFixed(0)}x: a {liqDistance !== null ? fmtPercent(liqDistance, 2) : `${(90 / leverage).toFixed(2)}%`} move against you liquidates the position. Above{" "}
              {DIRECT_MAX_LEVERAGE}x, opens and closes go through the keeper at the next price, and each side&rsquo;s fee is capped at 10% of margin.
            </p>
          ) : null}
        </div>

        {twapping ? (
          <p className="text-xs text-faint">TWAP slices carry no take-profit or stop-loss: set them on the position as it builds (a trailing stop works too).</p>
        ) : !showBrackets ? (
          <button type="button" className="link self-start text-[0.8125rem]" onClick={() => setBracketsOpen(true)} data-testid="add-brackets">
            Add take-profit / stop-loss
          </button>
        ) : (
        <div className="grid gap-2">
          <div>
            <div className="flex items-baseline justify-between">
              <label className="field-label" htmlFor={`${ids}-tp`}>
                Take-profit <span className="text-faint">(optional)</span>
              </label>
              <button type="button" className="link text-xs" onClick={() => onPickRequest("tp")}>
                Pick on chart
              </button>
            </div>
            <div className="field" data-invalid={tpError !== null}>
              <input id={`${ids}-tp`} inputMode="decimal" autoComplete="off" placeholder={tpUnit === "price" ? "Price" : tpUnit === "r" ? "2" : "5"} value={tpText} onChange={(event) => setTpText(event.target.value)} aria-invalid={tpError !== null} data-testid="ticket-tp" />
              <select className="unit-select" aria-label="Take-profit entered as" value={tpUnit} onChange={(event) => { setTpUnit(event.target.value as TpUnit); setTpText(""); }}>
                <option value="price">Price</option>
                <option value="pct">% move</option>
                <option value="roe">% ROE</option>
                <option value="r">R multiple</option>
              </select>
            </div>
            {tpError ? (
              <p className="mt-1 text-xs text-short">{tpError}</p>
            ) : takeProfit && tpPnl !== null && margin ? (
              <p className="num mt-1 text-xs text-faint">
                {tpUnit !== "price" ? `At ${fmtPrice(takeProfit, dp)}: ` : ""}
                <span className="text-long">{fmtUsdc(tpCapped && maxProfit !== null ? maxProfit : tpPnl, 2, { sign: true })} {sym}</span> ({fmtPercent(ratio(tpCapped && maxProfit !== null ? maxProfit : tpPnl, margin), 0, true)} ROE)
                {tpCapped ? ". Beyond the profit cap: the extra is not paid." : ""}
              </p>
            ) : null}
          </div>
          <div>
            <div className="flex items-baseline justify-between">
              <label className="field-label" htmlFor={`${ids}-sl`}>
                Stop-loss <span className="text-faint">{qtyMode === "risk" ? "(needed for risk sizing)" : "(optional)"}</span>
              </label>
              <button type="button" className="link text-xs" onClick={() => onPickRequest("sl")}>
                Pick on chart
              </button>
            </div>
            <div className="field" data-invalid={slError !== null}>
              <input id={`${ids}-sl`} inputMode="decimal" autoComplete="off" placeholder={effectiveSlUnit === "price" ? "Price" : "2"} value={slText} onChange={(event) => setSlText(event.target.value)} aria-invalid={slError !== null} data-testid="ticket-sl" />
              <select className="unit-select" aria-label="Stop-loss entered as" value={effectiveSlUnit} onChange={(event) => { setSlUnit(event.target.value as SlUnit); setSlText(""); }}>
                <option value="price">Price</option>
                <option value="pct">% move</option>
                {qtyMode !== "risk" ? <option value="roe">% ROE</option> : null}
              </select>
            </div>
            {slError ? (
              <p className="mt-1 text-xs text-short">{slError}</p>
            ) : stopLoss && slPnl !== null && margin ? (
              <p className="num mt-1 text-xs text-faint">
                {effectiveSlUnit !== "price" ? `At ${fmtPrice(stopLoss, dp)}: ` : ""}
                <span className="text-short">{fmtUsdc(slPnl, 2, { sign: true })} {sym}</span> ({fmtPercent(ratio(slPnl, margin), 0, true)} ROE) before fees
              </p>
            ) : null}
            {slBeyondLiq ? <p className="mt-1 text-xs text-warn">This stop is past the liquidation price, so the position would be liquidated first. Lower the leverage or tighten the stop.</p> : null}
          </div>
        </div>
        )}

        {entry && size !== null && size > 0n ? <TradeMap isLong={isLong} entry={entry} liq={liq && liq > 0n ? liq : null} stop={stopLoss && !slError ? stopLoss : null} target={takeProfit && !tpError ? takeProfit : null} dp={dp} /> : null}

        <div className="risk-card" data-tone={level?.tone ?? "none"} data-testid="risk-summary">
          <div className="flex items-center justify-between gap-2">
            <span className="risk-card-title">Risk</span>
            <span className="flex items-center gap-2">
              <span className="risk-meter" aria-hidden="true">
                {[1, 2, 3, 4].map((i) => (
                  <span key={i} data-on={level !== null && i <= level.filled} />
                ))}
              </span>
              <span className="risk-level">{level ? level.label : "—"}</span>
            </span>
          </div>
          <dl className="mt-2 grid gap-1.5 text-[0.8125rem]">
            <Row
              label="Most you can lose"
              strong
              hint="If the position is liquidated you lose its margin, plus the fees you paid. Nothing beyond that: there is no negative balance."
              value={maxLoss !== null ? `${fmtUsdc(maxLoss)} ${sym}` : "—"}
            />
            <Row
              label="Liquidated after"
              hint="The move against you, from entry, at which losses plus funding reach 90% of margin."
              value={liq === null ? "—" : liq === 0n ? "Never (1x long)" : `${liqDistance !== null ? fmtPercent(liqDistance, liqDistance < 0.01 ? 2 : 1) : "—"} move · ${fmtPrice(liq, dp)}`}
              tone={level && (level.tone === "high" || level.tone === "extreme") ? "short" : level?.tone === "moderate" ? "warn" : undefined}
            />
            {stopLoss && slPnl !== null && !slError ? (
              <Row label="Loss at your stop" hint="Price loss if the stop fills at its trigger, before fees." value={`${fmtUsdc(slPnl, 2, { sign: true })} ${sym}`} tone="short" />
            ) : null}
            <Row
              label="Most you can make"
              hint={`Profit per position is capped at ${params?.maxProfitMultiple.toString() ?? "10"}x margin.`}
              value={maxProfit !== null && margin ? `${fmtUsdc(maxProfit)} ${sym}${capDistance !== null ? ` after a ${fmtPercent(capDistance, capDistance < 0.01 ? 2 : 1)} move` : ""}` : "—"}
              tone="long"
            />
          </dl>
        </div>

        <dl className="grid gap-1.5 text-[0.8125rem]">
          <Row
            label={scalePlan ? "Average entry if all fill" : kind !== "market" ? "Entry" : "Entry estimate"}
            hint={
              kind === "market"
                ? upside
                  ? "Turbo markets fill at the oracle mid price, both ways. A keeper executes against the next price, at most your slippage tolerance away."
                  : "Buys fill at the oracle ask, sells at the bid. The fill is the price a keeper executes against, at most your slippage tolerance away."
                : undefined
            }
            value={entry ? fmtPrice(entry, dp) : "—"}
          />
          <Row
            label="Liquidation price"
            hint="The oracle mid price at which losses plus funding reach 90% of margin. Past it, anyone can liquidate the position and the margin is lost."
            value={liq === null ? "—" : liq === 0n ? "None" : fmtPrice(liq, dp)}
          />
          {upside ? (
            <Row
              label="Fee"
              hint={`No fee to open or to close. If you close in profit the house keeps ${fmtBps(profitShareBps)} of the profit; a loss costs nothing beyond the loss. Keeper orders cost ${fmtUsdc(params?.executionFee ?? 0n, 2)} ${sym} each.`}
              value={`None unless you win: ${fmtBps(profitShareBps)} of profit`}
              tone="long"
            />
          ) : (
            <Row
              label="Fees to open"
              hint="Open fee plus execution fees. The breakdown is under Details."
              value={openFee !== null && executionFees !== null ? `${fmtUsdc(openFee + executionFees, 2)} ${sym}` : size !== null && size > 0n ? "…" : "—"}
            />
          )}
          <Row
            label={twapPlan ? "Total over the TWAP" : "Total required"}
            strong
            hint={twapPlan ? "Drawn from your trading account one slice at a time: each slice's margin, fee escrow and execution fee." : "Taken from your wallet when you submit: margin, the fee escrow and execution fees."}
            value={required !== null ? `${fmtUsdc(required)} ${sym}` : "—"}
          />
        </dl>

        <details className="ticket-details" open={settings.ticketDetails} onToggle={(event) => {
          const open = (event.currentTarget as HTMLDetailsElement).open;
          if (open !== settings.ticketDetails) setSettings((s) => ({ ...s, ticketDetails: open }));
        }}>
          <summary>Details: fees, funding, profit cap</summary>
          <dl className="mt-2 grid gap-1.5 text-[0.8125rem]">
            <Row
              label="Open fee"
              hint="Base fee on size, plus a surcharge when the trade makes the market more one-sided. Keeper-filled orders escrow the maximum and refund the difference on fill."
              value={
                openFee !== null
                  ? `${fmtUsdc(openFee, 4)} ${sym}${skewFee > 0n ? ` (incl. ${fmtUsdc(skewFee, 4)} skew)` : ""}`
                  : size !== null && size > 0n
                    ? "…"
                    : "—"
              }
            />
            <Row
              label={`Execution fee${executionCount === 1 ? "" : "s"}`}
              hint="A flat fee per keeper-executed order: the open itself and each of take-profit / stop-loss. Bracket fees are refunded if you close by hand."
              value={executionFees !== null ? (executionCount === 0 ? "None" : `${fmtUsdc(executionFees, 2)} ${sym} (${executionCount} x ${fmtUsdc(params?.executionFee ?? 0n, 2)})`) : "—"}
            />
            {keeperOrder && required !== null && expectedCost !== null && required > expectedCost ? (
              <Row label="Fee escrow, refunded on fill" hint="Keeper-filled orders set aside the highest possible open fee; the unused part comes back when the order fills." value={`${fmtUsdc(required - expectedCost, 4)} ${sym}`} />
            ) : null}
            <Row
              label={upside ? "On a winning close" : "Close fee, later"}
              value={upside ? `${fmtBps(profitShareBps)} of the profit` : closeFeeEst !== null && size ? `${fmtUsdc(closeFeeEst, 4)} ${sym}` : "—"}
            />
            <Row
              label="Funding per hour"
              hint="Paid or received continuously while the position is open, at the current rate. The rate moves with the long/short balance."
              value={fundingForSide === null ? "—" : fundingForSide === 0n ? "0.00" : `${fundingForSide > 0n ? "pay" : "receive"} ${fmtUsdc(fundingForSide > 0n ? fundingForSide : -fundingForSide, 4)} ${sym}`}
              tone={fundingForSide !== null && fundingForSide > 0n ? "short" : fundingForSide !== null && fundingForSide < 0n ? "long" : undefined}
            />
            <Row
              label="Max profit"
              hint={`Profit on a position is capped at ${params?.maxProfitMultiple.toString() ?? "10"} times its margin.${upside ? ` In a Turbo market the house keeps ${fmtBps(profitShareBps)} of it.` : ""}`}
              value={maxProfitNet !== null && margin ? `${fmtUsdc(maxProfitNet)} ${sym}${capPrice ? ` at ${fmtPrice(capPrice, dp)}` : ""}` : "—"}
            />
          </dl>
          <CostBySize instrument={instrument} enabled={settings.ticketDetails} />
        </details>

        {awaiting && kind === "market" ? (
          <p className="notice" data-tone="warn">
            Awaiting an on-chain price{price.age !== null ? ` (last one is ${fmtAge(price.age)} old)` : ""}. You can still place the order: a keeper fills it once prices resume, within your slippage of the tape price shown.
          </p>
        ) : null}
        {merged ? (
          <div className="notice" data-testid="adds-to-position">
            <p className="text-[0.8125rem] text-text">Adds to your {sideWord}</p>
            <dl className="mt-1.5 grid gap-1 text-xs">
              <Row label="Size" value={`${fmtUsdc(position!.position.size)} → ${fmtUsdc(merged.size)} ${sym}`} />
              <Row label="Margin" value={`${fmtUsdc(position!.position.margin)} → ${fmtUsdc(merged.margin)} ${sym} (${ratio(merged.size, merged.margin).toFixed(1)}x)`} />
              <Row label="Average entry" value={fmtPrice(merged.entryPrice, dp)} />
              <Row
                label="Liquidation after"
                value={mergedLiq === null ? "—" : mergedLiq === 0n ? "None" : `${fmtPrice(mergedLiq, dp)}${mergedLiqDistance !== null ? ` · ${fmtPercent(mergedLiqDistance, mergedLiqDistance < 0.01 ? 2 : 1)} from the mark` : ""}`}
                tone={mergedLiqDistance !== null && mergedLiqDistance < 0.01 ? "short" : undefined}
              />
            </dl>
            {(takeProfit || stopLoss) && (position!.position.tpOrderId !== 0n || position!.position.slOrderId !== 0n) ? (
              <p className="mt-1.5 text-xs text-faint">The take-profit / stop-loss set here replace the position&rsquo;s current ones (their execution fee is refunded).</p>
            ) : null}
          </div>
        ) : null}
        {oppositeSide && kind !== "market" ? (
          <p className="notice" data-tone="warn">
            You hold a {position!.position.isLong ? "long" : "short"} here. One position per market: this order can only fill after that position is closed.
          </p>
        ) : null}
        {restingOpposite && !position ? (
          <p className="notice">
            Order #{restingOpposite.id.toString()} on the other side is already resting in this market. One position per market: whichever fills first blocks the other.
          </p>
        ) : null}

        {button}
        <TxStatus state={tx.state} onDismiss={tx.reset} />
        <TrackedOrders marketId={instrument.id} dp={dp} />
      </form>

      {confirming === "open" ? (
        <ConfirmDialog
          title={`Confirm ${twapPlan ? "TWAP" : kind === "limit" ? "limit" : kind === "stop" ? "stop" : merged ? "addition to your" : "market"} ${sideWord}`}
          lines={confirmLines}
          note={
            twapPlan
              ? `The keeper places one slice every ${fmtInterval(twapPlan.interval)} from your trading account and fills it at the next price; each fill adds to the position. Stop it any time from Orders (slices already placed stay). ${twapNeedsApproval ? "Your wallet confirms once to let the TWAP contract place slices within your instant-trading limits." : "No wallet confirmation needed."}`
              : highLeverage
              ? `${leverage.toFixed(0)}x leverage: a ${liqDistance !== null ? fmtPercent(liqDistance, 2) : "very small"} move against you liquidates this position and you lose the margin. A keeper fills it at the next oracle price; closing also goes through a keeper order.`
              : kind === "market" && publisher
                ? "A keeper fills this at the next oracle price, usually within 1-2 seconds. If the price runs past your worst fill, the order rests until it comes back or you cancel it."
                : undefined
          }
          confirmLabel={twapPlan ? `Start TWAP ${sideWord}` : kind === "limit" ? `Place limit ${sideWord}` : kind === "stop" ? `Place stop ${sideWord}` : merged ? `Add to ${sideWord}` : `${isLong ? "Buy / Long" : "Sell / Short"}`}
          tone={isLong ? "long" : "short"}
          allowSkip={!highLeverage}
          onSkipChange={(skip) => setSettings((s) => ({ ...s, oneClick: skip }))}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            void runOpen();
          }}
        />
      ) : null}
      {confirming === "close" && position ? (
        <ConfirmDialog
          title={`Close ${instrument.symbol} ${position.position.isLong ? "long" : "short"}`}
          lines={[
            { label: "Size", value: `${fmtUsdc(position.position.size)} ${sym}` },
            { label: "Unrealised PnL", value: positionValue?.pnl !== null && positionValue?.pnl !== undefined ? `${fmtUsdc(positionValue.pnl, 2, { sign: true })} ${sym}` : "—" },
            { label: "Slippage tolerance", value: `${slippagePct}%` },
          ]}
          note={publisher ? "This places a close order that a keeper executes at the next oracle price. It costs one execution fee." : undefined}
          confirmLabel="Close position"
          allowSkip
          onSkipChange={(skip) => setSettings((s) => ({ ...s, oneClick: skip }))}
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            runClose();
          }}
        />
      ) : null}
      {confirming === "reverse" && position ? (
        <ConfirmDialog
          title={`Reverse to ${position.position.isLong ? "short" : "long"}`}
          lines={[
            { label: "Step 1", value: `Close ${position.position.isLong ? "long" : "short"} ${fmtUsdc(position.position.size)} ${sym}` },
            { label: "Step 2", value: `Open ${position.position.isLong ? "short" : "long"} ${fmtUsdc(position.position.size)} ${sym} on ${fmtUsdc(position.position.margin)} margin` },
          ]}
          note={
            publisher
              ? "Reversing is two keeper orders, not one trade: first a close order, then, once a keeper has executed it, a market order the other way. You sign twice, pay fees on both, and the price can move in between. Take-profit and stop-loss are not carried over."
              : "Reversing is two transactions: a close, then an open the other way. You sign twice and pay fees on both. Take-profit and stop-loss are not carried over."
          }
          confirmLabel="Reverse position"
          onCancel={() => setConfirming(null)}
          onConfirm={() => {
            setConfirming(null);
            runReverse();
          }}
        />
      ) : null}
    </section>
  );
});
