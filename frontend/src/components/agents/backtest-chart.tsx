"use client";

import { useEffect, useMemo, useState, type KeyboardEvent } from "react";
import type { BtResult } from "@/lib/backtest";
import { fmtDateTime, fmtNum } from "@/lib/format";

const H_PRICE = 150;
const H_STRIP = 6;
const GAP = 10;
const H_EQUITY = 64;
const PAD_R = 64;
const PAD_T = 6;
const HEIGHT = PAD_T + H_PRICE + 4 + H_STRIP + GAP + H_EQUITY + 18;

/** The width of the element the returned ref is attached to (whichever element that is at the time). */
function useWidth() {
  const [el, setEl] = useState<HTMLDivElement | null>(null);
  const [width, setWidth] = useState(600);
  useEffect(() => {
    if (!el) return;
    setWidth(Math.round(el.getBoundingClientRect().width) || 600);
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w) setWidth(Math.round(w));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, [el]);
  return { ref: setEl, width };
}

const money = (v: number, sym: string) => `${v > 0 ? "+" : v < 0 ? "−" : ""}${fmtNum(Math.abs(v), 2)} ${sym}`;

/**
 * The replay at a glance: the price with the strategy's averages (and a mean reversion's entry bands), a strip of
 * what it held, entries and exits, and its running result underneath. Arrow keys move the read-out.
 */
export function BacktestChart({ result, kind, bandBps, priceDecimals, sym }: { result: BtResult; kind: "trend" | "meanRevert"; bandBps: number; priceDecimals: number; sym: string }) {
  const { ref, width } = useWidth();
  const [cursor, setCursor] = useState<number | null>(null);
  const pts = result.points;
  const plotW = Math.max(40, width - PAD_R);

  const geo = useMemo(() => {
    if (pts.length < 2) return null;
    const t0 = pts[0]!.time;
    const t1 = pts[pts.length - 1]!.time;
    const band = bandBps / 10_000;
    let lo = Infinity;
    let hi = -Infinity;
    for (const p of pts) {
      const vals = [p.close];
      if (p.a !== null) vals.push(kind === "meanRevert" ? p.a * (1 - band) : p.a, kind === "meanRevert" ? p.a * (1 + band) : p.a);
      if (p.b !== null) vals.push(p.b);
      for (const v of vals) {
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    const span = hi - lo || hi * 0.001 || 1;
    lo -= span * 0.06;
    hi += span * 0.06;
    let eLo = 0;
    let eHi = 0;
    for (const p of pts) {
      if (p.equity < eLo) eLo = p.equity;
      if (p.equity > eHi) eHi = p.equity;
    }
    if (eHi - eLo < 1e-9) {
      eHi += 1;
      eLo -= 1;
    }
    const x = (t: number) => ((t - t0) / Math.max(1, t1 - t0)) * plotW;
    const y = (v: number) => PAD_T + (1 - (v - lo) / (hi - lo)) * H_PRICE;
    const eTop = PAD_T + H_PRICE + 4 + H_STRIP + GAP;
    const ey = (v: number) => eTop + (1 - (v - eLo) / (eHi - eLo)) * H_EQUITY;
    const line = (get: (p: (typeof pts)[number]) => number | null) => {
      let d = "";
      let pen = false;
      for (const p of pts) {
        const v = get(p);
        if (v === null || !Number.isFinite(v)) {
          pen = false;
          continue;
        }
        d += `${pen ? "L" : "M"}${x(p.time).toFixed(1)},${y(v).toFixed(1)}`;
        pen = true;
      }
      return d;
    };
    const equity = pts.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.time).toFixed(1)},${ey(p.equity).toFixed(1)}`).join("");
    const area = `${equity}L${x(t1).toFixed(1)},${ey(0).toFixed(1)}L${x(t0).toFixed(1)},${ey(0).toFixed(1)}Z`;
    // Contiguous stretches of one side for the "held" strip.
    const strips: { x0: number; x1: number; side: "long" | "short" }[] = [];
    for (let i = 0; i < pts.length; i += 1) {
      const side = pts[i]!.held;
      if (side === "flat") continue;
      const prev = strips[strips.length - 1];
      const xs = x(pts[Math.max(0, i - 1)]!.time);
      const xe = x(pts[i]!.time);
      if (prev && prev.side === side && Math.abs(prev.x1 - xs) < 0.01) prev.x1 = xe;
      else strips.push({ x0: xs, x1: xe, side });
    }
    return { t0, t1, lo, hi, eLo, eHi, x, y, ey, eTop, price: line((p) => p.close), a: line((p) => p.a), b: line((p) => p.b), upper: kind === "meanRevert" ? line((p) => (p.a === null ? null : p.a * (1 + band))) : "", lower: kind === "meanRevert" ? line((p) => (p.a === null ? null : p.a * (1 - band))) : "", equity, area, strips };
  }, [pts, kind, bandBps, plotW]);

  if (!geo) return <div ref={ref} className="grid h-40 place-items-center text-xs text-faint">Not enough candles to draw.</div>;
  const last = pts[pts.length - 1]!;
  const tone = result.net > 0 ? "var(--color-long)" : result.net < 0 ? "var(--color-short)" : "var(--color-muted)";
  const at = cursor === null ? null : pts[Math.max(0, Math.min(pts.length - 1, cursor))]!;

  const onMove = (clientX: number, rect: DOMRect) => {
    const t = geo.t0 + ((clientX - rect.left) / plotW) * (geo.t1 - geo.t0);
    let best = 0;
    let lo = 0;
    let hi = pts.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pts[mid]!.time < t) lo = mid + 1;
      else hi = mid - 1;
    }
    best = Math.min(pts.length - 1, Math.max(0, lo));
    if (best > 0 && Math.abs(pts[best - 1]!.time - t) < Math.abs(pts[best]!.time - t)) best -= 1;
    setCursor(best);
  };
  const onKey = (e: KeyboardEvent) => {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === "ArrowLeft") setCursor((c) => Math.max(0, (c ?? pts.length) - step));
    else if (e.key === "ArrowRight") setCursor((c) => Math.min(pts.length - 1, (c ?? -1) + step));
    else if (e.key === "Home") setCursor(0);
    else if (e.key === "End") setCursor(pts.length - 1);
    else if (e.key === "Escape") setCursor(null);
    else return;
    e.preventDefault();
  };

  const dp = priceDecimals;
  return (
    <div
      ref={ref}
      className="relative select-none outline-none focus-visible:ring-2 focus-visible:ring-accent/60"
      tabIndex={0}
      role="img"
      aria-label={`Replay: result ${money(result.net, sym)}, ${result.trades.length} trades, largest drawdown ${fmtNum(result.maxDrawdown, 2)} ${sym}. Arrow keys read it point by point.`}
      onKeyDown={onKey}
      onMouseMove={(e) => onMove(e.clientX, e.currentTarget.getBoundingClientRect())}
      onMouseLeave={() => setCursor(null)}
      onBlur={() => setCursor(null)}
      data-testid="backtest-chart"
    >
      <svg width={width} height={HEIGHT} className="block overflow-visible">
        {/* Price pane */}
        <line x1={0} x2={plotW} y1={PAD_T + H_PRICE} y2={PAD_T + H_PRICE} stroke="var(--color-line)" />
        {geo.upper ? <path d={geo.upper} fill="none" stroke="var(--color-faint)" strokeDasharray="3 3" strokeWidth={1} /> : null}
        {geo.lower ? <path d={geo.lower} fill="none" stroke="var(--color-faint)" strokeDasharray="3 3" strokeWidth={1} /> : null}
        <path d={geo.price} fill="none" stroke="var(--color-muted)" strokeWidth={1.2} strokeOpacity={0.85} />
        {geo.a ? <path d={geo.a} fill="none" stroke="var(--color-accent)" strokeWidth={1.4} /> : null}
        {geo.b ? <path d={geo.b} fill="none" stroke="var(--color-warn)" strokeWidth={1.4} /> : null}
        {result.trades.map((t, i) => {
          const ex = geo.x(t.entryTime);
          const ey = geo.y(t.entryPrice);
          const up = t.side === "long";
          const color = up ? "var(--color-long)" : "var(--color-short)";
          const xx = geo.x(t.exitTime);
          const yy = geo.y(t.exitPrice);
          return (
            <g key={i}>
              <path d={up ? `M${ex - 4},${ey + 7}L${ex + 4},${ey + 7}L${ex},${ey + 1}Z` : `M${ex - 4},${ey - 7}L${ex + 4},${ey - 7}L${ex},${ey - 1}Z`} fill={color} />
              {t.exit === "open" ? null : t.exit === "liquidation" ? (
                <path d={`M${xx - 3.5},${yy - 3.5}L${xx + 3.5},${yy + 3.5}M${xx + 3.5},${yy - 3.5}L${xx - 3.5},${yy + 3.5}`} stroke="var(--color-short)" strokeWidth={2} />
              ) : (
                <circle cx={xx} cy={yy} r={2.8} fill="var(--color-panel)" stroke={t.net > 0 ? "var(--color-long)" : "var(--color-short)"} strokeWidth={1.5} />
              )}
            </g>
          );
        })}
        <text x={plotW + 6} y={PAD_T + 9} className="num" fontSize={10} fill="var(--color-faint)">
          {fmtNum(geo.hi, dp)}
        </text>
        <text x={plotW + 6} y={PAD_T + H_PRICE - 2} className="num" fontSize={10} fill="var(--color-faint)">
          {fmtNum(geo.lo, dp)}
        </text>
        <text x={plotW + 6} y={Math.min(PAD_T + H_PRICE - 14, Math.max(PAD_T + 22, geo.y(last.close) + 3))} className="num" fontSize={10} fill="var(--color-text)">
          {fmtNum(last.close, dp)}
        </text>

        {/* What it held */}
        <rect x={0} y={PAD_T + H_PRICE + 4} width={plotW} height={H_STRIP} fill="var(--color-raised)" rx={1} />
        {geo.strips.map((s, i) => (
          <rect key={i} x={s.x0} y={PAD_T + H_PRICE + 4} width={Math.max(1, s.x1 - s.x0)} height={H_STRIP} fill={s.side === "long" ? "var(--color-long)" : "var(--color-short)"} fillOpacity={0.75} />
        ))}

        {/* Result pane */}
        <line x1={0} x2={plotW} y1={geo.ey(0)} y2={geo.ey(0)} stroke="var(--color-line-strong)" strokeDasharray="2 3" />
        <path d={geo.area} fill={tone} fillOpacity={0.1} />
        <path d={geo.equity} fill="none" stroke={tone} strokeWidth={1.5} />
        <text x={plotW + 6} y={Math.max(geo.eTop + 9, Math.min(geo.eTop + H_EQUITY, geo.ey(last.equity) + 3))} className="num" fontSize={10} fill={tone}>
          {money(last.equity, "")}
        </text>
        <text x={0} y={HEIGHT - 3} className="num" fontSize={10} fill="var(--color-faint)">
          {fmtDateTime(geo.t0)}
        </text>
        <text x={plotW} y={HEIGHT - 3} textAnchor="end" className="num" fontSize={10} fill="var(--color-faint)">
          {fmtDateTime(geo.t1)}
        </text>

        {at ? (
          <g pointerEvents="none">
            <line x1={geo.x(at.time)} x2={geo.x(at.time)} y1={PAD_T} y2={geo.eTop + H_EQUITY} stroke="var(--color-line-strong)" />
            <circle cx={geo.x(at.time)} cy={geo.y(at.close)} r={3} fill="var(--color-text)" />
            <circle cx={geo.x(at.time)} cy={geo.ey(at.equity)} r={3} fill={tone} />
          </g>
        ) : null}
      </svg>
      {at ? (
        <div
          className="pointer-events-none absolute top-1 rounded-[4px] border border-line-strong bg-raised px-2 py-1.5 text-2xs shadow-lg"
          style={geo.x(at.time) > plotW / 2 ? { right: width - geo.x(at.time) + 10 } : { left: geo.x(at.time) + 10 }}
        >
          <div className="num text-faint">{fmtDateTime(at.time)}</div>
          <div className="num">Price {fmtNum(at.close, dp)}</div>
          {at.a !== null ? (
            <div className="num text-accent">
              {kind === "trend" ? "Fast" : "Average"} {fmtNum(at.a, dp)}
            </div>
          ) : null}
          {at.b !== null ? <div className="num text-warn">Slow {fmtNum(at.b, dp)}</div> : null}
          <div className={at.held === "long" ? "text-long" : at.held === "short" ? "text-short" : "text-muted"}>{at.held === "flat" ? "No position" : `Holding ${at.held}`}</div>
          <div className="num">Result {money(at.equity, sym)}</div>
        </div>
      ) : null}
    </div>
  );
}
