"use client";

import { useDeferredValue, useMemo, useRef, useState } from "react";
import { useReadContracts } from "wagmi";
import { AppLink } from "@/components/app-link";
import { useApp } from "@/components/providers";
import { FollowButton, TraderName } from "@/components/social/trader-name";
import { Tip } from "@/components/tip";
import { useLocalStore } from "@/hooks/use-local-store";
import { useLogFeed } from "@/hooks/use-log-feed";
import { useChainNow, useMarketData } from "@/hooks/use-market-data";
import { houseVaultAbi, perpEngineAbi } from "@/lib/abi";
import type { EngineEvent } from "@/lib/events";
import { orderTypeLabel } from "@/lib/events";
import { USDC_DECIMALS, fmtAge, fmtClock, fmtCompact, fmtPercent, fmtPrice, fmtUsdc } from "@/lib/format";
import { groupInstruments, marketSlug } from "@/lib/instruments";
import { ratio } from "@/lib/math";
import { follows, isFollowing } from "@/lib/social";

const WINDOWS = [
  { seconds: 300, label: "5 min" },
  { seconds: 900, label: "15 min" },
  { seconds: 3_600, label: "1 hour" },
] as const;

const MAX_ROWS = 150;

type TraderStats = { trader: string; pnl: bigint; fees: bigint; volume: bigint; trades: number; liquidations: number };

type Aggregate = {
  trades: number;
  opens: number;
  closes: number;
  liquidations: number;
  volume: bigint;
  fees: bigint;
  /** Net result of traders: positive means traders took money from the house. */
  traderPnl: bigint;
  traders: TraderStats[];
  uniqueTraders: number;
  perMarket: Map<string, { trades: number; volume: bigint }>;
  sizeOf: Map<string, { size: bigint; isLong: boolean }>;
};

function aggregate(events: readonly EngineEvent[]): Aggregate {
  const byTrader = new Map<string, TraderStats>();
  const perMarket = new Map<string, { trades: number; volume: bigint }>();
  const openByKey = new Map<string, { size: bigint; isLong: boolean }>();
  const sizeOf = new Map<string, { size: bigint; isLong: boolean }>();
  const out: Aggregate = { trades: 0, opens: 0, closes: 0, liquidations: 0, volume: 0n, fees: 0n, traderPnl: 0n, traders: [], uniqueTraders: 0, perMarket, sizeOf };

  const stats = (trader: string): TraderStats => {
    const key = trader.toLowerCase();
    let s = byTrader.get(key);
    if (!s) {
      s = { trader, pnl: 0n, fees: 0n, volume: 0n, trades: 0, liquidations: 0 };
      byTrader.set(key, s);
    }
    return s;
  };
  const market = (id: string) => {
    let m = perMarket.get(id);
    if (!m) {
      m = { trades: 0, volume: 0n };
      perMarket.set(id, m);
    }
    return m;
  };

  for (const e of events) {
    if (e.type === "open") {
      openByKey.set(e.key, { size: e.size, isLong: e.isLong });
      const s = stats(e.trader);
      s.trades += 1;
      s.volume += e.size;
      s.fees += e.fee;
      s.pnl -= e.fee;
      const m = market(e.marketId);
      m.trades += 1;
      m.volume += e.size;
      out.opens += 1;
      out.trades += 1;
      out.volume += e.size;
      out.fees += e.fee;
      out.traderPnl -= e.fee;
    } else if (e.type === "close") {
      // The close event carries no size; it is known only when the open is inside the window.
      const opened = openByKey.get(e.key);
      openByKey.delete(e.key);
      if (opened) sizeOf.set(e.id, opened);
      const size = opened?.size ?? 0n;
      const s = stats(e.trader);
      s.trades += 1;
      s.volume += size;
      s.fees += e.fee;
      s.pnl += e.pnl - e.fee;
      const m = market(e.marketId);
      m.trades += 1;
      m.volume += size;
      out.closes += 1;
      out.trades += 1;
      out.volume += size;
      out.fees += e.fee;
      out.traderPnl += e.pnl - e.fee;
    } else if (e.type === "liquidation") {
      const opened = openByKey.get(e.key);
      openByKey.delete(e.key);
      if (opened) sizeOf.set(e.id, opened);
      const s = stats(e.trader);
      s.liquidations += 1;
      s.pnl -= e.margin;
      market(e.marketId).trades += 1;
      out.liquidations += 1;
      out.traderPnl -= e.margin;
    }
  }
  out.traders = [...byTrader.values()].sort((a, b) => (a.pnl === b.pnl ? 0 : a.pnl < b.pnl ? 1 : -1));
  out.uniqueTraders = byTrader.size;
  return out;
}

function Figure({ label, children, tip }: { label: string; children: React.ReactNode; tip?: React.ReactNode }) {
  return (
    <div className="min-w-0 px-3 py-3">
      <dt className="flex items-center gap-1 text-xs text-muted">
        {label}
        {tip ? <Tip label={`About ${label.toLowerCase()}`}>{tip}</Tip> : null}
      </dt>
      <dd className="num mt-0.5 truncate text-xl font-semibold leading-tight">{children}</dd>
    </div>
  );
}

function Trader({ address }: { address: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <FollowButton address={address} />
      <TraderName address={address} />
    </span>
  );
}

export function ActivityScreen() {
  const { config: cfg } = useApp();
  const { instruments, byId, params } = useMarketData();
  const [windowSeconds, setWindowSeconds] = useState<number>(900);
  const [marketFilter, setMarketFilter] = useState<string | null>(null);
  const [paused, setPaused] = useState(false);
  const [showOrders, setShowOrders] = useState(false);
  const [followingOnly, setFollowingOnly] = useState(false);
  const [followed] = useLocalStore(follows);
  const sym = cfg.collateralSymbol;

  const feed = useLogFeed({ lookbackSeconds: windowSeconds, pollMs: 1_000, maxEvents: 8_000 });
  const live = useDeferredValue(feed.events);
  const frozen = useRef(live);
  if (!paused) frozen.current = live;
  const tableEvents = paused ? frozen.current : live;

  const vault = useReadContracts({
    allowFailure: false,
    contracts: [
      { abi: houseVaultAbi, address: cfg.houseVault, chainId: cfg.chainId, functionName: "totalHouseBalance" },
      { abi: houseVaultAbi, address: cfg.houseVault, chainId: cfg.chainId, functionName: "markedValue" },
      { abi: perpEngineAbi, address: cfg.perpEngine, chainId: cfg.chainId, functionName: "positionCount" },
      { abi: perpEngineAbi, address: cfg.perpEngine, chainId: cfg.chainId, functionName: "orderCount" },
    ],
    query: { refetchInterval: 3_000 },
  });

  // The window slides: events older than it drop out of the totals as time passes.
  const chainNow = useChainNow(5_000);
  const cutoff = Math.floor(chainNow) - windowSeconds - 5;
  const filtered = useMemo(
    () => live.filter((e) => e.time >= cutoff && (!marketFilter || ("marketId" in e && e.marketId === marketFilter))),
    [live, marketFilter, cutoff],
  );
  const totals = useMemo(() => aggregate(filtered), [filtered]);

  const rows = useMemo(() => {
    const out: EngineEvent[] = [];
    for (let i = tableEvents.length - 1; i >= 0 && out.length < MAX_ROWS; i -= 1) {
      const e = tableEvents[i]!;
      if (e.type === "orderExecuted") continue;
      if (!showOrders && (e.type === "orderCreated" || e.type === "orderCancelled")) continue;
      if (marketFilter && (!("marketId" in e) || e.marketId !== marketFilter)) continue;
      if (followingOnly && (!("trader" in e) || !isFollowing(followed, e.trader))) continue;
      out.push(e);
    }
    return out;
  }, [tableEvents, marketFilter, showOrders, followingOnly, followed]);

  const ordered = useMemo(() => groupInstruments(instruments).flatMap((g) => g.items), [instruments]);
  const maxOi = useMemo(() => ordered.reduce((m, i) => (i.longOi > m ? i.longOi : i.shortOi > m ? i.shortOi : m), 0n), [ordered]);
  const totalOi = params?.totalOpenInterest ?? 0n;
  const status = feed.status;
  const covered = status.loadedFromTime > 0 ? Math.max(0, Date.now() / 1000 - status.loadedFromTime) : 0;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end justify-between gap-3 px-1 pt-2">
        <div>
          <h1 className="wide text-xl font-semibold leading-tight sm:text-2xl">Venue activity</h1>
          <p className="mt-1 text-[0.8125rem] text-muted" role="status" aria-live="polite">
            <span aria-hidden="true" className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full align-middle ${status.phase === "live" ? "bg-long" : status.phase === "error" ? "bg-short" : "bg-warn"}`} />
            {status.phase === "error"
              ? `Event logs unavailable (${status.error ?? "RPC error"}). Retrying.`
              : status.phase === "live"
                ? `Live from block logs, covering the last ${fmtAge(covered)}. Block ${status.headBlock.toLocaleString("en-US")}.`
                : `Reading the last ${fmtAge(windowSeconds)} of block logs${status.pending > 0 ? ` (${status.pending} request${status.pending === 1 ? "" : "s"} left)` : ""}…`}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label="Time window">
          <span className="text-xs text-faint">Window</span>
          {WINDOWS.map((w) => (
            <button key={w.seconds} type="button" className="chip" aria-pressed={windowSeconds === w.seconds} onClick={() => setWindowSeconds(w.seconds)}>
              {w.label}
            </button>
          ))}
        </div>
      </div>

      <section className="panel" aria-label="Totals for the window">
        <dl className="grid grid-cols-2 divide-line sm:grid-cols-3 lg:grid-cols-6 lg:divide-x">
          <Figure label="Trades" tip="Position opens, closes and liquidations inside the window.">
            <span data-testid="stat-trades">{totals.trades.toLocaleString("en-US")}</span>
          </Figure>
          <Figure label="Volume" tip="Notional opened plus notional closed. A close only counts when its open is inside the window, because the close event does not carry the size.">
            {fmtCompact(totals.volume, USDC_DECIMALS)} <span className="text-xs font-normal text-muted">{sym}</span>
          </Figure>
          <Figure label="Liquidations">
            <span className={totals.liquidations > 0 ? "text-short" : ""} data-testid="stat-liquidations">{totals.liquidations.toLocaleString("en-US")}</span>
          </Figure>
          <Figure label="Unique traders">
            <span data-testid="stat-traders">{totals.uniqueTraders.toLocaleString("en-US")}</span>
          </Figure>
          <Figure label="Open interest" tip="Long plus short notional across all markets, right now.">
            {fmtCompact(totalOi, USDC_DECIMALS)} <span className="text-xs font-normal text-muted">{vault.data ? `${vault.data[2].toString()} positions` : ""}</span>
          </Figure>
          <Figure
            label="Vault NAV"
            tip={
              <>
                What a withdrawal is priced at: the lower of the realised balance
                {vault.data ? ` (${fmtUsdc(vault.data[0])})` : ""} and the balance marked for open trader PnL
                {vault.data ? ` (${fmtUsdc(vault.data[1])})` : ""}.
              </>
            }
          >
            {params ? fmtCompact(params.vaultNav, USDC_DECIMALS) : "—"} <span className="text-xs font-normal text-muted">{sym}</span>
          </Figure>
        </dl>
      </section>

      <div className="flex flex-wrap items-center gap-1.5 px-1" role="group" aria-label="Filter by market">
        <button type="button" className="chip" aria-pressed={marketFilter === null} onClick={() => setMarketFilter(null)}>
          All markets
        </button>
        {ordered.map((i) => (
          <button key={i.id} type="button" className="chip" aria-pressed={marketFilter === i.id} onClick={() => setMarketFilter(marketFilter === i.id ? null : i.id)}>
            {i.symbol}
            {totals.perMarket.get(i.id) && marketFilter === null ? <span className="num ml-1 text-faint">{totals.perMarket.get(i.id)!.trades}</span> : null}
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 items-start gap-2 xl:grid-cols-[minmax(0,1fr)_25rem]">
        <section className="panel min-w-0" aria-label="Live feed">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
            <h2 className="panel-title">Live feed</h2>
            <div className="flex items-center gap-3">
              <button type="button" className="chip" aria-pressed={followingOnly} onClick={() => setFollowingOnly((v) => !v)} data-testid="feed-following">
                ★ Following <span className="num ml-1 text-faint">{followed.length}</span>
              </button>
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <input type="checkbox" className="check" checked={showOrders} onChange={(event) => setShowOrders(event.target.checked)} />
                Order placements
              </label>
              <button type="button" className="chip" aria-pressed={paused} onClick={() => setPaused((v) => !v)}>
                {paused ? "Paused: resume" : "Pause"}
              </button>
            </div>
          </div>
          {rows.length === 0 ? (
            <div className="px-4 py-14 text-center text-muted">
              {status.phase === "starting" || status.pending > 0
                ? "Reading block logs…"
                : followingOnly
                  ? followed.length === 0
                    ? "You follow nobody yet: tap the star next to a trader to follow them."
                    : `No trades from traders you follow in the last ${fmtAge(Math.max(covered, 1))}.`
                  : `Nothing has traded${marketFilter ? " in this market" : ""} in the last ${fmtAge(Math.max(covered, 1))}.`}
            </div>
          ) : (
            <div className="feed-scroll">
              <table className="data-table feed-table">
                <thead className="sticky top-0 z-10 bg-panel">
                  <tr>
                    <th>Time</th>
                    <th>Event</th>
                    <th>Market</th>
                    <th>Trader</th>
                    <th className="r">Size</th>
                    <th className="r">Price</th>
                    <th className="r">Result</th>
                    <th className="r">
                      <span className="sr-only">Copy</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((e) => {
                    const inst = "marketId" in e ? byId.get(e.marketId) : undefined;
                    const dp = inst?.priceDecimals ?? 2;
                    const known = totals.sizeOf.get(e.id);
                    let label: React.ReactNode;
                    let size: React.ReactNode = "—";
                    let price: React.ReactNode = "—";
                    let result: React.ReactNode = "—";
                    if (e.type === "open") {
                      label = (
                        <>
                          Open <span className={e.isLong ? "text-long" : "text-short"}>{e.isLong ? "long" : "short"}</span>
                        </>
                      );
                      size = fmtUsdc(e.size, 0);
                      price = fmtPrice(e.price, dp);
                      result = <span className="text-faint">{(Number(e.size) / Math.max(1, Number(e.margin))).toFixed(0)}x</span>;
                    } else if (e.type === "close") {
                      label = (
                        <>
                          Close{known ? <span className={known.isLong ? " text-long" : " text-short"}> {known.isLong ? "long" : "short"}</span> : null}
                        </>
                      );
                      size = known ? fmtUsdc(known.size, 0) : "—";
                      price = fmtPrice(e.price, dp);
                      result = <span className={e.pnl > 0n ? "text-long" : e.pnl < 0n ? "text-short" : ""}>{fmtUsdc(e.pnl, 2, { sign: true })}</span>;
                    } else if (e.type === "liquidation") {
                      label = <span className="font-semibold text-short">Liquidation</span>;
                      size = known ? fmtUsdc(known.size, 0) : "—";
                      price = fmtPrice(e.price, dp);
                      result = <span className="text-short">{fmtUsdc(-e.margin, 2, { sign: true })}</span>;
                    } else if (e.type === "orderCreated") {
                      label = (
                        <span className="text-muted">
                          {orderTypeLabel(e.orderType)} placed <span className={e.isLong ? "text-long" : "text-short"}>{e.isLong ? "long" : "short"}</span>
                        </span>
                      );
                      size = e.orderType === 0 || e.orderType === 4 || e.size > 0n ? fmtUsdc(e.size, 0) : "—";
                      price = e.triggerPrice === 0n ? "—" : fmtPrice(e.triggerPrice, dp);
                    } else if (e.type === "orderCancelled") {
                      label = <span className="text-muted">Order #{e.orderId.toString()} cancelled</span>;
                    } else if (e.type === "marketSettled") {
                      label = <span className="text-accent">Market settled</span>;
                      price = fmtPrice(e.price, dp);
                    }
                    const lev = e.type === "open" && e.margin > 0n ? Math.max(1, Math.round(Number(e.size) / Number(e.margin))) : null;
                    return (
                      <tr key={e.id} data-type={e.type} data-followed={"trader" in e && isFollowing(followed, e.trader) ? "true" : undefined}>
                        <td className="num text-muted">{fmtClock(e.time)}</td>
                        <td>
                          {label}
                          {(e.type === "open" || e.type === "close") && e.orderId !== undefined ? <span className="num ml-1.5 text-xs text-faint">#{e.orderId.toString()}</span> : null}
                        </td>
                        <td className="wide font-semibold">{"marketId" in e ? (inst?.symbol ?? "Unknown") : "—"}</td>
                        <td>{"trader" in e ? <Trader address={e.trader} /> : "—"}</td>
                        <td className="r num">{size}</td>
                        <td className="r num">{price}</td>
                        <td className="r num">{result}</td>
                        <td className="r">
                          {e.type === "open" && inst && lev !== null ? (
                            <AppLink
                              route="trade"
                              params={{ market: marketSlug(inst), side: e.isLong ? "long" : "short", lev: String(lev), account: null }}
                              className="text-xs text-muted hover:text-accent"
                              title={`Open the ticket with ${inst.symbol} ${e.isLong ? "long" : "short"} at ${lev}x; you choose the size`}
                            >
                              Copy
                            </AppLink>
                          ) : null}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>

        <div className="flex min-w-0 flex-col gap-2">
          <section className="panel" aria-label="Open interest by market">
            <div className="flex items-baseline justify-between border-b border-line px-3 py-2">
              <h2 className="panel-title">Open interest</h2>
              <span className="text-xs text-faint">
                <span className="text-long">long</span> / <span className="text-short">short</span>, {sym}
              </span>
            </div>
            <ul className="grid gap-2 px-3 py-3">
              {ordered.length === 0 ? <li className="text-muted">Loading markets…</li> : null}
              {ordered.map((i) => {
                const longPct = maxOi > 0n ? ratio(i.longOi, maxOi) * 100 : 0;
                const shortPct = maxOi > 0n ? ratio(i.shortOi, maxOi) * 100 : 0;
                return (
                  <li key={i.id} className="grid grid-cols-[6.5rem_1fr] items-center gap-2" data-testid={`oi-${i.symbol}`}>
                    <span className="wide truncate text-xs font-semibold">{i.symbol}</span>
                    <span className="grid gap-0.5" role="img" aria-label={`${i.symbol}: ${fmtUsdc(i.longOi, 0)} long, ${fmtUsdc(i.shortOi, 0)} short`}>
                      <span className="flex items-center gap-2">
                        <span className="oi-bar"><span className="bg-long" style={{ width: `${longPct}%` }} /></span>
                        <span className="num w-14 text-right text-xs text-long">{fmtCompact(i.longOi, USDC_DECIMALS)}</span>
                      </span>
                      <span className="flex items-center gap-2">
                        <span className="oi-bar"><span className="bg-short" style={{ width: `${shortPct}%` }} /></span>
                        <span className="num w-14 text-right text-xs text-short">{fmtCompact(i.shortOi, USDC_DECIMALS)}</span>
                      </span>
                    </span>
                  </li>
                );
              })}
            </ul>
          </section>

          <section className="panel" aria-label="Top traders">
            <div className="flex items-baseline justify-between border-b border-line px-3 py-2">
              <h2 className="panel-title">Top traders</h2>
              <span className="text-xs text-faint">realised in the window, after fees</span>
            </div>
            {totals.traders.length === 0 ? (
              <p className="px-3 py-8 text-center text-muted">No trades in the window yet.</p>
            ) : (
              <div className="relative overflow-x-auto">
              <table className="data-table">
                <thead>
                  <tr>
                    <th>#</th>
                    <th>Trader</th>
                    <th className="r">PnL</th>
                    <th className="r">Volume</th>
                    <th className="r">Trades</th>
                  </tr>
                </thead>
                <tbody>
                  {totals.traders.slice(0, 12).map((t, i) => (
                    <tr key={t.trader} data-testid="leader-row">
                      <td className="num text-faint">{i + 1}</td>
                      <td>
                        <Trader address={t.trader} />
                        {t.liquidations > 0 ? <span className="ml-1.5 text-xs text-short">{t.liquidations} liq</span> : null}
                      </td>
                      <td className={`r num ${t.pnl > 0n ? "text-long" : t.pnl < 0n ? "text-short" : ""}`}>{fmtUsdc(t.pnl, 2, { sign: true })}</td>
                      <td className="r num">{fmtCompact(t.volume, USDC_DECIMALS)}</td>
                      <td className="r num">{t.trades}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              </div>
            )}
            <p className="border-t border-line px-3 py-1.5 text-2xs text-faint">
              House result in the window: <span className={`num ${totals.traderPnl < 0n ? "text-long" : totals.traderPnl > 0n ? "text-short" : ""}`}>{fmtUsdc(-totals.traderPnl, 2, { sign: true })} {sym}</span>
              {totals.trades > 0 ? ` (${fmtPercent(totals.closes + totals.liquidations > 0 ? totals.liquidations / (totals.closes + totals.liquidations) : 0, 0)} of exits were liquidations)` : ""}. Click a trader to watch the account.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
}
