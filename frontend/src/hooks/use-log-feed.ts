"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { usePublicClient } from "wagmi";
import type { Address } from "viem";
import { useAppConfig } from "@/components/providers";
import { EMPTY_FEED, LogFeed, type LogFeedSnapshot } from "@/lib/events";

const noopSubscribe = () => () => {};
const emptySnapshot = (): LogFeedSnapshot => EMPTY_FEED;

/**
 * Engine events from the chain: a bounded back-fill of the last `lookbackSeconds`, then a live tail.
 * With `trader` the RPC filters on the indexed trader topic.
 */
export function useLogFeed(options: {
  enabled?: boolean;
  trader?: Address;
  lookbackSeconds: number;
  pollMs?: number;
  maxEvents?: number;
  exactTimes?: boolean;
  /** Blocks per back-fill request; see `LogFeedOptions.blockRange`. */
  blockRange?: number;
}) {
  const cfg = useAppConfig();
  const client = usePublicClient({ chainId: cfg.chainId });
  const { enabled = true, trader, lookbackSeconds, pollMs = 1_000, maxEvents = 4_000, exactTimes = false, blockRange } = options;
  const [feed, setFeed] = useState<LogFeed | null>(null);

  useEffect(() => {
    if (!client || !enabled) {
      setFeed(null);
      return;
    }
    const next = new LogFeed({ client, engine: cfg.perpEngine, trader, lookbackSeconds, pollMs, maxEvents, exactTimes, blockRange });
    next.start();
    setFeed(next);
    return () => next.stop();
  }, [client, cfg.perpEngine, enabled, trader, lookbackSeconds, pollMs, maxEvents, exactTimes, blockRange]);

  const snapshot = useSyncExternalStore(feed?.subscribe ?? noopSubscribe, feed?.getSnapshot ?? emptySnapshot, emptySnapshot);
  return { ...snapshot, extend: (seconds: number) => (feed ? feed.extend(seconds) : Promise.resolve()) };
}

export type LogFeedHandle = ReturnType<typeof useLogFeed>;
