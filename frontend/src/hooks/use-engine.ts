"use client";

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { useReadContract, useReadContracts } from "wagmi";
import type { Address, Hex } from "viem";
import { useAppConfig } from "@/components/providers";
import { houseVaultAbi, perpEngineAbi } from "@/lib/abi";
import { erc20Abi } from "@/lib/abis-extra";
import { fetchDayReference } from "@/lib/benchmarks";
import { MARKETS, type MarketInfo } from "@/lib/markets";

export type EngineParams = {
  baseFeeBps: bigint;
  maxSkewFeeBps: bigint;
  executionFee: bigint;
  minMargin: bigint;
  maxPriceAge: bigint;
  maxOiToNavBps: bigint;
  totalOpenInterest: bigint;
  paused: boolean;
  vaultNav: bigint;
};

/** Protocol-wide parameters the order form needs. */
export function useEngineParams() {
  const cfg = useAppConfig();
  const engine = { abi: perpEngineAbi, address: cfg.perpEngine, chainId: cfg.chainId } as const;
  const query = useReadContracts({
    allowFailure: false,
    contracts: [
      { ...engine, functionName: "baseFeeBps" },
      { ...engine, functionName: "maxSkewFeeBps" },
      { ...engine, functionName: "executionFee" },
      { ...engine, functionName: "minMargin" },
      { ...engine, functionName: "maxPriceAge" },
      { ...engine, functionName: "maxOiToNavBps" },
      { ...engine, functionName: "totalOpenInterest" },
      { ...engine, functionName: "paused" },
      { abi: houseVaultAbi, address: cfg.houseVault, chainId: cfg.chainId, functionName: "totalAssets" },
    ],
  });
  const data = useMemo<EngineParams | undefined>(() => {
    const d = query.data;
    if (!d) return undefined;
    return {
      baseFeeBps: d[0],
      maxSkewFeeBps: d[1],
      executionFee: d[2],
      minMargin: d[3],
      maxPriceAge: d[4],
      maxOiToNavBps: d[5],
      totalOpenInterest: d[6],
      paused: d[7],
      vaultNav: d[8],
    };
  }, [query.data]);
  return { data, isLoading: query.isLoading, isError: query.isError, error: query.error, refetch: query.refetch };
}

export type MarketState = {
  /** False when the engine has never listed this feed. */
  listed: boolean;
  enabled: boolean;
  invert: boolean;
  maxLeverage: number;
  maxOiPerSide: bigint;
  skewScale: bigint;
  longOi: bigint;
  shortOi: bigint;
  /** Per second, 1e18-scaled; positive means longs pay. */
  fundingRate: bigint;
};

/** On-chain state of every market the UI knows, keyed by feed id. */
export function useMarketStates() {
  const cfg = useAppConfig();
  const engine = { abi: perpEngineAbi, address: cfg.perpEngine, chainId: cfg.chainId } as const;
  const marketCalls = useReadContracts({
    allowFailure: false,
    contracts: MARKETS.map((m) => ({ ...engine, functionName: "markets" as const, args: [m.id] as const })),
  });
  // fundingRate reverts for unlisted markets, so failures are tolerated per call.
  const fundingCalls = useReadContracts({
    allowFailure: true,
    contracts: MARKETS.map((m) => ({ ...engine, functionName: "fundingRate" as const, args: [m.id] as const })),
  });

  const data = useMemo<Record<Hex, MarketState> | undefined>(() => {
    if (!marketCalls.data) return undefined;
    const out: Record<Hex, MarketState> = {};
    MARKETS.forEach((market, i) => {
      const row = marketCalls.data[i];
      if (!row) return;
      const [enabled, invert, maxLeverage, lastFundingTime, maxOiPerSide, skewScale, longOi, shortOi] = row;
      const funding = fundingCalls.data?.[i];
      out[market.id] = {
        listed: lastFundingTime !== 0n,
        enabled,
        invert,
        maxLeverage,
        maxOiPerSide,
        skewScale,
        longOi,
        shortOi,
        fundingRate: funding && funding.status === "success" ? funding.result : 0n,
      };
    });
    return out;
  }, [marketCalls.data, fundingCalls.data]);

  return {
    data,
    isLoading: marketCalls.isLoading,
    isError: marketCalls.isError,
    error: marketCalls.error,
    refetch: marketCalls.refetch,
  };
}

export function useTraderPositions(trader: Address | undefined) {
  const cfg = useAppConfig();
  return useReadContract({
    abi: perpEngineAbi,
    address: cfg.perpEngine,
    chainId: cfg.chainId,
    functionName: "getTraderPositions",
    args: trader ? [trader] : undefined,
    query: { enabled: trader !== undefined },
  });
}

export function useTraderOrders(trader: Address | undefined) {
  const cfg = useAppConfig();
  return useReadContract({
    abi: perpEngineAbi,
    address: cfg.perpEngine,
    chainId: cfg.chainId,
    functionName: "getTraderOrders",
    args: trader ? [trader] : undefined,
    query: { enabled: trader !== undefined },
  });
}

export type PositionView = NonNullable<ReturnType<typeof useTraderPositions>["data"]>[number];
export type OrderRow = NonNullable<ReturnType<typeof useTraderOrders>["data"]>[1][number];

export function useUsdcBalance(owner: Address | undefined) {
  const cfg = useAppConfig();
  return useReadContract({
    abi: erc20Abi,
    address: cfg.usdc,
    chainId: cfg.chainId,
    functionName: "balanceOf",
    args: owner ? [owner] : undefined,
    query: { enabled: owner !== undefined },
  });
}

export function useUsdcAllowance(owner: Address | undefined, spender: Address) {
  const cfg = useAppConfig();
  return useReadContract({
    abi: erc20Abi,
    address: cfg.usdc,
    chainId: cfg.chainId,
    functionName: "allowance",
    args: owner ? [owner, spender] : undefined,
    query: { enabled: owner !== undefined },
  });
}

/** Reference price ~24h ago from Pyth Benchmarks; null when there is no history. */
export function useDayReference(market: MarketInfo) {
  return useQuery({
    queryKey: ["day-reference", market.id],
    queryFn: ({ signal }) => fetchDayReference(market, signal),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    retry: 1,
  });
}
