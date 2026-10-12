"use client";

import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import { useAppConfig } from "@/components/providers";
import { HouseMetrics } from "@/components/house/house-metrics";
import { StakingCard } from "@/components/house/staking-card";
import { VaultCard } from "@/components/house/vault-card";
import { houseVaultAbi, rewardTokenAbi } from "@/lib/abi";

export type HouseStats = {
  nav: bigint;
  sharePrice: bigint;
  deployedAt: bigint;
  traderLosses: bigint;
  traderProfits: bigint;
  fees: bigint;
  stakerYieldAllocated: bigint;
  pendingStakerYield: bigint;
  shortfall: bigint;
  lockPeriod: bigint;
  freeLiquidity: bigint;
  shareSupply: bigint;
  rebatesMinted: bigint;
  totalStaked: bigint;
};

function useHouseStats() {
  const cfg = useAppConfig();
  const vault = { abi: houseVaultAbi, address: cfg.houseVault, chainId: cfg.chainId } as const;
  const reward = { abi: rewardTokenAbi, address: cfg.rewardToken, chainId: cfg.chainId } as const;
  const query = useReadContracts({
    allowFailure: false,
    contracts: [
      { ...vault, functionName: "totalAssets" },
      { ...vault, functionName: "sharePrice" },
      { ...vault, functionName: "deployedAt" },
      { ...vault, functionName: "totalTraderLosses" },
      { ...vault, functionName: "totalTraderProfits" },
      { ...vault, functionName: "totalFeesCollected" },
      { ...vault, functionName: "totalStakerYieldAllocated" },
      { ...vault, functionName: "pendingStakerYield" },
      { ...vault, functionName: "totalShortfall" },
      { ...vault, functionName: "withdrawLockPeriod" },
      { ...vault, functionName: "freeLiquidity" },
      { ...vault, functionName: "totalSupply" },
      { ...reward, functionName: "totalRebatesMinted" },
      { ...reward, functionName: "totalStaked" },
    ],
  });
  const data = useMemo<HouseStats | undefined>(() => {
    const d = query.data;
    if (!d) return undefined;
    return {
      nav: d[0],
      sharePrice: d[1],
      deployedAt: d[2],
      traderLosses: d[3],
      traderProfits: d[4],
      fees: d[5],
      stakerYieldAllocated: d[6],
      pendingStakerYield: d[7],
      shortfall: d[8],
      lockPeriod: d[9],
      freeLiquidity: d[10],
      shareSupply: d[11],
      rebatesMinted: d[12],
      totalStaked: d[13],
    };
  }, [query.data]);
  return { data, isError: query.isError, refetch: query.refetch };
}

export function HouseScreen() {
  const stats = useHouseStats();

  return (
    <div className="flex flex-col gap-3">
      <div className="px-1 pb-1 pt-3 sm:pt-5">
        <h1 className="wide text-2xl font-semibold leading-tight sm:text-[2rem]">The house takes the other side of every trade</h1>
        <p className="mt-2 max-w-[68ch] text-muted">
          Deposit USDC into the vault to own a share of the house. It collects trader losses and fees, and pays trader
          profits. Returns can be negative when traders win.
        </p>
      </div>

      {stats.isError ? (
        <div className="notice flex flex-wrap items-center gap-3" data-tone="error" role="alert">
          <span className="flex-1">
            The house vault could not be read. The RPC may be down, or the configured contract addresses may not match this
            network.
          </span>
          <button type="button" className="btn btn-sm" onClick={() => void stats.refetch()}>
            Retry
          </button>
        </div>
      ) : null}

      <HouseMetrics stats={stats.data} />

      <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-2">
        <VaultCard stats={stats.data} />
        <StakingCard stats={stats.data} />
      </div>
    </div>
  );
}
