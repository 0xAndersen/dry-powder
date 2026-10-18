"use client";

import { useEffect, useMemo, useState } from "react";
import type { Address } from "viem";
import { AppLink } from "@/components/app-link";
import { PnlCalendar } from "@/components/portfolio/pnl-calendar";
import { PnlCurve } from "@/components/portfolio/pnl-curve";
import { Journal } from "@/components/portfolio/journal";
import { useApp } from "@/components/providers";
import { Tip } from "@/components/tip";
import { useAccountData } from "@/hooks/use-account-data";
import { useLogFeed } from "@/hooks/use-log-feed";
import { useChainNow, useMarketData } from "@/hooks/use-market-data";
import { useTradingAccount } from "@/hooks/use-trading-account";
import { useAccountView, useWallet } from "@/hooks/use-wallet";
import { accountTotals } from "@/lib/account-totals";
import { closedTrades } from "@/lib/aggregate";
import { USDC_DECIMALS, fmtAge, fmtCompact, fmtDateTime, fmtDuration, fmtPercent, fmtPrice, fmtUsdc, shortAddress, usdcToNum } from "@/lib/format";
import { valuePosition } from "@/lib/position";
import { RISK_TEXT, riskTone } from "@/lib/risk-tone";
import { tradeStats } from "@/lib/trade-stats";

const DAY = 86_400;
const PERIODS = [
  { key: "1d", label: "24h", seconds: DAY },
  { key: "7d", label: "7 days", seconds: 7 * DAY },
  { key: "30d", label: "30 days", seconds: 30 * DAY },
  { key: "all", label: "All", seconds: null },
] as const;
type PeriodKey = (typeof PERIODS)[number]["key"];

/** How far back "All" reads when the deployment time is unknown. */
const ALL_FALLBACK = 30 * DAY;

function Figure({ label, children, tip, sub }: { label: string; children: React.ReactNode; tip?: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="min-w-0 px-3 py-3">
      <dt className="flex items-center gap-1 text-xs text-muted">
        {label}
        {tip ? <Tip label={`About ${label.toLowerCase()}`}>{tip}</Tip> : null}
      </dt>
      <dd className="num mt-0.5 truncate text-xl font-semibold leading-tight">{children}</dd>
      {sub ? <dd className="num mt-0.5 truncate text-2xs text-faint">{sub}</dd> : null}
    </div>
  );
}

const tone = (v: bigint | null | undefined) => (v === null || v === undefined || v === 0n ? "" : v > 0n ? "text-long" : "text-short");

export function PortfolioScreen() {
  const { config: cfg } = useApp();
  const wallet = useWallet();
  const trading = useTradingAccount();
  const view = useAccountView();
  const { prices, params, byId } = useMarketData();
  const chainNow = useChainNow(10_000);
  const sym = cfg.collateralSymbol;

  // With instant trading set up, the trading account and the wallet hold separate histories: let either be shown.
  const [pick, setPick] = useState<"account" | "wallet" | null>(null);
  const tradingAccount = trading.account;
  const canSwitch = !view.watching && tradingAccount !== null && wallet.address !== undefined && tradingAccount.toLowerCase() !== wallet.address.toLowerCase();
  const showingWallet = pick === null ? view.address?.toLowerCase() === wallet.address?.toLowerCase() : pick === "wallet";
  const address: Address | undefined = canSwitch ? (showingWallet ? wallet.address : tradingAccount) : view.address;

  const [period, setPeriod] = useState<PeriodKey>("7d");
  const since = cfg.overrides.includes("engine") ? null : cfg.deployedAt;
  // Stable per account: changing it would restart the feed. The first read covers a day at most.
  const lookback = useMemo(() => {
    const now = Date.now() / 1000;
    return since ? Math.min(DAY, Math.max(3_600, now - since + 600)) : DAY;
  }, [since, address]); // eslint-disable-line react-hooks/exhaustive-deps
  const feed = useLogFeed({ enabled: address !== undefined, trader: address, lookbackSeconds: lookback, exactTimes: true, maxEvents: 8_000, blockRange: 10_000 });
  const account = useAccountData(address);

  // Read further back when the chosen period starts before what is loaded (bounded by the deployment time).
  const periodSeconds = PERIODS.find((p) => p.key === period)!.seconds;
  const floor = since ?? chainNow - ALL_FALLBACK;
  const wantFrom = Math.max(floor, periodSeconds === null ? floor : chainNow - periodSeconds);
  const status = feed.status;
  const covered = status.loadedFromTime > 0 && (since !== null ? status.loadedFromTime <= since + 60 : false);
  useEffect(() => {
    if (status.phase !== "live" || status.pending > 0 || status.loadedFromTime === 0 || status.loadedFrom <= 0 || covered) return;
    if (wantFrom >= status.loadedFromTime - 60) return;
    void feed.extend(Math.min(status.loadedFromTime - wantFrom + 600, 7 * DAY));
  }, [status.phase, status.pending, status.loadedFromTime, status.loadedFrom, wantFrom, covered]); // eslint-disable-line react-hooks/exhaustive-deps

  const allTrades = useMemo(() => closedTrades(feed.events, params?.maxProfitMultiple ?? 10n), [feed.events, params?.maxProfitMultiple]);
  const periodFrom = periodSeconds === null ? 0 : chainNow - periodSeconds;
  const trades = useMemo(() => allTrades.filter((t) => t.closeTime >= periodFrom), [allTrades, periodFrom]);
  const stats = useMemo(() => tradeStats(trades), [trades]);
  const totals = useMemo(() => (account.data && params ? accountTotals(account.data, prices, params, byId) : null), [account.data, prices, params, byId]);

  const curve = useMemo(() => {
    const start = Math.max(periodFrom, status.loadedFromTime || periodFrom);
    const points = [{ time: start, value: 0 }, ...stats.curve.map((p) => ({ time: p.time, value: usdcToNum(p.value) }))];
    const end = usdcToNum(stats.net + (totals?.pnl ?? 0n));
    points.push({ time: Math.max(chainNow, points[points.length - 1]!.time + 1), value: end });
    return points;
  }, [stats, totals?.pnl, periodFrom, status.loadedFromTime, chainNow]);

  const positions = useMemo(() => {
    if (!account.data || !params) return [];
    return account.data.positions.map((p) => {
      const id = p.position.priceId.toLowerCase();
      const inst = byId.get(id);
      return { view: p, inst, value: valuePosition(p, prices.get(id)?.mark ?? null, params.maxProfitMultiple) };
    });
  }, [account.data, params, prices, byId]);

  if (!address) {
    return (
      <div className="flex flex-col gap-2">
        <Heading />
        <section className="panel px-4 py-14 text-center text-muted">
          <p>Connect a wallet to see your portfolio, or watch any account: paste its address in the header, or open a trader&apos;s profile from Activity or the Leaderboard.</p>
          <p className="mt-3">
            <AppLink route="trade" className="btn btn-primary">
              Go to Trade
            </AppLink>
          </p>
        </section>
      </div>
    );
  }

  const loading = status.phase === "starting" || (status.phase === "backfilling" && feed.events.length === 0);
  const coverageText =
    status.phase === "error"
      ? `History unavailable (${status.error ?? "RPC error"}). Retrying.`
      : status.loadedFromTime > 0
        ? covered
          ? `All trades since this deployment (${fmtDateTime(since!)}).`
          : `Trades since ${fmtDateTime(status.loadedFromTime)}${status.pending > 0 ? `; reading further back (${status.pending} requests left)` : ""}.`
        : "Reading this account's history…";

  return (
    <div className="flex flex-col gap-2" data-testid="portfolio">
      <Heading>
        <div className="flex flex-wrap items-center gap-2">
          {view.watching ? <span className="watch-badge">Watching</span> : null}
          {canSwitch ? (
            <div className="segmented" role="group" aria-label="Which account">
              <button type="button" aria-pressed={!showingWallet} onClick={() => setPick("account")}>
                Trading account
              </button>
              <button type="button" aria-pressed={showingWallet} onClick={() => setPick("wallet")}>
                Wallet
              </button>
            </div>
          ) : null}
          <AppLink route="trader" params={{ address }} className="num text-[0.8125rem] text-muted hover:text-accent" title="Public profile">
            {shortAddress(address)}
          </AppLink>
        </div>
      </Heading>

      <div className="flex flex-wrap items-center justify-between gap-2 px-1">
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Period">
          {PERIODS.map((p) => (
            <button key={p.key} type="button" className="chip" aria-pressed={period === p.key} onClick={() => setPeriod(p.key)} data-testid={`period-${p.key}`}>
              {p.label}
            </button>
          ))}
        </div>
        <p className="text-xs text-faint" role="status" aria-live="polite">
          {coverageText}
        </p>
      </div>

      <section className="panel" aria-label="Summary">
        <dl className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8">
          <Figure label="Account value" tip="Balance + margin in positions + order escrow + unrealised PnL, right now.">
            {totals ? fmtUsdc(totals.equity) : <span className="skeleton w-20" />}
          </Figure>
          <Figure label="Unrealised" tip="Open positions at current prices, after funding, before close fees." sub={totals ? `${account.data?.positions.length ?? 0} open` : undefined}>
            {totals ? <span className={tone(totals.pnl)}>{fmtUsdc(totals.pnl, 2, { sign: true })}</span> : "—"}
          </Figure>
          <Figure label="Net PnL" tip="Closed trades in the period: what they returned beyond their margin, after every fee they paid (open, increases, closes) and funding." sub={`${stats.trades} trade${stats.trades === 1 ? "" : "s"}`}>
            <span className={tone(stats.net)} data-testid="portfolio-net">
              {fmtUsdc(stats.net, 2, { sign: true })}
            </span>
          </Figure>
          <Figure label="Win rate" sub={stats.trades > 0 ? `${stats.wins} won, ${stats.losses} lost` : undefined}>
            {stats.winRate === null ? "—" : fmtPercent(stats.winRate, 0)}
          </Figure>
          <Figure label="Profit factor" tip="Total won divided by total lost. Above 1 means winners outweigh losers.">
            {stats.profitFactor === null ? (stats.wins > 0 ? "∞" : "—") : stats.profitFactor.toFixed(2)}
          </Figure>
          <Figure label="Expectancy" tip="Average net result per trade.">
            <span className={tone(stats.expectancy)}>{stats.expectancy === null ? "—" : fmtUsdc(stats.expectancy, 2, { sign: true })}</span>
          </Figure>
          <Figure label="Max drawdown" tip="The largest fall in cumulative net PnL from a previous high, over the period's closed trades.">
            <span className={stats.maxDrawdown > 0n ? "text-short" : ""}>{stats.maxDrawdown > 0n ? `−${fmtUsdc(stats.maxDrawdown)}` : "0.00"}</span>
          </Figure>
          <Figure label="Volume" sub={stats.fees > 0n ? `${fmtUsdc(stats.fees)} ${sym} in fees` : undefined}>
            {fmtCompact(stats.volume, USDC_DECIMALS)}
          </Figure>
        </dl>
      </section>

      <div className="grid grid-cols-1 gap-2 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="panel min-w-0" aria-label="PnL over time">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-3 py-2">
            <h2 className="panel-title">Cumulative PnL</h2>
            <span className="text-2xs text-faint">closed trades, then open positions at current prices</span>
          </div>
          {loading ? <div className="h-[220px] p-3"><span className="skeleton h-full w-full" /></div> : <PnlCurve points={curve} unit={sym} />}
        </section>
        <section className="panel min-w-0" aria-label="Daily PnL">
          <div className="flex items-baseline justify-between border-b border-line px-3 py-2">
            <h2 className="panel-title">Daily PnL</h2>
            <span className="text-2xs text-faint">UTC days, last 13 weeks</span>
          </div>
          <div className="px-3 py-3">
            <PnlCalendar days={tradeStats(allTrades).days} unit={sym} nowSeconds={chainNow} />
            <dl className="mt-3 grid grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
              <div className="kv">
                <dt>Average win</dt>
                <dd className="num text-long">{stats.avgWin !== null ? fmtUsdc(stats.avgWin, 2, { sign: true }) : "—"}</dd>
              </div>
              <div className="kv">
                <dt>Average loss</dt>
                <dd className="num text-short">{stats.avgLoss !== null ? fmtUsdc(stats.avgLoss, 2, { sign: true }) : "—"}</dd>
              </div>
              <div className="kv">
                <dt>Best trade</dt>
                <dd className={`num ${tone(stats.best?.net)}`}>{stats.best ? fmtUsdc(stats.best.net, 2, { sign: true }) : "—"}</dd>
              </div>
              <div className="kv">
                <dt>Worst trade</dt>
                <dd className={`num ${tone(stats.worst?.net)}`}>{stats.worst ? fmtUsdc(stats.worst.net, 2, { sign: true }) : "—"}</dd>
              </div>
              <div className="kv">
                <dt>Average hold</dt>
                <dd className="num">{stats.avgHold !== null ? fmtDuration(stats.avgHold) : "—"}</dd>
              </div>
              <div className="kv">
                <dt>Liquidations</dt>
                <dd className={`num ${stats.liquidations > 0 ? "text-short" : ""}`}>{stats.liquidations}</dd>
              </div>
            </dl>
          </div>
        </section>
      </div>

      <div className="grid grid-cols-1 gap-2 lg:grid-cols-2">
        <section className="panel min-w-0" aria-label="Open positions">
          <div className="flex items-baseline justify-between border-b border-line px-3 py-2">
            <h2 className="panel-title">Open positions</h2>
            {totals ? (
              <span className="num text-2xs text-faint">
                <span className="text-long">{fmtCompact(totals.longExposure, USDC_DECIMALS)} long</span> · <span className="text-short">{fmtCompact(totals.shortExposure, USDC_DECIMALS)} short</span> ·{" "}
                {fmtUsdc(totals.margin)} {sym} at risk
              </span>
            ) : null}
          </div>
          {positions.length === 0 ? (
            <p className="px-4 py-8 text-center text-muted">{account.isLoading ? "Loading…" : "No open positions."}</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Market</th>
                    <th className="r">Size</th>
                    <th className="r">Margin</th>
                    <th className="r">PnL</th>
                    <th className="r">To liquidation</th>
                  </tr>
                </thead>
                <tbody>
                  {positions.map(({ view: p, inst, value }) => {
                    const t = riskTone(value.liquidatableNow ? 0 : value.liquidationDistance);
                    return (
                      <tr key={p.key}>
                        <td>
                          {inst ? (
                            <AppLink route="trade" params={{ market: inst.symbol }} className="wide font-semibold hover:text-accent">
                              {inst.symbol}
                            </AppLink>
                          ) : (
                            "Unknown"
                          )}{" "}
                          <span className={p.position.isLong ? "text-long" : "text-short"}>{p.position.isLong ? "Long" : "Short"}</span>
                          <span className="num ml-1 text-faint">{value.leverage.toFixed(value.leverage >= 10 ? 0 : 1)}x</span>
                        </td>
                        <td className="r num">{fmtUsdc(p.position.size, 0)}</td>
                        <td className="r num">{fmtUsdc(p.position.margin)}</td>
                        <td className={`r num ${tone(value.pnl)}`}>{value.pnl !== null ? fmtUsdc(value.pnl, 2, { sign: true }) : "—"}</td>
                        <td className={`r num ${t ? RISK_TEXT[t] : ""}`}>
                          {value.liquidatableNow ? "now" : value.liquidationDistance !== null ? `${fmtPercent(value.liquidationDistance, 2)} move` : "none"}
                          {value.liquidationPrice !== null && inst ? <span className="block text-2xs text-faint">at {fmtPrice(value.liquidationPrice, inst.priceDecimals)}</span> : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <section className="panel min-w-0" aria-label="By market and side">
          <div className="flex items-baseline justify-between border-b border-line px-3 py-2">
            <h2 className="panel-title">By market</h2>
            <span className="num text-2xs text-faint">
              Longs <span className={tone(stats.long.net)}>{fmtUsdc(stats.long.net, 2, { sign: true })}</span> ({stats.long.trades}) · Shorts{" "}
              <span className={tone(stats.short.net)}>{fmtUsdc(stats.short.net, 2, { sign: true })}</span> ({stats.short.trades})
            </span>
          </div>
          {stats.byMarket.size === 0 ? (
            <p className="px-4 py-8 text-center text-muted">No closed trades in this period.</p>
          ) : (
            <div className="overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>Market</th>
                    <th className="r">Trades</th>
                    <th className="r">Win rate</th>
                    <th className="r">Volume</th>
                    <th className="r">Net PnL</th>
                  </tr>
                </thead>
                <tbody>
                  {[...stats.byMarket.entries()]
                    .sort((a, b) => (a[1].net === b[1].net ? 0 : a[1].net < b[1].net ? 1 : -1))
                    .map(([id, m]) => (
                      <tr key={id}>
                        <td className="wide font-semibold">{byId.get(id)?.symbol ?? "Unknown"}</td>
                        <td className="r num">{m.trades}</td>
                        <td className="r num">{fmtPercent(m.wins / m.trades, 0)}</td>
                        <td className="r num">{fmtCompact(m.volume, USDC_DECIMALS)}</td>
                        <td className={`r num ${tone(m.net)}`}>{fmtUsdc(m.net, 2, { sign: true })}</td>
                      </tr>
                    ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      <Journal trades={trades} readOnly={view.watching} />

      {status.loadedFromTime > 0 && !covered && status.pending === 0 ? (
        <p className="px-1 text-center text-xs text-faint">
          History reads go back {fmtAge(Math.max(0, chainNow - status.loadedFromTime))}.{" "}
          <button type="button" className="link" onClick={() => void feed.extend(DAY)}>
            Read one more day
          </button>
        </p>
      ) : null}
    </div>
  );
}

function Heading({ children }: { children?: React.ReactNode }) {
  return (
    <div className="flex flex-wrap items-end justify-between gap-3 px-1 pt-2">
      <div>
        <h1 className="wide text-xl font-semibold leading-tight sm:text-2xl">Portfolio</h1>
        <p className="mt-1 text-[0.8125rem] text-muted">Performance, open risk and a journal of every closed trade.</p>
      </div>
      {children}
    </div>
  );
}
