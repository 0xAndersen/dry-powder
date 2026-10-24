import type { Hex } from "viem";
import { pythToQuote, type Quote } from "./oracle";

/** Pyth mode: live feed prices from Hermes and signed updates for transactions. */

export type FeedStatus = "connecting" | "live" | "polling" | "offline";

type HermesParsedPrice = {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
};

type HermesResponse = {
  binary?: { encoding?: string; data?: string[] };
  parsed?: HermesParsedPrice[] | null;
};

function idsQuery(ids: readonly Hex[]): string {
  return ids.map((id) => `ids[]=${id}`).join("&");
}

function authHeaders(apiKey: string): HeadersInit | undefined {
  return apiKey ? { Authorization: `Bearer ${apiKey}` } : undefined;
}

function quotesFrom(response: HermesResponse): Map<Hex, Quote> {
  const out = new Map<Hex, Quote>();
  for (const entry of response.parsed ?? []) {
    const id = `0x${entry.id.replace(/^0x/, "").toLowerCase()}` as Hex;
    try {
      const quote = pythToQuote(BigInt(entry.price.price), BigInt(entry.price.conf), entry.price.expo, entry.price.publish_time);
      if (quote) out.set(id, quote);
    } catch {
      // Malformed entry: skipped.
    }
  }
  return out;
}

export type FreshUpdate = {
  /** `bytes[] priceUpdate` argument for the engine. */
  updateData: Hex[];
  quotes: Map<Hex, Quote>;
};

/** Fetches the latest signed price update for `ids` from Hermes. */
export async function fetchLatestUpdate(
  hermesUrl: string,
  ids: readonly Hex[],
  apiKey: string,
  signal?: AbortSignal,
): Promise<FreshUpdate> {
  const url = `${hermesUrl}/v2/updates/price/latest?${idsQuery(ids)}&encoding=hex&parsed=true`;
  const res = await fetch(url, { signal, cache: "no-store", headers: authHeaders(apiKey) });
  if (res.status === 401 || res.status === 403) throw new Error("Pyth Hermes rejected the request: an API key is required");
  if (!res.ok) throw new Error(`Pyth Hermes returned HTTP ${res.status}`);
  const body = (await res.json()) as HermesResponse;
  const data = body.binary?.data ?? [];
  if (data.length === 0) throw new Error("Pyth Hermes returned no price update");
  return {
    updateData: data.map((d) => (d.startsWith("0x") ? (d as Hex) : (`0x${d}` as Hex))),
    quotes: quotesFrom(body),
  };
}

const NOTIFY_INTERVAL_MS = 250;
const STREAM_SILENCE_MS = 5_000;
const STREAM_DEAD_MS = 20_000;
const POLL_INTERVAL_MS = 1_500;

/**
 * Live Pyth prices per feed id. Without an API key it uses the Hermes SSE stream and falls back to
 * polling; with a key it polls only, because EventSource cannot send an Authorization header.
 */
export class HermesStore {
  private readonly hermesUrl: string;
  private readonly apiKey: string;
  private ids: Hex[] = [];
  private readonly listeners = new Set<() => void>();
  private visible = new Map<Hex, Quote>();
  private pending = new Map<Hex, Quote>();
  private status: FeedStatus = "connecting";
  private skew = 0;
  private maxPublishSeen = 0;
  private users = 0;
  private source: EventSource | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private watchdog: ReturnType<typeof setInterval> | null = null;
  private reconnectDelay = 1_000;
  private lastStreamAt = 0;
  private lastPollOkAt = 0;
  private streamOpenedAt = 0;
  private startedAt = 0;
  private polling = false;

  constructor(hermesUrl: string, apiKey: string) {
    this.hermesUrl = hermesUrl;
    this.apiKey = apiKey;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getQuotes = (): Map<Hex, Quote> => this.visible;
  getStatus = (): FeedStatus => this.status;

  /** Seconds since a price with `publishTime` was published, corrected for local clock error. */
  ageOf(publishTime: number, nowMs: number = Date.now()): number {
    return Math.max(0, nowMs / 1000 + this.skew - publishTime);
  }

  setFeeds(ids: readonly Hex[]): void {
    const next = [...new Set(ids.map((id) => id.toLowerCase() as Hex))].sort();
    if (next.join(",") === this.ids.join(",")) return;
    this.ids = next;
    if (this.users > 0) {
      this.connect();
      void this.poll();
    }
  }

  /** Feeds prices obtained elsewhere (for example right before a transaction) into the store. */
  ingest(quotes: Map<Hex, Quote>): void {
    const nowSec = Date.now() / 1000;
    for (const [id, quote] of quotes) {
      const current = this.pending.get(id);
      if (current && current.publishTime > quote.publishTime) continue;
      this.pending.set(id, quote);
      if (quote.publishTime > this.maxPublishSeen) {
        this.maxPublishSeen = quote.publishTime;
        this.skew = quote.publishTime - nowSec;
      }
    }
    this.scheduleNotify();
  }

  start(): void {
    this.users += 1;
    if (this.users > 1) return;
    this.startedAt = Date.now();
    this.connect();
    this.watchdog = setInterval(() => this.tick(), POLL_INTERVAL_MS);
    void this.poll();
  }

  stop(): void {
    this.users = Math.max(0, this.users - 1);
    if (this.users > 0) return;
    this.closeSource();
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.watchdog = null;
    this.reconnectTimer = null;
    this.notifyTimer = null;
  }

  private connect(): void {
    this.closeSource();
    if (this.apiKey || typeof EventSource === "undefined" || this.users === 0 || this.ids.length === 0) return;
    const url = `${this.hermesUrl}/v2/updates/price/stream?${idsQuery(this.ids)}&parsed=true&encoding=hex&allow_unordered=true`;
    let source: EventSource;
    try {
      source = new EventSource(url);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.source = source;
    this.streamOpenedAt = Date.now();
    source.onmessage = (event: MessageEvent<string>) => {
      let body: HermesResponse;
      try {
        body = JSON.parse(event.data) as HermesResponse;
      } catch {
        return;
      }
      const quotes = quotesFrom(body);
      if (quotes.size === 0) return;
      this.lastStreamAt = Date.now();
      this.reconnectDelay = 1_000;
      this.ingest(quotes);
      this.setStatus("live");
    };
    source.onerror = () => {
      // The browser retries by itself while CONNECTING; a CLOSED source needs a fresh one.
      if (source.readyState === EventSource.CLOSED && this.source === source) this.scheduleReconnect();
    };
  }

  private closeSource(): void {
    if (!this.source) return;
    this.source.onmessage = null;
    this.source.onerror = null;
    this.source.close();
    this.source = null;
  }

  private scheduleReconnect(): void {
    this.closeSource();
    if (this.reconnectTimer || this.users === 0) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, this.reconnectDelay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 15_000);
  }

  private tick(): void {
    const now = Date.now();
    if (now - this.lastStreamAt > STREAM_SILENCE_MS) {
      void this.poll();
      const reference = this.lastPollOkAt || this.startedAt || now;
      if (now - reference > 4 * POLL_INTERVAL_MS) this.setStatus("offline");
    }
    const streamSilentFor = now - Math.max(this.lastStreamAt, this.streamOpenedAt);
    if (this.source && streamSilentFor > STREAM_DEAD_MS && !this.reconnectTimer) this.scheduleReconnect();
  }

  private async poll(): Promise<void> {
    if (this.polling || this.users === 0 || this.ids.length === 0) return;
    this.polling = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
    try {
      const update = await fetchLatestUpdate(this.hermesUrl, this.ids, this.apiKey, controller.signal);
      this.lastPollOkAt = Date.now();
      this.ingest(update.quotes);
      if (Date.now() - this.lastStreamAt > STREAM_SILENCE_MS) this.setStatus(this.apiKey ? "live" : "polling");
    } catch {
      // Status is downgraded by the watchdog once polls have been failing for a while.
    } finally {
      clearTimeout(timeout);
      this.polling = false;
    }
  }

  private setStatus(status: FeedStatus): void {
    if (this.status === status) return;
    this.status = status;
    this.scheduleNotify();
  }

  private scheduleNotify(): void {
    if (this.notifyTimer) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.visible = new Map(this.pending);
      for (const listener of this.listeners) listener();
    }, NOTIFY_INTERVAL_MS);
  }
}
