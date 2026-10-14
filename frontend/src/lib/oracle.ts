import { ceilDiv, ONE } from "./math";

/** An 18-decimal price band as the engine sees it. Buys execute at `ask`, sells at `bid`. */
export type Quote = { mid: bigint; bid: bigint; ask: bigint; publishTime: number };

/** Normalises a raw Pyth-shaped price to 18 decimals exactly as `PythOracle._feed` does. */
export function pythToQuote(price: bigint, conf: bigint, expo: number, publishTime: number): Quote | null {
  if (price <= 0n || !Number.isInteger(expo) || expo > 0 || expo < -18 || conf < 0n || conf >= price) return null;
  const scale = 10n ** BigInt(18 + expo);
  return { mid: price * scale, bid: (price - conf) * scale, ask: (price + conf) * scale, publishTime };
}

/** Mirrors `PythOracle.peek`: optional division by a quote feed, then optional inversion. */
export function composeQuote(base: Quote, quote: Quote | null, invert: boolean): Quote | null {
  let { mid, bid, ask, publishTime } = base;
  if (quote) {
    if (quote.ask === 0n || quote.bid === 0n || quote.mid === 0n) return null;
    bid = (bid * ONE) / quote.ask;
    ask = ceilDiv(ask * ONE, quote.bid);
    mid = (mid * ONE) / quote.mid;
    publishTime = Math.min(publishTime, quote.publishTime);
    if (bid === 0n) return null;
  }
  if (invert) {
    if (bid === 0n || mid === 0n || ask === 0n) return null;
    const one = ONE * ONE;
    const invertedBid = one / ask;
    ask = ceilDiv(one, bid);
    bid = invertedBid;
    mid = one / mid;
    if (bid === 0n) return null;
  }
  return { mid, bid, ask, publishTime };
}
