"use client";

import { useMemo } from "react";
import { useReadContract, useReadContracts } from "wagmi";
import type { Address, Hex } from "viem";
import { useAppConfig } from "@/components/providers";
import { agentAccountAbi, trailingStopsAbi } from "@/lib/abi";
import type { Trail } from "@/lib/trailing";

export type TrailingState = {
  /** The deployment has the trailing-stop contract and `account` is a trading account that can use it. */
  available: boolean;
  /** The account has approved the contract as an agent (one wallet confirmation, once). */
  approved: boolean;
  /** Trails by lower-case market id. */
  trails: Map<string, Trail>;
  refetch: () => void;
};

const NONE: TrailingState = { available: false, approved: false, trails: new Map(), refetch: () => undefined };

/** Whether `account` (an agent account) lets the trailing-stop contract act, and its trails in `marketIds`. */
export function useTrailing(account: Address | undefined, marketIds: readonly Hex[]): TrailingState {
  const cfg = useAppConfig();
  const ts = cfg.trailingStops;
  const key = marketIds.map((m) => m.toLowerCase()).sort().join(",");
  const ids = useMemo(() => (key ? (key.split(",") as Hex[]) : []), [key]);
  const enabled = !!ts && !!account;

  // `agents` reverts on an address that is not an agent account (a wallet): trailing is then not available.
  const policy = useReadContract({
    address: account,
    abi: agentAccountAbi,
    functionName: "agents",
    args: [ts ?? "0x0000000000000000000000000000000000000000"],
    chainId: cfg.chainId,
    query: { enabled, refetchInterval: 5_000, retry: false },
  });
  const trails = useReadContracts({
    allowFailure: true,
    contracts: ids.map((m) => ({ address: ts ?? undefined, abi: trailingStopsAbi, functionName: "getTrail", args: [account ?? "0x0000000000000000000000000000000000000000", m], chainId: cfg.chainId }) as const),
    query: { enabled: enabled && ids.length > 0, refetchInterval: 3_000 },
  });

  return useMemo(() => {
    if (!enabled) return NONE;
    const map = new Map<string, Trail>();
    ids.forEach((m, i) => {
      const r = trails.data?.[i];
      if (r?.status !== "success") return;
      const t = r.result as { distanceBps: number; isLong: boolean; size: bigint; activation: bigint; best: bigint };
      if (t.distanceBps > 0) map.set(m, { distanceBps: Number(t.distanceBps), isLong: t.isLong, size: t.size, activation: t.activation, best: t.best });
    });
    const expiry = policy.data ? policy.data[0] : 0n;
    return {
      available: policy.isSuccess,
      approved: expiry > BigInt(Math.floor(Date.now() / 1000)),
      trails: map,
      refetch: () => {
        void policy.refetch();
        void trails.refetch();
      },
    };
  }, [enabled, ids, trails, policy]);
}
