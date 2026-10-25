import { assetName } from "./feeds";
import type { Instrument } from "./instruments";

/** Simple mode groups markets the way people talk about them. */
export type SimpleCategory = "crypto" | "currencies" | "metals" | "pairs" | "futures";

export const SIMPLE_CATEGORIES: readonly { key: SimpleCategory | "all"; label: string }[] = [
  { key: "all", label: "Everything" },
  { key: "crypto", label: "Crypto" },
  { key: "currencies", label: "Currencies" },
  { key: "metals", label: "Gold" },
  { key: "pairs", label: "Pairs" },
  { key: "futures", label: "Futures" },
];

export function simpleCategory(i: Instrument): SimpleCategory {
  if (i.kind === "dated") return "futures";
  if (i.kind === "cross") return "pairs";
  if (i.feed?.class === "metal") return "metals";
  if (i.kind === "fx" || i.feed?.class === "fx") return "currencies";
  return "crypto";
}

const SHORT_DATE = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", timeZone: "UTC" });

/** What the market is, in words: "Bitcoin", "Japanese yen", "Ether in bitcoin", "Bitcoin, 30 Oct". */
export function simpleName(i: Instrument): string {
  if (i.expiry !== 0) return `${assetName(i.base)}, ${SHORT_DATE.format(new Date(i.expiry * 1000))}`;
  if (i.kind === "cross") return `${assetName(i.base)} in ${assetName(i.quote).toLowerCase()}`;
  if (i.feed?.class === "metal") return i.feed.name.replace(/ \(.*\)$/, "");
  return assetName(i.base);
}

/** The subject of a sentence about the price: "Bitcoin", "the yen", "gold". */
export function simpleSubject(i: Instrument): string {
  const name = simpleName(i);
  if (i.feed?.class === "metal") return name.toLowerCase();
  if (i.feed?.class === "fx" || i.kind === "fx") return `the ${assetName(i.base).replace(/^Japanese /, "").toLowerCase()}`;
  return name;
}

/** Leverage presets for a market whose maximum is `max`: five steps, the last one the maximum. */
export function leverageSteps(max: number): number[] {
  const ladder = [2, 5, 10, 25, 50, 100, 200, 500, 1000, 2000, 5000];
  const below = ladder.filter((x) => x < max);
  if (below.length <= 4) return [...below, max];
  // Spread four picks across what is below the maximum, always keeping the low end.
  const picks = [below[0]!];
  for (let k = 1; k < 4; k += 1) picks.push(below[Math.round((k * (below.length - 1)) / 3)]!);
  return [...new Set([...picks, max])];
}

/** Amount presets in whole collateral units. */
export const AMOUNT_STEPS = [10, 25, 50, 100, 250] as const;

/** "0.9%" for small moves, "12%" for big ones. */
export function movePct(fraction: number): string {
  const pct = fraction * 100;
  if (pct >= 10) return `${pct.toFixed(0)}%`;
  if (pct >= 1) return `${pct.toFixed(1)}%`;
  if (pct >= 0.1) return `${pct.toFixed(2)}%`;
  return `${pct.toFixed(3)}%`;
}
