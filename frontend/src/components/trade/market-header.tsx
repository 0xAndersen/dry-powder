"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ArcGauge } from "@/components/arc-gauge";
import { useApp } from "@/components/providers";
import { Tip } from "@/components/tip";
import { TxStatus } from "@/components/tx-status";
import { useTradeContext } from "@/hooks/use-action-context";
import { useMarketData, type MarketPrice } from "@/hooks/use-market-data";
import { useTx } from "@/hooks/use-tx";
import { useAccountView, useWallet } from "@/hooks/use-wallet";
import { submitSettleMarket } from "@/lib/actions";
import { UserFacingError } from "@/lib/errors";
import { USDC_DECIMALS, fmtAge, fmtCompact, fmtDuration, fmtNum, fmtPercent, fmtPrice, fmtUtc } from "@/lib/format";
import { groupInstruments, isExpired, isSettled, kindInfo, krakenSource, type Instrument } from "@/lib/instruments";
import { fetchInstrumentCandles } from "@/lib/kraken";
import { ratio } from "@/lib/math";
import { useLocalStore } from "@/hooks/use-local-store";
import { toggleWatch, watchlist } from "@/lib/social";

function StatusChip({ instrument, price, chainNow }: { instrument: Instrument; price: MarketPrice; chainNow: number }) {
  if (isSettled(instrument)) return <span className="tag" data-tone="muted">Settled</span>;
  if (isExpired(instrument, chainNow)) return <span className="tag" data-tone="warn">Expired</span>;
  if (!instrument.enabled) return <span className="tag" data-tone="warn">Closed</span>;
  if (instrument.expiry !== 0) return <span className="tag" data-tone="accent">{fmtDuration(instrument.expiry - chainNow)}</span>;
  if (price.status === "awaiting") return <span className="tag" data-tone="warn">Awaiting price</span>;
  return null;
}

function MarketPicker({
  instruments,
  current,
  chainNow,
  onSelect,
  onClose,
}: {
  instruments: Instrument[];
  current: Instrument;
  chainNow: number;
  onSelect: (instrument: Instrument) => void;
  onClose: () => void;
}) {
  const { prices } = useMarketData();
  const [favourites] = useLocalStore(watchlist);
  const [query, setQuery] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return instruments;
    return instruments.filter((i) => `${i.symbol} ${i.name} ${i.base} ${i.quote} ${kindInfo(i.kind).label}`.toLowerCase().includes(q));
  }, [instruments, query]);
  const groups = useMemo(() => {
    const byKind = groupInstruments(filtered);
    const starred = filtered.filter((i) => favourites.includes(i.symbol));
    return starred.length > 0 && !query.trim() ? [{ kind: { key: "favourites", label: "Favourites" }, items: starred }, ...byKind] : byKind;
  }, [filtered, favourites, query]);

  useEffect(() => {
    inputRef.current?.focus();
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) onClose();
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [onClose]);

  return (
    <div ref={rootRef} role="dialog" aria-label="Choose a market" className="panel absolute left-0 top-full z-30 mt-1 w-[min(26rem,calc(100vw-1rem))] bg-raised shadow-[0_18px_44px_rgba(4,8,14,0.6)]">
      <form
        className="border-b border-line p-2"
        onSubmit={(event) => {
          event.preventDefault();
          const first = filtered[0];
          if (first) onSelect(first);
        }}
      >
        <label className="sr-only" htmlFor="market-search">
          Search markets
        </label>
        <div className="field h-9">
          <input id="market-search" ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search: BTC, gold, future…" autoComplete="off" />
        </div>
      </form>
      <div className="max-h-[min(28rem,60vh)] overflow-y-auto pb-1">
        {groups.length === 0 ? <p className="px-3 py-6 text-center text-muted">No market matches &ldquo;{query}&rdquo;.</p> : null}
        {groups.map((group) => (
          <section key={group.kind.key} aria-label={group.kind.label}>
            <h3 className="flex items-baseline justify-between px-3 pb-1 pt-3 text-xs">
              <span className="wide font-semibold text-accent">{group.kind.label}</span>
              <span className="text-faint">{group.items.length}</span>
            </h3>
            <ul>
              {group.items.map((i) => {
                const p = prices.get(i.id);
                const starred = favourites.includes(i.symbol);
                return (
                  <li key={i.id} className="flex items-center">
                    <button
                      type="button"
                      className={`shrink-0 pl-3 pr-1 text-base leading-none ${starred ? "text-warn" : "text-faint hover:text-muted"}`}
                      aria-label={starred ? `Remove ${i.symbol} from favourites` : `Add ${i.symbol} to favourites`}
                      aria-pressed={starred}
                      onClick={() => toggleWatch(i.symbol)}
                    >
                      {starred ? "★" : "☆"}
                    </button>
                    <button
                      type="button"
                      className="flex min-w-0 flex-1 items-center gap-3 px-2 py-2 text-left hover:bg-panel focus-visible:bg-panel"
                      aria-current={i.id === current.id ? "true" : undefined}
                      onClick={() => onSelect(i)}
                      data-testid={group.kind.key === "favourites" ? `favourite-option-${i.symbol}` : `market-option-${i.symbol}`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span className={`wide text-[0.8125rem] font-semibold ${i.id === current.id ? "text-accent" : "text-text"}`}>{i.symbol}</span>
                          {p ? <StatusChip instrument={i} price={p} chainNow={chainNow} /> : null}
                        </span>
                        <span className="block truncate text-xs text-faint">{i.name}</span>
                      </span>
                      <span className="text-right">
                        <span className="num block text-[0.8125rem]">{p?.display !== null && p?.display !== undefined ? fmtNum(p.display, i.priceDecimals) : "—"}</span>
                        <span className="num block text-xs text-faint">up to {i.maxLeverage}x</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}

function Stat({ label, children, tip }: { label: string; children: React.ReactNode; tip?: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="flex items-center gap-1 whitespace-nowrap text-2xs text-muted">
        {label}
        {tip ? <Tip label={`About ${label.toLowerCase()}`}>{tip}</Tip> : null}
      </dt>
      <dd className="num mt-px whitespace-nowrap text-[0.8125rem]">{children}</dd>
    </div>
  );
}

export function MarketHeader({
  instrument,
  instruments,
  price,
  chainNow,
  pickerOpen,
  onPickerChange,
  onSelect,
}: {
  instrument: Instrument;
  instruments: Instrument[];
  price: MarketPrice;
  chainNow: number;
  pickerOpen: boolean;
  onPickerChange: (open: boolean) => void;
  onSelect: (instrument: Instrument) => void;
}) {
  const { config: cfg } = useApp();
  const { prices } = useMarketData();
  const wallet = useWallet();
  const view = useAccountView();
  const tx = useTx({ autoDismissMs: 8000 });
  const actionContext = useTradeContext();
  const dp = instrument.priceDecimals;
  const kind = kindInfo(instrument.kind);
  const expired = isExpired(instrument, chainNow);
  const settled = isSettled(instrument);

  const source = useMemo(() => krakenSource(instrument), [instrument.feedId, instrument.quoteFeedId, instrument.invert]); // eslint-disable-line react-hooks/exhaustive-deps
  const dayRef = useQuery({
    queryKey: ["day-reference", cfg.krakenUrl, instrument.id],
    enabled: source !== null,
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    retry: 1,
    queryFn: async ({ signal }) => {
      const candles = await fetchInstrumentCandles(cfg.krakenUrl, source!, 60, signal);
      const last = candles[candles.length - 1];
      if (!last) return null;
      let reference = candles[0]!;
      for (const c of candles) {
        if (c.time <= last.time - 86_400) reference = c;
        else break;
      }
      return reference.close;
    },
  });
  const change = price.display !== null && dayRef.data ? price.display / dayRef.data - 1 : null;

  const fundingPerHour = (Number(instrument.fundingRate) * 3600) / 1e18;
  const totalOi = instrument.longOi + instrument.shortOi;
  const longShare = totalOi > 0n ? ratio(instrument.longOi, totalOi) : null;
  const age = price.publishTime !== null ? Math.max(0, chainNow - price.publishTime) : null;
  const canSettle = expired && !settled && price.exec !== null && price.exec.publishTime >= instrument.expiry;

  const settle = () => {
    void tx.run(async (api) => {
      const ctx = actionContext(api);
      if (!ctx) throw new UserFacingError("Connect your wallet first.");
      await submitSettleMarket(ctx, instrument.id, `Settle ${instrument.symbol}`);
      return `${instrument.symbol} settled. Positions can now be closed at the settlement price.`;
    });
  };

  const strip = useMemo(() => groupInstruments(instruments).flatMap((g) => g.items), [instruments]);

  return (
    <section className="panel" aria-label="Market">
      <div className="flex overflow-x-auto border-b border-line" role="tablist" aria-label="Markets">
        {strip.map((i) => {
          const p = prices.get(i.id);
          const selected = i.id === instrument.id;
          return (
            <button
              key={i.id}
              type="button"
              role="tab"
              aria-selected={selected}
              onClick={() => onSelect(i)}
              className={`flex shrink-0 flex-col items-start border-b-2 px-3 py-1.5 text-left transition-colors ${selected ? "border-accent bg-raised/60" : "border-transparent hover:bg-raised/30"}`}
            >
              <span className={`wide whitespace-nowrap text-xs font-semibold ${selected ? "text-text" : "text-muted"}`}>{i.symbol}</span>
              <span className={`num text-xs ${p?.status === "awaiting" ? "text-faint" : "text-text"}`}>
                {p?.display !== null && p?.display !== undefined ? fmtNum(p.display, i.priceDecimals) : "—"}
              </span>
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-x-6 gap-y-2.5 px-3 py-2.5">
        <div className="relative">
          <button
            type="button"
            className="group flex items-center gap-2 text-left"
            aria-haspopup="dialog"
            aria-expanded={pickerOpen}
            onClick={() => onPickerChange(!pickerOpen)}
            data-testid="market-picker"
          >
            <span>
              <span className="wide block text-lg font-bold leading-tight">{instrument.symbol}</span>
              <span className="block max-w-[15rem] truncate text-xs text-muted">
                {kind.singular}: {instrument.name}
              </span>
            </span>
            <span aria-hidden="true" className="text-muted group-hover:text-text">
              {"▾"}
            </span>
          </button>
          {pickerOpen ? (
            <MarketPicker
              instruments={instruments}
              current={instrument}
              chainNow={chainNow}
              onClose={() => onPickerChange(false)}
              onSelect={(i) => {
                onSelect(i);
                onPickerChange(false);
              }}
            />
          ) : null}
        </div>

        <div className="min-w-[9rem]">
          <p className={`num text-2xl font-semibold leading-tight ${price.status === "awaiting" ? "text-muted" : "text-text"}`} data-testid="market-price">
            {price.display !== null ? fmtNum(price.display, dp) : <span className="skeleton w-28" />}
          </p>
          <p className="num text-xs text-faint" data-testid="market-quote">
            {settled ? (
              "Settlement price: final"
            ) : price.status === "live" && price.exec ? (
              <>
                Bid {fmtPrice(price.exec.bid, dp)} / Ask {fmtPrice(price.exec.ask, dp)}
                {age !== null ? <span title="Age of the on-chain oracle price orders execute against"> · {fmtAge(age)} old</span> : null}
              </>
            ) : price.status === "awaiting" ? (
              <span className="text-warn">
                Awaiting on-chain price{age !== null ? `: last ${fmtAge(age)} ago` : ""}
              </span>
            ) : (
              "No price yet"
            )}
          </p>
        </div>

        <dl className="flex flex-wrap gap-x-6 gap-y-2">
          <Stat label="24h">{change !== null ? <span className={change >= 0 ? "text-long" : "text-short"}>{fmtPercent(change, 2, true)}</span> : "—"}</Stat>
          <Stat label="Funding / h" tip="Share of position size paid each hour at the current long/short balance. Positive: longs pay. Negative: shorts pay. The lighter side receives.">
            <span className={fundingPerHour > 0 ? "text-short" : fundingPerHour < 0 ? "text-long" : ""}>{fmtPercent(fundingPerHour, 4, true)}</span>
            <span className="ml-1 text-xs text-faint">{fundingPerHour > 0 ? "longs pay" : fundingPerHour < 0 ? "shorts pay" : "balanced"}</span>
          </Stat>
          <Stat label="Max leverage">{instrument.maxLeverage}x</Stat>
          {instrument.expiry !== 0 ? (
            <Stat
              label={settled ? "Settled at" : expired ? "Expired" : "Expires in"}
              tip={
                <>
                  A dated future stops taking new positions at expiry ({fmtUtc(instrument.expiry)}) and settles at the oracle price: the first price
                  published at or after expiry that anyone submits. Open positions are then closed at that price. Funding stops at expiry.
                </>
              }
            >
              {settled ? (
                <span className="text-accent" data-testid="settlement-price">{fmtPrice(instrument.settlementPrice, dp)}</span>
              ) : expired ? (
                <span className="text-warn">awaiting settlement</span>
              ) : (
                <span className="text-accent" data-testid="expiry-countdown">{fmtDuration(instrument.expiry - chainNow)}</span>
              )}
            </Stat>
          ) : null}
        </dl>

        <div className="flex items-center gap-3 sm:ml-auto">
          <ArcGauge
            fraction={longShare}
            leftColor="var(--color-long)"
            rightColor="var(--color-short)"
            width={76}
            stroke={6}
            label={longShare === null ? "No open interest" : `Open interest is ${fmtPercent(longShare, 0)} long and ${fmtPercent(1 - longShare, 0)} short`}
          >
            <span className="num text-2xs text-muted">{longShare === null ? "No OI" : `${fmtPercent(longShare, 0)} long`}</span>
          </ArcGauge>
          <dl className="grid gap-0.5 text-xs">
            <div className="flex items-baseline gap-2">
              <dt className="w-14 text-muted">Long OI</dt>
              <dd className="num text-long">{fmtCompact(instrument.longOi, USDC_DECIMALS)}</dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="w-14 text-muted">Short OI</dt>
              <dd className="num text-short">{fmtCompact(instrument.shortOi, USDC_DECIMALS)}</dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="w-14 text-muted">Cap / side</dt>
              <dd className="num text-faint">{fmtCompact(instrument.maxOiPerSide, USDC_DECIMALS)}</dd>
            </div>
          </dl>
        </div>
      </div>

      {instrument.expiry !== 0 ? (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-line px-3 py-2 text-[0.8125rem]" data-testid="dated-banner">
          <p className="min-w-0 flex-1 text-muted">
            {settled
              ? `Settled at ${fmtPrice(instrument.settlementPrice, dp)}. Open positions close at that price: use Settle & close on your position.`
              : expired
                ? "Expired. No new positions. It settles at the oracle price as soon as a price published after expiry is on-chain; until then open positions can still be closed at the live price."
                : `Settles at the oracle price at expiry, ${fmtUtc(instrument.expiry)}. New positions stop at expiry.`}
          </p>
          {expired && !settled ? (
            <button
              type="button"
              className="btn btn-sm btn-primary"
              disabled={!(wallet.ready || view.instant) || !canSettle || tx.busy}
              title={canSettle ? "Fixes the settlement price from the price now on-chain. Anyone may do this." : "Needs an on-chain price published after expiry. A keeper usually posts one within seconds."}
              onClick={settle}
              data-testid="settle-market"
            >
              Settle market
            </button>
          ) : null}
          {tx.state.phase !== "idle" ? <TxStatus state={tx.state} onDismiss={tx.reset} className="w-full" /> : null}
        </div>
      ) : null}
    </section>
  );
}
