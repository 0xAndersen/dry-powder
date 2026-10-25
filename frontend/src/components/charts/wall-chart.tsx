"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { CandlestickSeries, HistogramSeries, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { AppLink } from "@/components/app-link";
import { useAppConfig } from "@/components/providers";
import type { MarketPrice } from "@/hooks/use-market-data";
import { fmtNum, fmtPercent } from "@/lib/format";
import { krakenSource, marketSlug, type Instrument } from "@/lib/instruments";
import { RESOLUTIONS, fetchInstrumentCandles, resolutionInfo, type Candle, type Resolution } from "@/lib/kraken";
import { CHART_COLORS, baseChartOptions } from "./palette";

type Legend = { open: number; high: number; low: number; close: number } | null;

/**
 * One chart of the wall: candles and volume for a market at its own interval, the live tape price folded into the
 * last candle, a market and interval picker, and a link to trade it. Markets without an exchange pair are drawn from
 * the oracle prices seen while the page is open, like the trade chart.
 */
export function WallChart({
  index,
  instrument,
  instruments,
  price,
  resolution,
  chainNow,
  onMarket,
  onResolution,
}: {
  index: number;
  instrument: Instrument;
  instruments: readonly Instrument[];
  price: MarketPrice | undefined;
  resolution: Resolution;
  chainNow: number;
  onMarket: (slug: string) => void;
  onResolution: (resolution: Resolution) => void;
}) {
  const cfg = useAppConfig();
  const info = resolutionInfo(resolution);
  const dp = instrument.priceDecimals;
  const source = useMemo(() => krakenSource(instrument), [instrument.feedId, instrument.quoteFeedId, instrument.invert]); // eslint-disable-line react-hooks/exhaustive-deps
  const display = price?.display ?? null;
  const [legend, setLegend] = useState<Legend>(null);
  const [sessionCandles, setSessionCandles] = useState<Candle[]>([]);

  const history = useQuery({
    queryKey: ["candles", cfg.krakenUrl, instrument.id, resolution],
    queryFn: ({ signal }) => fetchInstrumentCandles(cfg.krakenUrl, source!, info.minutes, signal),
    enabled: source !== null,
    staleTime: 20_000,
    refetchInterval: 30_000,
    retry: 1,
  });

  useEffect(() => setSessionCandles([]), [instrument.id, resolution]);
  useEffect(() => {
    if (source !== null || display === null) return;
    const seconds = info.minutes * 60;
    const bucket = Math.floor(chainNow / seconds) * seconds;
    setSessionCandles((prev) => {
      const last = prev[prev.length - 1];
      if (last && last.time === bucket) {
        if (last.close === display) return prev;
        return [...prev.slice(0, -1), { ...last, high: Math.max(last.high, display), low: Math.min(last.low, display), close: display }];
      }
      return [...prev, { time: bucket, open: last?.close ?? display, high: display, low: display, close: display, volume: 0 }].slice(-1_000);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display, source, info.minutes, Math.floor(chainNow)]);
  const candles = source !== null ? history.data : sessionCandles;

  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const lastRef = useRef<Candle | null>(null);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, baseChartOptions());
    chart.applyOptions({ rightPriceScale: { scaleMargins: { top: 0.08, bottom: 0.2 } }, timeScale: { rightOffset: 6 } });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: CHART_COLORS.long,
      downColor: CHART_COLORS.short,
      borderUpColor: CHART_COLORS.long,
      borderDownColor: CHART_COLORS.short,
      wickUpColor: CHART_COLORS.long,
      wickDownColor: CHART_COLORS.short,
      priceLineColor: CHART_COLORS.text,
    });
    const volume = chart.addSeries(HistogramSeries, { priceScaleId: "volume", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });
    chart.subscribeCrosshairMove((param) => {
      const bar = param.seriesData.get(series) as { open: number; high: number; low: number; close: number } | undefined;
      setLegend(bar && param.time !== undefined ? { open: bar.open, high: bar.high, low: bar.low, close: bar.close } : null);
    });
    chartRef.current = chart;
    candleRef.current = series;
    volumeRef.current = volume;
    return () => {
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      lastRef.current = null;
    };
  }, []);

  useEffect(() => {
    candleRef.current?.applyOptions({ priceFormat: { type: "price", precision: dp, minMove: 1 / 10 ** dp } });
  }, [dp]);
  useEffect(() => {
    chartRef.current?.applyOptions({ timeScale: { timeVisible: resolution !== "1440" } });
  }, [resolution]);

  const dataKey = `${instrument.id}:${resolution}`;
  const shownKeyRef = useRef("");
  useEffect(() => {
    const series = candleRef.current;
    const volume = volumeRef.current;
    if (!series || !volume) return;
    if (!candles || candles.length === 0) {
      series.setData([]);
      volume.setData([]);
      lastRef.current = null;
      return;
    }
    series.setData(candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
    volume.setData(candles.map((c) => ({ time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? CHART_COLORS.volUp : CHART_COLORS.volDown })));
    lastRef.current = candles[candles.length - 1] ?? null;
    if (shownKeyRef.current !== dataKey) {
      shownKeyRef.current = dataKey;
      chartRef.current?.timeScale().scrollToRealTime();
    }
  }, [candles, dataKey]);

  // The live tape price folds into the last candle, or starts the next one when its interval has passed.
  useEffect(() => {
    const series = candleRef.current;
    const last = lastRef.current;
    if (!series || !last || display === null || source === null) return;
    const seconds = info.minutes * 60;
    const bucket = Math.floor(chainNow / seconds) * seconds;
    if (bucket < last.time || Math.abs(display / last.close - 1) > 0.2) return;
    const next: Candle =
      bucket === last.time
        ? { ...last, high: Math.max(last.high, display), low: Math.min(last.low, display), close: display }
        : { time: bucket, open: last.close, high: Math.max(last.close, display), low: Math.min(last.close, display), close: display, volume: 0 };
    series.update({ time: next.time as UTCTimestamp, open: next.open, high: next.high, low: next.low, close: next.close });
    lastRef.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display, candles, info.minutes, source]);

  const first = candles?.[0];
  const change = first && display !== null && first.open > 0 ? display / first.open - 1 : null;
  const slug = marketSlug(instrument);

  return (
    <section className="panel flex h-full min-h-0 min-w-0 flex-col" aria-label={`${instrument.symbol} chart`} data-testid={`wall-cell-${index}`} data-market={instrument.symbol} data-resolution={resolution}>
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-line px-2 py-1.5">
        <label className="sr-only" htmlFor={`wall-market-${index}`}>
          Market of chart {index + 1}
        </label>
        <select id={`wall-market-${index}`} className="unit-select h-7 max-w-[9.5rem] font-semibold" value={slug} onChange={(event) => onMarket(event.target.value)} data-testid="wall-market">
          {instruments.map((i) => (
            <option key={i.id} value={marketSlug(i)}>
              {i.symbol}
            </option>
          ))}
        </select>
        <span className="num text-[0.8125rem]">{display !== null ? fmtNum(display, dp) : "—"}</span>
        {change !== null ? (
          <span className={`num text-2xs ${change > 0 ? "text-long" : change < 0 ? "text-short" : "text-muted"}`} title="Change over the candles shown">
            {fmtPercent(change, 2, true)}
          </span>
        ) : null}
        <div className="ml-auto flex items-center gap-1">
          <div className="flex gap-0.5" role="group" aria-label={`Interval of chart ${index + 1}`}>
            {RESOLUTIONS.map((r) => (
              <button key={r.key} type="button" className="chip h-6 px-1.5 text-2xs" aria-pressed={resolution === r.key} onClick={() => onResolution(r.key)} data-testid={`wall-interval-${r.key}`}>
                {r.label}
              </button>
            ))}
          </div>
          <AppLink route="trade" params={{ market: slug }} className="btn btn-sm h-6 px-2 text-2xs" data-testid="wall-trade" aria-label={`Trade ${instrument.symbol}`}>
            Trade
          </AppLink>
        </div>
      </div>
      <div className="relative min-h-0 flex-1">
        <div ref={containerRef} className="absolute inset-0" />
        {legend ? (
          <p className="num pointer-events-none absolute left-2 top-1.5 z-[1] text-2xs text-muted">
            O {fmtNum(legend.open, dp)} H {fmtNum(legend.high, dp)} L {fmtNum(legend.low, dp)} C {fmtNum(legend.close, dp)}
          </p>
        ) : null}
        {source !== null && history.isError && !candles?.length ? (
          <p className="absolute inset-0 grid place-items-center text-xs text-faint">Candles unavailable right now. Retrying.</p>
        ) : null}
      </div>
    </section>
  );
}
