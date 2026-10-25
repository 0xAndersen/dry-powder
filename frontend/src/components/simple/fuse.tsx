"use client";

import { useEffect, useId, useRef, useState } from "react";

/** The fuse is drawn on a log scale of price moves, from 0.01% (left, at the powder) to 100% (right). */
const MIN_MOVE = 0.0001;
const MAX_MOVE = 1;

function position(distance: number): number {
  const d = Math.min(MAX_MOVE, Math.max(MIN_MOVE, distance));
  return Math.log10(d / MIN_MOVE) / Math.log10(MAX_MOVE / MIN_MOVE);
}

/** The element's width in CSS pixels, kept current (so the drawing is never stretched). */
function useWidth(fallback: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(fallback);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(([entry]) => {
      const w = Math.round(entry?.contentRect.width ?? 0);
      if (w > 0) setWidth(w);
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);
  return { ref, width };
}

/**
 * The fuse: how far the price can move against a trade before it closes on its own, drawn as a fuse running to
 * the powder. Its length is that distance on a log scale, so leverage shows at a glance: at 10x the fuse is long,
 * at 1000x it is a stub. On an open trade it burns down as the price moves against you; the tick marks where it
 * started.
 */
export function Fuse({
  distance,
  entryDistance = null,
  label,
  compact = false,
}: {
  /** Price move (fraction) that closes the trade, from where the price is now. Null: none (it cannot close). */
  distance: number | null;
  /** The same at entry, for the tick. */
  entryDistance?: number | null;
  label: string;
  compact?: boolean;
}) {
  const glow = useId().replace(/[^a-zA-Z0-9]/g, "");
  const { ref, width } = useWidth(320);
  const burnt = entryDistance !== null && entryDistance > 0 && distance !== null ? distance / entryDistance : null;
  const tone =
    distance === null
      ? "var(--color-faint)"
      : (burnt !== null ? burnt < 0.25 : distance < 0.002)
        ? "var(--color-short)"
        : (burnt !== null ? burnt < 0.5 : distance < 0.01)
          ? "var(--color-hot)"
          : "var(--color-fuse)";
  const W = Math.max(120, width);
  const H = compact ? 20 : 28;
  const mid = H / 2;
  const kegW = compact ? 12 : 16;
  const kegH = compact ? 10 : 14;
  const start = kegW + 5;
  const span = W - start - 10;
  const end = distance === null ? start + span : start + span * position(distance);
  const tick = entryDistance !== null && entryDistance > 0 ? start + span * position(entryDistance) : null;
  return (
    <div ref={ref} className="fuse" data-testid="fuse" data-distance={distance === null ? "" : distance.toFixed(6)}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} className="block max-w-full">
        <defs>
          <radialGradient id={`spark-${glow}`}>
            <stop offset="0%" stopColor="var(--color-spark)" stopOpacity="1" />
            <stop offset="45%" stopColor={tone} stopOpacity="0.5" />
            <stop offset="100%" stopColor={tone} stopOpacity="0" />
          </radialGradient>
        </defs>
        {/* The powder: what the trade loses when the spark reaches it. */}
        <rect x="1" y={mid - kegH / 2} width={kegW - 3} height={kegH} rx="3" fill="var(--color-text)" opacity="0.9" />
        <rect x={kegW - 4} y={mid - 1.5} width="6" height="3" rx="1" fill="var(--color-text)" opacity="0.9" />
        {/* The scale the fuse is measured on: dashed, so burnt length reads as gone. */}
        <line x1={start} y1={mid} x2={start + span} y2={mid} stroke="var(--color-line-strong)" strokeWidth="1.5" strokeDasharray="2 5" strokeLinecap="round" />
        {tick !== null ? <line x1={tick} y1={mid - (compact ? 4 : 6)} x2={tick} y2={mid + (compact ? 4 : 6)} stroke="var(--color-faint)" strokeWidth="1" /> : null}
        {end > start + 0.5 ? (
          <path d={`M${start} ${mid} Q ${(start + end) / 2} ${mid - (compact ? 2 : 3)} ${end} ${mid}`} fill="none" stroke={tone} strokeWidth={compact ? 2.5 : 3.25} strokeLinecap="round" />
        ) : null}
        {distance !== null ? (
          <g className="fuse-spark" style={{ transformOrigin: `${end}px ${mid}px` }}>
            <circle cx={end} cy={mid} r={compact ? 7 : 10} fill={`url(#spark-${glow})`} />
            <circle cx={end} cy={mid} r={compact ? 2 : 2.75} fill="var(--color-spark)" />
          </g>
        ) : null}
      </svg>
    </div>
  );
}
