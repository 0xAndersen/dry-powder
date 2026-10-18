/** Client-side mirrors of PerpEngine / PositionMath arithmetic. Everything is bigint. */

export const BPS = 10_000n;
export const ONE = 10n ** 18n;
export const LIQUIDATION_THRESHOLD_BPS = 9_000n;
export const SECONDS_PER_YEAR = 31_536_000;
/** USDC (6 dec) x price scale (18 dec) -> units of the underlying in 18 decimals. */
const UNIT_SCALE = 10n ** 30n;

export function ceilDiv(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

export function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

export function abs(a: bigint): bigint {
  return a < 0n ? -a : a;
}

export function minBig(a: bigint, b: bigint): bigint {
  return a < b ? a : b;
}

export function maxBig(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** Price PnL in USDC (6 dec), rounded against the trader exactly like `PositionMath.pricePnl`. */
export function pricePnl(size: bigint, entry: bigint, price: bigint, isLong: boolean): bigint {
  if (entry === 0n) return 0n;
  const profit = isLong ? price >= entry : price <= entry;
  const numerator = size * absDiff(price, entry);
  return profit ? numerator / entry : -ceilDiv(numerator, entry);
}

/** Liquidation price given funding already owed, mirroring `PositionMath.liquidationPrice`.
 *  Returns null when the position is liquidatable at any price, 0n when a long can never be liquidated. */
export function liquidationPrice(
  entry: bigint,
  margin: bigint,
  size: bigint,
  isLong: boolean,
  fundingOwed = 0n,
): bigint | null {
  if (size === 0n || entry === 0n) return null;
  const room = (margin * LIQUIDATION_THRESHOLD_BPS) / BPS - fundingOwed;
  if (room <= 0n) return null;
  if (isLong) {
    if (room >= size) return 0n;
    return ceilDiv(entry * (size - room), size);
  }
  return (entry * (size + room)) / size;
}

/** Price at which the profit cap (`maxProfitMultiple` x margin) is reached. Null when unreachable (short past zero). */
export function profitCapPrice(entry: bigint, margin: bigint, size: bigint, isLong: boolean, multiple: bigint): bigint | null {
  if (size === 0n) return null;
  const cap = margin * multiple;
  if (isLong) return entry + ceilDiv(entry * cap, size);
  if (cap >= size) return null;
  return (entry * (size - cap)) / size;
}

/** PerpEngine.MAX_LEVERAGE. */
export const MAX_LEVERAGE = 1_000;
/** PerpEngine.DIRECT_MAX_LEVERAGE: above it positions open and close only through keeper orders. */
export const DIRECT_MAX_LEVERAGE = 100;
/** PerpEngine.MARGIN_FEE_CAP_BPS: each side's fee is at most 10% of margin. */
export const MARGIN_FEE_CAP_BPS = 1_000n;

/** True when the engine requires keeper orders for this size and margin (leverage above 100x). */
export function needsKeeperOrders(size: bigint, margin: bigint): boolean {
  return size > margin * BigInt(DIRECT_MAX_LEVERAGE);
}

/** The engine's per-side fee cap for a position with this margin. */
export function feeCap(margin: bigint): bigint {
  return (margin * MARGIN_FEE_CAP_BPS) / BPS;
}

/** Upper bound of the open fee, as escrowed for limit orders (capped at 10% of margin). */
export function maxOpenFee(size: bigint, baseFeeBps: bigint, maxSkewFeeBps: bigint, margin?: bigint): bigint {
  const fee = ceilDiv(size * (baseFeeBps + maxSkewFeeBps), BPS);
  return margin === undefined ? fee : fee < feeCap(margin) ? fee : feeCap(margin);
}

/** Base fee on `size` (the close fee), capped at 10% of margin when the margin is given. */
export function baseFee(size: bigint, baseFeeBps: bigint, margin?: bigint): bigint {
  const fee = ceilDiv(size * baseFeeBps, BPS);
  return margin === undefined ? fee : fee < feeCap(margin) ? fee : feeCap(margin);
}

/** Worst acceptable fill for a buy (price may rise by `slippageBps`). */
export function withSlippageUp(price: bigint, slippageBps: bigint): bigint {
  return ceilDiv(price * (BPS + slippageBps), BPS);
}

/** Worst acceptable fill for a sell (price may fall by `slippageBps`). */
export function withSlippageDown(price: bigint, slippageBps: bigint): bigint {
  return (price * (BPS - slippageBps)) / BPS;
}

/** Units of the underlying (18 dec) that `size` USDC of notional represents at `price`. */
export function unitsOf(size: bigint, price: bigint): bigint {
  return price === 0n ? 0n : (size * UNIT_SCALE) / price;
}

/** USDC notional (6 dec) of `units` (18 dec) of the underlying at `price`. */
export function notionalOf(units: bigint, price: bigint): bigint {
  return (units * price) / UNIT_SCALE;
}

/** bigint ratio as a JS number, for display only. */
export function ratio(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) return NaN;
  const scaled = (numerator * 1_000_000_000n) / denominator;
  return Number(scaled) / 1e9;
}

/** Scales a bigint by a float factor with 1e-9 resolution (display-side conversions such as % of entry). */
export function scaleBy(value: bigint, factor: number): bigint {
  if (!Number.isFinite(factor)) return 0n;
  return (value * BigInt(Math.round(factor * 1e9))) / 1_000_000_000n;
}

/** PositionMath.UNIT_PRECISION: the engine's unit counters are `size * 1e36 / entry`. */
const ENGINE_UNIT_PRECISION = 10n ** 36n;

/**
 * The position after adding `addSize` filled at `price` (v3.1 merges): sizes and margins add, the entry is size over
 * units, rounded against the trader (up for a long, down for a short), exactly as `PerpEngine._open` computes it.
 */
export function mergedPosition(
  pos: { size: bigint; margin: bigint; entryPrice: bigint; isLong: boolean },
  addSize: bigint,
  addMargin: bigint,
  price: bigint,
): { size: bigint; margin: bigint; entryPrice: bigint } {
  const units = (pos.size * ENGINE_UNIT_PRECISION) / pos.entryPrice + (addSize * ENGINE_UNIT_PRECISION) / price;
  const size = pos.size + addSize;
  const scaled = size * ENGINE_UNIT_PRECISION;
  return { size, margin: pos.margin + addMargin, entryPrice: pos.isLong ? ceilDiv(scaled, units) : scaled / units };
}

/** Margin released by closing `closeSize` of a position (v3.1 partial close), or null when everything closes. */
export function partialRelease(size: bigint, margin: bigint, closeSize: bigint, minMargin: bigint): bigint | null {
  if (closeSize <= 0n || closeSize >= size) return null;
  const released = (margin * closeSize) / size;
  return margin - released < minMargin ? null : released;
}

/** Prices of a ladder of `count` orders from `from` to `to`, both included and evenly spaced. */
export function ladderPrices(from: bigint, to: bigint, count: number): bigint[] {
  if (!Number.isInteger(count) || count < 1) return [];
  if (count === 1) return [from];
  const step = (to - from) / BigInt(count - 1);
  return Array.from({ length: count }, (_, i) => (i === count - 1 ? to : from + step * BigInt(i)));
}

/**
 * The position a ladder of equal orders adds up to if every order fills (onto `held`, when there is one): size,
 * margin and the engine's blended entry, rounded against the trader as the engine rounds it.
 */
export function ladderFill(
  orders: readonly { price: bigint; size: bigint; margin: bigint }[],
  isLong: boolean,
  held: { size: bigint; margin: bigint; entryPrice: bigint } | null = null,
): { size: bigint; margin: bigint; entryPrice: bigint } | null {
  let pos = held;
  for (const o of orders) {
    if (o.price <= 0n || o.size <= 0n) return null;
    pos = pos ? mergedPosition({ ...pos, isLong }, o.size, o.margin, o.price) : { size: o.size, margin: o.margin, entryPrice: o.price };
  }
  return pos;
}
