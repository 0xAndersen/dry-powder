"use client";

import { useDeferredValue, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { useApp } from "@/components/providers";
import { useLogFeed } from "@/hooks/use-log-feed";
import { aggregate, continueState, type StatsState } from "@/lib/aggregate";
import { fetchStatsFile, statsUrlFor, type StatsFileResult } from "@/lib/stats-file";

const DAY = 86_400;

/** The indexer's snapshot for this deployment (refetched every two minutes; the indexer writes every five). */
export function useStatsFile() {
  const { config: cfg } = useApp();
  const url = statsUrlFor(cfg);
  return useQuery<StatsFileResult>({
    queryKey: ["stats-file", url, cfg.chainId, cfg.perpEngine],
    enabled: url !== null,
    staleTime: 60_000,
    refetchInterval: 120_000,
    retry: 1,
    queryFn: ({ signal }) => fetchStatsFile(url!, cfg, signal),
  });
}

export type VenueStats = {
  state: StatsState | null;
  /** "indexer": the snapshot continued with live events; "live": only the events this page has read. */
  source: "indexer" | "live" | null;
  /** Unix seconds from which the figures are complete. */
  from: number | null;
  /** Unix seconds of the snapshot's last block (indexer source). */
  snapshotTime: number | null;
  /** The live feed started after the snapshot's cursor, so a few minutes are missing until the indexer catches up. */
  gap: boolean;
  loading: boolean;
  error: string | null;
};

/**
 * Venue, market and trader statistics for the leaderboard: the indexer's stats.json when it is published, kept
 * current with the engine's events since its cursor; otherwise computed from the last day of events read here.
 */
export function useVenueStats(): VenueStats {
  const { config: cfg } = useApp();
  const file = useStatsFile();
  const settled = file.data !== undefined || file.isError || statsUrlFor(cfg) === null;
  const ready = file.data?.status === "ready" ? file.data.state : null;

  // Decided once (changing it restarts the feed): with a snapshot, read from a little before its cursor; without
  // one, up to a day (or since the deployment, if that is sooner).
  const lookbackRef = useRef<number | null>(null);
  if (lookbackRef.current === null && settled) {
    const now = Date.now() / 1000;
    const since = cfg.overrides.includes("engine") ? null : cfg.deployedAt;
    lookbackRef.current = ready ? Math.max(600, now - ready.cursorTime + 300) : since ? Math.min(DAY, Math.max(3_600, now - since + 600)) : DAY;
  }
  const feed = useLogFeed({ enabled: lookbackRef.current !== null, lookbackSeconds: lookbackRef.current ?? DAY, pollMs: 3_000, maxEvents: 20_000, blockRange: 5_000 });
  const events = useDeferredValue(feed.events);

  return useMemo<VenueStats>(() => {
    if (!settled) return { state: null, source: null, from: null, snapshotTime: null, gap: false, loading: true, error: null };
    if (ready) {
      const state = continueState(ready, events);
      const gap = feed.status.loadedFromTime > 0 && feed.status.loadedFromTime > ready.cursorTime + 30 && feed.status.loadedFrom > ready.cursorBlock + 1;
      return { state, source: "indexer", from: ready.deployTime || null, snapshotTime: ready.cursorTime, gap, loading: false, error: null };
    }
    const backfilling = feed.status.phase === "starting" || (feed.status.phase === "backfilling" && events.length === 0);
    const state = aggregate(events, { chainId: cfg.chainId, engine: cfg.perpEngine });
    return {
      state,
      source: "live",
      from: feed.status.loadedFromTime || null,
      snapshotTime: null,
      gap: false,
      loading: backfilling,
      error: feed.status.phase === "error" ? (feed.status.error ?? "Event logs unavailable") : null,
    };
  }, [settled, ready, events, feed.status.loadedFromTime, feed.status.loadedFrom, feed.status.phase, feed.status.error, cfg.chainId, cfg.perpEngine]);
}
