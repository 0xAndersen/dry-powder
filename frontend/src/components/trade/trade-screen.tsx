"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AccountBar } from "@/components/trade/account-bar";
import { AccountTables, type TablesHandle } from "@/components/trade/account-tables";
import { MarketHeader } from "@/components/trade/market-header";
import { OrderTicket, type TicketDraft, type TicketHandle } from "@/components/trade/order-ticket";
import { PriceChart, type ChartLine, type PickTarget } from "@/components/trade/price-chart";
import { ShortcutsOverlay } from "@/components/trade/shortcuts-overlay";
import { useAccountData } from "@/hooks/use-account-data";
import { useLocalStore } from "@/hooks/use-local-store";
import { useLogFeed } from "@/hooks/use-log-feed";
import { useChainNow, useMarketData, useMarketPrice } from "@/hooks/use-market-data";
import { useAccountView } from "@/hooks/use-wallet";
import { fmtPrice, priceToNum } from "@/lib/format";
import { findBySlug, groupInstruments, marketSlug, type Instrument } from "@/lib/instruments";
import { orderTracker } from "@/lib/order-tracker";
import { valuePosition } from "@/lib/position";
import { priceAlerts, type PriceAlert } from "@/lib/storage";
import { toast } from "@/lib/toasts";

/** How far back the account history is read on load. "Load earlier" extends it. */
const HISTORY_LOOKBACK_SECONDS = 6 * 3_600;

function isTyping(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return target.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName);
}

export function TradeScreen() {
  const searchParams = useSearchParams();
  const { instruments, byId, params, loading, error, refetch } = useMarketData();
  const view = useAccountView();
  const account = useAccountData(view.address);
  const chainNow = useChainNow();
  const feed = useLogFeed({ enabled: view.address !== undefined, trader: view.address, lookbackSeconds: HISTORY_LOOKBACK_SECONDS, exactTimes: true, maxEvents: 3_000 });

  const ordered = useMemo(() => groupInstruments(instruments).flatMap((g) => g.items), [instruments]);
  const instrument: Instrument | undefined = findBySlug(instruments, searchParams.get("market")) ?? ordered[0];
  const price = useMarketPrice(instrument?.id);

  // The market lives in the URL so links are shareable; the History API keeps the switch client-side.
  const selectMarket = useCallback((next: Instrument) => {
    const query = new URLSearchParams(window.location.search);
    query.set("market", marketSlug(next));
    window.history.replaceState(null, "", `?${query.toString()}`);
  }, []);

  const ticketRef = useRef<TicketHandle>(null);
  const tablesRef = useRef<TablesHandle>(null);
  const accountRef = useRef(account.data);
  accountRef.current = account.data;
  const getAccount = useCallback(() => accountRef.current, []);

  const [pick, setPick] = useState<PickTarget | null>(null);
  const [draft, setDraft] = useState<TicketDraft>({ isLong: true, limit: null, takeProfit: null, stopLoss: null });
  const [pickerOpen, setPickerOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [indicatorsHidden, setIndicatorsHidden] = useState(false);
  const [alerts, setAlerts] = useLocalStore(priceAlerts);

  const position = useMemo(
    () => (instrument ? account.data?.positions.find((p) => p.position.priceId.toLowerCase() === instrument.id) : undefined),
    [account.data, instrument],
  );

  // ── Follow keeper orders placed here until they fill, and surface what happens to the account. ──
  const startedAt = useRef(Date.now() / 1000);
  const announced = useRef(new Set<string>());
  useEffect(() => {
    const tracked = orderTracker.get();
    const resting = tracked.filter((o) => o.status === "resting");
    const pending = tracked.filter((o) => o.status === "resting" || o.status === "gone");
    const recent = feed.events.slice(-300);
    for (const event of recent) {
      if (event.type === "orderExecuted" || event.type === "orderCancelled") {
        const tracked = pending.find((o) => o.orderId === event.orderId);
        if (!tracked) continue;
        if (event.type === "orderExecuted") {
          orderTracker.resolve(event.orderId, "filled", event.price);
          const dp = byId.get(tracked.marketId)?.priceDecimals ?? 2;
          const what = tracked.action === "close" ? `${tracked.symbol} position closed` : `${tracked.isLong ? "Long" : "Short"} ${tracked.symbol} filled`;
          toast("ok", what, `Order #${event.orderId} executed at ${fmtPrice(event.price, dp)}`);
        } else {
          orderTracker.resolve(event.orderId, "cancelled");
        }
      } else if (event.type === "liquidation" && event.time > startedAt.current - 5 && !announced.current.has(event.id)) {
        announced.current.add(event.id);
        const symbol = byId.get(event.marketId)?.symbol ?? "Position";
        toast("error", `${symbol} position liquidated`, view.watching ? "The watched account lost the position's margin." : "Losses reached 90% of margin. The margin is lost; DRY was minted as a rebate.", 15_000);
      } else if (event.type === "close" && event.orderId !== undefined && event.time > startedAt.current - 5 && !announced.current.has(event.id)) {
        // Take-profit and stop-loss fills were not placed in this session, so nothing is tracking them.
        announced.current.add(event.id);
        if (!resting.some((o) => o.orderId === event.orderId) && !orderTracker.get().some((o) => o.orderId === event.orderId)) {
          const inst = byId.get(event.marketId);
          toast(event.pnl >= 0n ? "ok" : "warn", `${inst?.symbol ?? "Position"} closed by order #${event.orderId}`, `At ${fmtPrice(event.price, inst?.priceDecimals ?? 2)}${event.pnl > 0n ? ". More powder for the next one." : ""}`);
        }
      }
    }
    // Fallback when the log reader is behind: the order has left the book. If the account already shows its
    // result (a position for an open, none for a close) it filled; otherwise say only that it is gone.
    if (account.data) {
      const open = new Set(account.data.orders.map((o) => o.id));
      const held = new Set(account.data.positions.map((p) => p.position.priceId.toLowerCase()));
      for (const t of resting) {
        if (open.has(t.orderId) || Date.now() - t.placedAt < 3_000) continue;
        const has = held.has(t.marketId.toLowerCase());
        if (t.action === "close" ? !has : has) orderTracker.resolve(t.orderId, "filled");
        else if (Date.now() - t.placedAt > 8_000) orderTracker.resolve(t.orderId, "gone");
      }
    }
  }, [feed.version, feed.events, account.data, byId, view.watching]);

  // ── Chart lines ──
  const lines = useMemo<ChartLine[]>(() => {
    if (!instrument) return [];
    const out: ChartLine[] = [];
    const orders = account.data?.orders ?? [];
    if (instrument.settlementPrice !== 0n) out.push({ key: "settle", price: priceToNum(instrument.settlementPrice), title: "Settlement", tone: "settle" });
    if (position) {
      const pos = position.position;
      const value = valuePosition(position, null, params?.maxProfitMultiple ?? 10n);
      out.push({ key: "entry", price: priceToNum(pos.entryPrice), title: `${pos.isLong ? "Long" : "Short"} entry`, tone: "entry" });
      if (value.liquidationPrice !== null) out.push({ key: "liq", price: priceToNum(value.liquidationPrice), title: "Liquidation", tone: "liq" });
      for (const row of orders) {
        if (row.id === pos.tpOrderId && row.id !== 0n) out.push({ key: "tp", price: priceToNum(row.order.triggerPrice), title: "Take-profit", tone: "tp" });
        if (row.id === pos.slOrderId && row.id !== 0n) out.push({ key: "sl", price: priceToNum(row.order.triggerPrice), title: "Stop-loss", tone: "sl" });
      }
    }
    for (const row of orders) {
      if (row.order.orderType !== 0 || row.order.priceId.toLowerCase() !== instrument.id) continue;
      out.push({ key: `order-${row.id}`, price: priceToNum(row.order.triggerPrice), title: `Limit ${row.order.isLong ? "long" : "short"} #${row.id}`, tone: "order" });
    }
    if (draft.limit !== null) out.push({ key: "draft-limit", price: draft.limit, title: `Draft limit ${draft.isLong ? "long" : "short"}`, tone: "draft" });
    if (!position) {
      if (draft.takeProfit !== null) out.push({ key: "draft-tp", price: draft.takeProfit, title: "Draft take-profit", tone: "draft" });
      if (draft.stopLoss !== null) out.push({ key: "draft-sl", price: draft.stopLoss, title: "Draft stop-loss", tone: "draft" });
    }
    for (const alert of alerts) {
      if (alert.marketId === instrument.id && alert.firedAt === null) out.push({ key: `alert-${alert.id}`, price: alert.price, title: "Alert", tone: "alert" });
    }
    return out;
  }, [instrument, account.data, position, draft, alerts, params?.maxProfitMultiple]);

  const onPick = useCallback(
    (target: PickTarget, value: number) => {
      setPick(null);
      if (!instrument) return;
      if (target === "alert") {
        const current = price.display;
        const alert: PriceAlert = {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          marketId: instrument.id,
          symbol: instrument.symbol,
          price: Number(value.toFixed(instrument.priceDecimals)),
          direction: current !== null && value < current ? "below" : "above",
          createdAt: Date.now(),
          firedAt: null,
        };
        setAlerts((prev) => [...prev, alert].slice(-50));
        toast("info", `Alert set on ${instrument.symbol}`, `${alert.direction === "above" ? "At or above" : "At or below"} ${alert.price.toFixed(instrument.priceDecimals)}`, 4_000);
        return;
      }
      if (target !== "limit" && position && view.canTrade) tablesRef.current?.editTrigger(instrument.id, target, value);
      else ticketRef.current?.setPrice(target, value);
    },
    [instrument, position, view.canTrade, price.display, setAlerts],
  );

  // ── Keyboard shortcuts ──
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target)) return;
      if (document.querySelector('[aria-modal="true"]')) return;
      const key = event.key;
      const cycle = (step: number) => {
        if (!instrument || ordered.length === 0) return;
        const index = ordered.findIndex((i) => i.id === instrument.id);
        const next = ordered[(index + step + ordered.length) % ordered.length];
        if (next) selectMarket(next);
      };
      let handled = true;
      if (key === "b" || key === "B") ticketRef.current?.setSide(true);
      else if (key === "s" || key === "S") ticketRef.current?.setSide(false);
      else if (key === "m" || key === "M") ticketRef.current?.setKind("market");
      else if (key === "l" || key === "L") ticketRef.current?.setKind("limit");
      else if (key === "q" || key === "Q") ticketRef.current?.focusSize();
      else if (key === "Enter" && !(event.target instanceof HTMLButtonElement) && !(event.target instanceof HTMLAnchorElement)) ticketRef.current?.submit();
      else if (key === "x" || key === "X") ticketRef.current?.close();
      else if (key === "[") cycle(-1);
      else if (key === "]") cycle(1);
      else if (key === "/") setPickerOpen(true);
      else if (key === "i" || key === "I") setIndicatorsHidden((v) => !v);
      else if (key === "t" || key === "T") setPick((p) => (p === "limit" ? null : "limit"));
      else if (key === "?") setShortcutsOpen(true);
      else handled = false;
      if (handled) event.preventDefault();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [instrument, ordered, selectMarket]);

  if (!instrument) {
    return (
      <div className="flex flex-col gap-2">
        <h1 className="sr-only">Trade</h1>
        {error ? (
          <div className="notice flex flex-wrap items-center gap-3" data-tone="error" role="alert">
            <span className="flex-1">The trading engine could not be read. The RPC may be down, or the configured contract addresses may not match this network.</span>
            <button type="button" className="btn btn-sm" onClick={refetch}>
              Retry
            </button>
          </div>
        ) : loading ? (
          <div className="panel flex h-64 items-center justify-center gap-2 text-muted" role="status">
            <span className="spinner" aria-hidden="true" /> Loading markets from the chain
          </div>
        ) : (
          <div className="panel px-4 py-16 text-center text-muted">No markets are listed on this deployment yet.</div>
        )}
      </div>
    );
  }

  const pickTargets: PickTarget[] = view.watching ? ["alert"] : ["limit", "tp", "sl", "alert"];

  return (
    <div className="flex flex-col gap-2">
      <h1 className="sr-only">Trade {instrument.symbol}</h1>
      {error ? (
        <div className="notice flex flex-wrap items-center gap-3" data-tone="error" role="alert">
          <span className="flex-1">The chain is not answering. Figures may be out of date until the RPC recovers.</span>
          <button type="button" className="btn btn-sm" onClick={refetch}>
            Retry
          </button>
        </div>
      ) : null}
      {params?.paused ? (
        <p className="notice" data-tone="warn" role="status">
          Trading is paused: new positions and limit orders are blocked. Open positions can still be closed.
        </p>
      ) : null}

      <AccountBar view={view} account={account.data} loading={account.isLoading} />

      <div className="trade-grid">
        <div className="[grid-area:market] min-w-0">
          <MarketHeader instrument={instrument} instruments={instruments} price={price} chainNow={chainNow} pickerOpen={pickerOpen} onPickerChange={setPickerOpen} onSelect={selectMarket} />
        </div>
        <div className="[grid-area:chart] min-w-0">
          <PriceChart
            instrument={instrument}
            price={price}
            lines={lines}
            pickTargets={pickTargets}
            pick={pick}
            onPickChange={setPick}
            onPick={onPick}
            indicatorsHidden={indicatorsHidden}
            chainNow={chainNow}
          />
        </div>
        <div className="[grid-area:ticket] min-w-0">
          <div className="lg:sticky lg:top-[3.5rem] lg:max-h-[calc(100dvh-4rem)] lg:overflow-y-auto">
            <OrderTicket
              key={instrument.id}
              ref={ticketRef}
              instrument={instrument}
              price={price}
              account={view.watching ? undefined : account.data}
              getAccount={getAccount}
              view={view}
              position={position}
              chainNow={chainNow}
              onDraftChange={setDraft}
              onPickRequest={setPick}
              onShowShortcuts={() => setShortcutsOpen(true)}
            />
          </div>
        </div>
        <div className="[grid-area:tables] min-w-0">
          <AccountTables
            ref={tablesRef}
            view={view}
            account={account.data}
            loading={account.isLoading}
            error={account.isError}
            feed={feed}
            instrument={instrument}
            price={price}
            chainNow={chainNow}
            onSelectMarket={selectMarket}
            onPickAlert={() => setPick("alert")}
          />
        </div>
      </div>

      {shortcutsOpen ? <ShortcutsOverlay onClose={() => setShortcutsOpen(false)} /> : null}
    </div>
  );
}
