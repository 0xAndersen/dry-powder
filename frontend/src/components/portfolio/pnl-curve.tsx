"use client";

import { useEffect, useRef, useState } from "react";
import { BaselineSeries, ColorType, CrosshairMode, LineStyle, createChart, type IChartApi, type ISeriesApi, type UTCTimestamp } from "lightweight-charts";
import { fmtDateTime, safeLocale } from "@/lib/format";

const COLORS = { text: "#a0a9b6", grid: "#1a1e24", border: "#262b33", long: "#3ecf8e", short: "#f0646f" };

export type CurvePoint = { time: number; value: number };

const signed = (v: number) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** Lightweight-charts needs strictly increasing times: keep the last value per second. */
function series(points: readonly CurvePoint[]) {
  const out: { time: UTCTimestamp; value: number }[] = [];
  for (const p of points) {
    const time = Math.floor(p.time) as UTCTimestamp;
    const last = out[out.length - 1];
    if (last && last.time >= time) last.value = p.value;
    else out.push({ time, value: p.value });
  }
  return out;
}

/** Cumulative net PnL over time: green above zero, red below. */
export function PnlCurve({ points, unit, height = 220 }: { points: readonly CurvePoint[]; unit: string; height?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Baseline"> | null>(null);
  const [hover, setHover] = useState<CurvePoint | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const chart = createChart(el, {
      autoSize: true,
      layout: { background: { type: ColorType.Solid, color: "transparent" }, textColor: COLORS.text, fontFamily: '"Inter Variable", Inter, system-ui, sans-serif', fontSize: 11 },
      grid: { vertLines: { visible: false }, horzLines: { color: COLORS.grid } },
      rightPriceScale: { borderColor: COLORS.border, scaleMargins: { top: 0.12, bottom: 0.08 } },
      timeScale: { borderColor: COLORS.border, timeVisible: true, secondsVisible: false },
      crosshair: { mode: CrosshairMode.Magnet, vertLine: { labelVisible: false }, horzLine: { labelVisible: true } },
      handleScale: { mouseWheel: false, pinch: true },
      handleScroll: { mouseWheel: false, pressedMouseMove: true, horzTouchDrag: true, vertTouchDrag: false },
      localization: { locale: safeLocale(), priceFormatter: signed },
    });
    const s = chart.addSeries(BaselineSeries, {
      baseValue: { type: "price", price: 0 },
      topLineColor: COLORS.long,
      topFillColor1: "rgba(62, 207, 142, 0.22)",
      topFillColor2: "rgba(62, 207, 142, 0.02)",
      bottomLineColor: COLORS.short,
      bottomFillColor1: "rgba(240, 100, 111, 0.02)",
      bottomFillColor2: "rgba(240, 100, 111, 0.22)",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    s.createPriceLine({ price: 0, color: COLORS.border, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
    chart.subscribeCrosshairMove((param) => {
      const bar = param.seriesData.get(s) as { value?: number } | undefined;
      if (!bar || bar.value === undefined || param.time === undefined) setHover(null);
      else setHover({ time: Number(param.time), value: bar.value });
    });
    chartRef.current = chart;
    seriesRef.current = s;
    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const data = series(points);
    seriesRef.current?.setData(data);
    if (data.length > 1) chartRef.current?.timeScale().fitContent();
  }, [points]);

  const last = points[points.length - 1];
  const shown = hover ?? last ?? null;
  return (
    <div className="relative">
      <p className="pointer-events-none absolute left-3 top-2 z-[1] text-xs text-muted" aria-live="off">
        {shown ? (
          <>
            <span className={`num text-[0.8125rem] font-semibold ${shown.value > 0 ? "text-long" : shown.value < 0 ? "text-short" : "text-text"}`}>
              {signed(shown.value)} {unit}
            </span>
            <span className="ml-2 text-faint">{hover ? fmtDateTime(hover.time) : "now"}</span>
          </>
        ) : null}
      </p>
      <div ref={ref} style={{ height }} role="img" aria-label={last ? `Cumulative net PnL, now ${signed(last.value)} ${unit}` : "Cumulative net PnL"} />
    </div>
  );
}
