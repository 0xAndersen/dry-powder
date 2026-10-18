import { createLocalStore } from "./storage";

/** Personal preferences beyond the ticket's trade settings: notifications, haptics and self-imposed risk limits. */
export type Prefs = {
  /** Warn when this share of a position's liquidation buffer is left (`half`: 50%, `quarter`: 25%), or never. */
  liqWarn: "off" | "half" | "quarter";
  /** System notifications for fills, take-profits, stop-losses and liquidations (needs notifications allowed). */
  fillNotifications: boolean;
  /** Vibrate on fills and warnings (phones). */
  haptics: boolean;
  /** Price and PnL in the browser tab title. */
  titleTicker: boolean;
  /** Stop opening new positions after losing this much (whole collateral units) since 00:00 UTC. Null: no limit. */
  dailyLossLimit: number | null;
  /** Personal leverage cap, below the market maximum. Null: the market's own maximum. */
  maxLeverage: number | null;
};

export const DEFAULT_PREFS: Prefs = {
  liqWarn: "half",
  fillNotifications: true,
  haptics: true,
  titleTicker: true,
  dailyLossLimit: null,
  maxLeverage: null,
};

export const prefs = createLocalStore<Prefs>("dp:prefs:v1", DEFAULT_PREFS, (stored) => {
  if (!stored || typeof stored !== "object") return null;
  const s = stored as Partial<Prefs>;
  const positive = (v: unknown, max: number) => {
    const n = Number(v);
    return v !== null && v !== undefined && Number.isFinite(n) && n > 0 && n <= max ? n : null;
  };
  return {
    liqWarn: s.liqWarn === "off" || s.liqWarn === "quarter" ? s.liqWarn : "half",
    fillNotifications: s.fillNotifications !== false,
    haptics: s.haptics !== false,
    titleTicker: s.titleTicker !== false,
    dailyLossLimit: positive(s.dailyLossLimit, 1e12),
    maxLeverage: positive(s.maxLeverage, 1000),
  };
});

/** Unix seconds of the most recent 00:00 UTC. */
export function utcDayStart(nowMs = Date.now()): number {
  const d = new Date(nowMs);
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 1000);
}
