import type { Hex } from "viem";
import { MARKETS, marketById, type MarketInfo } from "./markets";
import { ceilDiv } from "./math";

/** A price as the engine would see it: 18-decimal mid and the confidence band it executes against. */
export type PriceTick = {
  id: Hex;
  mid: bigint;
  /** Sells fill here (price − conf). */
  bid: bigint;
  /** Buys fill here (price + conf). */
  ask: bigint;
  /** Mid as a float, for charts only. */
  midNum: number;
  publishTime: number;
};

export type FeedStatus = "connecting" | "live" | "polling" | "offline";

type HermesParsedPrice = {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
};

type HermesResponse = {
  binary?: { encoding?: string; data?: string[] };
  parsed?: HermesParsedPrice[] | null;
};

const ONE_E36 = 10n ** 36n;

/**
 * Normalises a Pyth price to 18 decimals exactly as `PerpEngine._peekPrice` does, including the
 * reciprocal for inverted markets. Returns null for prices the engine would reject as invalid.
 */
export function toTick(parsed: HermesParsedPrice, market: MarketInfo): PriceTick | null {
  let raw: bigint;
  let conf: bigint;
  try {
    raw = BigInt(parsed.price.price);
    conf = BigInt(parsed.price.conf);
  } catch {
    return null;
  }
  const expo = parsed.price.expo;
  if (raw <= 0n || !Number.isInteger(expo) || expo > 0 || expo < -18 || conf < 0n || conf >= raw) return null;

  const scale = 10n ** BigInt(18 + expo);
  let mid = raw * scale;
  let bid = (raw - conf) * scale;
  let ask = (raw + conf) * scale;
  if (market.invert) {
    const invertedBid = ONE_E36 / ask;
    const invertedAsk = ceilDiv(ONE_E36, bid);
    bid = invertedBid;
    ask = invertedAsk;
    mid = ONE_E36 / mid;
    if (bid === 0n) return null;
  }
  return {
    id: market.id,
    mid,
    bid,
    ask,
    midNum: Number(mid) / 1e18,
    publishTime: parsed.price.publish_time,
  };
}

function idsQuery(ids: readonly Hex[]): string {
  return ids.map((id) => `ids[]=${id}`).join("&");
}

function ticksFrom(response: HermesResponse): PriceTick[] {
  const out: PriceTick[] = [];
  for (const entry of response.parsed ?? []) {
    const market = marketById(`0x${entry.id.replace(/^0x/, "")}`);
    if (!market) continue;
    const tick = toTick(entry, market);
    if (tick) out.push(tick);
  }
  return out;
}

export type FreshUpdate = {
  /** `bytes[] priceUpdate` argument for the engine. */
  updateData: Hex[];
  ticks: PriceTick[];
};

/** Fetches the latest signed price update for `ids` from Hermes. */
export async function fetchLatestUpdate(
  hermesUrl: string,
  ids: readonly Hex[],
  signal?: AbortSignal,
): Promise<FreshUpdate> {
  const url = `${hermesUrl}/v2/updates/price/latest?${idsQuery(ids)}&encoding=hex&parsed=true`;
  const res = await fetch(url, { signal, cache: "no-store" });
  if (!res.ok) throw new Error(`Pyth Hermes returned HTTP ${res.status}`);
  const body = (await res.json()) as HermesResponse;
  const data = body.binary?.data ?? [];
  if (data.length === 0) throw new Error("Pyth Hermes returned no price update");
  return {
    updateData: data.map((d) => (d.startsWith("0x") ? (d as Hex) : (`0x${d}` as Hex))),
    ticks: ticksFrom(body),
  };
}

const NOTIFY_INTERVAL_MS = 250;
const STREAM_SILENCE_MS = 5_000;
const STREAM_DEAD_MS = 20_000;
const POLL_INTERVAL_MS = 2_000;

/**
 * Live prices for every listed market: Hermes SSE stream with automatic reconnect, falling back to
 * polling `latest` whenever the stream has been silent for a few seconds.
 */
export class PriceStore {
  private readonly hermesUrl: string;
  private readonly ids: readonly Hex[] = MARKETS.map((m) => m.id);
  private readonly listeners = new Set<() => void>();
  private visible = new Map<Hex, PriceTick>();
  private pending = new Map<Hex, PriceTick>();
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
  private polling = false;

  constructor(hermesUrl: string) {
    this.hermesUrl = hermesUrl;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getTick = (id: Hex): PriceTick | undefined => this.visible.get(id);
  getStatus = (): FeedStatus => this.status;

  /** Seconds since `tick` was published, corrected for the difference between local and oracle clocks. */
  ageOf(tick: PriceTick, nowMs: number = Date.now()): number {
    return Math.max(0, nowMs / 1000 + this.skew - tick.publishTime);
  }

  /** Feeds a price obtained elsewhere (for example right before a transaction) into the store. */
  ingest(ticks: readonly PriceTick[]): void {
    const nowSec = Date.now() / 1000;
    for (const tick of ticks) {
      const current = this.pending.get(tick.id);
      if (current && current.publishTime > tick.publishTime) continue;
      this.pending.set(tick.id, tick);
      if (tick.publishTime > this.maxPublishSeen) {
        this.maxPublishSeen = tick.publishTime;
        this.skew = tick.publishTime - nowSec;
      }
    }
    this.scheduleNotify();
  }

  start(): void {
    this.users += 1;
    if (this.users > 1) return;
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
    if (typeof EventSource === "undefined" || this.users === 0) return;
    this.closeSource();
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
      const ticks = ticksFrom(body);
      if (ticks.length === 0) return;
      this.lastStreamAt = Date.now();
      this.reconnectDelay = 1_000;
      this.ingest(ticks);
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
    const streamSilentFor = now - Math.max(this.lastStreamAt, this.streamOpenedAt);
    if (now - this.lastStreamAt > STREAM_SILENCE_MS) {
      void this.poll();
      if (now - this.lastPollOkAt > 3 * POLL_INTERVAL_MS && this.lastPollOkAt !== 0) this.setStatus("offline");
      if (this.lastPollOkAt === 0 && now - this.streamOpenedAt > 3 * POLL_INTERVAL_MS) this.setStatus("offline");
    }
    // A stream that is nominally open but silent is replaced.
    if (this.source && streamSilentFor > STREAM_DEAD_MS && !this.reconnectTimer) this.scheduleReconnect();
  }

  private async poll(): Promise<void> {
    if (this.polling || this.users === 0) return;
    this.polling = true;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 4_000);
    try {
      const update = await fetchLatestUpdate(this.hermesUrl, this.ids, controller.signal);
      this.lastPollOkAt = Date.now();
      this.ingest(update.ticks);
      if (Date.now() - this.lastStreamAt > STREAM_SILENCE_MS) this.setStatus("polling");
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
