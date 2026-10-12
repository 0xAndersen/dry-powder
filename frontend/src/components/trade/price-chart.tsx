"use client";

import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type CandlestickData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { usePrice } from "@/hooks/use-prices";
import { RESOLUTIONS, fetchCandles, resolutionInfo, type Candle, type Resolution } from "@/lib/benchmarks";
import type { MarketInfo } from "@/lib/markets";

export type ChartLine = { key: string; price: number; title: string; tone: "entry" | "liq" | "tp" | "sl" };

const COLORS = {
  text: "#97a3b7",
  grid: "#1e2a3c",
  border: "#293548",
  long: "#4cc9a0",
  short: "#f06f7f",
  brass: "#e3b45c",
  entry: "#e6eaf2",
} as const;

const LINE_COLOR: Record<ChartLine["tone"], string> = {
  entry: COLORS.entry,
  liq: COLORS.brass,
  tp: COLORS.long,
  sl: COLORS.short,
};

function toBar(c: Candle): CandlestickData<UTCTimestamp> {
  return { time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close };
}

export function PriceChart({ market, lines, stale }: { market: MarketInfo; lines: ChartLine[]; stale: boolean }) {
  const [resolution, setResolution] = useState<Resolution>("15");
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const lastCandleRef = useRef<Candle | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const tick = usePrice(market.id);

  const history = useQuery({
    queryKey: ["candles", market.id, resolution],
    queryFn: ({ signal }) => fetchCandles(market, resolution, signal),
    staleTime: 60_000,
    refetchOnWindowFocus: true,
    retry: 1,
  });

  // Create the chart once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: COLORS.text,
        fontFamily: '"Archivo Variable", system-ui, sans-serif',
        fontSize: 11,
      },
      grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
      rightPriceScale: { borderColor: COLORS.border, scaleMargins: { top: 0.12, bottom: 0.12 } },
      timeScale: { borderColor: COLORS.border, timeVisible: true, secondsVisible: false, rightOffset: 6 },
      crosshair: { mode: CrosshairMode.Normal },
    });
    const series = chart.addSeries(CandlestickSeries, {
      upColor: COLORS.long,
      downColor: COLORS.short,
      borderUpColor: COLORS.long,
      borderDownColor: COLORS.short,
      wickUpColor: COLORS.long,
      wickDownColor: COLORS.short,
      priceLineColor: COLORS.text,
    });
    chartRef.current = chart;
    seriesRef.current = series;
    return () => {
      priceLinesRef.current = [];
      lastCandleRef.current = null;
      seriesRef.current = null;
      chartRef.current = null;
      chart.remove();
    };
  }, []);

  // Price precision follows the market (JPY/USD needs eight decimals).
  useEffect(() => {
    seriesRef.current?.applyOptions({
      priceFormat: { type: "price", precision: market.priceDecimals, minMove: 1 / 10 ** market.priceDecimals },
    });
  }, [market.priceDecimals]);

  useEffect(() => {
    chartRef.current?.applyOptions({ timeScale: { timeVisible: resolution !== "D" } });
  }, [resolution]);

  // Load history whenever the market or resolution changes.
  const candles = history.data;
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    if (!candles) {
      series.setData([]);
      lastCandleRef.current = null;
      return;
    }
    series.setData(candles.map(toBar));
    lastCandleRef.current = candles[candles.length - 1] ?? null;
    chartRef.current?.timeScale().scrollToRealTime();
  }, [candles]);

  // Fold live prices into the last candle, or start a new one when its interval has passed.
  const livePrice = tick?.midNum;
  const liveTime = tick?.publishTime;
  useEffect(() => {
    const series = seriesRef.current;
    const last = lastCandleRef.current;
    if (!series || !last || livePrice === undefined || liveTime === undefined || !candles) return;
    const seconds = resolutionInfo(resolution).seconds;
    const bucket = Math.floor(liveTime / seconds) * seconds;
    if (bucket < last.time) return;
    const next: Candle =
      bucket === last.time
        ? { ...last, high: Math.max(last.high, livePrice), low: Math.min(last.low, livePrice), close: livePrice }
        : {
            time: bucket,
            open: last.close,
            high: Math.max(last.close, livePrice),
            low: Math.min(last.close, livePrice),
            close: livePrice,
          };
    series.update(toBar(next));
    lastCandleRef.current = next;
  }, [livePrice, liveTime, resolution, candles]);

  // Horizontal lines for the trader's position in this market.
  const linesKey = lines.map((l) => `${l.key}:${l.price}`).join("|");
  useEffect(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const line of priceLinesRef.current) series.removePriceLine(line);
    priceLinesRef.current = lines
      .filter((l) => Number.isFinite(l.price) && l.price > 0)
      .map((l) =>
        series.createPriceLine({
          price: l.price,
          color: LINE_COLOR[l.tone],
          lineWidth: 1,
          lineStyle: l.tone === "entry" ? LineStyle.Solid : LineStyle.Dashed,
          axisLabelVisible: true,
          title: l.title,
        }),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey]);

  const empty = history.isSuccess && candles !== undefined && candles.length === 0;

  return (
    <section className="panel flex min-h-0 flex-col" aria-label={`${market.symbol} price chart`}>
      <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-2 sm:px-4">
        <div className="flex items-center gap-1" role="group" aria-label="Candle interval">
          {RESOLUTIONS.map((r) => (
            <button
              key={r.key}
              type="button"
              className="chip"
              aria-pressed={resolution === r.key}
              onClick={() => setResolution(r.key)}
            >
              {r.label}
            </button>
          ))}
        </div>
        <p className="hidden text-xs text-faint sm:block">
          {stale ? "Market closed. Showing the last session." : "Pyth mid price, times in UTC"}
        </p>
      </div>
      <div className="relative h-[320px] sm:h-[420px] xl:h-[480px]">
        <div ref={containerRef} className="absolute inset-0" />
        {history.isPending ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-muted" role="status">
            <span className="spinner" aria-hidden="true" /> Loading candles
          </div>
        ) : null}
        {history.isError ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="text-muted">Chart history could not be loaded from Pyth Benchmarks. Live prices still work.</p>
            <button type="button" className="btn btn-sm" onClick={() => void history.refetch()}>
              Retry
            </button>
          </div>
        ) : null}
        {empty ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-muted">
            No candles for this interval yet. Try a longer one.
          </div>
        ) : null}
      </div>
    </section>
  );
}
