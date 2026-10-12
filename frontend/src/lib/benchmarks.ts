import type { MarketInfo } from "./markets";

export const BENCHMARKS_URL = "https://benchmarks.pyth.network";

export type Resolution = "1" | "5" | "15" | "60" | "240" | "D";

export const RESOLUTIONS: readonly { key: Resolution; label: string; seconds: number; bars: number }[] = [
  { key: "1", label: "1m", seconds: 60, bars: 360 },
  { key: "5", label: "5m", seconds: 300, bars: 400 },
  { key: "15", label: "15m", seconds: 900, bars: 400 },
  { key: "60", label: "1h", seconds: 3_600, bars: 500 },
  { key: "240", label: "4h", seconds: 14_400, bars: 500 },
  { key: "D", label: "1D", seconds: 86_400, bars: 365 },
];

export function resolutionInfo(key: Resolution) {
  return RESOLUTIONS.find((r) => r.key === key) ?? RESOLUTIONS[2]!;
}

export type Candle = { time: number; open: number; high: number; low: number; close: number };

type HistoryResponse = {
  s: "ok" | "no_data" | "error";
  errmsg?: string;
  t?: number[];
  o?: number[];
  h?: number[];
  l?: number[];
  c?: number[];
};

function isPositive(n: unknown): n is number {
  return typeof n === "number" && Number.isFinite(n) && n > 0;
}

async function fetchRange(
  market: MarketInfo,
  resolution: Resolution,
  from: number,
  to: number,
  signal?: AbortSignal,
): Promise<Candle[]> {
  const params = new URLSearchParams({
    symbol: market.benchSymbol,
    resolution,
    from: String(Math.floor(from)),
    to: String(Math.ceil(to)),
  });
  const res = await fetch(`${BENCHMARKS_URL}/v1/shims/tradingview/history?${params.toString()}`, { signal });
  if (!res.ok) throw new Error(`Pyth Benchmarks returned HTTP ${res.status}`);
  const body = (await res.json()) as HistoryResponse;
  if (body.s === "error") throw new Error(body.errmsg || "Pyth Benchmarks could not serve this chart");
  if (body.s !== "ok" || !body.t) return [];

  const byTime = new Map<number, Candle>();
  for (let i = 0; i < body.t.length; i += 1) {
    const time = body.t[i];
    const o = body.o?.[i];
    const h = body.h?.[i];
    const l = body.l?.[i];
    const c = body.c?.[i];
    if (!isPositive(time) || !isPositive(o) || !isPositive(h) || !isPositive(l) || !isPositive(c)) continue;
    // Inverted markets quote 1/price, which swaps the roles of high and low.
    byTime.set(
      time,
      market.invert
        ? { time, open: 1 / o, high: 1 / l, low: 1 / h, close: 1 / c }
        : { time, open: o, high: h, low: l, close: c },
    );
  }
  return [...byTime.values()].sort((a, b) => a.time - b.time);
}

/** Candle history for a market, already inverted where the market is. Runs in the browser only. */
export async function fetchCandles(market: MarketInfo, resolution: Resolution, signal?: AbortSignal): Promise<Candle[]> {
  const info = resolutionInfo(resolution);
  const to = Date.now() / 1000 + 60;
  const span = info.bars * info.seconds;
  const candles = await fetchRange(market, resolution, to - span, to, signal);
  if (candles.length > 0) return candles;
  // FX markets are shut over the weekend: look further back so the chart still shows the last session.
  return fetchRange(market, resolution, to - span - 3 * 86_400, to, signal);
}

/** Price roughly 24 hours before the most recent candle, for the "24h" change figure. */
export async function fetchDayReference(market: MarketInfo, signal?: AbortSignal): Promise<number | null> {
  const to = Date.now() / 1000 + 60;
  const candles = await fetchRange(market, "60", to - 5 * 86_400, to, signal);
  const last = candles[candles.length - 1];
  if (!last) return null;
  const target = last.time - 86_400;
  let reference: Candle | undefined;
  for (const candle of candles) {
    if (candle.time <= target) reference = candle;
    else break;
  }
  return reference ? reference.close : (candles[0]?.open ?? null);
}
