/** Client-side mirrors of PerpEngine arithmetic. Everything is bigint; see PerpEngine.sol for the reference. */

export const BPS = 10_000n;
export const ONE = 10n ** 18n;
export const LIQUIDATION_THRESHOLD_BPS = 9_000n;
export const SECONDS_PER_YEAR = 31_536_000;

export function ceilDiv(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

export function absDiff(a: bigint, b: bigint): bigint {
  return a > b ? a - b : b - a;
}

/** Price PnL in USDC (6 dec), rounded against the trader exactly like `_pricePnl`. */
export function pricePnl(size: bigint, entry: bigint, price: bigint, isLong: boolean): bigint {
  if (entry === 0n) return 0n;
  const profit = isLong ? price >= entry : price <= entry;
  const numerator = size * absDiff(price, entry);
  return profit ? numerator / entry : -ceilDiv(numerator, entry);
}

/** Liquidation price of a fresh position (no funding accrued yet), mirroring `_liquidationPrice`. */
export function estimateLiquidationPrice(entry: bigint, margin: bigint, size: bigint, isLong: boolean): bigint | null {
  if (size === 0n || entry === 0n) return null;
  const room = (margin * LIQUIDATION_THRESHOLD_BPS) / BPS;
  if (isLong) {
    if (room >= size) return 0n;
    return ceilDiv(entry * (size - room), size);
  }
  return (entry * (size + room)) / size;
}

/** Upper bound of the open fee, as escrowed for limit orders. */
export function maxOpenFee(size: bigint, baseFeeBps: bigint, maxSkewFeeBps: bigint): bigint {
  return ceilDiv(size * (baseFeeBps + maxSkewFeeBps), BPS);
}

export function closeFee(size: bigint, baseFeeBps: bigint): bigint {
  return ceilDiv(size * baseFeeBps, BPS);
}

/** Worst acceptable fill for a buy (price may rise by `slippageBps`). */
export function withSlippageUp(price: bigint, slippageBps: bigint): bigint {
  return ceilDiv(price * (BPS + slippageBps), BPS);
}

/** Worst acceptable fill for a sell (price may fall by `slippageBps`). */
export function withSlippageDown(price: bigint, slippageBps: bigint): bigint {
  return (price * (BPS - slippageBps)) / BPS;
}

/** bigint ratio as a JS number, for display only. */
export function ratio(numerator: bigint, denominator: bigint): number {
  if (denominator === 0n) return NaN;
  const scaled = (numerator * 1_000_000_000n) / denominator;
  return Number(scaled) / 1e9;
}
