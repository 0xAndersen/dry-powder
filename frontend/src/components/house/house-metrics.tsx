"use client";

import { ArcGauge } from "@/components/arc-gauge";
import { useAppConfig } from "@/components/providers";
import { Tip } from "@/components/tip";
import type { HouseStats } from "@/components/house/house-screen";
import { useChainNow } from "@/hooks/use-market-data";
import { TOKEN_DECIMALS, fmtCompact, fmtDuration, fmtPercent, fmtUsdc } from "@/lib/format";
import { SECONDS_PER_YEAR, ratio } from "@/lib/math";

const INITIAL_SHARE_PRICE = 1_000_000n;
const MIN_AGE_FOR_APY = 3_600;

/** Annualised share-price growth since deployment. Null when it would not mean anything yet. */
function realisedApy(stats: HouseStats, nowSeconds: number): number | null {
  const elapsed = nowSeconds - Number(stats.deployedAt);
  if (elapsed < MIN_AGE_FOR_APY || stats.shareSupply === 0n || stats.sharePrice === 0n) return null;
  const growth = ratio(stats.sharePrice, INITIAL_SHARE_PRICE);
  if (!Number.isFinite(growth) || growth <= 0) return null;
  const apy = Math.pow(growth, SECONDS_PER_YEAR / elapsed) - 1;
  return Number.isFinite(apy) ? apy : null;
}

function Cell({ label, children, note, tip }: { label: string; children: React.ReactNode; note?: React.ReactNode; tip?: React.ReactNode }) {
  return (
    <div className="min-w-0 px-4 py-4">
      <p className="flex items-center gap-1 text-xs text-muted">
        {label}
        {tip ? <Tip label={`About ${label.toLowerCase()}`}>{tip}</Tip> : null}
      </p>
      <p className="mt-1">{children}</p>
      {note ? <p className="mt-1 text-xs text-faint">{note}</p> : null}
    </div>
  );
}

function Figure({ children, tone }: { children: React.ReactNode; tone?: "long" | "short" }) {
  const color = tone === "long" ? "text-long" : tone === "short" ? "text-short" : "text-text";
  return <span className={`num text-[1.5rem] font-semibold leading-tight ${color}`}>{children}</span>;
}

export function HouseMetrics({ stats }: { stats: HouseStats | undefined }) {
  const { collateralSymbol: sym } = useAppConfig();
  const nowSeconds = useChainNow(30_000);
  const loading = <span className="skeleton h-7 w-28" />;

  const apy = stats ? realisedApy(stats, nowSeconds) : null;
  const ageSeconds = stats ? Math.max(0, nowSeconds - Number(stats.deployedAt)) : 0;

  const inflow = stats ? stats.traderLosses + stats.fees : 0n;
  const paidOut = stats ? stats.traderProfits : 0n;
  const net = inflow - paidOut;
  const inflowShare = stats && inflow + paidOut > 0n ? ratio(inflow, inflow + paidOut) : null;
  const inOutRatio = paidOut > 0n ? ratio(inflow, paidOut) : null;
  const openPnl = stats?.unrealizedTraderPnl ?? 0n;

  return (
    <section className="panel" aria-label="House metrics">
      <div className="grid divide-y divide-line sm:grid-cols-2 sm:divide-y-0 xl:grid-cols-[1.15fr_0.85fr_1.5fr_1fr] xl:divide-x">
        <Cell
          label="Vault NAV"
          tip={
            stats ? (
              <span className="grid gap-1.5">
                <span>The vault keeps three values and always prices shares on the side that protects existing holders.</span>
                <span className="num">Realised balance: {fmtUsdc(stats.realised)} {sym}. Cash the house holds.</span>
                <span className="num">
                  Marked value: {fmtUsdc(stats.markedValue)} {sym}. Realised balance {openPnl > 0n ? "minus" : "plus"} what open trades{" "}
                  {openPnl > 0n ? "are winning" : "are losing"} at the last oracle prices ({fmtUsdc(openPnl < 0n ? -openPnl : openPnl)}).
                </span>
                <span className="num">Exit value: {fmtUsdc(stats.nav)} {sym}. The lower of the two; withdrawals are priced here, and it is the NAV shown.</span>
                <span className="num">Entry value: {fmtUsdc(stats.entryValue)} {sym}. The higher of the two; deposits buy in here.</span>
                <span>With no open positions all three are equal.</span>
              </span>
            ) : (
              "Loading"
            )
          }
          note={
            stats ? (
              <span className="num">
                Share price {fmtUsdc(stats.sharePrice, 6)} {sym}
                {stats.entryValue !== stats.nav ? `. Deposits priced on ${fmtUsdc(stats.entryValue)}` : ""}
              </span>
            ) : undefined
          }
        >
          {stats ? (
            <>
              <Figure>{fmtUsdc(stats.nav)}</Figure> <span className="text-muted">{sym}</span>
            </>
          ) : (
            loading
          )}
        </Cell>

        <Cell
          label="Vault APY"
          note={
            stats
              ? apy === null
                ? stats.shareSupply === 0n
                  ? "No deposits yet"
                  : `Shown once the vault is over an hour old (now ${fmtDuration(ageSeconds)})`
                : `Realised since launch ${fmtDuration(ageSeconds)} ago, annualised. Not a forecast.`
              : undefined
          }
        >
          {stats ? <Figure tone={apy === null ? undefined : apy >= 0 ? "long" : "short"}>{apy === null ? "—" : apy > 100 ? ">10,000%" : fmtPercent(apy, 2, true)}</Figure> : loading}
        </Cell>

        <div className="flex min-w-0 items-center gap-4 px-4 py-4">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted">Net house win / loss, realised</p>
            <p className="mt-1">
              {stats ? (
                <>
                  <Figure tone={net > 0n ? "long" : net < 0n ? "short" : undefined}>{fmtUsdc(net, 2, { sign: true })}</Figure> <span className="text-muted">{sym}</span>
                </>
              ) : (
                loading
              )}
            </p>
            {stats ? (
              <p className="num mt-1 text-xs text-faint">
                In {fmtUsdc(inflow)} ({fmtUsdc(stats.traderLosses)} losses + {fmtUsdc(stats.fees)} fees), out {fmtUsdc(paidOut)} in trader profits. Open trades:{" "}
                <span className={openPnl > 0n ? "text-short" : openPnl < 0n ? "text-long" : ""}>
                  {openPnl === 0n ? "flat" : `traders ${openPnl > 0n ? "up" : "down"} ${fmtUsdc(openPnl < 0n ? -openPnl : openPnl)}`}
                </span>
              </p>
            ) : null}
          </div>
          <ArcGauge
            fraction={inflowShare}
            leftColor="var(--color-long)"
            rightColor="var(--color-short)"
            width={104}
            stroke={8}
            label={
              inflowShare === null
                ? "No settled trades yet"
                : `${fmtPercent(inflowShare, 0)} of settled flow came in to the house, ${fmtPercent(1 - inflowShare, 0)} went out to traders`
            }
          >
            <span className="num whitespace-nowrap text-xs text-text">{inOutRatio !== null ? `${inOutRatio.toFixed(2)} : 1` : inflow > 0n ? "All in" : "—"}</span>
            <span className="text-2xs text-faint">in : out</span>
          </ArcGauge>
        </div>

        <Cell label="Loss rebates minted" note={stats ? `${fmtCompact(stats.totalStaked, TOKEN_DECIMALS)} DRY staked right now` : undefined}>
          {stats ? (
            <>
              <Figure>{fmtCompact(stats.rebatesMinted, TOKEN_DECIMALS)}</Figure> <span className="text-muted">DRY</span>
            </>
          ) : (
            loading
          )}
        </Cell>
      </div>
      {stats && stats.shortfall > 0n ? (
        <p className="notice m-3 mt-0" data-tone="warn">
          The vault has been unable to pay {fmtUsdc(stats.shortfall)} {sym} of trader profits in full since launch.
        </p>
      ) : null}
    </section>
  );
}
