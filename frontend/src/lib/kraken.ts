/** Kraken public REST: tape prices and candles for display. Never used for execution. */

export type Ticker = { bid: number; ask: number; last: number };
export type Candle = { time: number; open: number; high: number; low: number; close: number; volume: number };

export const RESOLUTIONS = [
  { key: "1", label: "1m", minutes: 1 },
  { key: "5", label: "5m", minutes: 5 },
  { key: "15", label: "15m", minutes: 15 },
  { key: "60", label: "1h", minutes: 60 },
  { key: "240", label: "4h", minutes: 240 },
  { key: "1440", label: "1D", minutes: 1440 },
] as const;

export type Resolution = (typeof RESOLUTIONS)[number]["key"];

export function resolutionInfo(key: Resolution) {
  return RESOLUTIONS.find((r) => r.key === key) ?? RESOLUTIONS[2];
}

type KrakenResponse<T> = { error?: string[]; result?: Record<string, T> };

/** Kraken answers with its own pair names (`XXBTZUSD` for `XBTUSD`). Both spellings resolve to the request name. */
function aliases(pair: string): string[] {
  const out = [pair];
  if (pair.length === 6) {
    const a = pair.slice(0, 3);
    const b = pair.slice(3);
    for (const pa of ["X", "Z"]) for (const pb of ["X", "Z"]) out.push(`${pa}${a}${pb}${b}`);
  }
  return out;
}

function pick<T>(result: Record<string, T>, pair: string): T | undefined {
  for (const name of aliases(pair)) {
    const hit = result[name];
    if (hit !== undefined) return hit;
  }
  const lower = pair.toLowerCase();
  for (const [key, value] of Object.entries(result)) {
    if (key.toLowerCase() === lower) return value;
  }
  return undefined;
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<Record<string, T>> {
  const res = await fetch(url, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`Kraken returned HTTP ${res.status}`);
  const body = (await res.json()) as KrakenResponse<T>;
  if (body.error && body.error.length > 0) throw new Error(`Kraken: ${body.error.join(", ")}`);
  return body.result ?? {};
}

type RawTicker = { a?: string[]; b?: string[]; c?: string[] };

export async function fetchTickers(krakenUrl: string, pairs: readonly string[], signal?: AbortSignal): Promise<Map<string, Ticker>> {
  const out = new Map<string, Ticker>();
  if (pairs.length === 0) return out;
  const result = await getJson<RawTicker>(`${krakenUrl}/0/public/Ticker?pair=${pairs.join(",")}`, signal);
  for (const pair of pairs) {
    const raw = pick(result, pair);
    if (!raw) continue;
    const ask = Number(raw.a?.[0]);
    const bid = Number(raw.b?.[0]);
    const last = Number(raw.c?.[0]);
    if (ask > 0 && bid > 0) out.set(pair, { ask, bid, last: last > 0 ? last : (ask + bid) / 2 });
  }
  return out;
}

type RawCandle = [number, string, string, string, string, string, string, number];

export async function fetchOhlc(krakenUrl: string, pair: string, minutes: number, signal?: AbortSignal): Promise<Candle[]> {
  const result = await getJson<unknown>(`${krakenUrl}/0/public/OHLC?pair=${pair}&interval=${minutes}`, signal);
  const rows = pick(result, pair);
  if (!Array.isArray(rows)) return [];
  const out: Candle[] = [];
  for (const row of rows as RawCandle[]) {
    const time = Number(row[0]);
    const open = Number(row[1]);
    const high = Number(row[2]);
    const low = Number(row[3]);
    const close = Number(row[4]);
    const volume = Number(row[6]);
    if (!(time > 0 && open > 0 && high > 0 && low > 0 && close > 0)) continue;
    out.push({ time, open, high, low, close, volume: Number.isFinite(volume) ? volume : 0 });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Candles of a cross: bar-by-bar ratio of two series. High and low are bounded by what both bars allow. */
export function crossCandles(base: readonly Candle[], quote: readonly Candle[]): Candle[] {
  const byTime = new Map(quote.map((c) => [c.time, c]));
  const out: Candle[] = [];
  for (const b of base) {
    const q = byTime.get(b.time);
    if (!q) continue;
    const open = b.open / q.open;
    const close = b.close / q.close;
    const a = b.high / q.high;
    const c = b.low / q.low;
    out.push({
      time: b.time,
      open,
      close,
      high: Math.max(open, close, a, c),
      low: Math.min(open, close, a, c),
      volume: b.volume,
    });
  }
  return out;
}

/** Candles of the reciprocal price, which swaps the roles of high and low. */
export function invertCandles(candles: readonly Candle[]): Candle[] {
  return candles.map((c) => ({ time: c.time, open: 1 / c.open, high: 1 / c.low, low: 1 / c.high, close: 1 / c.close, volume: c.volume }));
}

export async function fetchInstrumentCandles(
  krakenUrl: string,
  source: { base: string; quote: string | null; invert: boolean },
  minutes: number,
  signal?: AbortSignal,
): Promise<Candle[]> {
  const [base, quote] = await Promise.all([
    fetchOhlc(krakenUrl, source.base, minutes, signal),
    source.quote ? fetchOhlc(krakenUrl, source.quote, minutes, signal) : Promise.resolve(null),
  ]);
  const series = quote ? crossCandles(base, quote) : base;
  return source.invert ? invertCandles(series) : series;
}

/** Tape quote of an instrument from raw tickers: optional cross, then optional inversion. */
export function composeTicker(base: Ticker | undefined, quote: Ticker | undefined | null, invert: boolean): Ticker | null {
  if (!base) return null;
  let { bid, ask, last } = base;
  if (quote !== null) {
    if (!quote) return null;
    bid = bid / quote.ask;
    ask = ask / quote.bid;
    last = last / quote.last;
  }
  if (invert) {
    const invertedBid = 1 / ask;
    ask = 1 / bid;
    bid = invertedBid;
    last = 1 / last;
  }
  if (!(bid > 0 && ask > 0 && last > 0)) return null;
  return { bid, ask, last };
}

export type TapeStatus = "connecting" | "live" | "offline";

const POLL_MS = 2_000;

/** Polls Kraken `Ticker` for every pair the listed markets need, in one request. */
export class KrakenStore {
  private readonly url: string;
  private pairs: string[] = [];
  private readonly listeners = new Set<() => void>();
  private tickers = new Map<string, Ticker>();
  private status: TapeStatus = "connecting";
  private timer: ReturnType<typeof setInterval> | null = null;
  private busy = false;
  private failures = 0;
  private users = 0;

  constructor(url: string) {
    this.url = url;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getTickers = (): Map<string, Ticker> => this.tickers;
  getStatus = (): TapeStatus => this.status;

  setPairs(pairs: readonly string[]): void {
    const next = [...new Set(pairs)].sort();
    if (next.join(",") === this.pairs.join(",")) return;
    this.pairs = next;
    void this.poll();
  }

  start(): void {
    this.users += 1;
    if (this.users > 1) return;
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    void this.poll();
  }

  stop(): void {
    this.users = Math.max(0, this.users - 1);
    if (this.users > 0) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private async poll(): Promise<void> {
    if (this.busy || this.pairs.length === 0 || this.users === 0) return;
    if (typeof document !== "undefined" && document.hidden) return;
    this.busy = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
    try {
      const next = await fetchTickers(this.url, this.pairs, controller.signal);
      if (next.size > 0) {
        this.tickers = next;
        this.failures = 0;
        this.status = "live";
        this.emit();
      }
    } catch {
      this.failures += 1;
      if (this.failures >= 3 && this.status !== "offline") {
        this.status = "offline";
        this.emit();
      }
    } finally {
      clearTimeout(timeout);
      this.busy = false;
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
