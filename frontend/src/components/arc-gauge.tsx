import type { ReactNode } from "react";

/**
 * The house motif: a half-circle split between two quantities (long vs short open interest,
 * money in vs money out). `fraction` is the left quantity's share, 0..1, or null when there is no data.
 */
export function ArcGauge({
  fraction,
  leftColor,
  rightColor,
  width = 120,
  stroke = 8,
  label,
  children,
}: {
  fraction: number | null;
  leftColor: string;
  rightColor: string;
  width?: number;
  stroke?: number;
  /** Accessible description of what the arc shows. */
  label: string;
  children?: ReactNode;
}) {
  const r = (width - stroke) / 2;
  const height = width / 2 + stroke / 2;
  const cy = width / 2;
  const d = `M ${stroke / 2} ${cy} A ${r} ${r} 0 0 1 ${width - stroke / 2} ${cy}`;
  const share = fraction === null || !Number.isFinite(fraction) ? null : Math.min(1, Math.max(0, fraction));
  const gap = share !== null && share > 0.02 && share < 0.98 ? 1.2 : 0;
  const left = share === null ? 0 : share * 100;

  return (
    <div className="relative shrink-0" style={{ width, height }}>
      <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={label}>
        <path d={d} fill="none" stroke="var(--color-line-strong)" strokeWidth={stroke} pathLength={100} />
        {share !== null ? (
          <>
            <path
              d={d}
              fill="none"
              stroke={rightColor}
              strokeWidth={stroke}
              pathLength={100}
              strokeDasharray={`${Math.max(0, 100 - left - gap)} 100`}
              strokeDashoffset={-(left + gap)}
            />
            <path
              d={d}
              fill="none"
              stroke={leftColor}
              strokeWidth={stroke}
              pathLength={100}
              strokeDasharray={`${Math.max(0, left - gap)} 100`}
            />
          </>
        ) : null}
      </svg>
      {children ? (
        <div className="absolute inset-x-0 bottom-0 flex flex-col items-center leading-tight">{children}</div>
      ) : null}
    </div>
  );
}
