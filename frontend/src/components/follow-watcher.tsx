"use client";

import { useEffect, useRef } from "react";
import { useAppConfig } from "@/components/providers";
import { useLocalStore } from "@/hooks/use-local-store";
import { useLogFeed } from "@/hooks/use-log-feed";
import { useMarketData } from "@/hooks/use-market-data";
import { useAccountView, useWallet } from "@/hooks/use-wallet";
import type { EngineEvent } from "@/lib/events";
import { fmtPrice, fmtUsdc, shortAddress } from "@/lib/format";
import { notify } from "@/lib/notify";
import { prefs } from "@/lib/prefs";
import { follows, isFollowing, nicknameOf, type Follow } from "@/lib/social";

type Described = { tone: "info" | "ok" | "warn"; title: string; body: string };

type Lookup = { symbol: (marketId: string) => string; decimals: (marketId: string) => number; unit: string };

/** What a followed trader did, in one line and a detail line; null for events that are not trades. */
export function describeFollowedTrade(e: EngineEvent, name: string, look: Lookup): Described | null {
  const px = (marketId: string, price: bigint) => fmtPrice(price, look.decimals(marketId));
  const usd = (v: bigint, sign = false) => `${fmtUsdc(v, 2, { sign })} ${look.unit}`;
  switch (e.type) {
    case "open": {
      const lev = e.margin > 0n ? Number((e.size * 10n) / e.margin) / 10 : 0;
      return {
        tone: "info",
        title: `${name} opened a ${e.isLong ? "long" : "short"} on ${look.symbol(e.marketId)}`,
        body: `${usd(e.size)} at ${lev}x, entry ${px(e.marketId, e.price)}`,
      };
    }
    case "increase":
      return {
        tone: "info",
        title: `${name} added to a ${e.isLong ? "long" : "short"} on ${look.symbol(e.marketId)}`,
        body: `+${usd(e.addedSize)} at ${px(e.marketId, e.price)}; now ${usd(e.newSize)}`,
      };
    case "decrease":
      return {
        tone: e.pnl >= 0n ? "ok" : "info",
        title: `${name} closed part of ${look.symbol(e.marketId)}`,
        body: `${usd(e.closedSize)} at ${px(e.marketId, e.price)}, PnL ${usd(e.pnl, true)}`,
      };
    case "close":
      return {
        tone: e.pnl >= 0n ? "ok" : "info",
        title: `${name} closed ${look.symbol(e.marketId)}`,
        body: `PnL ${usd(e.pnl, true)} at ${px(e.marketId, e.price)}`,
      };
    case "liquidation":
      return {
        tone: "warn",
        title: `${name} was liquidated on ${look.symbol(e.marketId)}`,
        body: `${usd(e.margin)} of margin at ${px(e.marketId, e.price)}`,
      };
    default:
      return null;
  }
}

/**
 * FOMO-style alerts: when a trader you follow opens, adds to, closes or is liquidated on a position, a toast with a
 * link to their profile (and a system notification when allowed). Runs only while you follow someone and the alert
 * is on. Only events after the page loaded alert, never the back-fill, and never your own trades.
 */
export function FollowWatcher() {
  const cfg = useAppConfig();
  const [list] = useLocalStore(follows);
  const [p] = useLocalStore(prefs);
  const view = useAccountView();
  const wallet = useWallet();
  const { byId } = useMarketData();
  const enabled = p.followAlerts && list.length > 0;
  const feed = useLogFeed({ enabled, lookbackSeconds: 10, pollMs: 4_000, maxEvents: 300 });
  // Block the feed started at; events at or before it are history, not news.
  const startBlock = useRef<number | null>(null);
  const seen = useRef(new Set<string>());
  const latest = useRef<{ list: Follow[]; byId: typeof byId; own: string[] }>({ list, byId, own: [] });
  latest.current = { list, byId, own: [view.address, wallet.address].filter((a): a is `0x${string}` => !!a).map((a) => a.toLowerCase()) };

  useEffect(() => {
    if (!enabled) {
      startBlock.current = null;
      seen.current.clear();
    }
  }, [enabled]);

  useEffect(() => {
    if (!enabled || feed.status.headBlock === 0) return;
    if (startBlock.current === null) startBlock.current = feed.status.headBlock;
    const { list: following, byId: markets, own } = latest.current;
    const look: Lookup = {
      symbol: (id) => markets.get(id.toLowerCase())?.symbol ?? "a market",
      decimals: (id) => markets.get(id.toLowerCase())?.priceDecimals ?? 2,
      unit: cfg.collateralSymbol,
    };
    for (const e of feed.events) {
      if (seen.current.has(e.id)) continue;
      seen.current.add(e.id);
      if (e.block <= startBlock.current || !("trader" in e)) continue;
      const trader = e.trader;
      if (own.includes(trader.toLowerCase()) || !isFollowing(following, trader)) continue;
      const name = nicknameOf(following, trader) ?? shortAddress(trader);
      const d = describeFollowedTrade(e, name, look);
      if (!d) continue;
      notify(d.tone, d.title, d.body, { tag: `follow-${e.id}`, ttlMs: 12_000, action: { label: "View trader", route: "trader", params: { address: trader } } });
    }
    // Bounded memory on a long-lived tab.
    if (seen.current.size > 2_000) seen.current = new Set([...seen.current].slice(-1_000));
  }, [enabled, feed.version, feed.events, feed.status.headBlock, cfg.collateralSymbol]);

  return null;
}
