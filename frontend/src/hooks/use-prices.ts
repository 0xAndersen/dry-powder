"use client";

import { useCallback, useEffect, useState, useSyncExternalStore } from "react";
import type { Hex } from "viem";
import { useApp } from "@/components/providers";
import type { FeedStatus, PriceTick } from "@/lib/pyth";

/** A market counts as closed once its latest price is older than this. The engine itself allows 3 s. */
export const STALE_AFTER_SECONDS = 8;

export function usePrice(id: Hex): PriceTick | undefined {
  const { prices } = useApp();
  const getSnapshot = useCallback(() => prices.getTick(id), [prices, id]);
  return useSyncExternalStore(prices.subscribe, getSnapshot, () => undefined);
}

export function useFeedStatus(): FeedStatus {
  const { prices } = useApp();
  return useSyncExternalStore(prices.subscribe, prices.getStatus, () => "connecting" as const);
}

/** Wall-clock time that re-renders the caller every `intervalMs`. */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

export type PriceState = {
  tick: PriceTick | undefined;
  /** Seconds since the oracle published this price. */
  age: number | undefined;
  /** True when the engine would reject the price as stale (weekend FX, oracle outage). */
  stale: boolean;
};

export function usePriceState(id: Hex): PriceState {
  const { prices } = useApp();
  const tick = usePrice(id);
  const now = useNow(1_000);
  if (!tick) return { tick: undefined, age: undefined, stale: false };
  const age = prices.ageOf(tick, now);
  return { tick, age, stale: age > STALE_AFTER_SECONDS };
}
