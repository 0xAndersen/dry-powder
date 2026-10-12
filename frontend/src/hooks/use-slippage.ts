"use client";

import { useCallback, useSyncExternalStore } from "react";

const STORAGE_KEY = "arc-house:slippage-bps";
export const DEFAULT_SLIPPAGE_BPS = 30;
export const MAX_SLIPPAGE_BPS = 5_000;

let current = DEFAULT_SLIPPAGE_BPS;
let loaded = false;
const listeners = new Set<() => void>();

function load(): void {
  if (loaded || typeof window === "undefined") return;
  loaded = true;
  try {
    const stored = Number(window.localStorage.getItem(STORAGE_KEY));
    if (Number.isInteger(stored) && stored >= 0 && stored <= MAX_SLIPPAGE_BPS && window.localStorage.getItem(STORAGE_KEY) !== null) {
      current = stored;
    }
  } catch {
    // Storage can be unavailable (private mode); the default applies.
  }
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot(): number {
  load();
  return current;
}

/** Slippage tolerance in basis points, shared by the order form and the close button. */
export function useSlippage(): [number, (bps: number) => void] {
  const value = useSyncExternalStore(subscribe, getSnapshot, () => DEFAULT_SLIPPAGE_BPS);
  const set = useCallback((bps: number) => {
    if (!Number.isInteger(bps) || bps < 0 || bps > MAX_SLIPPAGE_BPS) return;
    current = bps;
    loaded = true;
    try {
      window.localStorage.setItem(STORAGE_KEY, String(bps));
    } catch {
      // Ignored: the setting still applies for this session.
    }
    for (const listener of listeners) listener();
  }, []);
  return [value, set];
}
