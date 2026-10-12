"use client";

import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import type { Address } from "viem";
import type { ContractFunctionReturnType } from "viem";
import { useAppConfig } from "@/components/providers";
import { engineLensAbi, perpEngineAbi, rewardTokenAbi } from "@/lib/abi";
import { erc20Abi } from "@/lib/abis-extra";

export type PositionView = ContractFunctionReturnType<typeof engineLensAbi, "view", "getTraderPositions">[number];
export type OrderData = ContractFunctionReturnType<typeof engineLensAbi, "view", "getTraderOrders">[1][number];
export type OrderRow = { id: bigint; order: OrderData };

export type AccountData = {
  positions: readonly PositionView[];
  orders: OrderRow[];
  balance: bigint;
  /** Collateral allowance granted to the engine. */
  allowance: bigint;
  /** Payments the engine could not deliver; collected with `claim()`. */
  claimable: bigint;
  house: bigint;
  houseStaked: bigint;
};

/** Everything about one account that the trading screen shows, refreshed about once a second. */
export function useAccountData(address: Address | undefined) {
  const cfg = useAppConfig();
  const lens = { abi: engineLensAbi, address: cfg.engineLens, chainId: cfg.chainId } as const;
  const reward = { abi: rewardTokenAbi, address: cfg.rewardToken, chainId: cfg.chainId } as const;
  const token = { abi: erc20Abi, address: cfg.usdc, chainId: cfg.chainId } as const;
  const who = address ?? "0x0000000000000000000000000000000000000000";

  const query = useReadContracts({
    allowFailure: false,
    contracts: [
      { ...lens, functionName: "getTraderPositions", args: [who] },
      { ...lens, functionName: "getTraderOrders", args: [who] },
      { ...token, functionName: "balanceOf", args: [who] },
      { ...token, functionName: "allowance", args: [who, cfg.perpEngine] },
      { abi: perpEngineAbi, address: cfg.perpEngine, chainId: cfg.chainId, functionName: "claimable", args: [who] },
      { ...reward, functionName: "balanceOf", args: [who] },
      { ...reward, functionName: "stakedBalance", args: [who] },
    ],
    query: { enabled: address !== undefined, refetchInterval: 1_200 },
  });

  const data = useMemo<AccountData | undefined>(() => {
    const d = query.data;
    if (!d || !address) return undefined;
    const [ids, rows] = d[1];
    return {
      positions: d[0],
      orders: ids.map((id, i) => ({ id, order: rows[i]! })).filter((row) => row.order !== undefined),
      balance: d[2],
      allowance: d[3],
      claimable: d[4],
      house: d[5],
      houseStaked: d[6],
    };
  }, [query.data, address]);

  return { data, isLoading: address !== undefined && query.isPending, isError: query.isError, refetch: query.refetch };
}
