"use client";

import { useEffect, useMemo, useSyncExternalStore } from "react";
import { useChainNow, useMarketData } from "@/hooks/use-market-data";
import { useStatsFile } from "@/hooks/use-venue-stats";
import type { Instrument } from "@/lib/instruments";
import { HISTORY_FINE_SECONDS, HISTORY_HOUR_SECONDS, type HistoryPoint } from "@/lib/stats-file";

const YEAR = 365 * 86_400;
/** Live samples: at most one a minute per market (chain time), a day of them. */
export const LIVE_SECONDS = 60;
const LIVE_KEEP = 24 * 60;

/** A market's funding and open interest now, in the indexer's units (bp a year, whole USDC). */
export function livePoint(instrument: Instrument, mid: number | null, time: number): HistoryPoint {
  return {
    time,
    fundingBps: Number((instrument.fundingRate * BigInt(YEAR) * 10_000n) / 10n ** 18n),
    longOi: Number(instrument.longOi / 1_000_000n),
    shortOi: Number(instrument.shortOi / 1_000_000n),
    mid,
  };
}

// Samples taken while the app is open, shared by every panel: they continue the indexer's series, or stand in for it
// on a deployment without one.
const live = new Map<string, HistoryPoint[]>();
const listeners = new Set<() => void>();
let version = 0;

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function record(id: string, point: HistoryPoint): boolean {
  const list = live.get(id) ?? [];
  const last = list[list.length - 1];
  if (last && point.time < last.time) return false;
  if (last && last.time === point.time) {
    if (last.fundingBps === point.fundingBps && last.longOi === point.longOi && last.shortOi === point.shortOi && last.mid === point.mid) return false;
    list[list.length - 1] = point;
  } else list.push(point);
  if (list.length > LIVE_KEEP) list.splice(0, list.length - LIVE_KEEP);
  live.set(id, list);
  return true;
}

/** Records a live sample of every market at most once a minute while mounted. */
export function useLiveMarketSamples(): void {
  const { instruments, prices } = useMarketData();
  const chainNow = useChainNow(5_000);
  const minute = Math.floor(chainNow / LIVE_SECONDS) * LIVE_SECONDS;
  useEffect(() => {
    if (minute <= 0) return;
    let changed = false;
    for (const i of instruments) {
      const p = prices.get(i.id);
      const mid = p?.mark ? Number(p.mark) / 1e18 : null;
      if (record(i.id, livePoint(i, mid !== null && Number.isFinite(mid) && mid > 0 ? Number(mid.toPrecision(7)) : null, minute))) changed = true;
    }
    if (changed) {
      version += 1;
      for (const l of listeners) l();
    }
  }, [instruments, prices, minute]);
}

/** Keeps the last point of each `seconds` bucket after `after`, stamped at the bucket's start. */
function bucketed(points: readonly HistoryPoint[], seconds: number, after: number): HistoryPoint[] {
  const out: HistoryPoint[] = [];
  for (const p of points) {
    const t = Math.floor(p.time / seconds) * seconds;
    if (t <= after) continue;
    const last = out[out.length - 1];
    if (last && last.time === t) out[out.length - 1] = { ...p, time: t };
    else out.push({ ...p, time: t });
  }
  return out;
}

export type MarketHistoryView = {
  /** Hourly points, oldest first, continued with live samples. */
  hourly: HistoryPoint[];
  /** 5-minute points for the last day (live samples a minute apart when there is no indexer history). */
  fine: HistoryPoint[];
  /** "indexer": stats.json history continued live; "live": only what this page has seen since it opened. */
  source: "indexer" | "live";
  /** Unix seconds of the indexer's latest sample, if any. */
  sampledAt: number | null;
  loading: boolean;
};

/** Funding and open-interest history of one market: the indexer's series, continued with live samples. */
export function useMarketHistory(marketId: string): MarketHistoryView {
  const file = useStatsFile();
  const id = marketId.toLowerCase();
  const liveVersion = useSyncExternalStore(subscribe, () => version, () => 0);
  const ready = file.data?.status === "ready" ? file.data.history : null;
  return useMemo(() => {
    void liveVersion;
    const hourly = ready?.hourly[id] ?? [];
    const fine = ready?.fine[id] ?? [];
    const tail = live.get(id) ?? [];
    const hasIndexer = hourly.length > 0 || fine.length > 0;
    const lastHour = hourly.length > 0 ? hourly[hourly.length - 1]!.time : -Infinity;
    const lastFine = fine.length > 0 ? fine[fine.length - 1]!.time : -Infinity;
    return {
      hourly: [...hourly, ...bucketed(tail, HISTORY_HOUR_SECONDS, lastHour)],
      fine: hasIndexer ? [...fine, ...bucketed(tail, HISTORY_FINE_SECONDS, lastFine)] : [...tail],
      source: hasIndexer ? "indexer" : "live",
      sampledAt: ready && ready.sampledAt > 0 ? ready.sampledAt : null,
      loading: file.isLoading,
    };
  }, [ready, id, liveVersion, file.isLoading]);
}
