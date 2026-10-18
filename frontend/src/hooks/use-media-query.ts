"use client";

import { useSyncExternalStore } from "react";

/** Live `matchMedia` result; false on the server and before hydration. */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      if (typeof window === "undefined" || !window.matchMedia) return () => {};
      const list = window.matchMedia(query);
      list.addEventListener("change", onChange);
      return () => list.removeEventListener("change", onChange);
    },
    () => (typeof window !== "undefined" && window.matchMedia ? window.matchMedia(query).matches : false),
    () => false,
  );
}
