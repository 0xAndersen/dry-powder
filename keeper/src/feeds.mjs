// Price feeds the publisher signs (Pyth ids, so moving to real Pyth later is configuration only) and the
// Kraken pairs they are read from.
import { encodeAbiParameters, keccak256 } from "viem";

export const FEEDS = [
  { key: "BTC", id: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", expo: -8, pair: "XBTUSD", alt: "XXBTZUSD" },
  { key: "ETH", id: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", expo: -8, pair: "ETHUSD", alt: "XETHZUSD" },
  { key: "SOL", id: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", expo: -8, pair: "SOLUSD", alt: "SOLUSD" },
  { key: "EUR", id: "0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b", expo: -5, pair: "EURUSD", alt: "ZEURZUSD" },
  { key: "JPY", id: "0xef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52", expo: -3, pair: "USDJPY", alt: "ZUSDZJPY" },
  { key: "XAU", id: "0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2", expo: -3, pair: "PAXGUSD", alt: "PAXGUSD" },
];
export const FEED_BY_ID = new Map(FEEDS.map((f) => [f.id.toLowerCase(), f]));

const DIGEST_TYPES = ["uint256", "address", "bytes32", "int64", "uint64", "int32", "uint64"].map((type) => ({ type }));
const UPDATE_TYPES = ["bytes32", "int64", "uint64", "int32", "uint64", "bytes"].map((type) => ({ type }));

/** Integer price and confidence in the feed's exponent from a bid/ask quote: mid, max(half spread, 1 bp). */
export function quoteToPrice(feed, bid, ask) {
  const mid = (bid + ask) / 2;
  const scale = 10 ** -feed.expo;
  const price = BigInt(Math.round(mid * scale));
  // Tolerance absorbs float noise (1.1e-4 * 1e5 is 11.000000000000002, which must stay 11).
  let conf = BigInt(Math.ceil(Math.max(Math.abs(ask - bid) / 2, mid * 1e-4) * scale - 1e-6));
  if (conf < 1n) conf = 1n;
  return { price, conf, mid };
}

/** One PublisherOracle update (V2_SPEC.md): EIP-191 signature over the chain-bound digest. */
export async function signUpdate(signer, chainId, oracle, feed, price, conf, publishTime) {
  const digest = keccak256(
    encodeAbiParameters(DIGEST_TYPES, [BigInt(chainId), oracle, feed.id, price, conf, feed.expo, BigInt(publishTime)]),
  );
  const sig = await signer.signMessage({ message: { raw: digest } });
  return encodeAbiParameters(UPDATE_TYPES, [feed.id, price, conf, feed.expo, BigInt(publishTime), sig]);
}

/** Latest bid/ask per feed from Kraken's public ticker. A ticker frozen for `staleMs` is treated as closed. */
export function makeKraken(baseUrl, staleMs = 60_000) {
  const state = new Map(); // key -> { bid, ask, at, fp, changedAt }
  async function poll() {
    const url = `${baseUrl}/0/public/Ticker?pair=${FEEDS.map((f) => f.pair).join(",")}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(8_000) });
    if (!r.ok) throw new Error(`kraken http ${r.status}`);
    const j = await r.json();
    if (j.error?.length) throw new Error(`kraken ${j.error[0]}`);
    const t = Date.now();
    for (const f of FEEDS) {
      const k = j.result[f.alt] ?? j.result[f.pair];
      if (!k) continue;
      const fp = [k.a?.[0], k.b?.[0], k.c?.[0], k.v?.[0], k.t?.[0]].join("|");
      const prev = state.get(f.key);
      const changedAt = !prev || prev.fp !== fp ? t : prev.changedAt;
      state.set(f.key, { bid: +k.b[0], ask: +k.a[0], at: t, fp, changedAt });
    }
  }
  /** Usable quote for `feed`, or null if missing, old or frozen (closed market, e.g. FX at the weekend). */
  function quote(feed) {
    const q = state.get(feed.key);
    if (!q || !(q.bid > 0) || !(q.ask > 0)) return null;
    const t = Date.now();
    if (t - q.at > 15_000 || t - q.changedAt > staleMs) return null;
    return q;
  }
  return { poll, quote };
}
