"use client";

import { useEffect, useMemo } from "react";
import { useLocalStore } from "@/hooks/use-local-store";
import type { LogFeedHandle } from "@/hooks/use-log-feed";
import { fmtClock, fmtUsdc } from "@/lib/format";
import { prefs, utcDayStart } from "@/lib/prefs";

/**
 * The trader's own limits (Settings): the daily loss limit and the cool-off after a liquidation. Returns the
 * sentence to show while new positions are refused, or null. Reads the account's own history from `feed`.
 */
export function useRiskLimits(feed: LogFeedHandle, chainNow: number): string | null {
  const [preferences] = useLocalStore(prefs);
  // Realised result since 00:00 UTC: price PnL, fees and liquidations.
  const dayStart = utcDayStart();
  const limit = preferences.dailyLossLimit;
  useEffect(() => {
    // Make sure the history covers the whole UTC day when a limit is set.
    if (limit !== null && feed.status.phase === "live" && feed.status.loadedFromTime > dayStart) void feed.extend(feed.status.loadedFromTime - dayStart + 60);
  }, [limit, feed, dayStart]);
  const todayResult = useMemo(() => {
    if (limit === null) return null;
    let total = 0n;
    for (const e of feed.events) {
      if (e.time < dayStart) continue;
      if (e.type === "close") total += e.pnl - e.fee;
      else if (e.type === "open") total -= e.fee;
      else if (e.type === "liquidation") total -= e.margin;
    }
    return total;
  }, [limit, feed.events, dayStart]);
  const dailyLimitText =
    limit !== null && todayResult !== null && todayResult <= -BigInt(Math.round(limit * 1e6))
      ? `Daily loss limit reached (${fmtUsdc(todayResult, 2, { sign: true })} today). New positions reopen at 00:00 UTC`
      : null;
  // Self-imposed cool-off: no new positions for a while after a liquidation.
  const coolOff = preferences.coolOffMinutes;
  const lastLiquidation = useMemo(() => {
    if (coolOff === null) return null;
    let last = 0;
    for (const e of feed.events) if (e.type === "liquidation" && e.time > last) last = e.time;
    return last || null;
  }, [coolOff, feed.events]);
  const coolOffUntil = coolOff !== null && lastLiquidation !== null ? lastLiquidation + coolOff * 60 : null;
  const coolOffText = coolOffUntil !== null && chainNow < coolOffUntil ? `Cooling off after a liquidation. New positions reopen at ${fmtClock(coolOffUntil)}` : null;
  return dailyLimitText ?? coolOffText;
}
