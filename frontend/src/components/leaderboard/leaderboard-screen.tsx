"use client";

import { useMemo, useState } from "react";
import { FollowButton, TraderName } from "@/components/social/trader-name";
import { useApp } from "@/components/providers";
import { Tip } from "@/components/tip";
import { useLocalStore } from "@/hooks/use-local-store";
import { useChainNow } from "@/hooks/use-market-data";
import { useVenueStats } from "@/hooks/use-venue-stats";
import { useAccountView, useWallet } from "@/hooks/use-wallet";
import { DAY, HOUR, allTime, roiOf, seasonAt, seasonByNumber, sumBuckets, winRateOf, type PeriodSum, type TraderRecord } from "@/lib/aggregate";
import { USDC_DECIMALS, fmtAge, fmtCompact, fmtDuration, fmtPercent, fmtUsdc, fmtUtc } from "@/lib/format";
import { follows, isFollowing } from "@/lib/social";

type PeriodKey = "season" | "1d" | "7d" | "30d" | "all";
type Metric = "net" | "roi" | "winRate" | "volume" | "trades";

const PERIODS: { key: PeriodKey; label: string }[] = [
  { key: "season", label: "Season" },
  { key: "1d", label: "24h" },
  { key: "7d", label: "7 days" },
  { key: "30d", label: "30 days" },
  { key: "all", label: "All time" },
];
const METRICS: { key: Metric; label: string; tip?: string }[] = [
  { key: "net", label: "PnL", tip: "Net PnL of trades closed in the period: what exits returned beyond their margin, after every fee." },
  { key: "roi", label: "ROI", tip: "Net PnL over the margin released by the period's exits. Ranked among traders with at least 3 closed trades." },
  { key: "winRate", label: "Win rate", tip: "Winning round trips over all closed in the period. Ranked among traders with at least 3 closed trades." },
  { key: "volume", label: "Volume", tip: "Notional opened, increased and closed in the period." },
  { key: "trades", label: "Trades", tip: "Round trips closed in the period (full closes and liquidations)." },
];
const MIN_TRADES_FOR_RATIOS = 3;
const ROWS = 100;

type Row = { address: string; sum: PeriodSum; roi: number | null; winRate: number | null };

function periodSum(t: TraderRecord, period: PeriodKey, now: number, season: { start: number; end: number }): PeriodSum {
  switch (period) {
    case "all":
      return allTime(t);
    case "1d":
      return sumBuckets(t.hours, Math.floor((now - DAY) / HOUR) + 1, Math.floor(now / HOUR) + 1);
    case "7d":
      return sumBuckets(t.days, Math.floor(now / DAY) - 6, Math.floor(now / DAY) + 1);
    case "30d":
      return sumBuckets(t.days, Math.floor(now / DAY) - 29, Math.floor(now / DAY) + 1);
    case "season":
      return sumBuckets(t.days, Math.floor(season.start / DAY), Math.ceil(season.end / DAY));
  }
}

export function LeaderboardScreen() {
  const { config: cfg } = useApp();
  const stats = useVenueStats();
  const now = useChainNow(1_000);
  const wallet = useWallet();
  const view = useAccountView();
  const [list] = useLocalStore(follows);
  const [period, setPeriod] = useState<PeriodKey>("season");
  const [metric, setMetric] = useState<Metric>("net");
  const [followingOnly, setFollowingOnly] = useState(false);
  const [seasonOffset, setSeasonOffset] = useState(0);
  const sym = cfg.collateralSymbol;

  const launch = stats.state?.deployTime || (cfg.overrides.includes("engine") ? null : cfg.deployedAt) || stats.from || Math.floor(now);
  const current = seasonAt(Math.floor(now), launch);
  const season = seasonByNumber(Math.max(0, current.number - seasonOffset), launch);

  const rows = useMemo(() => {
    const out: Row[] = [];
    if (!stats.state) return out;
    for (const [address, t] of Object.entries(stats.state.traders)) {
      const sum = periodSum(t, period, Math.floor(now), season);
      if (sum.trades === 0 && sum.volume === 0n) continue;
      out.push({ address, sum, roi: roiOf(sum), winRate: winRateOf(sum) });
    }
    return out;
    // Re-ranked on new data, not on every clock tick.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stats.state, period, season.start, Math.floor(now / 60)]);

  const ranked = useMemo(() => {
    const ratio = metric === "roi" || metric === "winRate";
    const value = (r: Row): number | bigint | null => {
      switch (metric) {
        case "net":
          return r.sum.net;
        case "roi":
          return r.roi;
        case "winRate":
          return r.winRate;
        case "volume":
          return r.sum.volume;
        case "trades":
          return r.sum.trades;
      }
    };
    return rows
      .filter((r) => !ratio || r.sum.trades >= MIN_TRADES_FOR_RATIOS)
      .sort((a, b) => {
        const va = value(a);
        const vb = value(b);
        if (va === null && vb === null) return 0;
        if (va === null) return 1;
        if (vb === null) return -1;
        if (va === vb) return b.sum.trades - a.sum.trades;
        return va < vb ? 1 : -1;
      });
  }, [rows, metric]);

  const me = (view.watching ? undefined : view.address)?.toLowerCase() ?? wallet.address?.toLowerCase();
  const myRank = me ? ranked.findIndex((r) => r.address.toLowerCase() === me) : -1;
  const shown = (followingOnly ? ranked.filter((r) => isFollowing(list, r.address)) : ranked).slice(0, ROWS);

  const coverage =
    stats.source === "indexer"
      ? `Indexed from this deployment's first block, updated ${stats.snapshotTime ? `${fmtAge(Math.max(0, now - stats.snapshotTime))} ago` : "recently"}, plus live events.${stats.gap ? " The live feed has a short gap until the indexer catches up." : ""}`
      : stats.source === "live"
        ? `The indexer file is not published yet, so this covers events read here: since ${stats.from ? fmtUtc(stats.from) : "…"}.`
        : "Loading statistics…";

  return (
    <div className="flex flex-col gap-2" data-testid="leaderboard">
      <div className="flex flex-wrap items-end justify-between gap-3 px-1 pt-2">
        <div>
          <h1 className="wide text-xl font-semibold leading-tight sm:text-2xl">Leaderboard</h1>
          <p className="mt-1 text-[0.8125rem] text-muted">Closed trades only: a position counts when it is closed or liquidated.</p>
        </div>
        {myRank >= 0 ? (
          <p className="num text-[0.8125rem] text-muted" data-testid="my-rank">
            Your rank: <span className="text-text">#{myRank + 1}</span> of {ranked.length}
          </p>
        ) : null}
      </div>

      <div className="flex flex-wrap items-center gap-1.5 px-1" role="group" aria-label="Period">
        {PERIODS.map((p) => (
          <button key={p.key} type="button" className="chip" aria-pressed={period === p.key} onClick={() => setPeriod(p.key)} data-testid={`lb-period-${p.key}`}>
            {p.label}
          </button>
        ))}
        <span className="mx-1 h-4 w-px bg-line" aria-hidden="true" />
        <button type="button" className="chip" aria-pressed={followingOnly} onClick={() => setFollowingOnly((v) => !v)} data-testid="lb-following">
          ★ Following <span className="num ml-1 text-faint">{list.length}</span>
        </button>
      </div>

      {period === "season" ? (
        <section className="panel flex flex-wrap items-center gap-x-6 gap-y-2 px-3 py-2.5" aria-label="Season" data-testid="season">
          <div className="flex items-center gap-2">
            <button type="button" className="btn btn-sm btn-ghost" disabled={season.number <= 0} onClick={() => setSeasonOffset((n) => n + 1)} aria-label="Previous season">
              ‹
            </button>
            <h2 className="wide text-base font-semibold">{season.number === 0 ? "Pre-season" : `Season ${season.number}`}</h2>
            <button type="button" className="btn btn-sm btn-ghost" disabled={seasonOffset === 0} onClick={() => setSeasonOffset((n) => Math.max(0, n - 1))} aria-label="Next season">
              ›
            </button>
          </div>
          <p className="num text-xs text-muted">
            {fmtUtc(season.start)} to {fmtUtc(season.end)}
          </p>
          <p className="num ml-auto text-[0.8125rem]">
            {now < season.end ? (
              <>
                Ends in <span className="text-accent">{fmtDuration(season.end - now)}</span>
              </>
            ) : (
              <span className="text-muted">Finished</span>
            )}
          </p>
          <p className="w-full text-2xs text-faint">Seasons run Monday 00:00 UTC to the next Monday. Rankings are for fun and for the record: there are no prizes on testnet.</p>
        </section>
      ) : null}

      <section className="panel min-w-0" aria-label="Rankings">
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2" role="group" aria-label="Rank by">
          <span className="text-xs text-faint">Rank by</span>
          {METRICS.map((m) => (
            <button key={m.key} type="button" className="chip" aria-pressed={metric === m.key} onClick={() => setMetric(m.key)} data-testid={`lb-metric-${m.key}`}>
              {m.label}
            </button>
          ))}
          {METRICS.find((m) => m.key === metric)?.tip ? <Tip label="About this ranking">{METRICS.find((m) => m.key === metric)!.tip}</Tip> : null}
        </div>
        {stats.loading ? (
          <p className="px-4 py-12 text-center text-muted">Loading rankings…</p>
        ) : shown.length === 0 ? (
          <p className="px-4 py-12 text-center text-muted">
            {followingOnly ? "None of the traders you follow closed a trade in this period." : stats.error ? `Rankings unavailable: ${stats.error}` : "No closed trades in this period yet. Be the first."}
          </p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table card-table">
              <thead>
                <tr>
                  <th>Trader</th>
                  <th className="r">PnL ({sym})</th>
                  <th className="r">ROI</th>
                  <th className="r">Win rate</th>
                  <th className="r">Volume</th>
                  <th className="r">Trades</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => {
                  const rank = ranked.indexOf(r) + 1;
                  const mine = r.address.toLowerCase() === me;
                  return (
                    <tr key={r.address} className={mine ? "bg-accent/5" : undefined} data-testid="lb-row">
                      <td data-cell="market">
                        <span className="inline-flex items-center gap-2">
                          <span className={`num w-8 ${rank <= 3 ? "font-semibold text-text" : "text-faint"}`}>#{rank}</span>
                          <FollowButton address={r.address} />
                          <TraderName address={r.address} />
                          {r.sum.liquidations > 0 ? <span className="text-2xs text-short">{r.sum.liquidations} liq</span> : null}
                        </span>
                      </td>
                      <td className={`r num ${r.sum.net > 0n ? "text-long" : r.sum.net < 0n ? "text-short" : ""}`} data-cell="pnl">
                        <span>{fmtUsdc(r.sum.net, 2, { sign: true })}</span>
                      </td>
                      <td className="r num" data-label="ROI">
                        {r.roi === null ? "—" : fmtPercent(r.roi, 1, true)}
                      </td>
                      <td className="r num" data-label="Win rate">
                        {r.winRate === null ? "—" : `${fmtPercent(r.winRate, 0)}`}
                        <span className="text-faint"> {r.sum.wins}/{r.sum.trades}</span>
                      </td>
                      <td className="r num" data-label="Volume">
                        {fmtCompact(r.sum.volume, USDC_DECIMALS)}
                      </td>
                      <td className="r num" data-label="Trades">
                        {r.sum.trades}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="border-t border-line px-3 py-1.5 text-2xs text-faint" data-testid="lb-coverage">
          {coverage}
        </p>
      </section>
    </div>
  );
}
