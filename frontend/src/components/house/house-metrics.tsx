"use client";

import { ArcGauge } from "@/components/arc-gauge";
import type { HouseStats } from "@/components/house/house-screen";
import { useNow } from "@/hooks/use-prices";
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

function Cell({ label, children, note }: { label: string; children: React.ReactNode; note?: React.ReactNode }) {
  return (
    <div className="min-w-0 px-4 py-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1">{children}</p>
      {note ? <p className="mt-1 text-xs text-faint">{note}</p> : null}
    </div>
  );
}

function Figure({ children, tone }: { children: React.ReactNode; tone?: "long" | "short" }) {
  const color = tone === "long" ? "text-long" : tone === "short" ? "text-short" : "text-text";
  return <span className={`num text-[1.625rem] font-semibold leading-tight ${color}`}>{children}</span>;
}

export function HouseMetrics({ stats }: { stats: HouseStats | undefined }) {
  const now = useNow(30_000);
  const loading = <span className="skeleton h-7 w-28" />;

  const nowSeconds = now / 1000;
  const apy = stats ? realisedApy(stats, nowSeconds) : null;
  const ageSeconds = stats ? Math.max(0, nowSeconds - Number(stats.deployedAt)) : 0;

  const inflow = stats ? stats.traderLosses + stats.fees : 0n;
  const paidOut = stats ? stats.traderProfits : 0n;
  const net = inflow - paidOut;
  const inflowShare = stats && inflow + paidOut > 0n ? ratio(inflow, inflow + paidOut) : null;
  const inOutRatio = paidOut > 0n ? ratio(inflow, paidOut) : null;

  return (
    <section className="panel" aria-label="House metrics">
      <div className="grid divide-y divide-line sm:grid-cols-2 sm:divide-y-0 xl:grid-cols-[1fr_1fr_1.5fr_1fr] xl:divide-x">
        <Cell
          label="Total house vault NAV"
          note={stats ? `Share price ${fmtUsdc(stats.sharePrice, 6)} USDC per rcUSDC` : undefined}
        >
          {stats ? (
            <>
              <Figure>{fmtUsdc(stats.nav)}</Figure> <span className="text-muted">USDC</span>
            </>
          ) : (
            loading
          )}
        </Cell>

        <Cell
          label="Current vault APY"
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
          {stats ? (
            <Figure tone={apy === null ? undefined : apy >= 0 ? "long" : "short"}>
              {apy === null ? "—" : apy > 100 ? ">10,000%" : fmtPercent(apy, 2, true)}
            </Figure>
          ) : (
            loading
          )}
        </Cell>

        <div className="flex min-w-0 items-center gap-4 px-4 py-4">
          <div className="min-w-0 flex-1">
            <p className="text-xs text-muted">Net house win / loss</p>
            <p className="mt-1">
              {stats ? (
                <>
                  <Figure tone={net > 0n ? "long" : net < 0n ? "short" : undefined}>{fmtUsdc(net, 2, { sign: true })}</Figure>{" "}
                  <span className="text-muted">USDC</span>
                </>
              ) : (
                loading
              )}
            </p>
            {stats ? (
              <p className="num mt-1 text-xs text-faint">
                In {fmtUsdc(inflow)} ({fmtUsdc(stats.traderLosses)} losses + {fmtUsdc(stats.fees)} fees), out{" "}
                {fmtUsdc(paidOut)} in trader profits
              </p>
            ) : null}
          </div>
          <ArcGauge
            fraction={inflowShare}
            leftColor="var(--color-long)"
            rightColor="var(--color-short)"
            width={112}
            stroke={8}
            label={
              inflowShare === null
                ? "No settled trades yet"
                : `${fmtPercent(inflowShare, 0)} of settled flow came in to the house, ${fmtPercent(1 - inflowShare, 0)} went out to traders`
            }
          >
            <span className="num whitespace-nowrap text-xs text-text">
              {inOutRatio !== null ? `${inOutRatio.toFixed(2)} : 1` : inflow > 0n ? "All in" : "—"}
            </span>
            <span className="text-2xs text-faint">in : out</span>
          </ArcGauge>
        </div>

        <Cell
          label="Total loss-rebate tokens minted"
          note={stats ? `${fmtCompact(stats.totalStaked, TOKEN_DECIMALS)} HOUSE staked right now` : undefined}
        >
          {stats ? (
            <>
              <Figure>{fmtCompact(stats.rebatesMinted, TOKEN_DECIMALS)}</Figure> <span className="text-muted">HOUSE</span>
            </>
          ) : (
            loading
          )}
        </Cell>
      </div>
      {stats && stats.shortfall > 0n ? (
        <p className="notice m-3 mt-0" data-tone="warn">
          The vault has been unable to pay {fmtUsdc(stats.shortfall)} USDC of trader profits in full since launch.
        </p>
      ) : null}
    </section>
  );
}
