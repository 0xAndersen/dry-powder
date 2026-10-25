"use client";

import { useMemo } from "react";
import { AppLink } from "@/components/app-link";
import { useLocalStore } from "@/hooks/use-local-store";
import { useMediaQuery } from "@/hooks/use-media-query";
import { useChainNow, useMarketData } from "@/hooks/use-market-data";
import { findBySlug, groupInstruments, marketSlug, type Instrument } from "@/lib/instruments";
import { RESOLUTIONS, type Resolution } from "@/lib/kraken";
import { createLocalStore } from "@/lib/storage";
import { WallChart } from "./wall-chart";

export const WALL_LAYOUTS = [1, 2, 4, 6] as const;
export type WallLayout = (typeof WALL_LAYOUTS)[number];
export const WALL_CELLS = 6;

export type WallCell = { market: string | null; resolution: Resolution };
export type WallState = { layout: WallLayout; cells: WallCell[] };

const DEFAULT_RESOLUTIONS: Resolution[] = ["15", "15", "15", "60", "60", "60"];
const isResolution = (v: unknown): v is Resolution => RESOLUTIONS.some((r) => r.key === v);

/** The wall's layout and each chart's market and interval, remembered in this browser. */
export const wallStore = createLocalStore<WallState>(
  "dp:chart-wall:v1",
  { layout: 4, cells: DEFAULT_RESOLUTIONS.map((resolution) => ({ market: null, resolution })) },
  (raw) => {
    if (!raw || typeof raw !== "object") return null;
    const r = raw as Partial<WallState>;
    const layout = WALL_LAYOUTS.includes(r.layout as WallLayout) ? (r.layout as WallLayout) : 4;
    const cells = Array.from({ length: WALL_CELLS }, (_, k) => {
      const c = Array.isArray(r.cells) ? (r.cells[k] as Partial<WallCell> | undefined) : undefined;
      return {
        market: typeof c?.market === "string" && c.market.length <= 40 ? c.market : null,
        resolution: isResolution(c?.resolution) ? c.resolution : DEFAULT_RESOLUTIONS[k]!,
      };
    });
    return { layout, cells };
  },
);

/** Rows the layout takes at the current width: phones stack every chart. */
function rowsFor(layout: WallLayout, wide: boolean, xl: boolean): number {
  if (!wide) return layout;
  if (layout === 1 || layout === 2) return 1;
  if (layout === 4) return 2;
  return xl ? 2 : 3;
}

/**
 * Several charts side by side for wide screens: 1, 2, 4 or 6, each with its own market and interval, kept in this
 * browser; stacked one under another on phones.
 */
export function ChartWall() {
  const { instruments, prices, loading, error } = useMarketData();
  const chainNow = useChainNow(1_000);
  const [wall, setWall] = useLocalStore(wallStore);
  const wide = useMediaQuery("(min-width: 768px)");
  const xl = useMediaQuery("(min-width: 1280px)");

  const ordered = useMemo(() => groupInstruments(instruments).flatMap((g) => g.items), [instruments]);
  // A cell without a stored market (or one this deployment does not list) shows the market at its position.
  const cellInstrument = (k: number): Instrument | undefined => findBySlug(ordered, wall.cells[k]?.market) ?? ordered[k % Math.max(1, ordered.length)];

  const setCell = (k: number, patch: Partial<WallCell>) =>
    setWall((s) => ({ ...s, cells: s.cells.map((c, j) => (j === k ? { ...c, ...patch } : c)) }));

  const rows = rowsFor(wall.layout, wide, xl);
  const height = wide ? `max(260px, calc((100dvh - 10.5rem) / ${rows}))` : "320px";
  const cols = wall.layout === 1 ? "grid-cols-1" : wall.layout === 6 ? "grid-cols-1 md:grid-cols-2 xl:grid-cols-3" : "grid-cols-1 md:grid-cols-2";

  return (
    <div className="flex flex-col gap-2" data-testid="chart-wall">
      <div className="flex flex-wrap items-end justify-between gap-3 px-1 pt-2">
        <div>
          <h1 className="wide text-xl font-semibold leading-tight sm:text-2xl">Charts</h1>
          <p className="mt-1 text-[0.8125rem] text-muted">Up to six charts side by side. Each keeps its own market and interval in this browser.</p>
        </div>
        <div className="flex items-center gap-2">
          <div className="flex gap-1" role="group" aria-label="Charts on the wall">
            {WALL_LAYOUTS.map((n) => (
              <button
                key={n}
                type="button"
                className="chip"
                aria-pressed={wall.layout === n}
                onClick={() => setWall((s) => ({ ...s, layout: n }))}
                title={`${n} chart${n === 1 ? "" : "s"}`}
                data-testid={`wall-layout-${n}`}
              >
                {n}
              </button>
            ))}
          </div>
          <AppLink route="markets" className="btn btn-sm btn-ghost">
            Markets
          </AppLink>
        </div>
      </div>

      {ordered.length === 0 ? (
        <section className="panel px-4 py-14 text-center text-muted">{loading ? "Loading markets…" : error ? "Markets unavailable: the RPC did not answer. Retrying." : "No markets listed."}</section>
      ) : (
        <div className={`grid gap-2 ${cols}`}>
          {Array.from({ length: wall.layout }, (_, k) => {
            const instrument = cellInstrument(k);
            if (!instrument) return null;
            return (
              <div key={k} className="min-w-0" style={{ height }}>
                <WallChart
                  index={k}
                  instrument={instrument}
                  instruments={ordered}
                  price={prices.get(instrument.id)}
                  resolution={wall.cells[k]?.resolution ?? "15"}
                  chainNow={chainNow}
                  onMarket={(slug) => setCell(k, { market: slug })}
                  onResolution={(resolution) => setCell(k, { resolution, market: wall.cells[k]?.market ?? marketSlug(instrument) })}
                />
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
