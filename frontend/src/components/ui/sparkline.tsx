/** A price line with no axes: shape only. The dashed line is where the window started. */
export function Sparkline({
  values,
  width = 96,
  height = 28,
  tone,
  label,
  className,
}: {
  values: readonly number[] | null;
  width?: number;
  height?: number;
  /** Colour by direction; "flat" uses the muted text colour. */
  tone: "up" | "down" | "flat";
  label?: string;
  className?: string;
}) {
  if (!values || values.length < 2) {
    return <span className={`inline-block ${className ?? ""}`} style={{ width, height }} aria-hidden="true" />;
  }
  let min = Infinity;
  let max = -Infinity;
  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
  }
  const pad = 2;
  const span = max - min || Math.abs(max) * 1e-6 || 1;
  const x = (i: number) => pad + (i / (values.length - 1)) * (width - pad * 2);
  const y = (v: number) => pad + (1 - (v - min) / span) * (height - pad * 2);
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const colour = tone === "up" ? "var(--color-long)" : tone === "down" ? "var(--color-short)" : "var(--color-muted)";
  const base = y(values[0]!);
  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={className}
      role={label ? "img" : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
    >
      <line x1={pad} x2={width - pad} y1={base} y2={base} stroke="var(--color-line-strong)" strokeWidth={1} strokeDasharray="2 3" />
      <polyline points={points} fill="none" stroke={colour} strokeWidth={1.5} strokeLinejoin="round" strokeLinecap="round" />
    </svg>
  );
}
