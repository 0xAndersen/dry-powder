"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { HistogramSeries, LineSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { CHART_COLORS, baseChartOptions } from "@/components/charts/palette";
import { Tip } from "@/components/tip";
import { useChainNow, useMarketData } from "@/hooks/use-market-data";
import { fmtAge, fmtNum } from "@/lib/format";
import type { HistoryPoint } from "@/lib/stats-file";
import { useLiveMarketSamples, useMarketHistory } from "./use-market-history";

const RANGES = [
  { key: "24h", label: "24h", seconds: 86_400 },
  { key: "7d", label: "7d", seconds: 7 * 86_400 },
  { key: "30d", label: "30d", seconds: 30 * 86_400 },
] as const;
type RangeKey = (typeof RANGES)[number]["key"];

/** "12.3k", "1.20M": open interest in whole USDC. */
function compact(value: number): string {
  const abs = Math.abs(value);
  if (abs >= 1e9) return `${(value / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(value / 1e6).toFixed(2)}M`;
  if (abs >= 1e4) return `${(value / 1e3).toFixed(1)}k`;
  return fmtNum(value, 0);
}

/** Annualised funding in % from bp, signed. */
const apr = (bps: number) => bps / 100;
const fmtApr = (pct: number) => `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${Math.abs(pct).toFixed(Math.abs(pct) >= 100 ? 0 : 2)}%`;

type Legend = { time: number; funding: number; long: number; short: number } | null;

/**
 * Funding and open interest over time for one market: annualised funding as bars (above zero: longs pay shorts) and
 * long against short open interest, 24 hours at 5-minute steps or 7 and 30 days by the hour. Built from the indexer's
 * stats.json history and continued with what this page reads live; without an indexer it shows live samples only.
 */
export function FundingOiPanel({ marketId, className = "", height = 240 }: { marketId: string; className?: string; height?: number }) {
  useLiveMarketSamples();
  const { byId } = useMarketData();
  const instrument = byId.get(marketId.toLowerCase());
  const history = useMarketHistory(marketId);
  const chainNow = useChainNow(10_000);
  const [range, setRange] = useState<RangeKey>("24h");
  const [legend, setLegend] = useState<Legend>(null);

  const points: HistoryPoint[] = useMemo(() => {
    const seconds = RANGES.find((r) => r.key === range)!.seconds;
    const from = chainNow - seconds;
    const list = range === "24h" ? history.fine : history.hourly;
    return list.filter((p) => p.time >= from);
  }, [history, range, chainNow]);
  const last = points[points.length - 1] ?? null;

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const fundingRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const longRef = useRef<ISeriesApi<"Line"> | null>(null);
  const shortRef = useRef<ISeriesApi<"Line"> | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, baseChartOptions());
    chart.applyOptions({ rightPriceScale: { scaleMargins: { top: 0.12, bottom: 0.08 } } });
    const funding = chart.addSeries(
      HistogramSeries,
      { priceLineVisible: false, lastValueVisible: true, priceFormat: { type: "custom", minMove: 0.01, formatter: (v: number) => fmtApr(v) } },
      0,
    );
    const long = chart.addSeries(LineSeries, { color: CHART_COLORS.long, lineWidth: 2, priceLineVisible: false, title: "Long", priceFormat: { type: "custom", minMove: 1, formatter: compact } }, 1);
    const short = chart.addSeries(LineSeries, { color: CHART_COLORS.short, lineWidth: 2, priceLineVisible: false, title: "Short", priceFormat: { type: "custom", minMove: 1, formatter: compact } }, 1);
    chart.panes()[0]?.setHeight(Math.round(height * 0.42));
    chart.subscribeCrosshairMove((param) => {
      if (param.time === undefined) {
        setLegend(null);
        return;
      }
      const f = param.seriesData.get(funding) as { value?: number } | undefined;
      const l = param.seriesData.get(long) as { value?: number } | undefined;
      const s = param.seriesData.get(short) as { value?: number } | undefined;
      setLegend({ time: Number(param.time), funding: f?.value ?? 0, long: l?.value ?? 0, short: s?.value ?? 0 });
    });
    chartRef.current = chart;
    fundingRef.current = funding;
    longRef.current = long;
    shortRef.current = short;
    return () => {
      chart.remove();
      chartRef.current = null;
    };
  }, [height]);

  useEffect(() => {
    const funding = fundingRef.current;
    const long = longRef.current;
    const short = shortRef.current;
    if (!funding || !long || !short) return;
    const time = (p: HistoryPoint) => p.time as UTCTimestamp;
    funding.setData(points.map((p) => ({ time: time(p), value: apr(p.fundingBps), color: p.fundingBps > 0 ? CHART_COLORS.shortBar : p.fundingBps < 0 ? CHART_COLORS.longBar : CHART_COLORS.muted })));
    long.setData(points.map((p) => ({ time: time(p), value: p.longOi })));
    short.setData(points.map((p) => ({ time: time(p), value: p.shortOi })));
    // A long series fits the width; a short one (live samples just started) keeps narrow bars at the right edge.
    const scale = chartRef.current?.timeScale();
    if (!scale) return;
    if (points.length >= 40) scale.fitContent();
    else {
      scale.applyOptions({ barSpacing: 8 });
      scale.scrollToRealTime();
    }
  }, [points]);

  const shown = legend ?? (last ? { time: last.time, funding: apr(last.fundingBps), long: last.longOi, short: last.shortOi } : null);
  const total = shown ? shown.long + shown.short : 0;
  const longShare = shown && total > 0 ? shown.long / total : null;
  const symbol = instrument?.symbol ?? "this market";
  const payer = shown ? (shown.funding > 0 ? "longs pay shorts" : shown.funding < 0 ? "shorts pay longs" : "balanced") : null;

  return (
    <section className={`min-w-0 ${className}`} aria-label={`${symbol} funding and open interest history`} data-testid="funding-oi-panel">
      <div className="flex flex-wrap items-center justify-between gap-2 px-3 pt-2.5">
        <h3 className="flex items-center gap-1 text-[0.8125rem] font-semibold">
          Funding and open interest
          <Tip label="About funding and open interest history">
            Bars: funding as a yearly rate at that moment (above zero, longs pay shorts; below, shorts pay longs). It moves with the long/short balance and is settled
            continuously into every position. Lines: long and short open interest in USDC. The engine takes the other side, so the two need not match.
          </Tip>
        </h3>
        <div className="flex gap-1" role="group" aria-label="History range">
          {RANGES.map((r) => (
            <button key={r.key} type="button" className="chip" aria-pressed={range === r.key} onClick={() => setRange(r.key)} data-testid={`history-range-${r.key}`}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      <dl className="num grid grid-cols-3 gap-x-3 px-3 pt-2 text-xs" data-testid="history-legend">
        <div className="min-w-0">
          <dt className="text-2xs text-faint">Funding a year</dt>
          <dd className={shown ? (shown.funding > 0 ? "text-short" : shown.funding < 0 ? "text-long" : "text-muted") : "text-faint"} data-testid="history-funding">
            {shown ? fmtApr(shown.funding) : "—"}
            {payer ? <span className="block text-2xs text-faint">{payer}</span> : null}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-2xs text-faint">Long / short OI</dt>
          <dd className="truncate" data-testid="history-oi">
            {shown ? (
              <>
                <span className="text-long">{compact(shown.long)}</span>
                <span className="text-faint"> / </span>
                <span className="text-short">{compact(shown.short)}</span>
              </>
            ) : (
              "—"
            )}
          </dd>
        </div>
        <div className="min-w-0 text-right">
          <dt className="text-2xs text-faint">{legend ? new Date(legend.time * 1000).toISOString().slice(5, 16).replace("T", " ") + " UTC" : "Long share"}</dt>
          <dd>{longShare === null ? "—" : `${Math.round(longShare * 100)}% long`}</dd>
        </div>
      </dl>
      <div className="relative mt-1" style={{ height }}>
        <div ref={containerRef} className="absolute inset-0" />
        {points.length === 0 ? (
          <p className="absolute inset-0 grid place-items-center px-6 text-center text-xs text-faint">{history.loading ? "Loading history…" : "No samples yet for this range."}</p>
        ) : null}
      </div>
      <p className="px-3 pb-2.5 pt-1 text-2xs text-faint" data-testid="history-source">
        {history.source === "indexer"
          ? `From the venue's indexer, sampled every 5 minutes${history.sampledAt ? ` (latest ${fmtAge(Math.max(0, chainNow - history.sampledAt))} ago)` : ""}, continued live.`
          : "Live samples since this page opened, one a minute: this deployment publishes no indexer history yet."}
      </p>
    </section>
  );
}
