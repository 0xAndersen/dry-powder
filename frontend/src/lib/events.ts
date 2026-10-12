import { encodeEventTopics, numberToHex, pad, parseEventLogs, type Address, type Hex, type PublicClient, type RpcLog } from "viem";
import { perpEngineAbi } from "./abi";

/** Engine event log reader: bounded-range `eth_getLogs` back-fill plus a live tail. */

type Common = {
  /** `${block}-${logIndex}`; unique and sortable within a feed. */
  id: string;
  block: number;
  logIndex: number;
  tx: Hex;
  /** Unix seconds, interpolated from sampled block timestamps unless the feed fetches exact times. */
  time: number;
};

export type OpenEvent = Common & {
  type: "open";
  key: Hex;
  trader: Address;
  marketId: Hex;
  isLong: boolean;
  margin: bigint;
  size: bigint;
  price: bigint;
  fee: bigint;
  /** Set when a keeper executed an order in the same transaction. */
  orderId?: bigint;
};

export type CloseEvent = Common & {
  type: "close";
  key: Hex;
  trader: Address;
  marketId: Hex;
  price: bigint;
  /** Price PnL minus funding, after the profit cap, before the close fee. */
  pnl: bigint;
  fee: bigint;
  payout: bigint;
  orderId?: bigint;
};

export type LiquidationEvent = Common & {
  type: "liquidation";
  key: Hex;
  trader: Address;
  liquidator: Address;
  marketId: Hex;
  price: bigint;
  margin: bigint;
  liquidatorFee: bigint;
  toVault: bigint;
};

export type OrderCreatedEvent = Common & {
  type: "orderCreated";
  orderId: bigint;
  trader: Address;
  marketId: Hex;
  /** 0 limit open, 1 take-profit, 2 stop-loss, 3 close. */
  orderType: number;
  isLong: boolean;
  triggerPrice: bigint;
  margin: bigint;
  size: bigint;
};

export type OrderCancelledEvent = Common & { type: "orderCancelled"; orderId: bigint; trader: Address };
export type OrderExecutedEvent = Common & { type: "orderExecuted"; orderId: bigint; trader: Address; keeper: Address; price: bigint };
export type MarketSettledEvent = Common & { type: "marketSettled"; marketId: Hex; price: bigint };

export type EngineEvent =
  | OpenEvent
  | CloseEvent
  | LiquidationEvent
  | OrderCreatedEvent
  | OrderCancelledEvent
  | OrderExecutedEvent
  | MarketSettledEvent;

const TRADER_EVENTS = [
  "PositionOpened",
  "PositionClosed",
  "PositionLiquidated",
  "OrderCreated",
  "OrderCancelled",
  "OrderExecuted",
] as const;
const ALL_EVENTS = [...TRADER_EVENTS, "MarketSettled"] as const;

function topic0(eventName: (typeof ALL_EVENTS)[number]): Hex {
  return encodeEventTopics({ abi: perpEngineAbi, eventName })[0]!;
}

/** Largest block span requested in one `eth_getLogs` call. */
export const MAX_BLOCK_RANGE = 2_000;

/** Maps block numbers to timestamps from a handful of sampled blocks. */
class BlockClock {
  private anchors: { block: number; time: number }[] = [];
  secPerBlock = 1;

  add(block: number, time: number): void {
    const anchors = this.anchors;
    let i = anchors.length;
    while (i > 0 && anchors[i - 1]!.block > block) i -= 1;
    if (i > 0 && anchors[i - 1]!.block === block) return;
    anchors.splice(i, 0, { block, time });
    if (anchors.length > 600) anchors.splice(1, 1);
  }

  timeOf(block: number): number {
    const anchors = this.anchors;
    if (anchors.length === 0) return Date.now() / 1000;
    let lo = 0;
    let hi = anchors.length - 1;
    if (block <= anchors[0]!.block) return anchors[0]!.time - (anchors[0]!.block - block) * this.secPerBlock;
    if (block >= anchors[hi]!.block) return anchors[hi]!.time + (block - anchors[hi]!.block) * this.secPerBlock;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (anchors[mid]!.block <= block) lo = mid;
      else hi = mid;
    }
    const a = anchors[lo]!;
    const b = anchors[hi]!;
    if (a.block === block) return a.time;
    return a.time + ((block - a.block) / (b.block - a.block)) * (b.time - a.time);
  }
}

export type LogFeedStatus = {
  phase: "starting" | "backfilling" | "live" | "error";
  error: string | null;
  headBlock: number;
  /** Oldest block covered so far. */
  loadedFrom: number;
  /** Unix seconds of `loadedFrom`. */
  loadedFromTime: number;
  secPerBlock: number;
  /** Back-fill requests still outstanding. */
  pending: number;
};

export type LogFeedSnapshot = { events: EngineEvent[]; status: LogFeedStatus; version: number };

export type LogFeedOptions = {
  client: PublicClient;
  engine: Address;
  /** Only events of this trader (uses the indexed topic, so the RPC filters). */
  trader?: Address;
  lookbackSeconds: number;
  pollMs: number;
  maxEvents: number;
  /** Fetch the real timestamp of every block that holds an event (for account history). */
  exactTimes?: boolean;
};

const INITIAL_STATUS: LogFeedStatus = {
  phase: "starting",
  error: null,
  headBlock: 0,
  loadedFrom: 0,
  loadedFromTime: 0,
  secPerBlock: 1,
  pending: 0,
};

export const EMPTY_FEED: LogFeedSnapshot = { events: [], status: INITIAL_STATUS, version: 0 };

export class LogFeed {
  private readonly opts: LogFeedOptions;
  private readonly clock = new BlockClock();
  private readonly listeners = new Set<() => void>();
  private readonly seen = new Set<string>();
  private events: EngineEvent[] = [];
  private status: LogFeedStatus = INITIAL_STATUS;
  private snapshot: LogFeedSnapshot = EMPTY_FEED;
  private version = 0;
  private lastBlock = -1;
  private timer: ReturnType<typeof setInterval> | null = null;
  private notifyTimer: ReturnType<typeof setTimeout> | null = null;
  private polling = false;
  private stopped = false;
  private readonly topics: (Hex | Hex[] | null)[];

  constructor(opts: LogFeedOptions) {
    this.opts = opts;
    this.topics = opts.trader
      ? [TRADER_EVENTS.map(topic0), null, pad(opts.trader.toLowerCase() as Hex, { size: 32 })]
      : [ALL_EVENTS.map(topic0)];
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = (): LogFeedSnapshot => this.snapshot;

  start(): void {
    void this.init();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.notifyTimer) clearTimeout(this.notifyTimer);
    this.timer = null;
    this.notifyTimer = null;
  }

  /** Loads `seconds` more history before what is already covered. */
  async extend(seconds: number): Promise<void> {
    if (this.stopped || this.status.loadedFrom <= 0 || this.status.pending > 0) return;
    const blocks = Math.ceil(seconds / this.clock.secPerBlock);
    const to = this.status.loadedFrom - 1;
    const from = Math.max(0, to - blocks + 1);
    await this.backfill(from, to);
  }

  private async init(): Promise<void> {
    const { client } = this.opts;
    if (this.stopped) return;
    try {
      const head = await client.getBlock({ blockTag: "latest" });
      const headNumber = Number(head.number);
      const headTime = Number(head.timestamp);
      this.clock.add(headNumber, headTime);
      if (headNumber > 0) {
        const probe = Math.max(0, headNumber - 1_000);
        const older = await client.getBlock({ blockNumber: BigInt(probe) });
        this.clock.add(probe, Number(older.timestamp));
        const per = (headTime - Number(older.timestamp)) / Math.max(1, headNumber - probe);
        this.clock.secPerBlock = Math.min(15, Math.max(0.05, per || 1));
      }
      if (this.stopped) return;
      this.lastBlock = headNumber;
      const blocks = Math.ceil(this.opts.lookbackSeconds / this.clock.secPerBlock);
      const from = Math.max(0, headNumber - blocks);
      this.setStatus({ headBlock: headNumber, loadedFrom: headNumber + 1, secPerBlock: this.clock.secPerBlock });
      this.timer = setInterval(() => void this.poll(), this.opts.pollMs);
      await this.backfill(from, headNumber);
    } catch (error) {
      this.setStatus({ phase: "error", error: error instanceof Error ? error.message : "Could not read event logs" });
      if (!this.stopped) setTimeout(() => void this.init(), 4_000);
    }
  }

  /** Fetches [from, to] in chunks, newest first, three requests at a time. */
  private async backfill(from: number, to: number): Promise<void> {
    if (to < from) {
      this.setStatus({ phase: "live", pending: 0, loadedFrom: Math.min(this.status.loadedFrom, from) });
      return;
    }
    const ranges: [number, number][] = [];
    for (let end = to; end >= from; end -= MAX_BLOCK_RANGE) ranges.push([Math.max(from, end - MAX_BLOCK_RANGE + 1), end]);
    let next = 0;
    let remaining = ranges.length;
    let failed: string | null = null;
    this.setStatus({ phase: "backfilling", pending: remaining, error: null });

    const worker = async () => {
      while (!this.stopped && next < ranges.length) {
        const [a, b] = ranges[next++]!;
        try {
          if (ranges.length > 1 || this.opts.exactTimes !== true) await this.anchor(a);
          const events = await this.fetchRange(a, b);
          this.insert(events);
          remaining -= 1;
          // Chunks finish out of order; coverage is only contiguous once every newer chunk is in.
          this.setStatus({ pending: remaining });
        } catch (error) {
          failed = error instanceof Error ? error.message : "Could not read event logs";
          remaining -= 1;
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    if (this.stopped) return;
    this.setStatus({
      phase: failed ? "error" : "live",
      error: failed,
      pending: 0,
      loadedFrom: failed ? this.status.loadedFrom : from,
      loadedFromTime: this.clock.timeOf(from),
    });
  }

  private async anchor(block: number): Promise<void> {
    try {
      const b = await this.opts.client.getBlock({ blockNumber: BigInt(block) });
      this.clock.add(block, Number(b.timestamp));
    } catch {
      // Interpolation falls back to the block-time estimate.
    }
  }

  private async poll(): Promise<void> {
    if (this.polling || this.stopped || this.lastBlock < 0) return;
    if (typeof document !== "undefined" && document.hidden) return;
    this.polling = true;
    try {
      const head = await this.opts.client.getBlock({ blockTag: "latest" });
      const headNumber = Number(head.number);
      this.clock.add(headNumber, Number(head.timestamp));
      let guard = 0;
      while (this.lastBlock < headNumber && guard < 6 && !this.stopped) {
        const from = this.lastBlock + 1;
        const to = Math.min(headNumber, from + MAX_BLOCK_RANGE - 1);
        const events = await this.fetchRange(from, to);
        this.lastBlock = to;
        this.insert(events);
        guard += 1;
      }
      if (this.status.headBlock !== headNumber || this.status.phase === "error") {
        this.setStatus({ headBlock: headNumber, ...(this.status.pending === 0 ? { phase: "live" as const, error: null } : {}) });
      }
    } catch (error) {
      this.setStatus({ phase: "error", error: error instanceof Error ? error.message : "Could not read event logs" });
    } finally {
      this.polling = false;
    }
  }

  private async fetchRange(from: number, to: number): Promise<EngineEvent[]> {
    const { client, engine } = this.opts;
    const raw = (await client.request({
      method: "eth_getLogs",
      params: [{ address: engine, fromBlock: numberToHex(from), toBlock: numberToHex(to), topics: this.topics }],
    })) as RpcLog[];
    if (raw.length === 0) return [];

    if (this.opts.exactTimes) {
      const blocks = [...new Set(raw.map((l) => Number(BigInt(l.blockNumber ?? "0x0"))))].slice(0, 200);
      await Promise.all(blocks.map((b) => this.anchor(b)));
    }

    const parsed = parseEventLogs({ abi: perpEngineAbi, logs: raw, eventName: [...ALL_EVENTS] });
    const out: EngineEvent[] = [];
    for (const log of parsed) {
      const block = Number(BigInt(log.blockNumber ?? 0));
      const logIndex = Number(BigInt(log.logIndex ?? 0));
      const common: Common = {
        id: `${block}-${logIndex}`,
        block,
        logIndex,
        tx: (log.transactionHash ?? "0x") as Hex,
        time: this.clock.timeOf(block),
      };
      switch (log.eventName) {
        case "PositionOpened": {
          const a = log.args;
          out.push({ ...common, type: "open", key: a.key, trader: a.trader, marketId: lower(a.priceId), isLong: a.isLong, margin: a.margin, size: a.size, price: a.entryPrice, fee: a.fee });
          break;
        }
        case "PositionClosed": {
          const a = log.args;
          out.push({ ...common, type: "close", key: a.key, trader: a.trader, marketId: lower(a.priceId), price: a.exitPrice, pnl: a.pnl, fee: a.fee, payout: a.payout });
          break;
        }
        case "PositionLiquidated": {
          const a = log.args;
          out.push({ ...common, type: "liquidation", key: a.key, trader: a.trader, liquidator: a.liquidator, marketId: lower(a.priceId), price: a.price, margin: a.margin, liquidatorFee: a.liquidatorFee, toVault: a.toVault });
          break;
        }
        case "OrderCreated": {
          const a = log.args;
          out.push({ ...common, type: "orderCreated", orderId: a.orderId, trader: a.trader, marketId: lower(a.priceId), orderType: Number(a.orderType), isLong: a.isLong, triggerPrice: a.triggerPrice, margin: a.margin, size: a.size });
          break;
        }
        case "OrderCancelled":
          out.push({ ...common, type: "orderCancelled", orderId: log.args.orderId, trader: log.args.trader });
          break;
        case "OrderExecuted":
          out.push({ ...common, type: "orderExecuted", orderId: log.args.orderId, trader: log.args.trader, keeper: log.args.keeper, price: log.args.price });
          break;
        case "MarketSettled":
          out.push({ ...common, type: "marketSettled", marketId: lower(log.args.priceId), price: log.args.settlementPrice });
          break;
      }
    }

    // OrderExecuted carries neither market nor order type; the fill it caused is in the same transaction.
    const byTx = new Map<string, EngineEvent[]>();
    for (const event of out) {
      const list = byTx.get(event.tx);
      if (list) list.push(event);
      else byTx.set(event.tx, [event]);
    }
    for (const list of byTx.values()) {
      for (const executed of list) {
        if (executed.type !== "orderExecuted") continue;
        let best: OpenEvent | CloseEvent | undefined;
        for (const candidate of list) {
          if ((candidate.type !== "open" && candidate.type !== "close") || candidate.orderId !== undefined) continue;
          if (candidate.trader.toLowerCase() !== executed.trader.toLowerCase() || candidate.logIndex > executed.logIndex) continue;
          if (!best || candidate.logIndex > best.logIndex) best = candidate;
        }
        if (best) best.orderId = executed.orderId;
      }
    }
    return out;
  }

  private insert(incoming: EngineEvent[]): void {
    const fresh = incoming.filter((e) => !this.seen.has(e.id));
    if (fresh.length === 0) return;
    for (const event of fresh) this.seen.add(event.id);
    const last = this.events[this.events.length - 1];
    const first = fresh[0]!;
    let merged: EngineEvent[];
    if (!last || last.block < first.block || (last.block === first.block && last.logIndex < first.logIndex)) {
      merged = this.events.concat(fresh);
    } else {
      merged = this.events.concat(fresh).sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
    }
    if (merged.length > this.opts.maxEvents) {
      const dropped = merged.splice(0, merged.length - this.opts.maxEvents);
      for (const event of dropped) this.seen.delete(event.id);
    }
    this.events = merged;
    this.scheduleNotify();
  }

  private setStatus(patch: Partial<LogFeedStatus>): void {
    this.status = { ...this.status, ...patch };
    this.scheduleNotify();
  }

  private scheduleNotify(): void {
    if (this.notifyTimer || this.stopped) return;
    this.notifyTimer = setTimeout(() => {
      this.notifyTimer = null;
      this.version += 1;
      this.snapshot = { events: this.events, status: this.status, version: this.version };
      for (const listener of this.listeners) listener();
    }, 300);
  }
}

function lower(id: Hex): Hex {
  return id.toLowerCase() as Hex;
}

export const ORDER_TYPE_LABELS = ["Limit open", "Take-profit", "Stop-loss", "Close"] as const;

export function orderTypeLabel(orderType: number): string {
  return ORDER_TYPE_LABELS[orderType] ?? "Order";
}
