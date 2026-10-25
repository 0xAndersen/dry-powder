"use client";

import { useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { getAddress, isAddress, type Address } from "viem";
import { AppLink } from "@/components/app-link";
import { AgentBadgeFor } from "@/components/agents/agent-badge";
import { PnlCalendar } from "@/components/portfolio/pnl-calendar";
import { PnlCurve } from "@/components/portfolio/pnl-curve";
import { Journal } from "@/components/portfolio/journal";
import { useApp } from "@/components/providers";
import { Avatar } from "@/components/social/avatar";
import { ShareSheet } from "@/components/social/share-sheet";
import { FollowButton, useIsMe } from "@/components/social/trader-name";
import { useAccountData } from "@/hooks/use-account-data";
import { useLocalStore } from "@/hooks/use-local-store";
import { useLogFeed } from "@/hooks/use-log-feed";
import { useChainNow, useMarketData } from "@/hooks/use-market-data";
import { useStatsFile } from "@/hooks/use-venue-stats";
import { DAY, allTime, closedTrades, continueState, roiOf, winRateOf } from "@/lib/aggregate";
import { USDC_DECIMALS, fmtAge, fmtCompact, fmtDateTime, fmtPercent, fmtPrice, fmtUsdc, shortAddress, usdcToNum } from "@/lib/format";
import { valuePosition } from "@/lib/position";
import { RISK_TEXT, riskTone } from "@/lib/risk-tone";
import type { ShareCard } from "@/lib/share-card";
import { closedTradeCard, profileCard, profileLink, shareText, type CardContext } from "@/lib/share-data";
import { follows, isFollowing, nicknameOf, setNickname, toggleFollow } from "@/lib/social";
import { tradeStats } from "@/lib/trade-stats";

const tone = (v: bigint | null | undefined) => (v === null || v === undefined || v === 0n ? "" : v > 0n ? "text-long" : "text-short");

function Figure({ label, children, sub }: { label: string; children: React.ReactNode; sub?: React.ReactNode }) {
  return (
    <div className="min-w-0 px-3 py-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="num mt-0.5 truncate text-xl font-semibold leading-tight">{children}</dd>
      {sub ? <dd className="num mt-0.5 truncate text-2xs text-faint">{sub}</dd> : null}
    </div>
  );
}

export function TraderScreen() {
  const searchParams = useSearchParams();
  const raw = searchParams.get("address") ?? searchParams.get("account");
  const address = raw && isAddress(raw, { strict: false }) ? getAddress(raw) : undefined;
  if (!address) {
    return (
      <section className="panel mt-2 px-4 py-14 text-center text-muted">
        <h1 className="wide text-xl text-text">Trader profile</h1>
        <p className="mt-2">Open a trader from the Leaderboard or the Activity feed, or add <span className="num">?address=0x…</span> to this page&apos;s address.</p>
        <p className="mt-4">
          <AppLink route="leaderboard" className="btn btn-primary">
            Leaderboard
          </AppLink>
        </p>
      </section>
    );
  }
  return <Profile address={address} />;
}

function Profile({ address }: { address: Address }) {
  const { config: cfg } = useApp();
  const { prices, params, byId } = useMarketData();
  const chainNow = useChainNow(10_000);
  const [list] = useLocalStore(follows);
  const following = isFollowing(list, address);
  const nickname = nicknameOf(list, address);
  const me = useIsMe(address);
  const [copied, setCopied] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [share, setShare] = useState<{ card: ShareCard; title: string } | null>(null);
  const sym = cfg.collateralSymbol;

  const since = cfg.overrides.includes("engine") ? null : cfg.deployedAt;
  const lookback = useMemo(() => {
    const now = Date.now() / 1000;
    return since ? Math.min(DAY, Math.max(3_600, now - since + 600)) : DAY;
  }, [since, address]); // eslint-disable-line react-hooks/exhaustive-deps
  const feed = useLogFeed({ trader: address, lookbackSeconds: lookback, exactTimes: true, maxEvents: 6_000, blockRange: 10_000 });
  const account = useAccountData(address);
  const file = useStatsFile();

  const trades = useMemo(() => closedTrades(feed.events, params?.maxProfitMultiple ?? 10n), [feed.events, params?.maxProfitMultiple]);
  const stats = useMemo(() => tradeStats(trades), [trades]);
  // All-time figures: the indexer's record of this trader, continued with the events read here.
  const record = useMemo(() => {
    if (file.data?.status !== "ready") return null;
    const state = continueState(file.data.state, feed.events, address);
    return state.traders[address.toLowerCase()] ?? null;
  }, [file.data, feed.events, address]);
  const all = record ? allTime(record) : null;

  const covered = since !== null && feed.status.loadedFromTime > 0 && feed.status.loadedFromTime <= since + 60;
  const curve = useMemo(() => {
    const start = feed.status.loadedFromTime || chainNow;
    return [{ time: start, value: 0 }, ...stats.curve.map((p) => ({ time: p.time, value: usdcToNum(p.value) }))];
  }, [stats.curve, feed.status.loadedFromTime, chainNow]);
  const calendarDays = useMemo(() => {
    if (!record) return stats.days;
    const out = new Map<number, { net: bigint; trades: number }>();
    for (const b of record.days) out.set(b.i, { net: b.r - b.f, trades: b.t });
    return out;
  }, [record, stats.days]);

  const positions = useMemo(() => {
    if (!account.data || !params) return [];
    return account.data.positions.map((p) => {
      const id = p.position.priceId.toLowerCase();
      return { view: p, inst: byId.get(id), value: valuePosition(p, prices.get(id)?.mark ?? null, params.maxProfitMultiple) };
    });
  }, [account.data, params, prices, byId]);

  const copy = (text: string, what: string) => {
    void navigator.clipboard?.writeText(text).then(() => {
      setCopied(what);
      setTimeout(() => setCopied(null), 1_500);
    });
  };
  const profileUrl = typeof window === "undefined" ? "" : window.location.href;

  // Prefer the all-time record; fall back to the trades read here.
  const net = all ? all.net : stats.net;
  const tradesCount = all ? all.trades : stats.trades;
  const winRate = all ? winRateOf(all) : stats.winRate;
  const roi = all ? roiOf(all) : stats.roi;
  const volume = all ? all.volume : stats.volume;
  const liquidations = all ? all.liquidations : stats.liquidations;
  const cardContext: CardContext = {
    market: (id) => byId.get(id.toLowerCase()),
    unit: sym,
    chainId: cfg.chainId,
    trader: nickname ?? shortAddress(address),
    href: profileUrl,
  };
  const shareProfile = () =>
    setShare({
      card: profileCard({ net, roi, trades: tradesCount, winRate, volume, liquidations }, all ? "All time" : "Recent trades", cardContext),
      title: me ? "Share your profile" : "Share this profile",
    });

  return (
    <div className="flex flex-col gap-2" data-testid="trader-profile">
      <section className="panel mt-2 flex flex-wrap items-center gap-x-4 gap-y-3 px-3 py-3">
        <Avatar address={address} size={48} />
        <div className="min-w-0 flex-1">
          <h1 className="wide flex flex-wrap items-center gap-2 text-xl font-semibold leading-tight">
            {nickname ?? <span className="num">{shortAddress(address)}</span>}
            {me ? (
              <span className="tag" data-tone="accent">
                You
              </span>
            ) : null}
            <AgentBadgeFor address={address} />
          </h1>
          <p className="mt-0.5 flex flex-wrap items-center gap-2 text-xs text-muted">
            <span className="num break-all">{address}</span>
            <button type="button" className="link" onClick={() => copy(address, "address")}>
              {copied === "address" ? "Copied" : "Copy"}
            </button>
          </p>
          {editing ? (
            <form
              className="mt-2 flex flex-wrap items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                if (!following) toggleFollow(address);
                setNickname(address, draft);
                setEditing(false);
              }}
            >
              <div className="field h-8 w-48">
                <input value={draft} onChange={(event) => setDraft(event.target.value)} maxLength={32} placeholder="Nickname (only you see it)" aria-label="Nickname" autoFocus />
              </div>
              <button type="submit" className="btn btn-sm btn-primary">
                Save
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setEditing(false)}>
                Cancel
              </button>
            </form>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!me ? <FollowButton address={address} label /> : null}
          {!me && !editing ? (
            <button
              type="button"
              className="btn btn-sm"
              onClick={() => {
                setDraft(nickname ?? "");
                setEditing(true);
              }}
            >
              {nickname ? "Rename" : "Nickname"}
            </button>
          ) : null}
          <AppLink route="trade" params={{ account: address }} className="btn btn-sm" title="Open the trade screen read-only on this account">
            Watch in Trade
          </AppLink>
          <button type="button" className="btn btn-sm btn-ghost" onClick={shareProfile} data-testid="share-profile">
            Share profile
          </button>
          <a className="btn btn-sm btn-ghost" href={`${cfg.explorerUrl}/address/${address}`} target="_blank" rel="noreferrer">
            Explorer
          </a>
        </div>
      </section>

      <section className="panel" aria-label="Performance">
        <dl className="grid grid-cols-2 sm:grid-cols-3 xl:grid-cols-6">
          <Figure label={all ? "Net PnL, all time" : "Net PnL"} sub={record ? `since ${fmtDateTime(record.firstTime)}` : undefined}>
            <span className={tone(net)} data-testid="trader-net">
              {fmtUsdc(net, 2, { sign: true })}
            </span>
          </Figure>
          <Figure label="ROI" sub={all ? "net over margin released" : "net over margin put in"}>
            {roi === null ? "—" : <span className={roi > 0 ? "text-long" : roi < 0 ? "text-short" : ""}>{fmtPercent(roi, 1, true)}</span>}
          </Figure>
          <Figure label="Win rate" sub={tradesCount > 0 ? `${all ? all.wins : stats.wins} of ${tradesCount}` : undefined}>
            {winRate === null ? "—" : fmtPercent(winRate, 0)}
          </Figure>
          <Figure label="Trades">{tradesCount.toLocaleString("en-US")}</Figure>
          <Figure label="Volume" sub={sym}>
            {fmtCompact(volume, USDC_DECIMALS)}
          </Figure>
          <Figure label="Liquidations">
            <span className={liquidations > 0 ? "text-short" : ""}>{liquidations}</span>
          </Figure>
        </dl>
        <p className="border-t border-line px-3 py-1.5 text-2xs text-faint">
          {record
            ? `All-time figures from the venue indexer, plus live events. Last trade ${record.lastTime ? `${fmtAge(Math.max(0, chainNow - record.lastTime))} ago` : "unknown"}.`
            : `From the trades read here${feed.status.loadedFromTime ? ` (since ${fmtDateTime(feed.status.loadedFromTime)})` : ""}${covered ? ": everything since this deployment" : ""}.`}
        </p>
      </section>

      <div className="grid grid-cols-1 gap-2 xl:grid-cols-[minmax(0,1fr)_22rem]">
        <section className="panel min-w-0" aria-label="PnL over time">
          <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-3 py-2">
            <h2 className="panel-title">Cumulative PnL</h2>
            <span className="text-2xs text-faint">closed trades read here</span>
          </div>
          <PnlCurve points={curve} unit={sym} />
        </section>
        <section className="panel min-w-0" aria-label="Daily PnL">
          <div className="flex items-baseline justify-between border-b border-line px-3 py-2">
            <h2 className="panel-title">Daily PnL</h2>
            <span className="text-2xs text-faint">UTC days</span>
          </div>
          <div className="px-3 py-3">
            <PnlCalendar days={calendarDays} unit={sym} nowSeconds={chainNow} />
          </div>
        </section>
      </div>

      <section className="panel min-w-0" aria-label="Open positions">
        <div className="flex items-baseline justify-between border-b border-line px-3 py-2">
          <h2 className="panel-title">Open positions</h2>
          <span className="text-2xs text-faint">Copy opens the ticket with the same market, side and leverage; you choose the size.</span>
        </div>
        {positions.length === 0 ? (
          <p className="px-4 py-8 text-center text-muted">{account.isLoading ? "Loading…" : "No open positions."}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="data-table card-table">
              <thead>
                <tr>
                  <th>Market</th>
                  <th className="r">Size</th>
                  <th className="r">Entry</th>
                  <th className="r">PnL</th>
                  <th className="r">To liquidation</th>
                  <th className="r">
                    <span className="sr-only">Copy</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {positions.map(({ view: p, inst, value }) => {
                  const t = riskTone(value.liquidatableNow ? 0 : value.liquidationDistance);
                  const lev = Math.max(1, Math.round(value.leverage));
                  return (
                    <tr key={p.key}>
                      <td data-cell="market">
                        <span className="wide font-semibold">{inst?.symbol ?? "Unknown"}</span>{" "}
                        <span className={p.position.isLong ? "text-long" : "text-short"}>{p.position.isLong ? "Long" : "Short"}</span>
                        <span className="num ml-1 text-faint">{lev}x</span>
                      </td>
                      <td className="r num" data-label="Size">
                        {fmtUsdc(p.position.size, 0)}
                      </td>
                      <td className="r num" data-label="Entry">
                        {inst ? fmtPrice(p.position.entryPrice, inst.priceDecimals) : "—"}
                      </td>
                      <td className={`r num ${tone(value.pnl)}`} data-cell="pnl">
                        <span>{value.pnl !== null ? fmtUsdc(value.pnl, 2, { sign: true }) : "—"}</span>
                      </td>
                      <td className={`r num ${t ? RISK_TEXT[t] : ""}`} data-label="To liquidation">
                        {value.liquidatableNow ? "now" : value.liquidationDistance !== null ? `${fmtPercent(value.liquidationDistance, 2)} move` : "none"}
                      </td>
                      <td className="r" data-cell="actions">
                        {inst && !me ? (
                          <AppLink route="trade" params={{ market: inst.symbol, side: p.position.isLong ? "long" : "short", lev: String(lev), account: null }} className="btn btn-sm" data-testid="copy-trade">
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

      <Journal trades={trades} readOnly notes={false} title="Recent trades" onShare={(t) => setShare({ card: closedTradeCard(t, cardContext), title: "Share this trade" })} />

      {share ? <ShareSheet card={share.card} title={share.title} text={shareText(share.card)} link={profileLink(address)} onClose={() => setShare(null)} /> : null}
      {!covered && feed.status.loadedFromTime > 0 && feed.status.pending === 0 ? (
        <p className="px-1 text-center text-xs text-faint">
          Trades read back to {fmtDateTime(feed.status.loadedFromTime)}.{" "}
          <button type="button" className="link" onClick={() => void feed.extend(DAY)}>
            Read one more day
          </button>
        </p>
      ) : null}
    </div>
  );
}
