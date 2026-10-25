#!/usr/bin/env node
// Serverless indexer: turns PerpEngine logs into the stats the app's leaderboard, portfolio and trader pages read.
// There is no backend. GitHub Actions runs this next to the keeper (.github/scripts/keeper-status.sh) and pushes the
// result to status/stats.json on the repository's `status` branch.
//
//   DEPLOYMENT=../deployments/arc-testnet.json STATS_FILE=stats.json node src/indexer.mjs
//
// Each run continues from the `cursorBlock` of the previous file. For a new engine (or a file written for another
// engine or chain) it starts again from the block the engine was deployed in, found by binary search on eth_getCode.
// A run stops after MAX_SECONDS and saves its progress, so a long back-fill spreads over several runs.
//
// Environment: DEPLOYMENT (deployment JSON with engine, lens, chainId, rpcUrl, deployedAt), STATS_FILE (default
// ./stats.json), RPC_URL / RPC_URLS, CHAIN_ID, PERP_ENGINE_ADDRESS, ENGINE_LENS_ADDRESS, START_BLOCK (skips the
// deploy-block search), MAX_SECONDS (default 240), LOG_RANGE (blocks per eth_getLogs, default 10000, halved on range
// errors), SAFETY_BLOCKS (how far behind the head to stop, default 10, so a lagging RPC node behind a load balancer
// cannot hide recent logs).
//
// Funding and open interest are state, not events: each run also samples EngineLens.getMarkets() once (when the
// lens address is known) into `marketHistory` (see "Market history" below).
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeEventLog, decodeFunctionResult, encodeEventTopics, encodeFunctionData } from "viem";
import { engineLensAbi, perpEngineAbi } from "./abi.mjs";

export const SCHEMA = 1;
export const DAY = 86_400;
export const HOUR = 3_600;
/** Daily buckets kept per trader and for the venue. */
export const DAYS_KEPT = 60;
/** Hourly buckets kept per trader (rolling 24 h leaderboards). */
export const HOURS_KEPT = 48;

// ─────────────────────────────── Events ───────────────────────────────

/**
 * Events added by the v3.1 engine (partial closes and margin top-ups). Decoded here so the numbers are right the day
 * it ships; an engine without them simply never emits them. Dropped in favour of the generated ABI once it has them.
 */
export const V31_EVENTS = [
  {
    type: "event",
    name: "PositionIncreased",
    inputs: [
      { name: "key", type: "bytes32", indexed: true },
      { name: "trader", type: "address", indexed: true },
      { name: "priceId", type: "bytes32", indexed: true },
      { name: "isLong", type: "bool", indexed: false },
      { name: "addedMargin", type: "uint256", indexed: false },
      { name: "addedSize", type: "uint256", indexed: false },
      { name: "price", type: "uint256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
      { name: "newMargin", type: "uint256", indexed: false },
      { name: "newSize", type: "uint256", indexed: false },
      { name: "newEntryPrice", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "PositionDecreased",
    inputs: [
      { name: "key", type: "bytes32", indexed: true },
      { name: "trader", type: "address", indexed: true },
      { name: "priceId", type: "bytes32", indexed: true },
      { name: "exitPrice", type: "uint256", indexed: false },
      { name: "closedSize", type: "uint256", indexed: false },
      { name: "releasedMargin", type: "uint256", indexed: false },
      { name: "pnl", type: "int256", indexed: false },
      { name: "fee", type: "uint256", indexed: false },
      { name: "payout", type: "uint256", indexed: false },
    ],
  },
  {
    type: "event",
    name: "MarginAdded",
    inputs: [
      { name: "key", type: "bytes32", indexed: true },
      { name: "trader", type: "address", indexed: true },
      { name: "amount", type: "uint256", indexed: false },
      { name: "newMargin", type: "uint256", indexed: false },
    ],
  },
];

/** Every event the aggregation reads. Order events are not needed: fills show up as position events. */
export const INDEXED_EVENTS = [
  "PositionOpened",
  "PositionClosed",
  "PositionLiquidated",
  "PositionIncreased",
  "PositionDecreased",
  "MarginAdded",
  "MarketListed",
  "MarketSettled",
  "MaxProfitMultipleSet",
];

const known = new Set(perpEngineAbi.filter((x) => x.type === "event").map((x) => x.name));
export const EVENT_ABI = [...perpEngineAbi.filter((x) => x.type === "event"), ...V31_EVENTS.filter((x) => !known.has(x.name))];
export const TOPICS = INDEXED_EVENTS.map((eventName) => encodeEventTopics({ abi: EVENT_ABI, eventName })[0]);

/** Decodes raw RPC logs into `{ name, args, block, logIndex, tx, time }`, oldest first. Unknown logs are skipped. */
export function decodeLogs(raw, timeOf) {
  const out = [];
  for (const log of raw) {
    let decoded;
    try {
      decoded = decodeEventLog({ abi: EVENT_ABI, data: log.data, topics: log.topics });
    } catch {
      continue;
    }
    const block = Number(BigInt(log.blockNumber));
    out.push({
      name: decoded.eventName,
      args: decoded.args,
      block,
      logIndex: Number(BigInt(log.logIndex)),
      tx: log.transactionHash,
      time: Math.floor(timeOf(block, log)),
    });
  }
  return out.sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
}

// ─────────────────────────────── Aggregation ───────────────────────────────
//
// Amounts are collateral micro-units (USDC has 6 decimals) and prices 18 decimals, as bigints in memory and decimal
// strings in the file. What is counted:
//   realised  what exits returned beyond the margin they released, before their fee: payout + fee - margin released
//             (a liquidation: minus its margin). So it already includes funding, the profit cap and any shortfall.
//   fees      open, increase, decrease and close fees. Net PnL = realised - fees.
//   funding   derived per exit: price PnL at the exit price (engine rounding) minus the reported PnL; positive means
//             paid. Skipped when the profit cap was binding or the open is not known.
//   volume    notional opened, increased, decreased, closed and liquidated.
//   margin    margin released by exits: the denominator of ROI.
//   trades    round trips: a position closed in full or liquidated. A trade's net is its realised minus all of its
//             fees; wins, losses, best, worst and drawdown are per trade.
//   buckets   per UTC day (and per hour for traders) of the time things happened: realised and fees on the day they
//             were realised or paid, trade counts on the day the trade closed.

const TOTALS = () => ({
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
const SIDE = () => ({ trades: 0, wins: 0, losses: 0, net: 0n, volume: 0n });
const BUCKET = (i) => ({ i, r: 0n, f: 0n, v: 0n, m: 0n, t: 0, w: 0, l: 0, x: 0 });
const MARKET = () => ({ symbol: "", ...TOTALS(), longVolume: 0n, shortVolume: 0n, settlementPrice: 0n, hours: [] });
const TRADER = () => ({
  ...TOTALS(),
  grossWin: 0n,
  grossLoss: 0n,
  best: null,
  worst: null,
  cum: 0n,
  peak: 0n,
  maxDrawdown: 0n,
  firstBlock: 0,
  lastBlock: 0,
  long: SIDE(),
  short: SIDE(),
  markets: {},
  days: [],
  hours: [],
});

export function emptyState({ chainId, engine, deployBlock = 0, deployTime = 0 }) {
  return {
    schema: SCHEMA,
    chainId,
    engine: engine.toLowerCase(),
    deployBlock,
    deployTime,
    cursorBlock: deployBlock - 1,
    cursorTime: deployTime,
    updatedAt: null,
    maxProfitMultiple: 10n,
    events: 0,
    venue: TOTALS(),
    days: [],
    markets: {},
    traders: {},
    open: {},
    marketHistory: emptyHistory(),
  };
}

/** Engine `PositionMath.pricePnl`: profits rounded down, losses up. */
export function pricePnl(size, entry, price, isLong) {
  if (entry === 0n) return 0n;
  const profit = isLong ? price >= entry : price <= entry;
  const diff = price > entry ? price - entry : entry - price;
  const n = size * diff;
  return profit ? n / entry : -((n + entry - 1n) / entry);
}

function bucketAt(list, i) {
  const last = list[list.length - 1];
  if (last && last.i === i) return last;
  if (!last || last.i < i) {
    const b = BUCKET(i);
    list.push(b);
    return b;
  }
  let at = list.findIndex((b) => b.i >= i);
  if (at === -1) at = list.length;
  if (list[at]?.i === i) return list[at];
  const b = BUCKET(i);
  list.splice(at, 0, b);
  return b;
}

const lower = (x) => String(x).toLowerCase();

function touch(t, time) {
  if (!t.firstTime || time < t.firstTime) t.firstTime = time;
  if (time > t.lastTime) t.lastTime = time;
}

/** Applies one decoded event. `state` is mutated. Events must arrive in chain order. */
export function applyEvent(state, ev) {
  const a = ev.args;
  const time = ev.time;
  state.events += 1;

  if (ev.name === "MaxProfitMultipleSet") {
    state.maxProfitMultiple = BigInt(a.maxProfitMultiple);
    return;
  }
  if (ev.name === "MarketListed" || ev.name === "MarketSettled") {
    const m = (state.markets[lower(a.priceId)] ??= MARKET());
    if (ev.name === "MarketListed") m.symbol = String(a.symbol);
    else m.settlementPrice = BigInt(a.settlementPrice);
    return;
  }

  if (!POSITION_EVENTS.has(ev.name)) {
    state.events -= 1;
    return;
  }
  const key = lower(a.key);
  const traderId = lower(a.trader);
  const pos = state.open[key];
  const marketId = a.priceId !== undefined ? lower(a.priceId) : (pos?.market ?? null);
  const trader = (state.traders[traderId] ??= TRADER());
  const market = marketId ? (state.markets[marketId] ??= MARKET()) : null;
  const venue = state.venue;
  const all = market ? [trader, market, venue] : [trader, venue];
  for (const t of all) touch(t, time);
  if (!trader.firstBlock) trader.firstBlock = ev.block;
  trader.lastBlock = ev.block;

  // Buckets are created on first use, so a day only exists once something was traded, paid or realised in it.
  let buckets = null;
  const add = (field, amount) => {
    for (const t of all) t[field] += amount;
  };
  const addB = (field, amount) => {
    if (!buckets) {
      buckets = [bucketAt(trader.days, Math.floor(time / DAY)), bucketAt(trader.hours, Math.floor(time / HOUR)), bucketAt(state.days, Math.floor(time / DAY))];
      // Per market by the hour: rolling 24 h volume, fees and trades for the Markets page.
      if (market) buckets.push(bucketAt(market.hours, Math.floor(time / HOUR)));
    }
    for (const b of buckets) b[field] += amount;
  };
  const side = (isLong) => (marketId ? [trader[isLong ? "long" : "short"], (trader.markets[marketId] ??= SIDE())] : [trader[isLong ? "long" : "short"]]);
  const volume = (amount, isLong) => {
    add("volume", amount);
    addB("v", amount);
    if (isLong === undefined) return;
    if (market) market[isLong ? "longVolume" : "shortVolume"] += amount;
    for (const s of side(isLong)) s.volume += amount;
  };
  const fee = (amount) => {
    add("fees", amount);
    addB("f", amount);
  };
  const realise = (amount, released) => {
    add("realised", amount);
    add("margin", released);
    addB("r", amount);
    addB("m", released);
  };
  const funding = (size, exitPrice, pnl, released, p) => {
    if (!p || pnl >= released * state.maxProfitMultiple) return;
    add("funding", pricePnl(size, p.entry, exitPrice, p.long) - pnl);
  };
  // A round trip ends: count it once, with everything it realised and paid.
  const finish = (net, isLong, liquidated) => {
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
      for (const s of side(isLong)) {
        s.trades += 1;
        if (net > 0n) s.wins += 1;
        else if (net < 0n) s.losses += 1;
        s.net += net;
      }
    }
    delete state.open[key];
  };

  switch (ev.name) {
    case "PositionOpened": {
      const size = BigInt(a.size);
      const f = BigInt(a.fee);
      state.open[key] = {
        trader: traderId,
        market: marketId,
        long: Boolean(a.isLong),
        size,
        margin: BigInt(a.margin),
        entry: BigInt(a.entryPrice),
        fees: f,
        realised: 0n,
        openTime: time,
        openBlock: ev.block,
      };
      add("opens", 1);
      volume(size, Boolean(a.isLong));
      fee(f);
      break;
    }
    case "PositionIncreased": {
      const f = BigInt(a.fee);
      const p = (state.open[key] ??= {
        trader: traderId,
        market: marketId,
        long: Boolean(a.isLong),
        size: 0n,
        margin: 0n,
        entry: 0n,
        fees: 0n,
        realised: 0n,
        openTime: time,
        openBlock: ev.block,
      });
      p.size = BigInt(a.newSize);
      p.margin = BigInt(a.newMargin);
      p.entry = BigInt(a.newEntryPrice);
      p.fees += f;
      add("increases", 1);
      volume(BigInt(a.addedSize), Boolean(a.isLong));
      fee(f);
      break;
    }
    case "MarginAdded": {
      if (pos) pos.margin = BigInt(a.newMargin);
      add("marginAdds", 1);
      break;
    }
    case "PositionDecreased": {
      const closed = BigInt(a.closedSize);
      const released = BigInt(a.releasedMargin);
      const f = BigInt(a.fee);
      const pnl = BigInt(a.pnl);
      const realised = BigInt(a.payout) + f - released;
      add("decreases", 1);
      volume(closed, pos?.long);
      fee(f);
      realise(realised, released);
      funding(closed, BigInt(a.exitPrice), pnl, released, pos);
      if (pos) {
        pos.size -= closed;
        pos.margin -= released;
        pos.fees += f;
        pos.realised += realised;
        if (pos.size <= 0n) finish(pos.realised - pos.fees, pos.long, false);
      }
      break;
    }
    case "PositionClosed": {
      const f = BigInt(a.fee);
      const pnl = BigInt(a.pnl);
      // Without the open (the frontend aggregates partial windows) the margin is unknown: fall back to the PnL.
      const realised = pos ? BigInt(a.payout) + f - pos.margin : pnl;
      volume(pos ? pos.size : 0n, pos?.long);
      fee(f);
      realise(realised, pos ? pos.margin : 0n);
      if (pos) funding(pos.size, BigInt(a.exitPrice), pnl, pos.margin, pos);
      finish((pos ? pos.realised - pos.fees : 0n) + realised - f, pos?.long, false);
      break;
    }
    case "PositionLiquidated": {
      const margin = BigInt(a.margin);
      volume(pos ? pos.size : 0n, pos?.long);
      realise(-margin, margin);
      finish((pos ? pos.realised - pos.fees : 0n) - margin, pos?.long, true);
      break;
    }
  }
}

const POSITION_EVENTS = new Set(["PositionOpened", "PositionIncreased", "MarginAdded", "PositionDecreased", "PositionClosed", "PositionLiquidated"]);

/** Drops buckets older than the retention window, counted back from `now` (unix seconds). */
export function prune(state, now) {
  const firstDay = Math.floor(now / DAY) - (DAYS_KEPT - 1);
  const firstHour = Math.floor(now / HOUR) - (HOURS_KEPT - 1);
  state.days = state.days.filter((b) => b.i >= firstDay);
  for (const t of Object.values(state.traders)) {
    t.days = t.days.filter((b) => b.i >= firstDay);
    t.hours = t.hours.filter((b) => b.i >= firstHour);
  }
  for (const m of Object.values(state.markets)) m.hours = (m.hours ?? []).filter((b) => b.i >= firstHour);
  // Counted back from the latest sample (the chain's clock), so a pause in sampling never empties the history.
  state.marketHistory ??= emptyHistory();
  pruneHistory(state.marketHistory, state.marketHistory.sampledAt || now);
  boundHistory(state.marketHistory);
}

/** Sum of `field` over the hourly buckets of the `seconds` up to `now` (default: the last 24 hours, by the hour). */
export function recent(buckets, field, now, seconds = DAY) {
  const from = Math.floor((now - seconds) / HOUR) + 1;
  const to = Math.floor(now / HOUR);
  let total = typeof (buckets[0]?.[field] ?? 0n) === "bigint" ? 0n : 0;
  for (const b of buckets) if (b.i >= from && b.i <= to) total += b[field];
  return total;
}

// ─────────────────────────────── Market history ───────────────────────────────
//
// `marketHistory` in stats.json (optional: files without it still parse, and readers that do not know it ignore it):
//   { v: 1, sampledAt, hourly: { [marketId]: Point[] }, fine: { [marketId]: Point[] } }
// A Point is [i, f, l, s, p]:
//   i  hour number (hourly) or 5-minute number (fine): unix seconds / 3600 or / 300, floored
//   f  funding, annualised, in basis points (the engine's rate per second x seconds in a year); positive: longs pay
//   l  long open interest, whole USDC        s  short open interest, whole USDC (skew = l - s)
//   p  oracle mid price to 7 significant digits, or null when the market had no usable price
// One sample per run; a later sample in the same hour (or 5 minutes) replaces the earlier one. Hourly points are kept
// for 30 days and fine points for 24 hours. With many markets only those with the most open interest are kept
// (MAX_HOURLY_MARKETS / MAX_FINE_MARKETS), so the file stays small: about 30 kB per market at most.

export const FINE = 300;
export const HISTORY_HOURS = 30 * 24;
export const FINE_POINTS = 24 * 12;
export const MAX_HOURLY_MARKETS = 32;
export const MAX_FINE_MARKETS = 16;
const YEAR = 365 * DAY;

export function emptyHistory() {
  return { v: 1, sampledAt: 0, hourly: {}, fine: {} };
}

/** A point's figures from one EngineLens.getMarkets() view (as viem decodes it: bigints). */
export function samplePoint(view) {
  const rate = BigInt(view.fundingRate);
  const f = Number((rate * BigInt(YEAR) * 10_000n) / 10n ** 18n);
  const l = Number(BigInt(view.market.longOi) / 1_000_000n);
  const s = Number(BigInt(view.market.shortOi) / 1_000_000n);
  const mid = view.hasPrice ? Number(BigInt(view.price.mid)) / 1e18 : 0;
  const p = mid > 0 && Number.isFinite(mid) ? Number(mid.toPrecision(7)) : null;
  return { f, l, s, p };
}

function put(list, row) {
  const i = row[0];
  const last = list[list.length - 1];
  if (!last || last[0] < i) {
    list.push(row);
    return;
  }
  if (last[0] === i) {
    list[list.length - 1] = row;
    return;
  }
  // Out of order (a sample older than the last one): replace or insert in place.
  const at = list.findIndex((r) => r[0] >= i);
  if (list[at][0] === i) list[at] = row;
  else list.splice(at, 0, row);
}

/** Records one sample of every market at `time` (unix seconds). `history` is mutated. */
export function sampleMarkets(history, views, time) {
  const hour = Math.floor(time / HOUR);
  const fine = Math.floor(time / FINE);
  for (const view of views) {
    const id = String(view.id).toLowerCase();
    const { f, l, s, p } = samplePoint(view);
    put((history.hourly[id] ??= []), [hour, f, l, s, p]);
    put((history.fine[id] ??= []), [fine, f, l, s, p]);
  }
  if (time > history.sampledAt) history.sampledAt = time;
}

/** Drops hourly points older than 30 days and fine points older than 24 hours, counted back from `now`. */
export function pruneHistory(history, now) {
  const firstHour = Math.floor(now / HOUR) - (HISTORY_HOURS - 1);
  const firstFine = Math.floor(now / FINE) - (FINE_POINTS - 1);
  for (const [series, first] of [
    [history.hourly, firstHour],
    [history.fine, firstFine],
  ]) {
    for (const [id, list] of Object.entries(series)) {
      const kept = list.filter((r) => r[0] >= first);
      if (kept.length > 0) series[id] = kept;
      else delete series[id];
    }
  }
}

/** Keeps at most `maxHourly` / `maxFine` markets: those with the most open interest at their latest point. */
export function boundHistory(history, maxHourly = MAX_HOURLY_MARKETS, maxFine = MAX_FINE_MARKETS) {
  for (const [series, max] of [
    [history.hourly, maxHourly],
    [history.fine, maxFine],
  ]) {
    const ids = Object.keys(series);
    if (ids.length <= max) continue;
    const oi = (id) => {
      const last = series[id][series[id].length - 1];
      return last ? last[2] + last[3] : 0;
    };
    for (const id of ids.sort((a, b) => oi(b) - oi(a) || a.localeCompare(b)).slice(max)) delete series[id];
  }
}

const isPoint = (r) =>
  Array.isArray(r) &&
  r.length === 5 &&
  Number.isInteger(r[0]) &&
  Number.isFinite(r[1]) &&
  Number.isFinite(r[2]) &&
  Number.isFinite(r[3]) &&
  (r[4] === null || Number.isFinite(r[4]));

/** Reads `marketHistory` from a parsed file; anything malformed is dropped rather than failing the file. */
export function readHistory(raw) {
  const out = emptyHistory();
  if (!raw || typeof raw !== "object" || raw.v !== 1) return out;
  out.sampledAt = Number(raw.sampledAt) || 0;
  for (const name of ["hourly", "fine"]) {
    for (const [id, list] of Object.entries(raw[name] ?? {})) {
      if (!Array.isArray(list)) continue;
      const points = list.filter(isPoint).sort((a, b) => a[0] - b[0]);
      if (points.length > 0) out[name][id.toLowerCase()] = points;
    }
  }
  return out;
}

const GET_MARKETS = encodeFunctionData({ abi: engineLensAbi, functionName: "getMarkets" });

/** Samples EngineLens.getMarkets() at the latest block into `state.marketHistory`. Returns the number of markets. */
export async function sampleFromLens(rpc, lens, state) {
  const latest = await rpc.call("eth_getBlockByNumber", ["latest", false]);
  if (!latest) throw new Error("no latest block");
  const time = Number(BigInt(latest.timestamp));
  const data = await rpc.call("eth_call", [{ to: lens, data: GET_MARKETS }, latest.number]);
  const views = decodeFunctionResult({ abi: engineLensAbi, functionName: "getMarkets", data });
  state.marketHistory ??= emptyHistory();
  sampleMarkets(state.marketHistory, views, time);
  return views.length;
}

// ─────────────────────────────── File format ───────────────────────────────

/** Recursively turns bigints into decimal strings. */
function plain(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = plain(v);
    return out;
  }
  return value;
}

/** Reads `raw` with the field types of `template` (bigint fields from strings; missing fields take the default). */
function shaped(template, raw) {
  const out = { ...template };
  if (!raw || typeof raw !== "object") return out;
  for (const [k, v] of Object.entries(template)) {
    const r = raw[k];
    if (r === undefined || r === null) continue;
    if (typeof v === "bigint") out[k] = BigInt(r);
    else if (typeof v === "number") out[k] = Number(r) || 0;
    else if (typeof v === "string") out[k] = String(r);
    else if (typeof v === "boolean") out[k] = Boolean(r);
  }
  return out;
}

export function serialize(state) {
  return plain({ ...state, venue: { ...state.venue, traders: Object.keys(state.traders).length } });
}

export function deserialize(json) {
  if (!json || json.schema !== SCHEMA) return null;
  const state = emptyState({ chainId: Number(json.chainId), engine: String(json.engine ?? ""), deployBlock: Number(json.deployBlock) || 0, deployTime: Number(json.deployTime) || 0 });
  state.cursorBlock = Number(json.cursorBlock);
  state.cursorTime = Number(json.cursorTime) || 0;
  state.updatedAt = json.updatedAt ?? null;
  state.maxProfitMultiple = BigInt(json.maxProfitMultiple ?? 10);
  state.events = Number(json.events) || 0;
  state.venue = shaped(TOTALS(), json.venue);
  state.days = (json.days ?? []).map((b) => shaped(BUCKET(0), b));
  for (const [id, m] of Object.entries(json.markets ?? {})) {
    const market = shaped(MARKET(), m);
    market.hours = (m.hours ?? []).map((b) => shaped(BUCKET(0), b));
    state.markets[id] = market;
  }
  for (const [id, t] of Object.entries(json.traders ?? {})) {
    const trader = shaped(TRADER(), t);
    trader.best = t.best === null || t.best === undefined ? null : BigInt(t.best);
    trader.worst = t.worst === null || t.worst === undefined ? null : BigInt(t.worst);
    trader.long = shaped(SIDE(), t.long);
    trader.short = shaped(SIDE(), t.short);
    trader.markets = {};
    for (const [mid, s] of Object.entries(t.markets ?? {})) trader.markets[mid] = shaped(SIDE(), s);
    trader.days = (t.days ?? []).map((b) => shaped(BUCKET(0), b));
    trader.hours = (t.hours ?? []).map((b) => shaped(BUCKET(0), b));
    state.traders[id] = trader;
  }
  const OPEN = { trader: "", market: "", long: false, size: 0n, margin: 0n, entry: 0n, fees: 0n, realised: 0n, openTime: 0, openBlock: 0 };
  for (const [key, p] of Object.entries(json.open ?? {})) state.open[key] = shaped(OPEN, p);
  state.marketHistory = readHistory(json.marketHistory);
  return state;
}

// ─────────────────────────────── RPC ───────────────────────────────

export class RpcError extends Error {
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RATE_LIMITED = /rate.?limit|too many requests|request limit|capacity|throttl|per second/i;
/** True for errors that mean "ask for fewer blocks": block-range caps and result-size caps. */
export function isRangeError(error) {
  const msg = String(error?.message ?? error);
  if (RATE_LIMITED.test(msg)) return false;
  return (
    error?.code === -32005 ||
    error?.code === -32602 ||
    error?.code === -32600 ||
    /range|limit|exceed|too (many|large|big)|more than|10,?000|response size|timeout|timed out/i.test(msg)
  );
}

/**
 * JSON-RPC over fetch across a list of endpoints. A rate-limited endpoint (HTTP 429, or an RPC error saying so) is
 * retried after a backoff that honours Retry-After; a failing one (network, timeout, 5xx) passes the call to the
 * next. Other RPC errors are thrown as RpcError so the caller can react (a range error shrinks the request).
 */
export function makeRpc(urls, { timeoutMs = 20_000, attempts = 8, log = () => {} } = {}) {
  let current = 0;
  let id = 1;
  async function call(method, params) {
    let lastError = null;
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      const url = urls[current % urls.length];
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      let wait = 0;
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ jsonrpc: "2.0", id: id++, method, params }),
          signal: controller.signal,
        });
        if (res.status === 429) {
          const after = Number(res.headers.get("retry-after"));
          wait = Number.isFinite(after) && after > 0 ? after * 1000 : 0;
          throw new RpcError(`HTTP 429 from ${url}`, 429);
        }
        if (!res.ok) throw new RpcError(`HTTP ${res.status} from ${url}`, res.status);
        const body = await res.json();
        if (body.error) {
          const error = new RpcError(String(body.error.message ?? "RPC error"), body.error.code);
          if (!RATE_LIMITED.test(error.message)) throw Object.assign(error, { final: true });
          throw error;
        }
        return body.result;
      } catch (error) {
        if (error?.final) throw error;
        lastError = error;
        const limited = error?.code === 429 || RATE_LIMITED.test(String(error?.message));
        const backoff = wait || Math.min(15_000, 400 * 2 ** attempt) * (0.6 + Math.random() * 0.8);
        log(`rpc ${method}: ${error?.message ?? error}; ${limited ? `backing off ${Math.round(backoff)} ms` : "trying the next endpoint"}`);
        current += 1;
        await sleep(limited ? backoff : Math.min(backoff, 1_500));
      } finally {
        clearTimeout(timer);
      }
    }
    throw lastError ?? new Error(`${method} failed`);
  }
  return { call, urls };
}

const hex = (n) => `0x${n.toString(16)}`;

/** First block at which `address` has code: binary search on eth_getCode. Needs an RPC that serves historical state. */
export async function findDeployBlock(hasCode, head) {
  if (!(await hasCode(head))) throw new Error("the engine has no code at the head block (wrong address or chain?)");
  let lo = 0;
  let hi = head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (await hasCode(mid)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** First block whose timestamp is at or after `time`: binary search on headers (fallback when state is pruned). */
export async function findBlockAtTime(timeOfBlock, head, time) {
  let lo = 0;
  let hi = head;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if ((await timeOfBlock(mid)) >= time) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

// ─────────────────────────────── Run ───────────────────────────────

const ARC_TESTNET_RPCS = [
  "https://rpc.testnet.arc.io",
  "https://rpc.quicknode.testnet.arc.io",
  "https://rpc.drpc.testnet.arc.io",
  "https://rpc.blockdaemon.testnet.arc.io",
  "https://5042002.rpc.thirdweb.com",
];

function settings(env) {
  const file = env.DEPLOYMENT;
  const d = file ? JSON.parse(readFileSync(file, "utf8")) : {};
  const engine = env.PERP_ENGINE_ADDRESS || d.engine;
  if (!/^0x[0-9a-fA-F]{40}$/.test(engine || "")) throw new Error("missing engine address (DEPLOYMENT file or PERP_ENGINE_ADDRESS)");
  const chainId = Number(env.CHAIN_ID || d.chainId || 5042002);
  const urls = [
    ...new Set([
      ...(env.RPC_URLS ? env.RPC_URLS.split(/[\s,]+/).filter(Boolean) : []),
      ...(env.RPC_URL ? [env.RPC_URL] : []),
      ...(d.rpcUrl ? [d.rpcUrl] : []),
      ...(chainId === 5042002 ? ARC_TESTNET_RPCS : []),
    ]),
  ];
  if (!urls.length) throw new Error("set RPC_URL or RPC_URLS");
  const deployedAt = d.deployedAt ? Math.floor(Date.parse(d.deployedAt) / 1000) : null;
  const lens = env.ENGINE_LENS_ADDRESS || d.lens || "";
  return {
    engine: engine.toLowerCase(),
    lens: /^0x[0-9a-fA-F]{40}$/.test(lens) ? lens.toLowerCase() : null,
    chainId,
    urls,
    deployedAt: Number.isFinite(deployedAt) ? deployedAt : null,
    statsFile: resolve(env.STATS_FILE || "stats.json"),
    startBlock: env.START_BLOCK ? Number(env.START_BLOCK) : null,
    maxSeconds: Number(env.MAX_SECONDS || 240),
    logRange: Math.max(1, Number(env.LOG_RANGE || 10_000)),
    safetyBlocks: Math.max(0, Number(env.SAFETY_BLOCKS ?? 10)),
  };
}

function writeAtomic(file, state) {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, JSON.stringify(serialize(state)));
  renameSync(tmp, file);
}

export async function runIndexer(opts, log = (...m) => console.log(new Date().toISOString(), "[indexer]", ...m)) {
  const started = Date.now();
  const rpc = makeRpc(opts.urls, { log: (m) => log(m) });
  const chainId = Number(BigInt(await rpc.call("eth_chainId", [])));
  if (chainId !== opts.chainId) throw new Error(`RPC is chain ${chainId}, expected ${opts.chainId}`);
  const head = Number(BigInt(await rpc.call("eth_blockNumber", [])));
  const target = Math.max(0, head - opts.safetyBlocks);

  const blockTimes = new Map();
  const timeOfBlock = async (n) => {
    if (blockTimes.has(n)) return blockTimes.get(n);
    const b = await rpc.call("eth_getBlockByNumber", [hex(n), false]);
    if (!b) throw new Error(`block ${n} not found`);
    const t = Number(BigInt(b.timestamp));
    blockTimes.set(n, t);
    if (blockTimes.size > 5_000) blockTimes.delete(blockTimes.keys().next().value);
    return t;
  };

  let state = null;
  if (existsSync(opts.statsFile)) {
    try {
      state = deserialize(JSON.parse(readFileSync(opts.statsFile, "utf8")));
    } catch (error) {
      log(`could not read ${opts.statsFile} (${error.message}); starting over`);
    }
    if (state && (state.engine !== opts.engine || state.chainId !== opts.chainId)) {
      log(`stats file is for engine ${state.engine} on chain ${state.chainId}; starting over for ${opts.engine}`);
      state = null;
    }
    if (state && state.cursorBlock > head) {
      log(`stats cursor ${state.cursorBlock} is past the head ${head} (chain reset?); starting over`);
      state = null;
    }
  }

  if (!state) {
    let deployBlock = opts.startBlock;
    if (deployBlock === null) {
      try {
        deployBlock = await findDeployBlock(async (n) => ((await rpc.call("eth_getCode", [opts.engine, hex(n)])) ?? "0x").length > 2, head);
      } catch (error) {
        if (!opts.deployedAt) throw error;
        log(`deploy block search on eth_getCode failed (${error.message}); searching by the deployment time instead`);
        // Ten minutes of margin before the recorded deployment time; the logs before the engine existed are empty.
        deployBlock = await findBlockAtTime(timeOfBlock, head, opts.deployedAt - 600);
      }
    }
    state = emptyState({ chainId: opts.chainId, engine: opts.engine, deployBlock, deployTime: await timeOfBlock(deployBlock) });
    log(`indexing ${opts.engine} on chain ${opts.chainId} from block ${deployBlock}`);
  }

  // Blocks per request: halved on a range error, and never grown past a size the node has refused in this run.
  let range = opts.logRange;
  let ceiling = opts.logRange;
  let from = state.cursorBlock + 1;
  let chunks = 0;
  let lastSave = Date.now();
  while (from <= target && Date.now() - started < opts.maxSeconds * 1000) {
    const to = Math.min(target, from + range - 1);
    let raw;
    try {
      raw = await rpc.call("eth_getLogs", [{ address: opts.engine, fromBlock: hex(from), toBlock: hex(to), topics: [TOPICS] }]);
    } catch (error) {
      if (range > 1 && isRangeError(error)) {
        range = Math.max(1, Math.floor(range / 2));
        ceiling = range;
        log(`eth_getLogs ${from}-${to}: ${error.message}; trying ${range} blocks`);
        continue;
      }
      throw error;
    }
    // Arc returns blockTimestamp on every log; other nodes need the header of each block that has events.
    const missing = [...new Set(raw.filter((l) => !l.blockTimestamp).map((l) => Number(BigInt(l.blockNumber))))];
    const anchors = missing.length <= 24 ? missing : missing.filter((_, i) => i % Math.ceil(missing.length / 24) === 0).concat(missing[missing.length - 1]);
    for (const n of anchors) await timeOfBlock(n);
    const sorted = [...blockTimes.entries()].sort((x, y) => x[0] - y[0]);
    const timeOf = (block, l) => {
      if (l?.blockTimestamp) return Number(BigInt(l.blockTimestamp));
      if (blockTimes.has(block)) return blockTimes.get(block);
      // Interpolate between the nearest fetched headers.
      let before = null;
      let after = null;
      for (const [n, t] of sorted) {
        if (n <= block) before = [n, t];
        else {
          after = [n, t];
          break;
        }
      }
      if (before && after) return before[1] + ((block - before[0]) / (after[0] - before[0])) * (after[1] - before[1]);
      return (before ?? after)?.[1] ?? Date.now() / 1000;
    };
    for (const ev of decodeLogs(raw, timeOf)) applyEvent(state, ev);
    state.cursorBlock = to;
    from = to + 1;
    chunks += 1;
    if (raw.length < 2_000 && range < ceiling) range = Math.min(ceiling, range * 2);
    if (Date.now() - lastSave > 60_000) {
      state.updatedAt = new Date().toISOString();
      writeAtomic(opts.statsFile, state);
      lastSave = Date.now();
    }
  }

  if (state.cursorBlock >= state.deployBlock) state.cursorTime = await timeOfBlock(state.cursorBlock);
  // One sample of funding and open interest per run; a failure costs this point only, never the run.
  let sampled = 0;
  if (opts.lens) {
    try {
      sampled = await sampleFromLens(rpc, opts.lens, state);
    } catch (error) {
      log(`market sample skipped: ${String(error?.shortMessage ?? error?.message ?? error).split("\n")[0]}`);
    }
  }
  state.updatedAt = new Date().toISOString();
  prune(state, Math.max(state.cursorTime, Math.floor(Date.now() / 1000)));
  writeAtomic(opts.statsFile, state);
  const behind = target - state.cursorBlock;
  log(
    `cursor ${state.cursorBlock} (head ${head}${behind > 0 ? `, ${behind} blocks still to read` : ""}), ${chunks} log requests, ` +
      `${state.events} events, ${Object.keys(state.traders).length} traders, ${Object.keys(state.open).length} open positions, ` +
      `${sampled} markets sampled -> ${opts.statsFile}`,
  );
  return { state, head, behind };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  runIndexer(settings(process.env)).catch((error) => {
    console.error(new Date().toISOString(), "[indexer] failed:", error?.message ?? error);
    if (process.env.GITHUB_ACTIONS) console.log(`::warning::indexer failed: ${String(error?.message ?? error).slice(0, 500)}`);
    process.exit(1);
  });
}
