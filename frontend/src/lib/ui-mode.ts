import { createLocalStore } from "./storage";
import type { Route } from "./nav";

/**
 * Two ways to use the app. Simple: pick a market, up or down, an amount, done; plain words and one tap in and out.
 * Advanced: the full terminal, every order type, agents and the chart wall.
 */
export type UiMode = "simple" | "advanced";

/** The mode the trader chose; null until they choose (the first visit asks). */
export const uiMode = createLocalStore<UiMode | null>("dp:ui-mode:v1", null, (stored) =>
  stored === "simple" || stored === "advanced" ? stored : null,
);

/** Where each mode starts. */
export const MODE_HOME: Record<UiMode, Route> = { simple: "simple", advanced: "trade" };
