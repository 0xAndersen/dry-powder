/**
 * Off-chain mirror of PerpEngine's price normalisation and trigger rules.
 *
 * These decide what the keeper *attempts*; every attempt is simulated against the contract before it is
 * sent, so a mismatch here can cost a missed or wasted simulation but never an incorrect on-chain action.
 */

export const ONE = 10n ** 18n;
export const MAX_UINT256 = 2n ** 256n - 1n;

/** Raw Pyth price as published. */
export interface PythPrice {
  price: bigint;
  conf: bigint;
  expo: number;
  publishTime: number;
}

/** Price normalised to 18 decimals, as PerpEngine sees it. */
export interface EnginePrice {
  mid: bigint;
  bid: bigint;
  ask: bigint;
  publishTime: number;
}

/** Same result as PerpEngine._peekPrice, or null where the contract would reject the price. */
export function toEnginePrice(p: PythPrice, invert: boolean): EnginePrice | null {
  if (p.price <= 0n || p.expo > 0 || p.expo < -18) return null;
  if (p.conf >= p.price) return null;
  const scale = 10n ** BigInt(18 + p.expo);
  let mid = p.price * scale;
  let bid = (p.price - p.conf) * scale;
  let ask = (p.price + p.conf) * scale;
  if (invert) {
    const one = ONE * ONE;
    const invertedBid = one / ask;
    const invertedAsk = (one + bid - 1n) / bid; // rounded up, like Math.ceilDiv
    bid = invertedBid;
    ask = invertedAsk;
    mid = one / mid;
    if (bid === 0n) return null;
  }
  return { mid, bid, ask, publishTime: p.publishTime };
}

/**
 * Whether a position is liquidatable at `mid`, given the liquidation price reported by
 * PerpEngine.getPositions. The contract uses sentinels when funding alone decides the outcome:
 * for a long, max-uint means "at any price" and 0 means "never"; for a short, 0 means "at any price".
 */
export function isLiquidatable(isLong: boolean, liquidationPrice: bigint, mid: bigint): boolean {
  if (isLong) return liquidationPrice === MAX_UINT256 || mid <= liquidationPrice;
  return mid >= liquidationPrice;
}

export const OrderType = { LimitOpen: 0, TakeProfit: 1, StopLoss: 2 } as const;

/** Whether an order's price condition holds, mirroring _fillLimit and _fillTrigger. */
export function isTriggered(orderType: number, isLong: boolean, triggerPrice: bigint, px: EnginePrice): boolean {
  switch (orderType) {
    case OrderType.LimitOpen:
      // A buy fills at the ask and must not pay more than the limit; a sell fills at the bid.
      return isLong ? px.ask <= triggerPrice : px.bid >= triggerPrice;
    case OrderType.TakeProfit:
      return isLong ? px.mid >= triggerPrice : px.mid <= triggerPrice;
    case OrderType.StopLoss:
      return isLong ? px.mid <= triggerPrice : px.mid >= triggerPrice;
    default:
      return false;
  }
}

/** Splits `items` into consecutive chunks of at most `size`. */
export function chunk<T>(items: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}
