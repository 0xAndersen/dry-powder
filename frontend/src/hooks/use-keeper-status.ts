"use client";

import { useQuery } from "@tanstack/react-query";

/** The hosted keeper's health snapshot (pushed to the repository's status branch every 5 minutes). */
export const KEEPER_STATUS_URL = "https://raw.githubusercontent.com/0xAndersen/dry-powder/status/status/keeper.json";

export type KeeperHealth = {
  ok?: boolean;
  last?: { at?: number };
  stats?: { executed?: number; liquidated?: number; pushes?: number; feedsPushed?: number; ticks?: number; errors?: Record<string, number> };
  kraken?: unknown;
  uptimeS?: number;
};

export function useKeeperStatus(enabled = true) {
  const health = useQuery({
    queryKey: ["keeper-status"],
    refetchInterval: 60_000,
    retry: 1,
    enabled,
    queryFn: async () => {
      const r = await fetch(`${KEEPER_STATUS_URL}?t=${Math.floor(Date.now() / 60_000)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      return (await r.json()) as KeeperHealth;
    },
  });
  const at = health.data?.last?.at ?? 0;
  const ageMin = at ? Math.max(0, Math.round((Date.now() - at) / 60_000)) : null;
  // Snapshots arrive every 5 minutes; older than 12 means the keeper (or its status push) has stopped.
  const fresh = ageMin !== null && ageMin <= 12;
  const tone: "ok" | "warn" | "bad" | "idle" = health.isError || !health.data ? "idle" : health.data.ok && fresh ? "ok" : fresh ? "warn" : "bad";
  const text = !health.data ? "Keeper" : health.data.ok && fresh ? "Keeper running" : fresh ? "Keeper degraded" : "Keeper not reporting";
  return { data: health.data, isError: health.isError, ageMin, fresh, tone, text };
}
