"use client";

import { fmtUsdc } from "@/lib/format";

const DAY = 86_400;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const WEEKDAYS = ["Mon", "", "Wed", "", "Fri", "", ""];

/** Net PnL per UTC day as a grid of weeks (columns) by weekday (rows, Monday first), newest week on the right. */
export function PnlCalendar({ days, weeks = 13, unit, nowSeconds }: { days: Map<number, { net: bigint; trades: number }>; weeks?: number; unit: string; nowSeconds: number }) {
  const today = Math.floor(nowSeconds / DAY);
  // Unix day 4 (1970-01-05) was a Monday.
  const weekday = (d: number) => (((d - 4) % 7) + 7) % 7;
  const firstMonday = today - weekday(today) - (weeks - 1) * 7;
  let maxAbs = 0n;
  let green = 0;
  let red = 0;
  for (const [d, v] of days) {
    if (d < firstMonday || d > today) continue;
    const a = v.net < 0n ? -v.net : v.net;
    if (a > maxAbs) maxAbs = a;
    if (v.net > 0n) green += 1;
    else if (v.net < 0n) red += 1;
  }

  const columns: { start: number; month: string | null }[] = [];
  for (let w = 0; w < weeks; w += 1) {
    const start = firstMonday + w * 7;
    const date = new Date(start * DAY * 1000);
    const prev = w > 0 ? new Date((start - 7) * DAY * 1000) : null;
    columns.push({ start, month: !prev || prev.getUTCMonth() !== date.getUTCMonth() ? MONTHS[date.getUTCMonth()]! : null });
  }

  const cell = (d: number) => {
    if (d > today) return <span key={d} className="h-3 w-3" aria-hidden="true" />;
    const v = days.get(d);
    const label = `${new Date(d * DAY * 1000).toLocaleDateString("en-GB", { day: "2-digit", month: "short", timeZone: "UTC" })}: ${v ? `${fmtUsdc(v.net, 2, { sign: true })} ${unit}, ${v.trades} trade${v.trades === 1 ? "" : "s"}` : "no trades"}`;
    let background = "var(--color-raised)";
    if (v && v.net !== 0n && maxAbs > 0n) {
      const a = Number(((v.net < 0n ? -v.net : v.net) * 1000n) / maxAbs) / 1000;
      const strength = Math.round(30 + 70 * Math.sqrt(a));
      background = `color-mix(in srgb, var(${v.net > 0n ? "--color-long" : "--color-short"}) ${strength}%, var(--color-raised))`;
    } else if (v) {
      background = "var(--color-line-strong)";
    }
    return <span key={d} className="h-3 w-3 rounded-[2px]" style={{ background }} title={label} />;
  };

  return (
    <figure className="min-w-0">
      <div className="overflow-x-auto pb-1">
        <div className="inline-grid gap-[3px]" style={{ gridTemplateColumns: `1.75rem repeat(${weeks}, 0.75rem)` }} role="img" aria-label={`Daily net PnL over the last ${weeks} weeks: ${green} positive days, ${red} negative days.`}>
          <span aria-hidden="true" />
          {columns.map((c) => (
            <span key={c.start} className="h-3 overflow-visible whitespace-nowrap text-[0.625rem] leading-3 text-faint" aria-hidden="true">
              {c.month ?? ""}
            </span>
          ))}
          {WEEKDAYS.map((label, row) => (
            <Row key={row} label={label}>
              {columns.map((c) => cell(c.start + row))}
            </Row>
          ))}
        </div>
      </div>
      <figcaption className="mt-1.5 flex items-center gap-2 text-2xs text-faint">
        <span>
          {green} green, {red} red days
        </span>
        <span className="ml-auto flex items-center gap-1" aria-hidden="true">
          Loss
          <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: "var(--color-short)" }} />
          <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: "color-mix(in srgb, var(--color-short) 35%, var(--color-raised))" }} />
          <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: "var(--color-raised)" }} />
          <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: "color-mix(in srgb, var(--color-long) 35%, var(--color-raised))" }} />
          <span className="h-2.5 w-2.5 rounded-[2px]" style={{ background: "var(--color-long)" }} />
          Profit
        </span>
      </figcaption>
    </figure>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <>
      <span className="h-3 text-[0.625rem] leading-3 text-faint" aria-hidden="true">
        {label}
      </span>
      {children}
    </>
  );
}
