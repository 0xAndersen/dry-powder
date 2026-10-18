"use client";

import { useConfig } from "wagmi";
import { simulateContract, writeContract } from "wagmi/actions";
import { useAppConfig } from "@/components/providers";
import { Tip } from "@/components/tip";
import { TxStatus } from "@/components/tx-status";
import type { HouseStats } from "@/components/house/house-screen";
import { useChainNow } from "@/hooks/use-market-data";
import { useTx } from "@/hooks/use-tx";
import { useWallet } from "@/hooks/use-wallet";
import { houseVaultAbi } from "@/lib/abi";
import { fmtDuration, fmtPercent, fmtUsdc } from "@/lib/format";
import { BPS } from "@/lib/math";

const HWM_PRECISION = 10n ** 30n;

function Item({ label, children, tip }: { label: string; children: React.ReactNode; tip?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 text-xs text-muted">
        {label}
        {tip ? <Tip label={`About ${label.toLowerCase()}`}>{tip}</Tip> : null}
      </dt>
      <dd className="num mt-0.5 text-[0.9375rem]">{children}</dd>
    </div>
  );
}

/** Epoch settlement: when, what it would move to stakers, and the button anyone can press once it is due. */
export function EpochCard({ stats }: { stats: HouseStats | undefined }) {
  const cfg = useAppConfig();
  const wagmiConfig = useConfig();
  const wallet = useWallet();
  const tx = useTx();
  const now = useChainNow();
  const sym = cfg.collateralSymbol;

  const next = stats ? Number(stats.lastEpochTime + stats.epochLength) : 0;
  const remaining = stats ? next - now : 0;
  const due = stats !== undefined && remaining <= 0;
  const sharePct = stats ? Number(stats.stakerShareBps) / 100 : 15;

  // Mirrors HouseVault.settleEpoch so the button can say what pressing it will do.
  const perShare = stats && stats.shareSupply > 0n ? (stats.nav * HWM_PRECISION) / stats.shareSupply : 0n;
  const aboveMark = stats && perShare > stats.highWaterMark ? ((perShare - stats.highWaterMark) * stats.shareSupply) / HWM_PRECISION : 0n;
  const toStakers = stats && stats.totalStaked > 0n ? (aboveMark * stats.stakerShareBps) / BPS : 0n;
  // Per whole share (1e18 units) in 6-decimal collateral.
  const markPerShare = stats ? stats.highWaterMark / 10n ** 12n : 0n;
  const belowMark = stats && stats.shareSupply > 0n && perShare < stats.highWaterMark;

  const settle = () => {
    const who = wallet.address;
    if (!who || !wallet.ready) return;
    void tx.run(async (api) => {
      await api.send("Settle epoch", async () => {
        const { request } = await simulateContract(wagmiConfig, {
          abi: houseVaultAbi,
          address: cfg.houseVault,
          functionName: "settleEpoch",
          account: who,
          chainId: cfg.chainId,
        });
        return writeContract(wagmiConfig, request);
      });
      return toStakers > 0n
        ? `Epoch settled: about ${fmtUsdc(toStakers)} ${sym} now streams to DRY stakers.`
        : aboveMark > 0n
          ? "Epoch settled. Nobody is staking, so the house kept the gain and the high-water mark moved up."
          : "Epoch settled. The house is not above its high-water mark, so nothing went to stakers.";
    });
  };

  return (
    <section className="panel" aria-label="Epoch and staker yield">
      <div className="flex flex-wrap items-center gap-x-8 gap-y-3 px-4 py-3">
        <div className="min-w-[13rem] flex-1">
          <h2 className="panel-title">Profit share, settled each epoch</h2>
          <p className="mt-1 max-w-[62ch] text-[0.8125rem] text-muted">
            Once per epoch anyone can settle. If the value of a vault share is above its previous high, {sharePct}% of that gain is set aside and
            streamed to DRY stakers over {stats ? fmtDuration(Number(stats.streamPeriod)) : "the stream period"}. After a losing stretch the house must
            first recover to the old high before stakers earn again.
          </p>
        </div>
        <dl className="grid grid-cols-2 gap-x-8 gap-y-3 sm:grid-cols-4">
          <Item label="Next settlement">
            {stats ? due ? <span className="text-accent" data-testid="epoch-due">Due now</span> : <span data-testid="epoch-countdown">in {fmtDuration(remaining)}</span> : "…"}
          </Item>
          <Item
            label="High-water mark"
            tip="The highest value per vault share at which staker yield has been settled. Only gains above it are shared, so the same profit is never paid for twice."
          >
            {stats ? (
              <>
                {fmtUsdc(markPerShare, 6)}
                <span className={`ml-1.5 text-xs ${belowMark ? "text-short" : "text-faint"}`}>
                  {stats.shareSupply === 0n ? "" : belowMark ? `share is ${fmtPercent(1 - Number(perShare) / Number(stats.highWaterMark), 2)} below` : "share at or above"}
                </span>
              </>
            ) : (
              "…"
            )}
          </Item>
          <Item label="Gain above the mark" tip="House profit since the last settlement, counted on the exit value so open trader winnings are already deducted.">
            {stats ? `${fmtUsdc(aboveMark)} ${sym}` : "…"}
          </Item>
          <Item label="Settling now sends">
            {stats ? (
              stats.totalStaked === 0n && aboveMark > 0n ? (
                <span className="text-muted">0: nobody staked</span>
              ) : (
                <span className={toStakers > 0n ? "text-accent" : ""}>
                  {fmtUsdc(toStakers)} {sym}
                </span>
              )
            ) : (
              "…"
            )}
          </Item>
        </dl>
        <button
          type="button"
          className={`btn ${due ? "btn-primary" : ""}`}
          disabled={!due || !wallet.ready || tx.busy}
          title={!wallet.ready ? "Connect a wallet to settle" : due ? "Anyone may settle once the epoch is over" : "The epoch is not over yet"}
          onClick={settle}
          data-testid="settle-epoch"
        >
          {tx.busy ? <span className="spinner" aria-hidden="true" /> : null}
          Settle epoch
        </button>
      </div>
      {tx.state.phase !== "idle" ? <TxStatus state={tx.state} onDismiss={tx.reset} className="mx-4 mb-3" /> : null}
    </section>
  );
}
