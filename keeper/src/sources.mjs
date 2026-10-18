// Several exchanges behind one price: the publisher signs the median of the venues that agree, so a single
// venue's order book cannot move the venue's price (the failure mode that let one trader pull ~$1.28M out of a
// 1000x venue priced from a single book's midpoint in October 2026).
//
// Every source exposes { name, poll(), quote(feed) -> { bid, ask, at } | null }, like makeKraken in feeds.mjs.

/** Coinbase Exchange public tickers (one request per product). */
export function makeCoinbase(baseUrl = "https://api.exchange.coinbase.com", products = { BTC: "BTC-USD", ETH: "ETH-USD", SOL: "SOL-USD", XAU: "PAXG-USD" }, staleMs = 60_000) {
  const state = new Map();
  return {
    name: "coinbase",
    async poll() {
      const t = Date.now();
      await Promise.all(
        Object.entries(products).map(async ([key, product]) => {
          try {
            const r = await fetch(`${baseUrl}/products/${product}/ticker`, { signal: AbortSignal.timeout(5_000), headers: { "user-agent": "dry-powder-keeper" } });
            if (!r.ok) return;
            const j = await r.json();
            const bid = Number(j.bid);
            const ask = Number(j.ask);
            if (bid > 0 && ask > 0) {
              const prev = state.get(key);
              const fp = `${j.bid}|${j.ask}|${j.trade_id ?? ""}`;
              state.set(key, { bid, ask, at: t, fp, changedAt: !prev || prev.fp !== fp ? t : prev.changedAt });
            }
          } catch {
            // One product failing leaves the others usable.
          }
        }),
      );
    },
    quote(feed) {
      const q = state.get(feed.key);
      if (!q) return null;
      const t = Date.now();
      if (t - q.at > 15_000 || t - q.changedAt > staleMs) return null;
      return q;
    },
  };
}

/** Bitstamp public tickers. */
export function makeBitstamp(baseUrl = "https://www.bitstamp.net", pairs = { BTC: "btcusd", ETH: "ethusd", SOL: "solusd", EUR: "eurusd" }, staleMs = 60_000) {
  const state = new Map();
  return {
    name: "bitstamp",
    async poll() {
      const t = Date.now();
      await Promise.all(
        Object.entries(pairs).map(async ([key, pair]) => {
          try {
            const r = await fetch(`${baseUrl}/api/v2/ticker/${pair}/`, { signal: AbortSignal.timeout(5_000) });
            if (!r.ok) return;
            const j = await r.json();
            const bid = Number(j.bid);
            const ask = Number(j.ask);
            if (bid > 0 && ask > 0) {
              const prev = state.get(key);
              const fp = `${j.bid}|${j.ask}|${j.timestamp ?? ""}`;
              state.set(key, { bid, ask, at: t, fp, changedAt: !prev || prev.fp !== fp ? t : prev.changedAt });
            }
          } catch {
            // As above.
          }
        }),
      );
    },
    quote(feed) {
      const q = state.get(feed.key);
      if (!q) return null;
      const t = Date.now();
      if (t - q.at > 15_000 || t - q.changedAt > staleMs) return null;
      return q;
    },
  };
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const n = s.length;
  return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2;
};

/**
 * Combines sources into one `{ poll, quote }`. For each feed:
 * - one fresh source: its quote (markets only one venue lists, such as FX on weekends, keep working);
 * - two or more: the median mid of the sources within `maxDeviationBps` of the median of all, with the widest
 *   half-spread among them as the band; if fewer than two agree, no quote at all (nothing gets published, so a
 *   disagreement can only pause a market, never misprice it).
 * `primary` (the first source) must poll successfully, as before; the others are best effort.
 */
export function makeMedianSource(sources, { maxDeviationBps = 50, onDisagree } = {}) {
  const [primary, ...others] = sources;
  return {
    name: sources.map((s) => s.name ?? "source").join("+"),
    async poll() {
      await Promise.all([primary.poll(), ...others.map((s) => s.poll().catch(() => undefined))]);
    },
    quote(feed) {
      const quotes = sources.map((s) => s.quote(feed)).filter((q) => q && q.bid > 0 && q.ask > 0 && q.ask >= q.bid);
      if (quotes.length === 0) return null;
      if (quotes.length === 1) return quotes[0];
      const mids = quotes.map((q) => (q.bid + q.ask) / 2);
      const m = median(mids);
      const limit = maxDeviationBps / 10_000;
      // Two venues: they must agree with each other (each is only half the gap from their own median).
      const agree =
        quotes.length === 2
          ? Math.abs(mids[0] - mids[1]) / m <= limit
            ? quotes
            : []
          : quotes.filter((_, i) => Math.abs(mids[i] - m) / m <= limit);
      if (agree.length < 2) {
        onDisagree?.(feed, mids);
        return null;
      }
      const mid = median(agree.map((q) => (q.bid + q.ask) / 2));
      const half = Math.max(...agree.map((q) => (q.ask - q.bid) / 2));
      return { bid: mid - half, ask: mid + half, at: Math.min(...agree.map((q) => q.at)), sources: agree.length };
    },
  };
}
