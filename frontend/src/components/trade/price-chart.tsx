"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  CandlestickSeries,
  ColorType,
  CrosshairMode,
  HistogramSeries,
  LineSeries,
  LineStyle,
  createChart,
  createSeriesMarkers,
  type ISeriesMarkersPluginApi,
  type SeriesMarker,
  type Time,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type SeriesType,
  type UTCTimestamp,
} from "lightweight-charts";
import { useAppConfig } from "@/components/providers";
import { useLocalStore } from "@/hooks/use-local-store";
import type { MarketPrice } from "@/hooks/use-market-data";
import { fmtNum, fmtPercent } from "@/lib/format";
import { bollinger, ema, macd, rsi, sma, vwap, type IndicatorSettings, type Series } from "@/lib/indicators";
import { krakenSource, type Instrument } from "@/lib/instruments";
import { RESOLUTIONS, fetchInstrumentCandles, resolutionInfo, type Candle, type Resolution } from "@/lib/kraken";
import { indicatorSettings } from "@/lib/storage";

export type ChartLineTone = "entry" | "liq" | "tp" | "sl" | "order" | "draft" | "alert" | "settle";
export type ChartLine = { key: string; price: number; title: string; tone: ChartLineTone };
/** One of your fills drawn on the candles: entries as arrows, exits and liquidations as circles. */
export type ChartMarker = { id: string; time: number; kind: "open" | "close" | "liquidation"; isLong: boolean | null; text: string };

/** What a click on the chart sets. */
export type PickTarget = "limit" | "tp" | "sl" | "alert";
export const PICK_LABELS: Record<PickTarget, string> = { limit: "limit price", tp: "take-profit", sl: "stop-loss", alert: "alert" };

const COLORS = {
  text: "#a0a9b6",
  grid: "#1a1e24",
  border: "#262b33",
  long: "#3ecf8e",
  short: "#f0646f",
  accent: "#7ea6ff",
  liq: "#f59e4b",
  entry: "#e8ecf1",
  ema1: "#e6b450",
  ema2: "#5ec8d8",
  sma: "#c39bf0",
  bb: "#6b7482",
  vwap: "#d9a066",
  volUp: "rgba(62, 207, 142, 0.28)",
  volDown: "rgba(240, 100, 111, 0.28)",
} as const;

const LINE_STYLE: Record<ChartLineTone, { color: string; style: LineStyle }> = {
  entry: { color: COLORS.entry, style: LineStyle.Solid },
  liq: { color: COLORS.liq, style: LineStyle.Dashed },
  tp: { color: COLORS.long, style: LineStyle.Dashed },
  sl: { color: COLORS.short, style: LineStyle.Dashed },
  order: { color: COLORS.ema2, style: LineStyle.LargeDashed },
  draft: { color: COLORS.text, style: LineStyle.Dotted },
  alert: { color: COLORS.vwap, style: LineStyle.SparseDotted },
  settle: { color: COLORS.sma, style: LineStyle.Solid },
};

type Legend = { open: number; high: number; low: number; close: number; volume: number; time: number } | null;

function lineData(candles: readonly Candle[], values: Series) {
  const out: { time: UTCTimestamp; value: number }[] = [];
  for (let i = 0; i < candles.length; i += 1) {
    const v = values[i];
    if (v !== null && v !== undefined && Number.isFinite(v)) out.push({ time: candles[i]!.time as UTCTimestamp, value: v });
  }
  return out;
}

function NumberField({ label, value, min, max, step = 1, onChange }: { label: string; value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <label className="flex items-center gap-1 text-xs text-muted">
      <span>{label}</span>
      <input
        className="mini-input num w-12"
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => {
          const v = Number(event.target.value);
          if (Number.isFinite(v) && v >= min && v <= max) onChange(v);
        }}
      />
    </label>
  );
}

function IndicatorMenu({ settings, onChange }: { settings: IndicatorSettings; onChange: (next: IndicatorSettings) => void }) {
  const rows: { key: keyof IndicatorSettings; label: string; color?: string; fields: React.ReactNode }[] = [
    {
      key: "ema1",
      label: "EMA (fast)",
      color: COLORS.ema1,
      fields: <NumberField label="Period" value={settings.ema1.period} min={2} max={500} onChange={(period) => onChange({ ...settings, ema1: { ...settings.ema1, period } })} />,
    },
    {
      key: "ema2",
      label: "EMA (slow)",
      color: COLORS.ema2,
      fields: <NumberField label="Period" value={settings.ema2.period} min={2} max={500} onChange={(period) => onChange({ ...settings, ema2: { ...settings.ema2, period } })} />,
    },
    {
      key: "sma",
      label: "SMA",
      color: COLORS.sma,
      fields: <NumberField label="Period" value={settings.sma.period} min={2} max={500} onChange={(period) => onChange({ ...settings, sma: { ...settings.sma, period } })} />,
    },
    {
      key: "bb",
      label: "Bollinger Bands",
      color: COLORS.bb,
      fields: (
        <>
          <NumberField label="Period" value={settings.bb.period} min={2} max={500} onChange={(period) => onChange({ ...settings, bb: { ...settings.bb, period } })} />
          <NumberField label="Dev" value={settings.bb.mult} min={0.5} max={5} step={0.5} onChange={(mult) => onChange({ ...settings, bb: { ...settings.bb, mult } })} />
        </>
      ),
    },
    { key: "vwap", label: "VWAP (daily, UTC)", color: COLORS.vwap, fields: null },
    { key: "volume", label: "Volume", fields: null },
    {
      key: "rsi",
      label: "RSI (own pane)",
      fields: <NumberField label="Period" value={settings.rsi.period} min={2} max={100} onChange={(period) => onChange({ ...settings, rsi: { ...settings.rsi, period } })} />,
    },
    {
      key: "macd",
      label: "MACD (own pane)",
      fields: (
        <>
          <NumberField label="Fast" value={settings.macd.fast} min={2} max={200} onChange={(fast) => onChange({ ...settings, macd: { ...settings.macd, fast } })} />
          <NumberField label="Slow" value={settings.macd.slow} min={3} max={400} onChange={(slow) => onChange({ ...settings, macd: { ...settings.macd, slow } })} />
          <NumberField label="Signal" value={settings.macd.signal} min={2} max={100} onChange={(signal) => onChange({ ...settings, macd: { ...settings.macd, signal } })} />
        </>
      ),
    },
  ];
  return (
    <div className="panel absolute right-0 top-full z-20 mt-1 w-[min(21rem,calc(100vw-1.5rem))] p-2 shadow-[0_12px_32px_rgba(4,8,14,0.55)]" role="dialog" aria-label="Indicators">
      <ul className="divide-y divide-line/60">
        {rows.map((row) => {
          const on = settings[row.key].on;
          return (
            <li key={row.key} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-1.5 py-1.5">
              <label className="flex min-w-[9.5rem] flex-1 items-center gap-2 text-[0.8125rem]">
                <input
                  type="checkbox"
                  className="check"
                  checked={on}
                  onChange={(event) => onChange({ ...settings, [row.key]: { ...settings[row.key], on: event.target.checked } } as IndicatorSettings)}
                />
                {row.color ? <span aria-hidden="true" className="h-0.5 w-3" style={{ background: row.color }} /> : null}
                <span className={on ? "text-text" : "text-muted"}>{row.label}</span>
              </label>
              {row.fields ? <div className="flex items-center gap-2">{row.fields}</div> : null}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

export function PriceChart({
  instrument,
  price,
  lines,
  pickTargets,
  pick,
  onPickChange,
  onPick,
  indicatorsHidden,
  chainNow,
  markers = [],
}: {
  instrument: Instrument;
  price: MarketPrice;
  lines: ChartLine[];
  /** Your entries and exits in this market. */
  markers?: ChartMarker[];
  /** Which targets "set on chart" offers right now. */
  pickTargets: PickTarget[];
  pick: PickTarget | null;
  onPickChange: (target: PickTarget | null) => void;
  onPick: (target: PickTarget, price: number) => void;
  /** Temporarily hides every indicator (keyboard shortcut I). */
  indicatorsHidden: boolean;
  chainNow: number;
}) {
  const cfg = useAppConfig();
  const ids = useId();
  const [resolution, setResolution] = useState<Resolution>("15");
  const [settings, setSettings] = useLocalStore(indicatorSettings);
  const [menuOpen, setMenuOpen] = useState(false);
  const [legend, setLegend] = useState<Legend>(null);
  const [pickText, setPickText] = useState("");
  const [sessionCandles, setSessionCandles] = useState<Candle[]>([]);
  // Full-screen chart (phones in landscape, or more room on desktop). CSS-only so it works on iOS too.
  const [expanded, setExpanded] = useState(false);
  const markersRef = useRef<ISeriesMarkersPluginApi<Time> | null>(null);
  useEffect(() => {
    if (!expanded) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setExpanded(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [expanded]);

  const containerRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const pickInputRef = useRef<HTMLInputElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const indicatorRefs = useRef<ISeriesApi<SeriesType>[]>([]);
  const lastCandleRef = useRef<Candle | null>(null);
  const priceLinesRef = useRef<IPriceLine[]>([]);
  const pickRef = useRef<PickTarget | null>(null);
  const onPickRef = useRef(onPick);
  pickRef.current = pick;
  onPickRef.current = onPick;

  const source = useMemo(() => krakenSource(instrument), [instrument.feedId, instrument.quoteFeedId, instrument.invert]); // eslint-disable-line react-hooks/exhaustive-deps
  const info = resolutionInfo(resolution);
  const dp = instrument.priceDecimals;

  const history = useQuery({
    queryKey: ["candles", cfg.krakenUrl, instrument.id, resolution],
    queryFn: ({ signal }) => fetchInstrumentCandles(cfg.krakenUrl, source!, info.minutes, signal),
    enabled: source !== null,
    staleTime: 20_000,
    refetchInterval: 30_000,
    retry: 1,
  });

  // A feed with no known exchange pair still gets a chart: built from the oracle prices seen this session.
  useEffect(() => {
    setSessionCandles([]);
  }, [instrument.id, resolution]);
  const display = price.display;
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

  // Create the chart once.
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const chart = createChart(container, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: COLORS.text,
        fontFamily: '"Inter Variable", Inter, system-ui, sans-serif',
        fontSize: 11,
        panes: { separatorColor: COLORS.border, separatorHoverColor: "rgba(126,166,255,0.25)", enableResize: true },
      },
      grid: { vertLines: { color: COLORS.grid }, horzLines: { color: COLORS.grid } },
      rightPriceScale: { borderColor: COLORS.border, scaleMargins: { top: 0.08, bottom: 0.2 } },
      timeScale: { borderColor: COLORS.border, timeVisible: true, secondsVisible: false, rightOffset: 8 },
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
    const volume = chart.addSeries(HistogramSeries, { priceScaleId: "volume", priceFormat: { type: "volume" }, lastValueVisible: false, priceLineVisible: false });
    chart.priceScale("volume").applyOptions({ scaleMargins: { top: 0.84, bottom: 0 } });

    chart.subscribeCrosshairMove((param) => {
      const bar = param.seriesData.get(series) as { open: number; high: number; low: number; close: number } | undefined;
      if (!bar || param.time === undefined) {
        setLegend(null);
        return;
      }
      const vol = param.seriesData.get(volume) as { value?: number } | undefined;
      setLegend({ open: bar.open, high: bar.high, low: bar.low, close: bar.close, volume: vol?.value ?? 0, time: Number(param.time) });
    });
    chart.subscribeClick((param) => {
      const target = pickRef.current;
      if (!target || !param.point) return;
      const value = series.coordinateToPrice(param.point.y);
      if (value !== null && Number.isFinite(value) && value > 0) onPickRef.current(target, value);
    });

    chartRef.current = chart;
    candleRef.current = series;
    volumeRef.current = volume;
    markersRef.current = createSeriesMarkers(series, []);
    return () => {
      markersRef.current = null;
      priceLinesRef.current = [];
      indicatorRefs.current = [];
      lastCandleRef.current = null;
      candleRef.current = null;
      volumeRef.current = null;
      chartRef.current = null;
      chart.remove();
    };
  }, []);

  useEffect(() => {
    candleRef.current?.applyOptions({ priceFormat: { type: "price", precision: dp, minMove: 1 / 10 ** dp } });
  }, [dp]);

  useEffect(() => {
    chartRef.current?.applyOptions({ timeScale: { timeVisible: resolution !== "1440" } });
  }, [resolution]);

  // Candles and volume.
  const dataKey = `${instrument.id}:${resolution}`;
  const shownKeyRef = useRef("");
  useEffect(() => {
    const series = candleRef.current;
    const volume = volumeRef.current;
    if (!series || !volume) return;
    if (!candles || candles.length === 0) {
      series.setData([]);
      volume.setData([]);
      lastCandleRef.current = null;
      return;
    }
    series.setData(candles.map((c) => ({ time: c.time as UTCTimestamp, open: c.open, high: c.high, low: c.low, close: c.close })));
    volume.setData(
      settings.volume.on && !indicatorsHidden
        ? candles.map((c) => ({ time: c.time as UTCTimestamp, value: c.volume, color: c.close >= c.open ? COLORS.volUp : COLORS.volDown }))
        : [],
    );
    lastCandleRef.current = candles[candles.length - 1] ?? null;
    if (shownKeyRef.current !== dataKey) {
      shownKeyRef.current = dataKey;
      chartRef.current?.timeScale().scrollToRealTime();
    }
  }, [candles, dataKey, settings.volume.on, indicatorsHidden]);

  // Indicators: rebuilt whenever the candles or their settings change.
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    for (const s of indicatorRefs.current) {
      try {
        chart.removeSeries(s);
      } catch {
        // Already gone with its pane.
      }
    }
    indicatorRefs.current = [];
    if (!candles || candles.length === 0 || indicatorsHidden) return;
    const closes = candles.map((c) => c.close);
    const quiet = { lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false } as const;
    const overlay = (values: Series, color: string, title: string, width: 1 | 2 = 1, style: LineStyle = LineStyle.Solid) => {
      const s = chart.addSeries(LineSeries, { color, lineWidth: width, lineStyle: style, title, ...quiet, priceFormat: { type: "price", precision: dp, minMove: 1 / 10 ** dp } }, 0);
      s.setData(lineData(candles, values));
      indicatorRefs.current.push(s);
    };
    if (settings.ema1.on) overlay(ema(closes, settings.ema1.period), COLORS.ema1, `EMA ${settings.ema1.period}`, 2);
    if (settings.ema2.on) overlay(ema(closes, settings.ema2.period), COLORS.ema2, `EMA ${settings.ema2.period}`, 2);
    if (settings.sma.on) overlay(sma(closes, settings.sma.period), COLORS.sma, `SMA ${settings.sma.period}`, 2);
    if (settings.bb.on) {
      const bands = bollinger(closes, settings.bb.period, settings.bb.mult);
      overlay(bands.upper, COLORS.bb, "", 1);
      overlay(bands.middle, COLORS.bb, `BB ${settings.bb.period}/${settings.bb.mult}`, 1, LineStyle.Dashed);
      overlay(bands.lower, COLORS.bb, "", 1);
    }
    if (settings.vwap.on) overlay(vwap(candles), COLORS.vwap, "VWAP", 2);

    let pane = 1;
    if (settings.rsi.on) {
      const s = chart.addSeries(LineSeries, { color: COLORS.ema2, lineWidth: 2, title: `RSI ${settings.rsi.period}`, priceLineVisible: false, priceFormat: { type: "price", precision: 1, minMove: 0.1 } }, pane);
      s.setData(lineData(candles, rsi(closes, settings.rsi.period)));
      s.createPriceLine({ price: 70, color: COLORS.border, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
      s.createPriceLine({ price: 30, color: COLORS.border, lineWidth: 1, lineStyle: LineStyle.Dashed, axisLabelVisible: false, title: "" });
      indicatorRefs.current.push(s);
      pane += 1;
    }
    if (settings.macd.on) {
      const m = macd(closes, settings.macd.fast, settings.macd.slow, settings.macd.signal);
      const format = { type: "price", precision: Math.min(8, dp + 1), minMove: 1 / 10 ** Math.min(8, dp + 1) } as const;
      const hist = chart.addSeries(HistogramSeries, { ...quiet, priceFormat: format }, pane);
      hist.setData(
        lineData(candles, m.histogram).map((p) => ({ ...p, color: p.value >= 0 ? COLORS.volUp : COLORS.volDown })),
      );
      const line = chart.addSeries(LineSeries, { color: COLORS.ema2, lineWidth: 2, title: "MACD", ...quiet, priceFormat: format }, pane);
      line.setData(lineData(candles, m.line));
      const signal = chart.addSeries(LineSeries, { color: COLORS.vwap, lineWidth: 1, title: "Signal", ...quiet, priceFormat: format }, pane);
      signal.setData(lineData(candles, m.signal));
      indicatorRefs.current.push(hist, line, signal);
    }
    const panes = chart.panes();
    for (let i = 1; i < panes.length; i += 1) panes[i]?.setHeight(104);
  }, [candles, settings, indicatorsHidden, dp]);

  // Fold the live price into the last candle, or start a new one when its interval has passed.
  useEffect(() => {
    const series = candleRef.current;
    const last = lastCandleRef.current;
    if (!series || !last || display === null || source === null) return;
    const seconds = info.minutes * 60;
    const bucket = Math.floor(chainNow / seconds) * seconds;
    if (bucket < last.time) return;
    // A tape price far from the candles means the two disagree (for example a mocked or lagging source); do not draw a spike.
    if (Math.abs(display / last.close - 1) > 0.2) return;
    const next: Candle =
      bucket === last.time
        ? { ...last, high: Math.max(last.high, display), low: Math.min(last.low, display), close: display }
        : { time: bucket, open: last.close, high: Math.max(last.close, display), low: Math.min(last.close, display), close: display, volume: 0 };
    series.update({ time: next.time as UTCTimestamp, open: next.open, high: next.high, low: next.low, close: next.close });
    lastCandleRef.current = next;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [display, candles, info.minutes, source]);

  // Horizontal lines: position, orders, drafts from the ticket, alerts.
  const linesKey = lines.map((l) => `${l.key}:${l.price}:${l.tone}:${l.title}`).join("|");
  useEffect(() => {
    const series = candleRef.current;
    if (!series) return;
    for (const line of priceLinesRef.current) series.removePriceLine(line);
    priceLinesRef.current = lines
      .filter((l) => Number.isFinite(l.price) && l.price > 0)
      .map((l) =>
        series.createPriceLine({
          price: l.price,
          color: LINE_STYLE[l.tone].color,
          lineWidth: 1,
          lineStyle: LINE_STYLE[l.tone].style,
          axisLabelVisible: true,
          title: l.title,
        }),
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [linesKey]);

  // Your fills on the candles, snapped to the candle they fall in.
  const markersKey = `${dataKey}|${candles?.length ?? 0}|${markers.map((m) => m.id).join(",")}`;
  useEffect(() => {
    const plugin = markersRef.current;
    if (!plugin) return;
    if (!candles || candles.length === 0 || markers.length === 0) {
      plugin.setMarkers([]);
      return;
    }
    const seconds = info.minutes * 60;
    const first = candles[0]!.time;
    const out: SeriesMarker<Time>[] = markers
      .map((m) => ({ ...m, bucket: Math.floor(m.time / seconds) * seconds }))
      .filter((m) => m.bucket >= first)
      .sort((a, b) => a.bucket - b.bucket)
      .map((m) =>
        m.kind === "open"
          ? {
              time: m.bucket as UTCTimestamp,
              position: m.isLong ? "belowBar" : "aboveBar",
              shape: m.isLong ? "arrowUp" : "arrowDown",
              color: m.isLong ? COLORS.long : COLORS.short,
              text: m.text,
            }
          : {
              time: m.bucket as UTCTimestamp,
              position: "aboveBar",
              shape: "circle",
              color: m.kind === "liquidation" ? COLORS.liq : COLORS.entry,
              text: m.text,
            },
      );
    plugin.setMarkers(out);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [markersKey]);

  // Indicator menu: close on outside click / Escape.
  useEffect(() => {
    if (!menuOpen) return;
    const onPointer = (event: PointerEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) setMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  // Pick mode: prefill the typed alternative with the current price and listen for Escape.
  useEffect(() => {
    if (!pick) return;
    setPickText(display !== null ? display.toFixed(dp) : "");
    const t = setTimeout(() => pickInputRef.current?.select(), 0);
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onPickChange(null);
    };
    document.addEventListener("keydown", onKey);
    return () => {
      clearTimeout(t);
      document.removeEventListener("keydown", onKey);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pick]);

  const shown: Legend = legend ?? (candles && candles.length > 0 ? { ...candles[candles.length - 1]!, ...(lastCandleRef.current ?? {}) } : null);
  const change = shown ? shown.close / shown.open - 1 : null;
  const empty = (source === null || history.isSuccess) && candles !== undefined && candles.length === 0;
  const activeCount = (Object.keys(settings) as (keyof IndicatorSettings)[]).filter((k) => settings[k].on).length;
  const typedPick = Number(pickText);

  return (
    <section className={`panel flex min-h-0 flex-col ${expanded ? "chart-expanded" : ""}`} aria-label={`${instrument.symbol} price chart`} data-expanded={expanded}>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-b border-line px-2 py-1.5 sm:px-3">
        <div className="flex items-center gap-1" role="group" aria-label="Candle interval">
          {RESOLUTIONS.map((r) => (
            <button key={r.key} type="button" className="chip" aria-pressed={resolution === r.key} onClick={() => setResolution(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
        <div className="flex items-center gap-1" role="group" aria-label="Set a price by clicking the chart">
          <span className="hidden text-xs text-faint md:inline">Set on chart</span>
          {pickTargets.map((target) => (
            <button
              key={target}
              type="button"
              className="chip"
              aria-pressed={pick === target}
              title={`Click the chart to set the ${PICK_LABELS[target]}`}
              onClick={() => onPickChange(pick === target ? null : target)}
            >
              {target === "limit" ? "Limit" : target === "tp" ? "TP" : target === "sl" ? "SL" : "Alert"}
            </button>
          ))}
        </div>
        <div className="relative ml-auto flex items-center gap-1" ref={menuRef}>
          <button type="button" className="chip" aria-expanded={menuOpen} aria-haspopup="dialog" onClick={() => setMenuOpen((v) => !v)}>
            Indicators{activeCount > 0 ? ` (${activeCount})` : ""}
            {indicatorsHidden ? " hidden" : ""}
          </button>
          <button
            type="button"
            className="chip"
            aria-pressed={expanded}
            aria-label={expanded ? "Exit full screen" : "Full-screen chart"}
            title={expanded ? "Exit full screen (Esc)" : "Full-screen chart"}
            onClick={() => setExpanded((v) => !v)}
            data-testid="chart-expand"
          >
            {expanded ? "✕" : "⤢"}
          </button>
          {menuOpen ? <IndicatorMenu settings={settings} onChange={setSettings} /> : null}
        </div>
      </div>

      <div className="relative">
        <div className="pointer-events-none absolute left-2 top-1.5 z-10 flex flex-wrap gap-x-3 text-2xs text-muted sm:left-3" aria-hidden={legend === null}>
          {shown ? (
            <>
              <span>
                O <span className="num text-text">{fmtNum(shown.open, dp)}</span>
              </span>
              <span>
                H <span className="num text-text">{fmtNum(shown.high, dp)}</span>
              </span>
              <span>
                L <span className="num text-text">{fmtNum(shown.low, dp)}</span>
              </span>
              <span>
                C <span className="num text-text">{fmtNum(shown.close, dp)}</span>
              </span>
              {change !== null ? <span className={`num ${change >= 0 ? "text-long" : "text-short"}`}>{fmtPercent(change, 2, true)}</span> : null}
              {shown.volume > 0 ? (
                <span>
                  Vol <span className="num text-text">{fmtNum(shown.volume, shown.volume < 100 ? 2 : 0)}</span>
                </span>
              ) : null}
            </>
          ) : null}
        </div>

        {pick ? (
          <form
            className="pick-banner"
            onSubmit={(event) => {
              event.preventDefault();
              if (typedPick > 0) onPick(pick, typedPick);
            }}
          >
            <label htmlFor={`${ids}-pick`} className="text-[0.8125rem] text-text">
              Click the chart to set the {PICK_LABELS[pick]}, or type it
            </label>
            <input
              id={`${ids}-pick`}
              ref={pickInputRef}
              className="mini-input num w-28"
              inputMode="decimal"
              value={pickText}
              onChange={(event) => setPickText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
                event.preventDefault();
                const current = Number(pickText) || display || 0;
                const step = current * (event.shiftKey ? 0.005 : 0.0005);
                setPickText((event.key === "ArrowUp" ? current + step : Math.max(0, current - step)).toFixed(dp));
              }}
            />
            <button type="submit" className="btn btn-sm btn-primary" disabled={!(typedPick > 0)}>
              Set
            </button>
            <button type="button" className="btn btn-sm" onClick={() => onPickChange(null)}>
              Cancel
            </button>
          </form>
        ) : null}

        {/* `isolate` keeps the chart library's internal z-indexes from covering menus and dialogs. */}
        <div className="chart-box relative isolate z-0 h-[340px] sm:h-[440px] 2xl:h-[520px]" data-picking={pick ? "true" : undefined}>
          <div ref={containerRef} className={`h-full w-full ${pick ? "cursor-crosshair" : ""}`} data-testid="chart-canvas" />
        </div>

        {source !== null && history.isPending ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center gap-2 text-muted" role="status">
            <span className="spinner" aria-hidden="true" /> Loading candles
          </div>
        ) : null}
        {source !== null && history.isError ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-3 px-6 text-center">
            <p className="max-w-sm text-muted">Candle history could not be loaded from Kraken. Prices and trading are unaffected.</p>
            <button type="button" className="btn btn-sm" onClick={() => void history.refetch()}>
              Retry
            </button>
          </div>
        ) : null}
        {empty ? (
          <div className="pointer-events-none absolute inset-0 flex items-center justify-center px-6 text-center text-muted">
            {source === null ? "Collecting prices for this market. The chart fills in as they arrive." : "No candles for this interval yet. Try a longer one."}
          </div>
        ) : null}
      </div>
      <p className="border-t border-line px-3 py-1 text-2xs text-faint">
        {source === null
          ? "No exchange history is mapped to this feed: candles are built from oracle prices seen since you opened the page."
          : `Candles and volume: Kraken ${source.base}${source.quote ? ` / ${source.quote}` : ""}${source.invert ? ", inverted" : ""}${instrument.feed?.note ? `. ${instrument.feed.note}` : ""}. Orders execute at the on-chain oracle price, not at these.`}
      </p>
    </section>
  );
}
