"use client";

import { useMemo } from "react";
import { useReadContract, useReadContracts } from "wagmi";
import type { Address, Hex } from "viem";
import { useAppConfig } from "@/components/providers";
import { agentAccountAbi, twapOrdersAbi } from "@/lib/abi";
import type { Twap } from "@/lib/twap";

export type TwapState = {
  /** The deployment has the TWAP contract and `account` is a trading account that can use it. */
  available: boolean;
  /** The account's policy for the TWAP contract, while it is active. */
  approval: { expiry: number; maxLeverage: number; maxMargin: bigint } | null;
  /** Running TWAPs by lower-case market id. */
  twaps: Map<string, Twap>;
  refetch: () => void;
};

const NONE: TwapState = { available: false, approval: null, twaps: new Map(), refetch: () => undefined };
const ZERO = "0x0000000000000000000000000000000000000000" as const;

/** The TWAPs `account` (an agent account) has running in `marketIds`, and whether it lets the contract act. */
export function useTwaps(account: Address | undefined, marketIds: readonly Hex[]): TwapState {
  const cfg = useAppConfig();
  const tw = cfg.twapOrders;
  const key = marketIds.map((m) => m.toLowerCase()).sort().join(",");
  const ids = useMemo(() => (key ? (key.split(",") as Hex[]) : []), [key]);
  const enabled = !!tw && !!account;

  // `agents` reverts on an address that is not an agent account (a wallet): TWAPs are then not available.
  const policy = useReadContract({
    address: account,
    abi: agentAccountAbi,
    functionName: "agents",
    args: [tw ?? ZERO],
    chainId: cfg.chainId,
    query: { enabled, refetchInterval: 10_000, retry: false },
  });
  const reads = useReadContracts({
    allowFailure: true,
    contracts: ids.map((m) => ({ address: tw ?? undefined, abi: twapOrdersAbi, functionName: "getTwap", args: [account ?? ZERO, m], chainId: cfg.chainId }) as const),
    query: { enabled: enabled && ids.length > 0, refetchInterval: 4_000 },
  });

  return useMemo(() => {
    if (!enabled) return NONE;
    const map = new Map<string, Twap>();
    ids.forEach((m, i) => {
      const r = reads.data?.[i];
      if (r?.status !== "success") return;
      const t = r.result as {
        isLong: boolean;
        slices: number;
        done: number;
        interval: number;
        maxSlippageBps: number;
        nextAt: bigint;
        sliceMargin: bigint;
        refusals: number;
        sliceSize: bigint;
      };
      if (t.slices === 0) return;
      map.set(m, {
        isLong: t.isLong,
        slices: Number(t.slices),
        done: Number(t.done),
        interval: Number(t.interval),
        maxSlippageBps: Number(t.maxSlippageBps),
        nextAt: Number(t.nextAt),
        sliceMargin: t.sliceMargin,
        refusals: Number(t.refusals),
        sliceSize: t.sliceSize,
      });
    });
    const raw = policy.data;
    const now = Math.floor(Date.now() / 1000);
    const approval = raw && Number(raw[0]) > now ? { expiry: Number(raw[0]), maxLeverage: Number(raw[1]), maxMargin: raw[2] } : null;
    return {
      available: policy.isSuccess,
      approval,
      twaps: map,
      refetch: () => {
        void policy.refetch();
        void reads.refetch();
      },
    };
  }, [enabled, ids, reads, policy]);
}
