"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { Tip } from "@/components/tip";
import { Sparkline } from "@/components/ui/sparkline";
import { useDayStatsMany, type DayView } from "@/hooks/use-day-stats";
import { useLocalStore } from "@/hooks/use-local-store";
import { useChainNow, useMarketData, type MarketPrice } from "@/hooks/use-market-data";
import { useVenueStats } from "@/hooks/use-venue-stats";
import { recentBig } from "@/lib/aggregate";
import { USDC_DECIMALS, fmtCompact, fmtDuration, fmtNum, fmtPercent, fmtUsdc } from "@/lib/format";
import { INSTRUMENT_KINDS, groupInstruments, isExpired, isSettled, kindInfo, marketSlug, type Instrument, type InstrumentKindKey } from "@/lib/instruments";
import { ratio } from "@/lib/math";
import { hrefFor, stickyQuery } from "@/lib/nav";
import { toggleWatch, watchlist } from "@/lib/social";
import { createLocalStore } from "@/lib/storage";

type SortKey = "default" | "change" | "volume" | "oi" | "funding" | "leverage" | "name";
type Filter = "all" | "favourites" | InstrumentKindKey;
type ViewState = { sort: SortKey; desc: boolean; filter: Filter };

const SORTS: { key: SortKey; label: string }[] = [
  { key: "default", label: "Market type" },
  { key: "change", label: "24h change" },
  { key: "volume", label: "24h volume" },
  { key: "oi", label: "Open interest" },
  { key: "funding", label: "Funding" },
  { key: "leverage", label: "Max leverage" },
  { key: "name", label: "Name" },
];

const viewStore = createLocalStore<ViewState>("dp:markets-view:v1", { sort: "default", desc: true, filter: "all" }, (raw) => {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<ViewState>;
  const sort = SORTS.some((s) => s.key === r.sort) ? (r.sort as SortKey) : "default";
  const filter = r.filter === "all" || r.filter === "favourites" || INSTRUMENT_KINDS.some((k) => k.key === r.filter) ? (r.filter as Filter) : "all";
  return { sort, desc: r.desc !== false, filter };
});

/** Funding per hour as a fraction of position size; positive means longs pay. */
const fundingPerHour = (i: Instrument) => (Number(i.fundingRate) * 3600) / 1e18;


function Status({ instrument, price, chainNow }: { instrument: Instrument; price: MarketPrice | undefined; chainNow: number }) {
  if (isSettled(instrument)) return <span className="tag" data-tone="muted">Settled</span>;
  if (isExpired(instrument, chainNow)) return <span className="tag" data-tone="warn">Expired</span>;
  if (!instrument.enabled) return <span className="tag" data-tone="warn">Closed</span>;
  if (instrument.expiry !== 0) return <span className="tag" data-tone="accent">{fmtDuration(instrument.expiry - chainNow)}</span>;
  if (price?.status === "awaiting") return <span className="tag" data-tone="warn">Awaiting price</span>;
  return null;
}

function Star({ instrument, starred, testPrefix = "star" }: { instrument: Instrument; starred: boolean; testPrefix?: string }) {
  return (
    <button
      type="button"
      className={`relative z-[1] -m-1.5 p-1.5 text-base leading-none ${starred ? "text-warn" : "text-faint hover:text-muted"}`}
      aria-label={starred ? `Remove ${instrument.symbol} from favourites` : `Add ${instrument.symbol} to favourites`}
      aria-pressed={starred}
      onClick={(event) => {
        event.stopPropagation();
        toggleWatch(instrument.symbol);
      }}
      data-testid={`${testPrefix}-${instrument.symbol}`}
    >
      {starred ? "★" : "☆"}
    </button>
  );
}

function Change({ value }: { value: number | null }) {
  if (value === null) return <span className="text-faint">—</span>;
  return <span className={value > 0 ? "text-long" : value < 0 ? "text-short" : "text-muted"}>{fmtPercent(value, 2, true)}</span>;
}

function Funding({ instrument, compact = false }: { instrument: Instrument; compact?: boolean }) {
  const perHour = fundingPerHour(instrument);
  // Colour only what the four decimals can show: a rate that rounds to 0.0000% reads as balanced.
  const shown = Math.abs(perHour * 100) >= 0.00005 ? perHour : 0;
  const tone = shown > 0 ? "text-short" : shown < 0 ? "text-long" : "text-muted";
  if (instrument.expiry !== 0 && isSettled(instrument)) return <span className="text-faint">—</span>;
  return (
    <span className="whitespace-nowrap">
      <span className={tone}>{fmtPercent(perHour, 4, true)}</span>
      {compact ? null : <span className="block text-2xs text-faint">{fmtPercent(perHour * 24 * 365, 1, true)} a year</span>}
    </span>
  );
}

function Sentiment({ instrument, width = "w-20", suffix = "" }: { instrument: Instrument; width?: string; suffix?: string }) {
  const total = instrument.longOi + instrument.shortOi;
  const share = total > 0n ? ratio(instrument.longOi, total) : null;
  return (
    <span className="flex items-center justify-end gap-1.5" role="img" aria-label={share === null ? "No open interest" : `${fmtPercent(share, 0)} long, ${fmtPercent(1 - share, 0)} short`}>
      <span className={`flex h-1 ${width} overflow-hidden rounded-full bg-line`}>
        {share !== null ? (
          <>
            <span className="h-full bg-long" style={{ width: `${share * 100}%` }} />
            <span className="h-full bg-short" style={{ width: `${(1 - share) * 100}%` }} />
          </>
        ) : null}
      </span>
      <span className="num min-w-9 whitespace-nowrap text-right text-2xs text-faint" title={share === null ? undefined : "Share of open interest that is long"}>
        {share === null ? "—" : `${fmtPercent(share, 0)}${suffix}`}
      </span>
    </span>
  );
}

function SortHeader({ k, label, view, setView, className = "", tip }: { k: SortKey; label: string; view: ViewState; setView: (v: ViewState) => void; className?: string; tip?: React.ReactNode }) {
  const active = view.sort === k;
  return (
    <th className={className} aria-sort={active ? (view.desc ? "descending" : "ascending") : undefined}>
      <span className="inline-flex items-center gap-1">
        <button
          type="button"
          className={`inline-flex items-center gap-1 hover:text-text ${active ? "text-text" : ""}`}
          onClick={() => setView({ ...view, sort: k, desc: active ? !view.desc : k !== "name" })}
        >
          {label}
          <span aria-hidden="true" className={active ? "text-accent" : "text-transparent"}>
            {active && !view.desc ? "▴" : "▾"}
          </span>
        </button>
        {tip ? <Tip label={`About ${label.toLowerCase()}`}>{tip}</Tip> : null}
      </span>
    </th>
  );
}

export function MarketsScreen() {
  const { instruments, prices, params, loading, error } = useMarketData();
  const chainNow = useChainNow(1_000);
  const [favourites] = useLocalStore(watchlist);
  const [view, setView] = useLocalStore(viewStore);
  const [query, setQuery] = useState("");
  const q = useDeferredValue(query.trim().toLowerCase());
  const searchParams = useSearchParams();
  const hrefOf = (i: Instrument) => hrefFor("trade", stickyQuery(new URLSearchParams(searchParams.toString()), { market: marketSlug(i) }));

  const ordered = useMemo(() => groupInstruments(instruments).flatMap((g) => g.items), [instruments]);
  const day = useDayStatsMany(ordered, (id) => prices.get(id)?.display ?? null);
  const kinds = useMemo(() => INSTRUMENT_KINDS.filter((k) => instruments.some((i) => i.kind === k.key)).sort((a, b) => a.order - b.order), [instruments]);
  // Notional opened and closed in the last 24 hours, by market: the indexer's hourly buckets continued with live events.
  const stats = useVenueStats();
  const volumeHour = Math.floor(chainNow / 3_600);
  const volume = useMemo(() => {
    const out = new Map<string, bigint>();
    if (!stats.state) return out;
    for (const [id, m] of Object.entries(stats.state.markets)) out.set(id, recentBig(m.hours, "v", volumeHour * 3_600 + 3_599));
    return out;
  }, [stats.state, volumeHour]);
  const volumeKnown = stats.state !== null;
  const venueVolume = [...volume.values()].reduce((a, b) => a + b, 0n);

  const rows = useMemo(() => {
    let list = ordered;
    if (view.filter === "favourites") list = list.filter((i) => favourites.includes(i.symbol));
    else if (view.filter !== "all") list = list.filter((i) => i.kind === view.filter);
    if (q) list = list.filter((i) => `${i.symbol} ${i.name} ${i.base} ${i.quote} ${kindInfo(i.kind).label}`.toLowerCase().includes(q));
    if (view.sort === "default") return view.desc ? list : [...list].reverse();
    const value = (i: Instrument): number | string | null => {
      switch (view.sort) {
        case "change":
          return day.get(i.id)?.change ?? null;
        case "volume":
          return volumeKnown ? Number(volume.get(i.id) ?? 0n) : null;
        case "oi":
          return Number(i.longOi + i.shortOi);
        case "funding":
          return fundingPerHour(i);
        case "leverage":
          return i.maxLeverage;
        case "name":
          return i.symbol;
        default:
          return null;
      }
    };
    return [...list].sort((a, b) => {
      const va = value(a);
      const vb = value(b);
      if (va === null && vb === null) return 0;
      if (va === null) return 1; // unknowns last, whichever direction
      if (vb === null) return -1;
      const cmp = typeof va === "string" ? va.localeCompare(vb as string) : va - (vb as number);
      return view.desc ? -cmp : cmp;
    });
  }, [ordered, view, favourites, q, day, volume, volumeKnown]);

  const totalOi = params?.totalOpenInterest ?? 0n;
  const longOi = instruments.reduce((s, i) => s + i.longOi, 0n);
  const longShare = totalOi > 0n ? ratio(longOi, totalOi) : null;
  const cap = params ? (params.vaultNav * params.maxOiToNavBps) / 10_000n : null;
  const capUsed = cap && cap > 0n ? ratio(totalOi, cap) : null;

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-end justify-between gap-3 px-1 pt-2">
        <div>
          <h1 className="wide text-xl font-semibold leading-tight sm:text-2xl">Markets</h1>
          <p className="mt-1 text-[0.8125rem] text-muted">
            {instruments.length > 0 ? `${instruments.length} markets. Prices from the tape; trades fill at the on-chain oracle price.` : loading ? "Loading markets…" : error ? "Markets unavailable: the RPC did not answer. Retrying." : "No markets listed."}
          </p>
        </div>
      </div>

      <section className="panel" aria-label="Venue totals">
        <dl className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 lg:divide-x lg:divide-line">
          <div className="px-3 py-3">
            <dt className="text-xs text-muted">Open interest</dt>
            <dd className="num mt-0.5 text-xl font-semibold leading-tight">
              {params ? fmtCompact(totalOi, USDC_DECIMALS) : "—"}
              <span className="ml-1 text-xs font-normal text-muted">USDC</span>
            </dd>
          </div>
          <div className="px-3 py-3">
            <dt className="flex items-center gap-1 text-xs text-muted">
              Volume, 24h
              <Tip label="About volume">Notional opened, added, closed and liquidated in the last 24 hours, from the venue&apos;s events.</Tip>
            </dt>
            <dd className="num mt-0.5 text-xl font-semibold leading-tight" data-testid="venue-volume">
              {volumeKnown ? fmtCompact(venueVolume, USDC_DECIMALS) : stats.loading ? <span className="skeleton w-16" /> : "—"}
              <span className="ml-1 text-xs font-normal text-muted">USDC</span>
            </dd>
          </div>
          <div className="px-3 py-3">
            <dt className="text-xs text-muted">Long / short</dt>
            <dd className="num mt-0.5 text-xl font-semibold leading-tight">
              {longShare === null ? (
                "—"
              ) : (
                <>
                  <span className="text-long">{fmtPercent(longShare, 0)}</span>
                  <span className="text-faint"> / </span>
                  <span className="text-short">{fmtPercent(1 - longShare, 0)}</span>
                </>
              )}
            </dd>
          </div>
          <div className="px-3 py-3">
            <dt className="flex items-center gap-1 text-xs text-muted">
              Open-interest cap used
              <Tip label="About the open-interest cap">
                All markets together can hold open interest up to {params ? `${Number(params.maxOiToNavBps) / 10_000}x` : "a multiple of"} the vault&apos;s value
                {cap !== null ? ` (${fmtUsdc(cap, 0)} USDC now)` : ""}. Opens that would pass it are refused, so a full cap means no new positions until some close or the vault grows.
              </Tip>
            </dt>
            <dd className={`num mt-0.5 text-xl font-semibold leading-tight ${capUsed !== null && capUsed > 0.9 ? "text-warn" : ""}`}>{capUsed === null ? "—" : fmtPercent(capUsed, 1)}</dd>
          </div>
          <div className="px-3 py-3">
            <dt className="text-xs text-muted">Vault value</dt>
            <dd className="num mt-0.5 text-xl font-semibold leading-tight">
              {params ? fmtCompact(params.vaultNav, USDC_DECIMALS) : "—"}
              <span className="ml-1 text-xs font-normal text-muted">USDC</span>
            </dd>
          </div>
        </dl>
      </section>

      <div className="flex flex-wrap items-center gap-2 px-1">
        <div className="field h-9 w-full sm:w-64">
          <label className="sr-only" htmlFor="markets-search">
            Search markets
          </label>
          <input id="markets-search" type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search: BTC, gold, future…" autoComplete="off" data-testid="markets-search" />
        </div>
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-1.5" role="group" aria-label="Filter markets">
          <button type="button" className="chip" aria-pressed={view.filter === "all"} onClick={() => setView({ ...view, filter: "all" })}>
            All
          </button>
          <button type="button" className="chip" aria-pressed={view.filter === "favourites"} onClick={() => setView({ ...view, filter: "favourites" })} data-testid="filter-favourites">
            ★ Favourites <span className="num ml-1 text-faint">{favourites.filter((s) => instruments.some((i) => i.symbol === s)).length}</span>
          </button>
          {kinds.map((k) => (
            <button key={k.key} type="button" className="chip" aria-pressed={view.filter === k.key} onClick={() => setView({ ...view, filter: k.key })}>
              {k.label}
            </button>
          ))}
        </div>
        <label className="flex items-center gap-1.5 text-xs text-muted">
          Sort
          <select
            className="unit-select h-8"
            value={view.sort}
            onChange={(event) => {
              const sort = event.target.value as SortKey;
              setView({ ...view, sort, desc: sort !== "name" });
            }}
            data-testid="markets-sort"
          >
            {SORTS.map((s) => (
              <option key={s.key} value={s.key}>
                {s.label}
              </option>
            ))}
          </select>
        </label>
      </div>

      {rows.length === 0 ? (
        <section className="panel px-4 py-14 text-center text-muted">
          {instruments.length === 0
            ? loading
              ? "Loading markets…"
              : "No markets listed."
            : view.filter === "favourites" && !q
              ? "No favourites yet. Tap the star next to a market to keep it here and at the top of the market picker."
              : `No market matches${q ? ` “${query.trim()}”` : " this filter"}.`}
        </section>
      ) : (
        <>
          <section className="panel hidden overflow-x-auto md:block" aria-label="Markets">
            <table className="data-table markets-table">
              <thead>
                <tr>
                  <th className="w-8">
                    <span className="sr-only">Favourite</span>
                  </th>
                  <SortHeader k="name" label="Market" view={view} setView={setView} />
                  <th className="r">Price</th>
                  <SortHeader k="change" label="24h" view={view} setView={setView} className="r" />
                  <th className="hidden lg:table-cell">
                    <span className="sr-only">24-hour chart</span>
                  </th>
                  <SortHeader k="volume" label="Volume 24h" view={view} setView={setView} className="r" />
                  <SortHeader
                    k="funding"
                    label="Funding / h"
                    view={view}
                    setView={setView}
                    className="r"
                    tip="Share of position size paid each hour at the current long/short balance. Positive: longs pay shorts. Negative: shorts pay longs. Below it, the same rate over a year if nothing changed."
                  />
                  <SortHeader k="oi" label="Open interest" view={view} setView={setView} className="r" tip="Long plus short notional in USDC, with the long share. The engine is the other side of every trade, so this is not matched by other traders." />
                  <SortHeader k="leverage" label="Max" view={view} setView={setView} className="r" />
                  <th className="r">
                    <span className="sr-only">Trade</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((i) => (
                  <TableRow key={i.id} href={hrefOf(i)} instrument={i} price={prices.get(i.id)} day={day.get(i.id)} starred={favourites.includes(i.symbol)} chainNow={chainNow} volume={volumeKnown ? (volume.get(i.id) ?? 0n) : null} />
                ))}
              </tbody>
            </table>
          </section>

          <ul className="grid grid-cols-1 gap-1.5 md:hidden" aria-label="Markets">
            {rows.map((i) => (
              <MarketCard key={i.id} href={hrefOf(i)} instrument={i} price={prices.get(i.id)} day={day.get(i.id)} starred={favourites.includes(i.symbol)} chainNow={chainNow} volume={volumeKnown ? (volume.get(i.id) ?? 0n) : null} />
            ))}
          </ul>
        </>
      )}

      <p className="px-1 text-2xs text-faint">
        24h change and charts use hourly tape candles (Kraken; crosses and inverted pairs are computed from their legs). Funding moves with the long/short balance and is
        settled continuously into each position.
      </p>
    </div>
  );
}

type RowProps = { href: string; instrument: Instrument; price: MarketPrice | undefined; day: DayView | undefined; starred: boolean; chainNow: number; volume: bigint | null };

function TableRow({ href, instrument: i, price, day, starred, chainNow, volume }: RowProps) {
  const change = day?.change ?? null;
  const total = i.longOi + i.shortOi;
  return (
    <tr
      className="cursor-pointer hover:bg-raised/40"
      onClick={(event) => {
        if ((event.target as HTMLElement).closest("a,button")) return;
        window.location.assign(href);
      }}
      data-testid={`market-row-${i.symbol}`}
    >
      <td>
        <Star instrument={i} starred={starred} />
      </td>
      <td>
        <span className="flex items-center gap-2">
          <a href={href} className="wide text-[0.8125rem] font-semibold hover:text-accent">
            {i.symbol}
          </a>
          <Status instrument={i} price={price} chainNow={chainNow} />
        </span>
        <span className="block max-w-[16rem] truncate text-xs text-faint">
          {kindInfo(i.kind).singular}: {i.name}
        </span>
      </td>
      <td className="r num">{price?.display !== null && price?.display !== undefined ? fmtNum(price.display, i.priceDecimals) : "—"}</td>
      <td className="r num">{day?.loading ? <span className="skeleton w-12" /> : <Change value={change} />}</td>
      <td className="hidden lg:table-cell">
        <Sparkline values={day?.closes ?? null} tone={change === null ? "flat" : change >= 0 ? "up" : "down"} label={change === null ? undefined : `${i.symbol} over 24 hours: ${fmtPercent(change, 2, true)}`} />
      </td>
      <td className="r num" data-cell="volume">{volume === null ? <span className="text-faint">—</span> : fmtCompact(volume, USDC_DECIMALS)}</td>
      <td className="r num">
        <Funding instrument={i} />
      </td>
      <td className="r">
        <span className="num block">{fmtCompact(total, USDC_DECIMALS)}</span>
        <Sentiment instrument={i} />
      </td>
      <td className="r num">{i.maxLeverage}x</td>
      <td className="r">
        <a href={href} className="btn btn-sm" aria-label={`Trade ${i.symbol}`}>
          Trade
        </a>
      </td>
    </tr>
  );
}

function MarketCard({ href, instrument: i, price, day, starred, chainNow, volume }: RowProps) {
  const change = day?.change ?? null;
  const total = i.longOi + i.shortOi;
  return (
    <li className="panel relative min-w-0 px-3 py-2.5" data-testid={`market-card-${i.symbol}`}>
      <div className="flex items-center gap-3">
        <Star instrument={i} starred={starred} testPrefix="card-star" />
        <div className="min-w-0 flex-1">
          <span className="flex items-center gap-2">
            {/* The link covers the card; the star stays above it. */}
            <a href={href} className="wide text-[0.9375rem] font-semibold after:absolute after:inset-0 after:content-['']">
              {i.symbol}
            </a>
            <Status instrument={i} price={price} chainNow={chainNow} />
          </span>
          <span className="block truncate text-xs text-faint">{i.name}</span>
        </div>
        <Sparkline values={day?.closes ?? null} width={64} height={26} tone={change === null ? "flat" : change >= 0 ? "up" : "down"} className="shrink-0" />
        <div className="w-[5.75rem] shrink-0 text-right">
          <span className="num block text-[0.9375rem]">{price?.display !== null && price?.display !== undefined ? fmtNum(price.display, i.priceDecimals) : "—"}</span>
          <span className="num block text-xs">{day?.loading ? <span className="skeleton w-10" /> : <Change value={change} />}</span>
        </div>
      </div>
      <dl className="mt-2 grid grid-cols-[auto_auto_minmax(0,1fr)_auto] items-end gap-x-3 text-2xs text-muted">
        <div className="min-w-0">
          <dt>Funding / h</dt>
          <dd className="num text-xs">
            <Funding instrument={i} compact />
          </dd>
        </div>
        <div className="min-w-0">
          <dt>Vol 24h</dt>
          <dd className="num text-xs text-text">{volume === null ? "—" : fmtCompact(volume, USDC_DECIMALS)}</dd>
        </div>
        <div className="min-w-0">
          <dt>Open interest</dt>
          <dd className="num flex min-w-0 items-center gap-1.5 text-xs text-text">
            {fmtCompact(total, USDC_DECIMALS)}
            <Sentiment instrument={i} width="w-10" suffix=" long" />
          </dd>
        </div>
        <div className="text-right">
          <dt>Max</dt>
          <dd className="num text-xs text-text">{i.maxLeverage}x</dd>
        </div>
      </dl>
    </li>
  );
}
