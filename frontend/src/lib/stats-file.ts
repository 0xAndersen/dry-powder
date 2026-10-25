import { IS_STATIC_BUILD, type RuntimeConfig } from "./config";
import { staticBaseUrl } from "./nav";
import {
  bucket,
  marketTotals,
  sideTotals,
  totals,
  traderRecord,
  type Bucket,
  type OpenPosition,
  type SideTotals,
  type StatsState,
} from "./aggregate";

/**
 * The indexer's snapshot (keeper/src/indexer.mjs), published next to the keeper's health on the repository's
 * `status` branch. A deployment can point elsewhere with `statsUrl` in config.json (or STATS_URL): an absolute
 * URL, or a path relative to the app root, where config.json lives.
 */
const DEFAULT_STATS_URLS: Record<number, string> = {
  5042002: "https://raw.githubusercontent.com/0xAndersen/dry-powder/status/status/stats.json",
};

export function statsUrlFor(cfg: RuntimeConfig): string | null {
  const raw = cfg.statsUrl ?? DEFAULT_STATS_URLS[cfg.chainId] ?? null;
  if (!raw) return null;
  if (/^https?:\/\//i.test(raw)) return raw;
  if (typeof window === "undefined") return null;
  const base = IS_STATIC_BUILD ? staticBaseUrl(window.location) : `${window.location.origin}/`;
  return new URL(raw.replace(/^\.\//, ""), base).toString();
}

export type StatsFileResult =
  | { status: "ready"; state: StatsState; history: MarketHistory }
  | { status: "missing" }
  | { status: "mismatch"; engine: string; chainId: number }
  | { status: "error"; error: string };

// ─────────────────────────────── Market history ───────────────────────────────

/** One sample of a market's funding and open interest (stats.json `marketHistory`, keeper/src/indexer.mjs). */
export type HistoryPoint = {
  /** Unix seconds at the start of the hour (hourly series) or of the 5 minutes (fine series). */
  time: number;
  /** Funding, annualised, in basis points; positive: longs pay shorts. */
  fundingBps: number;
  /** Long and short open interest, whole USDC. */
  longOi: number;
  shortOi: number;
  /** Oracle mid, or null when the market had no usable price. */
  mid: number | null;
};

/** Hourly points for 30 days and 5-minute points for the last 24 hours, by lower-case market id. */
export type MarketHistory = { sampledAt: number; hourly: Record<string, HistoryPoint[]>; fine: Record<string, HistoryPoint[]> };

export const HISTORY_HOUR_SECONDS = 3_600;
export const HISTORY_FINE_SECONDS = 300;

export function emptyMarketHistory(): MarketHistory {
  return { sampledAt: 0, hourly: {}, fine: {} };
}

const finiteOrNull = (v: unknown): v is number | null => v === null || (typeof v === "number" && Number.isFinite(v));

/** Reads `marketHistory` (points `[i, f, l, s, p]`). Optional: a file without it, or with bad points, still loads. */
export function parseMarketHistory(raw: unknown): MarketHistory {
  const out = emptyMarketHistory();
  if (!raw || typeof raw !== "object") return out;
  const r = raw as Raw;
  if (r.v !== 1) return out;
  out.sampledAt = Number(r.sampledAt) || 0;
  for (const [name, seconds] of [
    ["hourly", HISTORY_HOUR_SECONDS],
    ["fine", HISTORY_FINE_SECONDS],
  ] as const) {
    const series = r[name];
    if (!series || typeof series !== "object") continue;
    for (const [id, list] of Object.entries(series as Raw)) {
      if (!Array.isArray(list)) continue;
      const points: HistoryPoint[] = [];
      for (const p of list) {
        if (!Array.isArray(p) || p.length !== 5) continue;
        const [i, f, l, s, mid] = p as unknown[];
        if (!Number.isInteger(i) || typeof f !== "number" || typeof l !== "number" || typeof s !== "number" || !finiteOrNull(mid)) continue;
        if (!Number.isFinite(f) || !Number.isFinite(l) || !Number.isFinite(s)) continue;
        points.push({ time: (i as number) * seconds, fundingBps: f, longOi: l, shortOi: s, mid: mid as number | null });
      }
      if (points.length > 0) out[name][id.toLowerCase()] = points.sort((a, b) => a.time - b.time);
    }
  }
  return out;
}

type Raw = Record<string, unknown>;

function shaped<T extends object>(template: T, raw: unknown): T {
  const out = { ...template } as Record<string, unknown>;
  if (!raw || typeof raw !== "object") return out as T;
  const r = raw as Raw;
  for (const [k, v] of Object.entries(template)) {
    const value = r[k];
    if (value === undefined || value === null) continue;
    try {
      if (typeof v === "bigint") out[k] = BigInt(value as string);
      else if (typeof v === "number") out[k] = Number(value) || 0;
      else if (typeof v === "string") out[k] = String(value);
      else if (typeof v === "boolean") out[k] = Boolean(value);
    } catch {
      // A malformed number keeps the default rather than failing the whole file.
    }
  }
  return out as T;
}

const nullableBig = (v: unknown): bigint | null => {
  if (v === null || v === undefined) return null;
  try {
    return BigInt(v as string);
  } catch {
    return null;
  }
};

const buckets = (list: unknown): Bucket[] => (Array.isArray(list) ? list.map((b) => shaped(bucket(0), b)).sort((a, b) => a.i - b.i) : []);

const OPEN: OpenPosition = { trader: "", market: "", long: false, size: 0n, margin: 0n, entry: 0n, fees: 0n, realised: 0n, openTime: 0, openBlock: 0 };

/** Validates and revives a parsed stats.json for this deployment. */
export function parseStatsFile(json: unknown, cfg: Pick<RuntimeConfig, "chainId" | "perpEngine">): StatsFileResult {
  if (!json || typeof json !== "object") return { status: "error", error: "not a JSON object" };
  const j = json as Raw;
  if (j.schema !== 1) return { status: "error", error: `unknown stats schema ${String(j.schema)}` };
  const engine = String(j.engine ?? "").toLowerCase();
  const chainId = Number(j.chainId);
  if (engine !== cfg.perpEngine.toLowerCase() || chainId !== cfg.chainId) return { status: "mismatch", engine, chainId };

  const state: StatsState = {
    schema: 1,
    chainId,
    engine,
    deployBlock: Number(j.deployBlock) || 0,
    deployTime: Number(j.deployTime) || 0,
    cursorBlock: Number(j.cursorBlock),
    cursorTime: Number(j.cursorTime) || 0,
    updatedAt: typeof j.updatedAt === "string" ? j.updatedAt : null,
    maxProfitMultiple: nullableBig(j.maxProfitMultiple) ?? 10n,
    events: Number(j.events) || 0,
    venue: shaped(totals(), j.venue),
    days: buckets(j.days),
    markets: {},
    traders: {},
    open: {},
  };
  if (!Number.isFinite(state.cursorBlock)) return { status: "error", error: "no cursor block" };
  for (const [id, m] of Object.entries((j.markets as Raw) ?? {})) {
    const market = shaped(marketTotals(), m);
    market.hours = buckets((m as Raw | null)?.hours);
    state.markets[id.toLowerCase()] = market;
  }
  for (const [id, t] of Object.entries((j.traders as Raw) ?? {})) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(id) || !t || typeof t !== "object") continue;
    const raw = t as Raw;
    const trader = shaped(traderRecord(), raw);
    trader.best = nullableBig(raw.best);
    trader.worst = nullableBig(raw.worst);
    trader.long = shaped(sideTotals(), raw.long);
    trader.short = shaped(sideTotals(), raw.short);
    trader.markets = {};
    for (const [mid, s] of Object.entries((raw.markets as Raw) ?? {})) trader.markets[mid.toLowerCase()] = shaped<SideTotals>(sideTotals(), s);
    trader.days = buckets(raw.days);
    trader.hours = buckets(raw.hours);
    state.traders[id.toLowerCase()] = trader;
  }
  for (const [key, p] of Object.entries((j.open as Raw) ?? {})) state.open[key.toLowerCase()] = shaped(OPEN, p);
  return { status: "ready", state, history: parseMarketHistory(j.marketHistory) };
}

export async function fetchStatsFile(url: string, cfg: Pick<RuntimeConfig, "chainId" | "perpEngine">, signal?: AbortSignal): Promise<StatsFileResult> {
  // The raw file host caches for minutes; a per-minute query string keeps reads at most a minute behind it.
  const sep = url.includes("?") ? "&" : "?";
  let res: Response;
  try {
    res = await fetch(`${url}${sep}t=${Math.floor(Date.now() / 60_000)}`, { cache: "no-store", signal });
  } catch (error) {
    if (signal?.aborted) throw error;
    return { status: "error", error: "the stats file could not be reached" };
  }
  if (res.status === 404) return { status: "missing" };
  if (!res.ok) return { status: "error", error: `HTTP ${res.status}` };
  try {
    return parseStatsFile(await res.json(), cfg);
  } catch {
    return { status: "error", error: "the stats file is not valid JSON" };
  }
}
