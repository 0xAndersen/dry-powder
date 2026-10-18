// Pure risk math, identical to the engine's rules. No network; safe to call in a loop.
//
// Units: sizes and margins are USDC with 6 decimals (bigint); prices have 18 decimals (bigint).

/** PerpEngine.MAX_LEVERAGE. */
export const MAX_LEVERAGE = 1_000;
/** PerpEngine.DIRECT_MAX_LEVERAGE: above it a position opens and closes only through keeper-filled orders. */
export const DIRECT_MAX_LEVERAGE = 100;
/** PerpEngine.MARGIN_FEE_CAP_BPS: each side's trading fee is at most 10% of margin. */
export const MARGIN_FEE_CAP_BPS = 1_000;
/** A position is liquidated once losses plus funding reach 90% of its margin. */
export const LIQUIDATION_THRESHOLD_BPS = 9_000;
export const BPS = 10_000n;

const ceilDiv = (a: bigint, b: bigint) => (a + b - 1n) / b;

/** True when a position of this size and margin must use keeper orders to open and close. */
export function needsKeeperOrders(size: bigint, margin: bigint): boolean {
  return size > margin * BigInt(DIRECT_MAX_LEVERAGE);
}

/** The most the engine charges per side for a position with this margin. */
export function feeCap(margin: bigint): bigint {
  return (margin * BigInt(MARGIN_FEE_CAP_BPS)) / BPS;
}

/** Margin for a size at a leverage, rounded up so the leverage is never exceeded. */
export function marginFor(size: bigint, leverage: number): bigint {
  const lev = BigInt(Math.round(leverage * 100));
  return ceilDiv(size * 100n, lev);
}

/**
 * Price at which losses plus funding reach 90% of margin. 0n means never (a long whose margin covers its size);
 * null means already liquidatable.
 */
export function liquidationPrice(entry: bigint, margin: bigint, size: bigint, isLong: boolean, fundingOwed = 0n): bigint | null {
  if (size === 0n || entry === 0n) return null;
  const room = (margin * BigInt(LIQUIDATION_THRESHOLD_BPS)) / BPS - fundingOwed;
  if (room <= 0n) return null;
  if (isLong) {
    if (room >= size) return 0n;
    return ceilDiv(entry * (size - room), size);
  }
  return (entry * (size + room)) / size;
}

/** Price at which profit reaches the cap (`multiple` x margin). Null when unreachable (a short past zero). */
export function profitCapPrice(entry: bigint, margin: bigint, size: bigint, isLong: boolean, multiple = 10n): bigint | null {
  if (size === 0n) return null;
  const cap = margin * multiple;
  if (isLong) return entry + ceilDiv(entry * cap, size);
  if (cap >= size) return null;
  return (entry * (size - cap)) / size;
}

export type RiskLevel = "low" | "moderate" | "high" | "extreme";

/** The app's risk bands, by the price move that liquidates the position. */
export function riskLevel(liquidationMove: number | null): RiskLevel {
  if (liquidationMove === null) return "low";
  if (liquidationMove >= 0.1) return "low";
  if (liquidationMove >= 0.03) return "moderate";
  if (liquidationMove >= 0.01) return "high";
  return "extreme";
}

export interface RiskInput {
  entry: bigint;
  size: bigint;
  margin: bigint;
  isLong: boolean;
  /** Open fee (from `quoteOpenFee`); defaults to the cap, the most it can be. */
  openFee?: bigint;
  /** Close fee estimate; defaults to the cap. */
  closeFee?: bigint;
  /** Keeper execution fees escrowed with the order(s). */
  executionFees?: bigint;
  stopLoss?: bigint;
  maxProfitMultiple?: bigint;
}

export interface Risk {
  leverage: number;
  keeperOrdersOnly: boolean;
  liquidationPrice: bigint | null;
  /** Fractional move against the position that liquidates it (0.0009 = 0.09%). */
  liquidationMove: number | null;
  level: RiskLevel;
  /** Margin plus every fee: the most this trade can cost. There is no negative balance. */
  maxLoss: bigint;
  /** Price loss if the stop fills at its trigger, before fees (negative). */
  lossAtStop: bigint | null;
  /** True when the stop sits past the liquidation price, so liquidation comes first. */
  stopPastLiquidation: boolean;
  maxProfit: bigint;
  /** Fractional move in favour at which the profit cap is reached. */
  profitCapMove: number | null;
}

const frac = (a: bigint, b: bigint) => Number((a * 1_000_000_000n) / b) / 1e9;

/** The worst case, the liquidation distance and the best case for a prospective position. */
export function assessRisk(r: RiskInput): Risk {
  const cap = feeCap(r.margin);
  const openFee = r.openFee ?? cap;
  const closeFee = r.closeFee ?? cap;
  const liq = liquidationPrice(r.entry, r.margin, r.size, r.isLong);
  const liquidationMove = liq === null ? 0 : liq === 0n ? null : frac(r.isLong ? r.entry - liq : liq - r.entry, r.entry);
  const multiple = r.maxProfitMultiple ?? 10n;
  const capPx = profitCapPrice(r.entry, r.margin, r.size, r.isLong, multiple);
  let lossAtStop: bigint | null = null;
  let stopPastLiquidation = false;
  if (r.stopLoss) {
    const move = r.isLong ? r.stopLoss - r.entry : r.entry - r.stopLoss;
    lossAtStop = (r.size * move) / r.entry;
    if (liq !== null && liq !== 0n) stopPastLiquidation = r.isLong ? r.stopLoss <= liq : r.stopLoss >= liq;
  }
  return {
    leverage: Number((r.size * 100n) / r.margin) / 100,
    keeperOrdersOnly: needsKeeperOrders(r.size, r.margin),
    liquidationPrice: liq,
    liquidationMove,
    level: riskLevel(liquidationMove),
    maxLoss: r.margin + openFee + closeFee + (r.executionFees ?? 0n),
    lossAtStop,
    stopPastLiquidation,
    maxProfit: r.margin * multiple,
    profitCapMove: capPx === null ? null : frac(r.isLong ? capPx - r.entry : r.entry - capPx, r.entry),
  };
}

/** PerpEngine's unit scale (`size * 1e36 / entry`): the merged entry price is computed from it. */
const UNIT_PRECISION = 10n ** 36n;

export interface MergeInput {
  /** The open position. */
  position: { size: bigint; margin: bigint; entry: bigint; isLong: boolean };
  /** What the order adds, filled at `price`. */
  add: { size: bigint; margin: bigint; price: bigint };
}

/**
 * The position after an addition, as the engine computes it (v3.1): size and margin add up; the entry is
 * size over units, rounded against the trader (up for a long, down for a short), so the position's PnL at any
 * price is what the two parts would have made separately (less rounding).
 */
export function mergedPosition(m: MergeInput): { size: bigint; margin: bigint; entry: bigint; leverage: number; liquidationPrice: bigint | null } {
  const { position: p, add } = m;
  const units = (p.size * UNIT_PRECISION) / p.entry + (add.size * UNIT_PRECISION) / add.price;
  const size = p.size + add.size;
  const margin = p.margin + add.margin;
  const entry = p.isLong ? ceilDiv(size * UNIT_PRECISION, units) : (size * UNIT_PRECISION) / units;
  return { size, margin, entry, leverage: Number((size * 100n) / margin) / 100, liquidationPrice: liquidationPrice(entry, margin, size, p.isLong) };
}

/**
 * A partial close as the engine settles it (v3.1): margin released in proportion (rounded down) and the part's
 * own profit cap; when what would remain is under `minMargin`, the whole position closes instead.
 */
export function partialClose(position: { size: bigint; margin: bigint }, closeSize: bigint, minMargin = 5_000_000n): { whole: boolean; releasedMargin: bigint; remaining: { size: bigint; margin: bigint } } {
  if (closeSize === 0n || closeSize >= position.size) return { whole: true, releasedMargin: position.margin, remaining: { size: 0n, margin: 0n } };
  const releasedMargin = (position.margin * closeSize) / position.size;
  if (position.margin - releasedMargin < minMargin) return { whole: true, releasedMargin: position.margin, remaining: { size: 0n, margin: 0n } };
  return { whole: false, releasedMargin, remaining: { size: position.size - closeSize, margin: position.margin - releasedMargin } };
}

/** Prices for a ladder of `count` orders evenly spaced from `from` to `to` (both included). */
export function ladderPrices(from: bigint, to: bigint, count: number): bigint[] {
  if (!Number.isInteger(count) || count < 1) throw new Error("count must be a positive integer");
  if (count === 1) return [from];
  const step = (to - from) / BigInt(count - 1);
  return Array.from({ length: count }, (_, i) => (i === count - 1 ? to : from + step * BigInt(i)));
}
