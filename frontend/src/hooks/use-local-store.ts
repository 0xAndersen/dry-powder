"use client";

import { useSyncExternalStore } from "react";
import type { LocalStore } from "@/lib/storage";

export function useLocalStore<T>(store: LocalStore<T>): [T, LocalStore<T>["set"]] {
  const value = useSyncExternalStore(store.subscribe, store.get, () => store.initial);
  return [value, store.set];
}
