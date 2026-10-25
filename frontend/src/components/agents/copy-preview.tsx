"use client";

import { useReadContract } from "wagmi";
import type { Address } from "viem";
import { AppLink } from "@/components/app-link";
import { useAppConfig } from "@/components/providers";
import { useMarketData } from "@/hooks/use-market-data";
import { useVenueStats } from "@/hooks/use-venue-stats";
import { DAY, allTime, roiOf, sumBuckets, winRateOf } from "@/lib/aggregate";
import { engineLensAbi } from "@/lib/abi";
import { fmtPercent, fmtPrice, fmtUsdc, shortAddress } from "@/lib/format";
import type { Instrument } from "@/lib/instruments";
import { valuePosition } from "@/lib/position";
import { bpsText, type StrategyDraft } from "@/lib/strategies";

const tone = (v: bigint | null | undefined) => (!v ? "" : v > 0n ? "text-long" : "text-short");

/**
 * A copy cannot be replayed from candles: what it would do depends on the leader. This shows what the leader holds
 * in the market now, what the copy would hold, and the leader's record on this venue.
 */
export function CopyPreview({ leader, instrument, draft }: { leader: Address | null; instrument: Instrument; draft: StrategyDraft }) {
  const cfg = useAppConfig();
  const { prices, params } = useMarketData();
  const sym = cfg.collateralSymbol;
  const positions = useReadContract({
    address: cfg.engineLens,
    abi: engineLensAbi,
    functionName: "getTraderPositions",
    args: [leader ?? "0x0000000000000000000000000000000000000000"],
    chainId: cfg.chainId,
    query: { enabled: !!leader, refetchInterval: 5_000 },
  });
  const stats = useVenueStats();

  if (!leader) {
    return (
      <div className="grid min-h-48 place-items-center px-4 py-8 text-center text-[0.8125rem] text-muted" data-testid="copy-preview">
        <p className="max-w-[44ch]">
          Enter the address to copy, or pick an agent from the directory below. Any trader works: a wallet or another agent account.
        </p>
      </div>
    );
  }

  const view = positions.data?.find((p) => p.position.priceId.toLowerCase() === instrument.id.toLowerCase());
  const mark = prices.get(instrument.id)?.mark ?? null;
  const value = view && params ? valuePosition(view, mark, params.maxProfitMultiple) : null;
  const theirs = view?.position;
  let copySize = 0n;
  let copySide: "long" | "short" | null = null;
  if (theirs && (theirs.isLong || draft.allowShort) && Number.isInteger(draft.ratioBps) && draft.ratioBps > 0) {
    copySize = (theirs.size * BigInt(draft.ratioBps)) / 10_000n;
    if (copySize > draft.maxSize) copySize = draft.maxSize;
    copySide = copySize > 0n ? (theirs.isLong ? "long" : "short") : null;
  }

  const record = stats.state?.traders[leader.toLowerCase()];
  const now = Math.floor(Date.now() / 1000);
  const week = record ? sumBuckets(record.days, Math.floor(now / DAY) - 6, Math.floor(now / DAY) + 1) : null;
  const all = record ? allTime(record) : null;

  return (
    <div className="flex flex-col gap-3 p-4" data-testid="copy-preview">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="panel-title">
          Following{" "}
          <AppLink route="trader" params={{ address: leader }} className="link num">
            {shortAddress(leader)}
          </AppLink>{" "}
          on {instrument.symbol}
        </h3>
        <span className="text-2xs text-faint">A copy follows live trades, so there is no replay.</span>
      </div>

      <dl className="grid gap-px overflow-hidden rounded-[6px] border border-line bg-line sm:grid-cols-2">
        <div className="bg-panel px-3 py-2.5">
          <dt className="text-xs text-muted">They hold now</dt>
          <dd className="mt-0.5 text-[0.8125rem]" data-testid="copy-leader-position">
            {positions.isLoading ? (
              <span className="skeleton" />
            ) : theirs ? (
              <>
                <span className={theirs.isLong ? "text-long" : "text-short"}>{theirs.isLong ? "Long" : "Short"}</span>{" "}
                <span className="num">
                  {fmtUsdc(theirs.size)} {sym}
                </span>
                <span className="num text-faint"> from {fmtPrice(theirs.entryPrice, instrument.priceDecimals)}</span>
                {value?.pnl !== null && value?.pnl !== undefined ? <span className={`num ml-1 ${tone(value.pnl)}`}>{fmtUsdc(value.pnl, 2, { sign: true })}</span> : null}
              </>
            ) : (
              <span className="text-muted">Nothing on {instrument.symbol}</span>
            )}
          </dd>
        </div>
        <div className="bg-panel px-3 py-2.5">
          <dt className="text-xs text-muted">The copy would hold</dt>
          <dd className="mt-0.5 text-[0.8125rem]">
            {copySide ? (
              <>
                <span className={copySide === "long" ? "text-long" : "text-short"}>{copySide === "long" ? "Long" : "Short"}</span>{" "}
                <span className="num">
                  {fmtUsdc(copySize)} {sym}
                </span>
                <span className="text-faint">
                  {" "}
                  ({bpsText(draft.ratioBps)} of theirs{copySize === draft.maxSize ? ", at your cap" : ""})
                </span>
              </>
            ) : theirs && !theirs.isLong && !draft.allowShort ? (
              <span className="text-muted">Nothing: shorts are off</span>
            ) : (
              <span className="text-muted">Nothing until they trade</span>
            )}
          </dd>
        </div>
      </dl>

      <div>
        <h4 className="text-xs text-muted">Their record here</h4>
        {stats.loading ? (
          <p className="mt-1 text-xs text-faint">Reading the venue&rsquo;s trades…</p>
        ) : !record || !all || all.trades === 0 ? (
          <p className="mt-1 text-xs text-faint">No closed trades seen for this address{stats.source === "live" ? " in the last day" : ""}.</p>
        ) : (
          <dl className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-4">
            <div>
              <dt className="text-2xs text-faint">PnL, 7 days</dt>
              <dd className={`num text-[0.8125rem] ${tone(week?.net)}`}>{week ? fmtUsdc(week.net, 2, { sign: true }) : "—"}</dd>
            </div>
            <div>
              <dt className="text-2xs text-faint">ROI, all</dt>
              <dd className="num text-[0.8125rem]">{roiOf(all) === null ? "—" : fmtPercent(roiOf(all)!, 1, true)}</dd>
            </div>
            <div>
              <dt className="text-2xs text-faint">Win rate</dt>
              <dd className="num text-[0.8125rem]">
                {winRateOf(all) === null ? "—" : fmtPercent(winRateOf(all)!, 0)}
                <span className="text-faint">
                  {" "}
                  {all.wins}/{all.trades}
                </span>
              </dd>
            </div>
            <div>
              <dt className="text-2xs text-faint">Liquidations</dt>
              <dd className={`num text-[0.8125rem] ${all.liquidations > 0 ? "text-short" : ""}`}>{all.liquidations}</dd>
            </div>
          </dl>
        )}
      </div>
      <p className="text-2xs leading-relaxed text-faint">
        The copy checks their position every reading and resizes when it is more than 10% off. Past results say little about the next trade: size the
        largest position for what you can afford to lose.
      </p>
    </div>
  );
}
