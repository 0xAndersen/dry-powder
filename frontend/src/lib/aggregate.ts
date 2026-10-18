import type { Address, Hex } from "viem";
import type { EngineEvent } from "./events";
import { pricePnl } from "./math";

/**
 * Venue, market and trader statistics from engine events. The same rules as the indexer
 * (keeper/src/indexer.mjs), so a stats.json it wrote can be continued here with live events, or the whole thing
 * computed from a window of events when there is no stats.json. Amounts are collateral micro-units.
 *
 *   realised  what exits returned beyond the margin they released, before their fee (payout + fee - margin);
 *             a liquidation is minus its margin. Funding, the profit cap and any shortfall are already in it.
 *   fees      open, increase, decrease and close fees. Net PnL = realised - fees.
 *   funding   per exit: price PnL at the exit price minus the reported PnL (positive: paid). Not counted when the
 *             profit cap was binding or the open is unknown.
 *   volume    notional opened, increased, decreased, closed and liquidated.
 *   margin    margin released by exits: the ROI denominator.
 *   trades    round trips (a position closed in full or liquidated); wins, losses, best, worst and drawdown are per
 *             trade, on its net (realised minus all of its fees).
 *   buckets   per UTC day (and hour, for traders) in which things happened.
 */

export const DAY = 86_400;
export const HOUR = 3_600;
export const DAYS_KEPT = 60;
export const HOURS_KEPT = 48;

/** Sum of a bucket field over the `seconds` (default 24 hours) up to `now`, by the hour. */
export function recentBig(buckets: readonly Bucket[] | undefined, field: "r" | "f" | "v" | "m", now: number, seconds = DAY): bigint {
  if (!buckets) return 0n;
  const from = Math.floor((now - seconds) / HOUR) + 1;
  const to = Math.floor(now / HOUR);
  let total = 0n;
  for (const b of buckets) if (b.i >= from && b.i <= to) total += b[field];
  return total;
}

export function recentCount(buckets: readonly Bucket[] | undefined, field: "t" | "w" | "l" | "x", now: number, seconds = DAY): number {
  if (!buckets) return 0;
  const from = Math.floor((now - seconds) / HOUR) + 1;
  const to = Math.floor(now / HOUR);
  let total = 0;
  for (const b of buckets) if (b.i >= from && b.i <= to) total += b[field];
  return total;
}

export type Totals = {
  opens: number;
  trades: number;
  wins: number;
  losses: number;
  liquidations: number;
  increases: number;
  decreases: number;
  marginAdds: number;
  volume: bigint;
  fees: bigint;
  realised: bigint;
  funding: bigint;
  margin: bigint;
  firstTime: number;
  lastTime: number;
};
export type SideTotals = { trades: number; wins: number; losses: number; net: bigint; volume: bigint };
/** i: day or hour number; r realised, f fees, v volume, m margin released; t trades, w wins, l losses, x liquidations. */
export type Bucket = { i: number; r: bigint; f: bigint; v: bigint; m: bigint; t: number; w: number; l: number; x: number };
export type MarketTotals = Totals & { symbol: string; longVolume: bigint; shortVolume: bigint; settlementPrice: bigint; hours: Bucket[] };
export type TraderRecord = Totals & {
  grossWin: bigint;
  grossLoss: bigint;
  best: bigint | null;
  worst: bigint | null;
  cum: bigint;
  peak: bigint;
  maxDrawdown: bigint;
  firstBlock: number;
  lastBlock: number;
  long: SideTotals;
  short: SideTotals;
  markets: Record<string, SideTotals>;
  days: Bucket[];
  hours: Bucket[];
};
export type OpenPosition = {
  trader: string;
  market: string;
  long: boolean;
  size: bigint;
  margin: bigint;
  entry: bigint;
  /** Fees paid so far in this round trip. */
  fees: bigint;
  /** Realised so far by partial closes. */
  realised: bigint;
  openTime: number;
  openBlock: number;
  // Kept only in the browser, for trade records: not in stats.json.
  openTx?: Hex;
  openSize?: bigint;
  openMargin?: bigint;
  peakSize?: bigint;
  committed?: bigint;
  partials?: number;
  /** Notional opened, increased and partly closed so far in this round trip. */
  traded?: bigint;
};
export type StatsState = {
  schema: 1;
  chainId: number;
  engine: string;
  deployBlock: number;
  deployTime: number;
  /** Last block fully counted. */
  cursorBlock: number;
  cursorTime: number;
  updatedAt: string | null;
  maxProfitMultiple: bigint;
  events: number;
  venue: Totals;
  days: Bucket[];
  markets: Record<string, MarketTotals>;
  traders: Record<string, TraderRecord>;
  open: Record<string, OpenPosition>;
};

/** One finished round trip, for the journal and share cards. Fields are null when the open fell outside the events. */
export type ClosedTrade = {
  /** The exit event's id (`block-logIndex`): stable, used to key journal notes. */
  id: string;
  key: Hex;
  trader: Address;
  marketId: Hex;
  isLong: boolean | null;
  /** Largest notional held during the trade. */
  size: bigint | null;
  /** Average entry at the exit. */
  entry: bigint | null;
  exit: bigint;
  /** Margin put in: at open, plus increases and top-ups. */
  margin: bigint | null;
  /** Leverage chosen at open (size / margin). */
  leverage: number | null;
  /** Notional traded over the round trip: opened, increased, partly and finally closed. Null when the open is unknown. */
  volume: bigint | null;
  realised: bigint;
  /** All fees of the trade; null when the open (and its fee) is unknown. */
  fees: bigint | null;
  /** Realised minus fees (minus the exit fee only, when the open is unknown). */
  net: bigint;
  /** Net as a fraction of margin. */
  roe: number | null;
  openTime: number | null;
  closeTime: number;
  liquidated: boolean;
  partials: number;
  orderId?: bigint;
  tx: Hex;
  openTx: Hex | null;
};

export const totals = (): Totals => ({
  opens: 0,
  trades: 0,
  wins: 0,
  losses: 0,
  liquidations: 0,
  increases: 0,
  decreases: 0,
  marginAdds: 0,
  volume: 0n,
  fees: 0n,
  realised: 0n,
  funding: 0n,
  margin: 0n,
  firstTime: 0,
  lastTime: 0,
});
export const sideTotals = (): SideTotals => ({ trades: 0, wins: 0, losses: 0, net: 0n, volume: 0n });
export const bucket = (i: number): Bucket => ({ i, r: 0n, f: 0n, v: 0n, m: 0n, t: 0, w: 0, l: 0, x: 0 });
export const marketTotals = (): MarketTotals => ({ symbol: "", ...totals(), longVolume: 0n, shortVolume: 0n, settlementPrice: 0n, hours: [] });
export const traderRecord = (): TraderRecord => ({
  ...totals(),
  grossWin: 0n,
  grossLoss: 0n,
  best: null,
  worst: null,
  cum: 0n,
  peak: 0n,
  maxDrawdown: 0n,
  firstBlock: 0,
  lastBlock: 0,
  long: sideTotals(),
  short: sideTotals(),
  markets: {},
  days: [],
  hours: [],
});

export function emptyState(opts: { chainId: number; engine: string; maxProfitMultiple?: bigint }): StatsState {
  return {
    schema: 1,
    chainId: opts.chainId,
    engine: opts.engine.toLowerCase(),
    deployBlock: 0,
    deployTime: 0,
    cursorBlock: -1,
    cursorTime: 0,
    updatedAt: null,
    maxProfitMultiple: opts.maxProfitMultiple ?? 10n,
    events: 0,
    venue: totals(),
    days: [],
    markets: {},
    traders: {},
    open: {},
  };
}

function bucketAt(list: Bucket[], i: number): Bucket {
  const last = list[list.length - 1];
  if (last && last.i === i) return last;
  if (!last || last.i < i) {
    const b = bucket(i);
    list.push(b);
    return b;
  }
  let at = list.findIndex((b) => b.i >= i);
  if (at === -1) at = list.length;
  const hit = list[at];
  if (hit && hit.i === i) return hit;
  const b = bucket(i);
  list.splice(at, 0, b);
  return b;
}

function touch(t: Totals, time: number) {
  if (!t.firstTime || time < t.firstTime) t.firstTime = time;
  if (time > t.lastTime) t.lastTime = time;
}

/**
 * Applies one event (mutating `state`); events must arrive in chain order. `onTrade` receives each finished round
 * trip. Order events are ignored; MarketSettled records the settlement price.
 */
export function applyEvent(state: StatsState, e: EngineEvent, onTrade?: (trade: ClosedTrade) => void): void {
  if (e.type === "marketSettled") {
    (state.markets[e.marketId] ??= marketTotals()).settlementPrice = e.price;
    return;
  }
  if (e.type !== "open" && e.type !== "increase" && e.type !== "decrease" && e.type !== "close" && e.type !== "liquidation" && e.type !== "marginAdded") return;
  state.events += 1;

  const time = Math.floor(e.time);
  const key = e.key.toLowerCase() as Hex;
  const traderId = e.trader.toLowerCase();
  const pos = state.open[key];
  const marketId = e.type === "marginAdded" ? (pos?.market ?? null) : e.marketId.toLowerCase();
  const trader = (state.traders[traderId] ??= traderRecord());
  const market = marketId ? (state.markets[marketId] ??= marketTotals()) : null;
  const all: Totals[] = market ? [trader, market, state.venue] : [trader, state.venue];
  for (const t of all) touch(t, time);
  if (!trader.firstBlock) trader.firstBlock = e.block;
  trader.lastBlock = e.block;

  let buckets: Bucket[] | null = null;
  const add = (field: "opens" | "trades" | "wins" | "losses" | "liquidations" | "increases" | "decreases" | "marginAdds", n: number) => {
    for (const t of all) t[field] += n;
  };
  const addBig = (field: "volume" | "fees" | "realised" | "funding" | "margin", n: bigint) => {
    for (const t of all) t[field] += n;
  };
  const addB = (field: "r" | "f" | "v" | "m" | "t" | "w" | "l" | "x", n: bigint | number) => {
    if (!buckets) {
      buckets = [bucketAt(trader.days, Math.floor(time / DAY)), bucketAt(trader.hours, Math.floor(time / HOUR)), bucketAt(state.days, Math.floor(time / DAY))];
      // Per market by the hour (as keeper/src/indexer.mjs): rolling 24 h volume, fees and trades.
      if (market) buckets.push(bucketAt((market.hours ??= []), Math.floor(time / HOUR)));
    }
    for (const b of buckets) {
      if (field === "r" || field === "f" || field === "v" || field === "m") b[field] += n as bigint;
      else b[field] += n as number;
    }
  };
  const sides = (isLong: boolean): SideTotals[] => {
    const out = [isLong ? trader.long : trader.short];
    if (marketId) out.push((trader.markets[marketId] ??= sideTotals()));
    return out;
  };
  const volume = (amount: bigint, isLong: boolean | undefined) => {
    addBig("volume", amount);
    addB("v", amount);
    if (isLong === undefined) return;
    if (market) market[isLong ? "longVolume" : "shortVolume"] += amount;
    for (const s of sides(isLong)) s.volume += amount;
  };
  const fee = (amount: bigint) => {
    addBig("fees", amount);
    addB("f", amount);
  };
  const realise = (amount: bigint, released: bigint) => {
    addBig("realised", amount);
    addBig("margin", released);
    addB("r", amount);
    addB("m", released);
  };
  const funding = (size: bigint, exitPrice: bigint, pnl: bigint, released: bigint, p: OpenPosition | undefined) => {
    if (!p || pnl >= released * state.maxProfitMultiple) return;
    addBig("funding", pricePnl(size, p.entry, exitPrice, p.long) - pnl);
  };
  const finish = (net: bigint, isLong: boolean | undefined, liquidated: boolean, trade: Omit<ClosedTrade, "net" | "roe">) => {
    add("trades", 1);
    addB("t", 1);
    if (net > 0n) {
      add("wins", 1);
      addB("w", 1);
      trader.grossWin += net;
    } else if (net < 0n) {
      add("losses", 1);
      addB("l", 1);
      trader.grossLoss -= net;
    }
    if (liquidated) {
      add("liquidations", 1);
      addB("x", 1);
    }
    if (trader.best === null || net > trader.best) trader.best = net;
    if (trader.worst === null || net < trader.worst) trader.worst = net;
    trader.cum += net;
    if (trader.cum > trader.peak) trader.peak = trader.cum;
    const drawdown = trader.peak - trader.cum;
    if (drawdown > trader.maxDrawdown) trader.maxDrawdown = drawdown;
    if (isLong !== undefined) {
      for (const s of sides(isLong)) {
        s.trades += 1;
        if (net > 0n) s.wins += 1;
        else if (net < 0n) s.losses += 1;
        s.net += net;
      }
    }
    delete state.open[key];
    if (onTrade) onTrade({ ...trade, net, roe: trade.margin && trade.margin > 0n ? Number((net * 1_000_000n) / trade.margin) / 1e6 : null });
  };
  const tradeOf = (p: OpenPosition | undefined, exit: bigint, realised: bigint, exitFee: bigint, liquidated: boolean, orderId?: bigint): Omit<ClosedTrade, "net" | "roe"> => ({
    id: e.id,
    key,
    trader: e.trader,
    marketId: (marketId ?? "0x") as Hex,
    isLong: p ? p.long : null,
    size: p ? (p.peakSize ?? p.size) : null,
    entry: p ? p.entry : null,
    exit,
    margin: p ? (p.committed ?? p.margin) : e.type === "liquidation" ? e.margin : null,
    leverage: p && (p.openMargin ?? p.margin) > 0n ? Number(((p.openSize ?? p.size) * 10n) / (p.openMargin ?? p.margin)) / 10 : null,
    volume: p && p.traded !== undefined ? p.traded + (e.type === "decrease" ? e.closedSize : p.size) : null,
    realised: (p ? p.realised : 0n) + realised,
    fees: p ? p.fees + exitFee : null,
    openTime: p ? p.openTime : null,
    closeTime: time,
    liquidated,
    partials: p?.partials ?? 0,
    orderId,
    tx: e.tx,
    openTx: p?.openTx ?? null,
  });

  switch (e.type) {
    case "open": {
      state.open[key] = {
        trader: traderId,
        market: e.marketId.toLowerCase(),
        long: e.isLong,
        size: e.size,
        margin: e.margin,
        entry: e.price,
        fees: e.fee,
        realised: 0n,
        openTime: time,
        openBlock: e.block,
        openTx: e.tx,
        openSize: e.size,
        openMargin: e.margin,
        peakSize: e.size,
        committed: e.margin,
        partials: 0,
        traded: e.size,
      };
      add("opens", 1);
      volume(e.size, e.isLong);
      fee(e.fee);
      break;
    }
    case "increase": {
      const p = (state.open[key] ??= {
        trader: traderId,
        market: e.marketId.toLowerCase(),
        long: e.isLong,
        size: 0n,
        margin: 0n,
        entry: 0n,
        fees: 0n,
        realised: 0n,
        openTime: time,
        openBlock: e.block,
      });
      p.size = e.newSize;
      p.margin = e.newMargin;
      p.entry = e.newEntryPrice;
      p.fees += e.fee;
      if (p.peakSize === undefined || e.newSize > p.peakSize) p.peakSize = e.newSize;
      p.committed = (p.committed ?? e.newMargin - e.addedMargin) + e.addedMargin;
      if (p.traded !== undefined) p.traded += e.addedSize;
      add("increases", 1);
      volume(e.addedSize, e.isLong);
      fee(e.fee);
      break;
    }
    case "marginAdded": {
      if (pos) {
        pos.margin = e.newMargin;
        pos.committed = (pos.committed ?? e.newMargin - e.amount) + e.amount;
      }
      add("marginAdds", 1);
      break;
    }
    case "decrease": {
      const realised = e.payout + e.fee - e.releasedMargin;
      add("decreases", 1);
      volume(e.closedSize, pos?.long);
      fee(e.fee);
      realise(realised, e.releasedMargin);
      funding(e.closedSize, e.price, e.pnl, e.releasedMargin, pos);
      if (pos) {
        const trade = tradeOf(pos, e.price, realised, e.fee, false, e.orderId);
        pos.size -= e.closedSize;
        pos.margin -= e.releasedMargin;
        pos.fees += e.fee;
        pos.realised += realised;
        pos.partials = (pos.partials ?? 0) + 1;
        if (pos.traded !== undefined) pos.traded += e.closedSize;
        if (pos.size <= 0n) finish(pos.realised - pos.fees, pos.long, false, { ...trade, realised: pos.realised, fees: pos.fees, partials: pos.partials - 1 });
      }
      break;
    }
    case "close": {
      const realised = pos ? e.payout + e.fee - pos.margin : e.pnl;
      volume(pos ? pos.size : 0n, pos?.long);
      fee(e.fee);
      realise(realised, pos ? pos.margin : 0n);
      if (pos) funding(pos.size, e.price, e.pnl, pos.margin, pos);
      finish((pos ? pos.realised - pos.fees : 0n) + realised - e.fee, pos?.long, false, tradeOf(pos, e.price, realised, e.fee, false, e.orderId));
      break;
    }
    case "liquidation": {
      volume(pos ? pos.size : 0n, pos?.long);
      realise(-e.margin, e.margin);
      finish((pos ? pos.realised - pos.fees : 0n) - e.margin, pos?.long, true, tradeOf(pos, e.price, -e.margin, 0n, true));
      break;
    }
  }
}

/** Fresh statistics from a run of events (for a window of the live feed, or one trader's history). */
export function aggregate(events: readonly EngineEvent[], opts: { chainId: number; engine: string; maxProfitMultiple?: bigint }, onTrade?: (trade: ClosedTrade) => void): StatsState {
  const state = emptyState(opts);
  for (const e of events) applyEvent(state, e, onTrade);
  return state;
}

/** Every finished round trip in `events`, newest first. */
export function closedTrades(events: readonly EngineEvent[], maxProfitMultiple = 10n): ClosedTrade[] {
  const out: ClosedTrade[] = [];
  aggregate(events, { chainId: 0, engine: "0x", maxProfitMultiple }, (t) => out.push(t));
  return out.reverse();
}

/**
 * `base` (an indexer snapshot) continued with the events after its cursor. With `trader`, only that trader's record
 * and positions are copied and continued (the events must be that trader's), which is far cheaper than the venue.
 */
export function continueState(base: StatsState, events: readonly EngineEvent[], trader?: string): StatsState {
  let state: StatsState;
  if (trader) {
    const id = trader.toLowerCase();
    const open: Record<string, OpenPosition> = {};
    for (const [k, p] of Object.entries(base.open)) if (p.trader === id) open[k] = { ...p };
    state = {
      ...base,
      venue: totals(),
      days: [],
      markets: {},
      traders: base.traders[id] ? { [id]: structuredClone(base.traders[id]) } : {},
      open,
    };
  } else {
    state = structuredClone(base);
  }
  for (const e of events) if (e.block > base.cursorBlock) applyEvent(state, e);
  return state;
}

// ─────────────────────────────── Periods ───────────────────────────────

export type PeriodSum = { realised: bigint; fees: bigint; net: bigint; volume: bigint; margin: bigint; trades: number; wins: number; losses: number; liquidations: number };

/** Sums buckets whose index is in [from, to). */
export function sumBuckets(list: readonly Bucket[], from: number, to: number): PeriodSum {
  const out: PeriodSum = { realised: 0n, fees: 0n, net: 0n, volume: 0n, margin: 0n, trades: 0, wins: 0, losses: 0, liquidations: 0 };
  for (const b of list) {
    if (b.i < from || b.i >= to) continue;
    out.realised += b.r;
    out.fees += b.f;
    out.volume += b.v;
    out.margin += b.m;
    out.trades += b.t;
    out.wins += b.w;
    out.losses += b.l;
    out.liquidations += b.x;
  }
  out.net = out.realised - out.fees;
  return out;
}

/** The all-time figures of a trader in the same shape as a period. */
export function allTime(t: Totals): PeriodSum {
  return {
    realised: t.realised,
    fees: t.fees,
    net: t.realised - t.fees,
    volume: t.volume,
    margin: t.margin,
    trades: t.trades,
    wins: t.wins,
    losses: t.losses,
    liquidations: t.liquidations,
  };
}

/** Net PnL over margin released; null when nothing was released. */
export function roiOf(p: { net: bigint; margin: bigint }): number | null {
  if (p.margin <= 0n) return null;
  return Number((p.net * 1_000_000n) / p.margin) / 1e6;
}

export function winRateOf(p: { trades: number; wins: number }): number | null {
  return p.trades > 0 ? p.wins / p.trades : null;
}

// ─────────────────────────────── Seasons ───────────────────────────────

const WEEK = 7 * DAY;
/** 1970-01-05 was a Monday: Mondays 00:00 UTC are this plus multiples of a week. */
const MONDAY_EPOCH = 4 * DAY;

/** Monday 00:00 UTC on or before `time`. */
export function weekStart(time: number): number {
  return Math.floor((time - MONDAY_EPOCH) / WEEK) * WEEK + MONDAY_EPOCH;
}

export type Season = {
  /** 0 for the days between launch and the first Monday. */
  number: number;
  start: number;
  end: number;
};

/**
 * Weekly seasons run Monday 00:00 UTC to the next Monday. Season 1 starts on the first Monday after launch; the
 * days before it are the pre-season (number 0), from launch to that Monday.
 */
export function seasonAt(time: number, launch: number): Season {
  const first = weekStart(launch) + (weekStart(launch) === launch ? 0 : WEEK);
  if (time < first) return { number: 0, start: launch, end: first };
  const n = Math.floor((time - first) / WEEK);
  return { number: n + 1, start: first + n * WEEK, end: first + (n + 1) * WEEK };
}

export function seasonByNumber(number: number, launch: number): Season {
  const first = weekStart(launch) + (weekStart(launch) === launch ? 0 : WEEK);
  if (number <= 0) return { number: 0, start: launch, end: first };
  return { number, start: first + (number - 1) * WEEK, end: first + number * WEEK };
}

/** Cumulative net PnL at the end of each day, for a curve: [dayStart, value] from `days` on top of `base`. */
export function dailyCurve(days: readonly Bucket[], base: bigint): { time: number; value: bigint }[] {
  let cum = base;
  return days.map((b) => {
    cum += b.r - b.f;
    return { time: b.i * DAY, value: cum };
  });
}
