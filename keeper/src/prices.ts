import { HermesClient } from "@pythnetwork/hermes-client";
import type { Hex } from "viem";
import { describeError, log } from "./logger.js";
import type { PythPrice } from "./math.js";

/** If the stream has been silent this long it is torn down and reopened, and polling takes over meanwhile. */
const STREAM_SILENCE_MS = 5_000;
const POLL_INTERVAL_MS = 1_000;
const RECONNECT_MAX_DELAY_MS = 15_000;

interface ParsedUpdate {
  id: string;
  price: { price: string; conf: string; expo: number; publish_time: number };
}

interface UpdatePayload {
  binary?: { data?: string[] };
  parsed?: ParsedUpdate[] | null;
}

type Stream = Awaited<ReturnType<HermesClient["getPriceUpdatesStream"]>>;

const with0x = (hex: string): Hex => (hex.startsWith("0x") ? (hex as Hex) : `0x${hex}`);
const without0x = (hex: string): string => (hex.startsWith("0x") ? hex.slice(2) : hex);

/**
 * Live Pyth prices from Hermes.
 *
 * The SSE stream gives sub-second prices for deciding *when* to act. For the transaction itself the
 * keeper asks Hermes for a fresh signed update covering only the feeds it needs (`fetchUpdate`): that
 * keeps the on-chain Pyth fee and calldata minimal and guarantees the price is inside the contract's
 * staleness window when it lands.
 */
export class PriceFeed {
  private readonly client: HermesClient;
  private readonly ids: string[];
  private readonly latest = new Map<string, PythPrice>();
  private stream: Stream | undefined;
  private lastMessageAt = 0;
  private reconnectAttempts = 0;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private watchdog: NodeJS.Timeout | undefined;
  private polling = false;
  private stopped = false;

  constructor(hermesUrl: string, ids: readonly Hex[]) {
    this.client = new HermesClient(hermesUrl, { timeout: 5_000, httpRetries: 2 });
    this.ids = ids.map(without0x).map((id) => id.toLowerCase());
  }

  async start(): Promise<void> {
    // Prime the cache so the keeper can act before the first stream message arrives.
    await this.poll();
    void this.connect();
    this.watchdog = setInterval(() => void this.checkStream(), POLL_INTERVAL_MS);
  }

  stop(): void {
    this.stopped = true;
    if (this.watchdog) clearInterval(this.watchdog);
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.stream?.close();
    this.stream = undefined;
  }

  /** Latest known price of `id`, or undefined if none has been received yet. */
  get(id: Hex): PythPrice | undefined {
    return this.latest.get(without0x(id).toLowerCase());
  }

  /** Milliseconds since anything was last heard from Hermes. */
  silenceMs(): number {
    return Date.now() - this.lastMessageAt;
  }

  /**
   * Fetches a fresh signed update for exactly `ids`, ready to pass as `priceUpdate` to the engine.
   * Also refreshes the cache with the prices it contains.
   */
  async fetchUpdate(ids: readonly Hex[]): Promise<Hex[]> {
    const payload = (await this.client.getLatestPriceUpdates(ids.map(without0x), {
      encoding: "hex",
      parsed: true,
    })) as UpdatePayload;
    this.ingest(payload);
    const data = payload.binary?.data ?? [];
    if (data.length === 0) throw new Error("Hermes returned no update data");
    return data.map(with0x);
  }

  private async connect(): Promise<void> {
    if (this.stopped) return;
    try {
      const stream = await this.client.getPriceUpdatesStream(this.ids, { encoding: "hex", parsed: true });
      this.stream = stream;
      stream.onopen = () => {
        this.reconnectAttempts = 0;
        log.info("hermes stream connected");
      };
      stream.onmessage = (event: MessageEvent) => {
        try {
          this.ingest(JSON.parse(String(event.data)) as UpdatePayload);
        } catch (err) {
          log.warn("hermes stream: unreadable message", { error: describeError(err) });
        }
      };
      stream.onerror = () => {
        // Hand reconnection to our own backoff rather than the library's, so it is bounded and logged.
        if (this.stream !== stream) return;
        log.warn("hermes stream error; reconnecting");
        this.scheduleReconnect();
      };
    } catch (err) {
      log.warn("hermes stream: could not connect", { error: describeError(err) });
      this.scheduleReconnect();
    }
  }

  private scheduleReconnect(): void {
    this.stream?.close();
    this.stream = undefined;
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(RECONNECT_MAX_DELAY_MS, 500 * 2 ** this.reconnectAttempts++);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.connect();
    }, delay);
  }

  /** While the stream is quiet, keep prices flowing by polling, and reopen a stream that has gone dead. */
  private async checkStream(): Promise<void> {
    if (this.stopped || this.silenceMs() < STREAM_SILENCE_MS) return;
    if (this.stream) {
      log.warn("hermes stream silent; reopening", { silenceMs: this.silenceMs() });
      this.scheduleReconnect();
    }
    await this.poll();
  }

  private async poll(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      const payload = (await this.client.getLatestPriceUpdates(this.ids, {
        encoding: "hex",
        parsed: true,
      })) as UpdatePayload;
      this.ingest(payload);
    } catch (err) {
      log.warn("hermes poll failed", { error: describeError(err) });
    } finally {
      this.polling = false;
    }
  }

  private ingest(payload: UpdatePayload): void {
    for (const entry of payload.parsed ?? []) {
      const id = without0x(entry.id).toLowerCase();
      const previous = this.latest.get(id);
      if (previous && previous.publishTime > entry.price.publish_time) continue;
      this.latest.set(id, {
        price: BigInt(entry.price.price),
        conf: BigInt(entry.price.conf),
        expo: entry.price.expo,
        publishTime: entry.price.publish_time,
      });
    }
    // A closed market (FX at the weekend) still answers polls, with an old publish time. Only count the
    // message as a sign of life for the stream watchdog; staleness is judged per feed by the keeper.
    this.lastMessageAt = Date.now();
  }
}
