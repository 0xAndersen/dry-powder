"use client";

import { useMemo } from "react";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useApp } from "@/components/providers";
import { krakenSource, type Instrument } from "@/lib/instruments";
import { fetchInstrumentCandles, type Candle } from "@/lib/kraken";

export type DayStats = {
  /** Close of the hourly bar that ended 24 hours before the latest one. */
  reference: number;
  /** Hourly closes over the last 24 hours, oldest first (the sparkline). */
  closes: number[];
  high: number;
  low: number;
};

/** The last day of hourly candles in the shape the header and the markets list need. */
export function dayStatsFrom(candles: readonly Candle[]): DayStats | null {
  const last = candles[candles.length - 1];
  if (!last) return null;
  let start = 0;
  for (let i = 0; i < candles.length; i += 1) {
    if (candles[i]!.time <= last.time - 86_400) start = i;
    else break;
  }
  const day = candles.slice(start);
  if (day.length < 2) return null;
  let high = -Infinity;
  let low = Infinity;
  for (const c of day.slice(1)) {
    if (c.high > high) high = c.high;
    if (c.low < low) low = c.low;
  }
  return { reference: day[0]!.close, closes: day.map((c) => c.close), high, low };
}

/** One market's query: shared by every caller (react-query dedupes on the key). */
function dayStatsQuery(krakenUrl: string, instrument: Instrument | undefined) {
  const source = instrument ? krakenSource(instrument) : null;
  return {
    queryKey: ["day-stats", krakenUrl, instrument?.id ?? null] as const,
    enabled: source !== null,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    retry: 1,
    queryFn: async ({ signal }: { signal: AbortSignal }) => dayStatsFrom(await fetchInstrumentCandles(krakenUrl, source!, 60, signal)),
  };
}

export type DayView = {
  stats: DayStats | null;
  /** Live price against the price 24 hours ago; null without both. */
  change: number | null;
  /** Sparkline values ending at the live price. */
  closes: number[] | null;
  loading: boolean;
};

function view(stats: DayStats | null | undefined, live: number | null, loading: boolean): DayView {
  if (!stats) return { stats: null, change: null, closes: null, loading };
  const fresh = live !== null && Number.isFinite(live) && live > 0;
  return {
    stats,
    change: fresh && stats.reference > 0 ? live / stats.reference - 1 : null,
    closes: fresh ? [...stats.closes, live] : stats.closes,
    loading: false,
  };
}

/**
 * 24-hour change, range and a sparkline from the tape's hourly candles (display only, like every tape figure).
 * Shared by the market header and the markets page, so both read one cached request per market.
 */
export function useDayStats(instrument: Instrument | undefined, live: number | null): DayView {
  const { config: cfg } = useApp();
  const query = useQuery(dayStatsQuery(cfg.krakenUrl, instrument));
  const enabled = instrument ? krakenSource(instrument) !== null : false;
  return useMemo(() => view(query.data, live, enabled && query.isPending), [query.data, live, enabled, query.isPending]);
}

/** Day stats for many markets at once, keyed by market id (for sorting a list by 24h change). */
export function useDayStatsMany(instruments: readonly Instrument[], liveOf: (id: string) => number | null): Map<string, DayView> {
  const { config: cfg } = useApp();
  const results = useQueries({ queries: instruments.map((i) => dayStatsQuery(cfg.krakenUrl, i)) });
  const data = results.map((r) => r.data);
  const pending = results.map((r) => r.isPending);
  const out = new Map<string, DayView>();
  instruments.forEach((i, n) => {
    const enabled = krakenSource(i) !== null;
    out.set(i.id, view(data[n], liveOf(i.id), enabled && pending[n] === true));
  });
  return out;
}
