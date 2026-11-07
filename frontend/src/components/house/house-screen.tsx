"use client";

import { useMemo } from "react";
import { useReadContracts } from "wagmi";
import { useAppConfig } from "@/components/providers";
import { EpochCard } from "@/components/house/epoch-card";
import { HouseMetrics } from "@/components/house/house-metrics";
import { StakingCard } from "@/components/house/staking-card";
import { VaultCard } from "@/components/house/vault-card";
import { houseVaultAbi, perpEngineAbi, rewardTokenAbi } from "@/lib/abi";

export type HouseStats = {
  /** Exit value: what withdrawals are priced at (`totalAssets`). */
  nav: bigint;
  entryValue: bigint;
  markedValue: bigint;
  realised: bigint;
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
  /** Assets per share unit, scaled by 1e30. */
  highWaterMark: bigint;
  lastEpochTime: bigint;
  epochLength: bigint;
  stakerShareBps: bigint;
  rebatesMinted: bigint;
  totalStaked: bigint;
  /** USDC per second, scaled by 1e18. */
  yieldRate: bigint;
  periodFinish: bigint;
  streamPeriod: bigint;
  yieldNotified: bigint;
  yieldClaimed: bigint;
  unrealizedTraderPnl: bigint;
  reservedLiquidity: bigint;
};

function useHouseStats() {
  const cfg = useAppConfig();
  const vault = { abi: houseVaultAbi, address: cfg.houseVault, chainId: cfg.chainId } as const;
  const reward = { abi: rewardTokenAbi, address: cfg.rewardToken, chainId: cfg.chainId } as const;
  const engine = { abi: perpEngineAbi, address: cfg.perpEngine, chainId: cfg.chainId } as const;
  const query = useReadContracts({
    allowFailure: false,
    contracts: [
      { ...vault, functionName: "totalAssets" },
      { ...vault, functionName: "entryValue" },
      { ...vault, functionName: "markedValue" },
      { ...vault, functionName: "totalHouseBalance" },
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
      { ...vault, functionName: "highWaterMark" },
      { ...vault, functionName: "lastEpochTime" },
      { ...vault, functionName: "epochLength" },
      { ...vault, functionName: "STAKER_SHARE_BPS" },
      { ...reward, functionName: "totalRebatesMinted" },
      { ...reward, functionName: "totalStaked" },
      { ...reward, functionName: "yieldRate" },
      { ...reward, functionName: "periodFinish" },
      { ...reward, functionName: "streamPeriod" },
      { ...reward, functionName: "totalYieldNotified" },
      { ...reward, functionName: "totalYieldClaimed" },
      { ...engine, functionName: "unrealizedTraderPnl" },
      { ...engine, functionName: "reservedLiquidity" },
    ],
    query: { refetchInterval: 2_500 },
  });
  const data = useMemo<HouseStats | undefined>(() => {
    const d = query.data;
    if (!d) return undefined;
    return {
      nav: d[0],
      entryValue: d[1],
      markedValue: d[2],
      realised: d[3],
      sharePrice: d[4],
      deployedAt: d[5],
      traderLosses: d[6],
      traderProfits: d[7],
      fees: d[8],
      stakerYieldAllocated: d[9],
      pendingStakerYield: d[10],
      shortfall: d[11],
      lockPeriod: d[12],
      freeLiquidity: d[13],
      shareSupply: d[14],
      highWaterMark: d[15],
      lastEpochTime: d[16],
      epochLength: d[17],
      stakerShareBps: d[18],
      rebatesMinted: d[19],
      totalStaked: d[20],
      yieldRate: d[21],
      periodFinish: d[22],
      streamPeriod: d[23],
      yieldNotified: d[24],
      yieldClaimed: d[25],
      unrealizedTraderPnl: d[26],
      reservedLiquidity: d[27],
    };
  }, [query.data]);
  return { data, isError: query.isError, refetch: query.refetch };
}

export function HouseScreen() {
  const stats = useHouseStats();

  return (
    <div className="flex flex-col gap-2">
      <div className="px-1 pb-1 pt-3 sm:pt-4">
        <h1 className="wide text-2xl font-semibold leading-tight sm:text-[2rem]">The house takes the other side of every trade</h1>
        <p className="mt-2 max-w-[70ch] text-muted">
          Deposit into the vault to own a share of the house. It collects trader losses and fees and pays trader profits, so
          returns are negative when traders win. Traders who lose are rebated in KEG, and staked KEG earns a share of what
          the house actually makes.
        </p>
      </div>

      {stats.isError ? (
        <div className="notice flex flex-wrap items-center gap-3" data-tone="error" role="alert">
          <span className="flex-1">The house vault could not be read. The RPC may be down, or the configured contract addresses may not match this network.</span>
          <button type="button" className="btn btn-sm" onClick={() => void stats.refetch()}>
            Retry
          </button>
        </div>
      ) : null}

      <HouseMetrics stats={stats.data} />
      <EpochCard stats={stats.data} />

      <div className="grid grid-cols-1 items-start gap-2 lg:grid-cols-2">
        <VaultCard stats={stats.data} />
        <StakingCard stats={stats.data} />
      </div>
    </div>
  );
}
