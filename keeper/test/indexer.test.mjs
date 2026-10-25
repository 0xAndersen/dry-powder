import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { encodeAbiParameters, encodeEventTopics, encodeFunctionResult, pad } from "viem";
import { engineLensAbi } from "../src/abi.mjs";
import {
  DAY,
  DAYS_KEPT,
  EVENT_ABI,
  FINE,
  FINE_POINTS,
  HISTORY_HOURS,
  HOUR,
  applyEvent,
  boundHistory,
  decodeLogs,
  deserialize,
  emptyHistory,
  emptyState,
  findBlockAtTime,
  findDeployBlock,
  isRangeError,
  pricePnl,
  prune,
  pruneHistory,
  readHistory,
  recent,
  runIndexer,
  sampleMarkets,
  samplePoint,
  serialize,
} from "../src/indexer.mjs";

const ENGINE = "0x00000000000000000000000000000000000000e1";
const ALICE = "0x000000000000000000000000000000000000a11c";
const BOB = "0x0000000000000000000000000000000000000b0b";
const BTC = "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43";
const ETH = "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace";
const usd = (n) => BigInt(Math.round(n * 1e6));
const px = (n) => BigInt(Math.round(n * 1e6)) * 10n ** 12n;
const key = (trader, market) => `0x${trader.slice(2).padStart(40, "0")}${market.slice(2, 26)}`;
// 2026-10-19 00:00 UTC, a Monday.
const T0 = 1_792_368_000;

let block = 100;
function ev(name, args, time) {
  block += 1;
  return { name, args, block, logIndex: 0, tx: `0x${block.toString(16).padStart(64, "0")}`, time };
}
const opened = (trader, market, isLong, margin, size, entry, fee, time) =>
  ev("PositionOpened", { key: key(trader, market), trader, priceId: market, isLong, margin, size, entryPrice: entry, fee }, time);
const closed = (trader, market, exit, pnl, fee, payout, time) =>
  ev("PositionClosed", { key: key(trader, market), trader, priceId: market, exitPrice: exit, pnl, fee, payout }, time);
const liquidated = (trader, market, price, margin, time) =>
  ev("PositionLiquidated", { key: key(trader, market), trader, liquidator: BOB, priceId: market, price, margin, liquidatorFee: margin / 20n, toVault: margin - margin / 20n }, time);
const fresh = () => emptyState({ chainId: 31337, engine: ENGINE, deployBlock: 1, deployTime: T0 - DAY });

test("a winning round trip: realised from the payout, fees on both sides, derived funding, buckets", () => {
  const s = fresh();
  // Long 1,000 notional at 100,000 with 100 margin; exits at 101,000: price PnL +10.00, 0.25 of funding owed.
  const size = usd(1_000);
  const margin = usd(100);
  const pricePart = pricePnl(size, px(100_000), px(101_000), true);
  assert.equal(pricePart, usd(10));
  const pnl = pricePart - usd(0.25);
  const closeFee = usd(0.5);
  applyEvent(s, opened(ALICE, BTC, true, margin, size, px(100_000), usd(0.6), T0 + 10));
  applyEvent(s, closed(ALICE, BTC, px(101_000), pnl, closeFee, margin + pnl - closeFee, T0 + 3_700));

  const t = s.traders[ALICE];
  assert.equal(t.opens, 1);
  assert.equal(t.trades, 1);
  assert.equal(t.wins, 1);
  assert.equal(t.losses, 0);
  assert.equal(t.realised, pnl, "realised is what the close returned beyond its margin, before its fee");
  assert.equal(t.fees, usd(1.1));
  assert.equal(t.funding, usd(0.25), "funding = price PnL at the exit minus the reported PnL");
  assert.equal(t.volume, size * 2n, "opened plus closed notional");
  assert.equal(t.margin, margin);
  assert.equal(t.best, pnl - usd(1.1));
  assert.equal(t.worst, pnl - usd(1.1));
  assert.equal(t.long.trades, 1);
  assert.equal(t.long.net, pnl - usd(1.1));
  assert.equal(t.short.trades, 0);
  assert.equal(t.markets[BTC].volume, size * 2n);
  assert.equal(t.firstTime, T0 + 10);
  assert.equal(t.lastTime, T0 + 3_700);
  assert.equal(Object.keys(s.open).length, 0);

  // Open fee in hour 0, the close in hour 1, both on day 0.
  assert.deepEqual(
    t.hours.map((b) => [b.i - Math.floor(T0 / HOUR), b.f, b.t]),
    [
      [0, usd(0.6), 0],
      [1, closeFee, 1],
    ],
  );
  assert.equal(t.days.length, 1);
  assert.equal(t.days[0].i, Math.floor(T0 / DAY));
  assert.equal(t.days[0].r - t.days[0].f, pnl - usd(1.1));
  assert.equal(t.days[0].m, margin);
  assert.equal(s.venue.trades, 1);
  assert.equal(s.markets[BTC].longVolume, size * 2n);
  assert.equal(s.days[0].v, size * 2n);
});

test("liquidation loses the margin; drawdown and losses are per trade", () => {
  const s = fresh();
  applyEvent(s, opened(ALICE, ETH, false, usd(50), usd(5_000), px(4_000), usd(1), T0 + 5));
  applyEvent(s, closed(ALICE, ETH, px(3_960), usd(50), usd(1), usd(50) + usd(50) - usd(1), T0 + 50));
  applyEvent(s, opened(ALICE, ETH, false, usd(50), usd(5_000), px(4_000), usd(1), T0 + 60));
  applyEvent(s, liquidated(ALICE, ETH, px(4_036), usd(50), T0 + 90));

  const t = s.traders[ALICE];
  assert.equal(t.trades, 2);
  assert.equal(t.wins, 1);
  assert.equal(t.losses, 1);
  assert.equal(t.liquidations, 1);
  assert.equal(t.realised, usd(50) - usd(50));
  assert.equal(t.fees, usd(3));
  assert.equal(t.best, usd(48));
  assert.equal(t.worst, -usd(51));
  assert.equal(t.grossWin, usd(48));
  assert.equal(t.grossLoss, usd(51));
  assert.equal(t.maxDrawdown, usd(51), "peak +48 after the win, then -51");
  assert.equal(t.cum, -usd(3));
  assert.equal(t.volume, usd(20_000), "the liquidated notional counts as closed");
  assert.equal(t.short.losses, 1);
  assert.equal(s.markets[ETH].liquidations, 1);
  assert.equal(s.venue.liquidations, 1);
  assert.equal(t.days[0].x, 1);
});

test("a capped profit skips the funding estimate; a loss beyond the margin is clamped by the payout", () => {
  const s = fresh();
  const margin = usd(10);
  applyEvent(s, opened(ALICE, BTC, true, margin, usd(1_000), px(100_000), 0n, T0));
  // Price PnL +200 would pay 200, but the cap is 10x margin = 100.
  applyEvent(s, closed(ALICE, BTC, px(120_000), usd(100), usd(0.5), margin + usd(100) - usd(0.5), T0 + 1));
  assert.equal(s.traders[ALICE].funding, 0n);
  assert.equal(s.traders[ALICE].realised, usd(100));

  applyEvent(s, opened(BOB, BTC, true, margin, usd(1_000), px(100_000), 0n, T0 + 2));
  // A gap through liquidation: the engine reports -15 but can only take the 10 of margin; the fee comes out of nothing.
  applyEvent(s, closed(BOB, BTC, px(98_500), -usd(15), 0n, 0n, T0 + 3));
  assert.equal(s.traders[BOB].realised, -margin);
  assert.equal(s.traders[BOB].worst, -margin);
});

test("v3.1: increase, margin top-up, partial decrease and final close make one trade", () => {
  const s = fresh();
  const k = key(ALICE, BTC);
  applyEvent(s, opened(ALICE, BTC, true, usd(100), usd(1_000), px(100_000), usd(1), T0));
  applyEvent(
    s,
    ev("PositionIncreased", { key: k, trader: ALICE, priceId: BTC, isLong: true, addedMargin: usd(100), addedSize: usd(1_000), price: px(102_000), fee: usd(1), newMargin: usd(200), newSize: usd(2_000), newEntryPrice: px(101_000) }, T0 + 10),
  );
  applyEvent(s, ev("MarginAdded", { key: k, trader: ALICE, amount: usd(50), newMargin: usd(250) }, T0 + 20));
  assert.equal(s.open[k].margin, usd(250));
  assert.equal(s.open[k].entry, px(101_000));

  // Close half at 103,000: price PnL on 1,000 from 101,000 = +19.80 (rounded down), no funding.
  const half = pricePnl(usd(1_000), px(101_000), px(103_000), true);
  applyEvent(
    s,
    ev("PositionDecreased", { key: k, trader: ALICE, priceId: BTC, exitPrice: px(103_000), closedSize: usd(1_000), releasedMargin: usd(125), pnl: half, fee: usd(0.5), payout: usd(125) + half - usd(0.5) }, T0 + DAY + 5),
  );
  let t = s.traders[ALICE];
  assert.equal(t.trades, 0, "a partial close is not a finished trade");
  assert.equal(t.decreases, 1);
  assert.equal(t.realised, half);
  assert.equal(t.funding, 0n);
  assert.equal(s.open[k].size, usd(1_000));
  assert.equal(s.open[k].margin, usd(125));

  const rest = pricePnl(usd(1_000), px(101_000), px(100_500), true);
  applyEvent(s, closed(ALICE, BTC, px(100_500), rest, usd(0.5), usd(125) + rest - usd(0.5), T0 + DAY + 50));
  t = s.traders[ALICE];
  assert.equal(t.trades, 1);
  const net = half + rest - usd(3);
  assert.equal(t.cum, net);
  assert.equal(net > 0n ? t.wins : t.losses, 1);
  assert.equal(t.volume, usd(1_000) * 4n, "open + increase + decrease + close");
  assert.equal(t.margin, usd(250), "released by the decrease and the close");
  assert.equal(t.increases, 1);
  assert.equal(t.marginAdds, 1);
  // Day 0 holds the open and increase fees; day 1 both exits and the finished trade.
  assert.deepEqual(
    t.days.map((b) => [b.i - Math.floor(T0 / DAY), b.f, b.t]),
    [
      [0, usd(2), 0],
      [1, usd(1), 1],
    ],
  );
  assert.equal(Object.keys(s.open).length, 0);
});

test("a decrease down to zero size finishes the trade", () => {
  const s = fresh();
  const k = key(ALICE, ETH);
  applyEvent(s, opened(ALICE, ETH, false, usd(20), usd(200), px(4_000), usd(0.1), T0));
  applyEvent(s, ev("PositionDecreased", { key: k, trader: ALICE, priceId: ETH, exitPrice: px(3_900), closedSize: usd(200), releasedMargin: usd(20), pnl: usd(5), fee: usd(0.1), payout: usd(24.9) }, T0 + 5));
  assert.equal(s.traders[ALICE].trades, 1);
  assert.equal(s.traders[ALICE].cum, usd(4.8));
  assert.equal(s.open[k], undefined);
});

test("closes whose open is unknown still count, without size, side or funding", () => {
  const s = fresh();
  applyEvent(s, closed(ALICE, BTC, px(100_000), usd(4), usd(0.2), usd(103.8), T0));
  const t = s.traders[ALICE];
  assert.equal(t.trades, 1);
  assert.equal(t.realised, usd(4), "falls back to the reported PnL");
  assert.equal(t.volume, 0n);
  assert.equal(t.long.trades + t.short.trades, 0);
});

test("market metadata and the profit multiple come from their events", () => {
  const s = fresh();
  applyEvent(s, ev("MarketListed", { priceId: BTC, symbol: "BTC-USD", feedId: BTC, quoteFeedId: `0x${"0".repeat(64)}`, invert: false, expiry: 0n }, T0));
  applyEvent(s, ev("MaxProfitMultipleSet", { maxProfitMultiple: 3n }, T0));
  applyEvent(s, ev("MarketSettled", { priceId: BTC, settlementPrice: px(99_000) }, T0));
  assert.equal(s.markets[BTC].symbol, "BTC-USD");
  assert.equal(s.markets[BTC].settlementPrice, px(99_000));
  assert.equal(s.maxProfitMultiple, 3n);
  assert.equal(Object.keys(s.traders).length, 0);
});

test("buckets older than the retention window are pruned; all-time totals stay", () => {
  const s = fresh();
  applyEvent(s, opened(ALICE, BTC, true, usd(10), usd(100), px(100_000), usd(0.1), T0));
  applyEvent(s, closed(ALICE, BTC, px(100_000), 0n, usd(0.1), usd(9.9), T0 + 60));
  applyEvent(s, opened(ALICE, BTC, true, usd(10), usd(100), px(100_000), usd(0.1), T0 + 70 * DAY));
  prune(s, T0 + 70 * DAY);
  const t = s.traders[ALICE];
  assert.equal(t.days.length, 1);
  assert.equal(t.days[0].i, Math.floor((T0 + 70 * DAY) / DAY));
  assert.ok(t.days[0].i - (DAYS_KEPT - 1) > Math.floor(T0 / DAY));
  assert.equal(t.hours.length, 1);
  assert.equal(t.trades, 1);
  assert.equal(t.fees, usd(0.3));
  assert.equal(s.days.length, 1);
});

test("markets keep hourly buckets: rolling 24 h volume, fees and trades; pruned like the traders'", () => {
  const s = fresh();
  applyEvent(s, opened(ALICE, BTC, true, usd(10), usd(1_000), px(100_000), usd(0.5), T0));
  applyEvent(s, closed(ALICE, BTC, px(101_000), usd(10), usd(0.5), usd(19.5), T0 + 2 * HOUR));
  applyEvent(s, opened(BOB, BTC, false, usd(20), usd(2_000), px(101_000), usd(1), T0 + 30 * HOUR));
  applyEvent(s, opened(BOB, ETH, true, usd(5), usd(500), px(4_000), usd(0.25), T0 + 30 * HOUR));
  const btc = s.markets[BTC];
  assert.equal(btc.hours.length, 3);
  assert.equal(recent(btc.hours, "v", T0 + 3 * HOUR), usd(2_000), "opened 1,000 and closed 1,000 in the last 24 h");
  assert.equal(recent(btc.hours, "f", T0 + 3 * HOUR), usd(1));
  assert.equal(recent(btc.hours, "t", T0 + 3 * HOUR), 1);
  // A day later only Bob's short is inside the window.
  assert.equal(recent(btc.hours, "v", T0 + 31 * HOUR), usd(2_000));
  assert.equal(recent(btc.hours, "v", T0 + 30 * HOUR, HOUR), usd(2_000));
  assert.equal(recent(s.markets[ETH].hours, "v", T0 + 31 * HOUR), usd(500));
  prune(s, T0 + 60 * HOUR);
  assert.deepEqual(s.markets[BTC].hours.map((b) => b.i), [Math.floor((T0 + 30 * HOUR) / HOUR)]);
  const back = deserialize(JSON.parse(JSON.stringify(serialize(s))));
  assert.equal(back.markets[BTC].hours[0].v, usd(2_000));
});

test("the file format round-trips exactly", () => {
  const s = fresh();
  applyEvent(s, opened(ALICE, BTC, true, usd(100), usd(1_000), px(100_000), usd(0.6), T0 + 10));
  applyEvent(s, closed(ALICE, BTC, px(99_000), -usd(10.2), usd(0.5), usd(89.3), T0 + 20));
  applyEvent(s, opened(BOB, ETH, false, usd(7), usd(700), px(4_000), usd(0.3), T0 + 30));
  s.cursorBlock = block;
  s.updatedAt = "2026-10-19T00:00:00.000Z";
  const text = JSON.stringify(serialize(s));
  const back = deserialize(JSON.parse(text));
  assert.equal(JSON.stringify(serialize(back)), text);
  assert.equal(back.traders[ALICE].worst, -usd(11.3));
  assert.equal(back.open[key(BOB, ETH)].size, usd(700));
  assert.equal(JSON.parse(text).venue.traders, 2);
  assert.equal(deserialize({ schema: 99 }), null, "another schema starts over");
});

// ─────────────────────────────── Market history ───────────────────────────────

const ZERO32 = `0x${"0".repeat(64)}`;
/** One EngineLens.getMarkets() entry as viem decodes it. */
function view(id, { rate = 0n, longOi = 0n, shortOi = 0n, mid = 0n, hasPrice = true, symbol = "BTC-USD" } = {}) {
  return {
    id,
    market: {
      enabled: true,
      invert: false,
      maxLeverage: 1000,
      lastFundingTime: 0n,
      expiry: 0n,
      feedId: id,
      quoteFeedId: ZERO32,
      maxOiPerSide: usd(5_000_000),
      skewScale: usd(1_000_000),
      longOi,
      shortOi,
      longUnits: 0n,
      shortUnits: 0n,
      fundingIndex: 0n,
      settlementPrice: 0n,
      symbol,
    },
    fundingRate: rate,
    hasPrice,
    price: { mid, bid: mid, ask: mid, publishTime: 0n },
  };
}
// 10% a year, per second, in 1e18.
const TEN_PCT = (10n ** 17n) / BigInt(365 * DAY);

test("a market sample: annualised funding in bp (sign = who pays), open interest in whole USDC, mid to 7 digits", () => {
  const p = samplePoint(view(BTC, { rate: TEN_PCT, longOi: usd(1_234_567.89), shortOi: usd(0.4), mid: px(106_450.123456) }));
  assert.ok(Math.abs(p.f - 1_000) <= 1, `10% a year is 1,000 bp (got ${p.f})`);
  assert.equal(p.l, 1_234_567, "whole USDC, rounded down");
  assert.equal(p.s, 0);
  assert.equal(p.p, 106_450.1);
  const shortsPay = samplePoint(view(BTC, { rate: -TEN_PCT * 3n }));
  assert.ok(Math.abs(shortsPay.f + 3_000) <= 1, "negative: shorts pay");
  assert.equal(samplePoint(view(BTC, { mid: px(100), hasPrice: false })).p, null, "no usable price: no mid");
  assert.equal(samplePoint(view(ETH, { mid: 6_689_123_456_789_012n })).p, 0.006689123, "small prices keep 7 significant digits");
});

test("samples bucket by the hour and by 5 minutes: a later sample in the same bucket replaces the earlier", () => {
  const h = emptyHistory();
  sampleMarkets(h, [view(BTC, { longOi: usd(100) }), view(ETH, { shortOi: usd(7) })], T0 + 10);
  sampleMarkets(h, [view(BTC, { longOi: usd(200) })], T0 + 290);
  sampleMarkets(h, [view(BTC, { longOi: usd(300) })], T0 + 310);
  assert.deepEqual(h.hourly[BTC], [[T0 / HOUR, 0, 300, 0, null]], "one point per hour: the latest");
  assert.deepEqual(
    h.fine[BTC].map((r) => [r[0], r[2]]),
    [
      [T0 / FINE, 200],
      [T0 / FINE + 1, 300],
    ],
  );
  assert.deepEqual(h.hourly[ETH], [[T0 / HOUR, 0, 0, 7, null]]);
  assert.equal(h.sampledAt, T0 + 310);
  // A sample older than the last one lands in its own place.
  sampleMarkets(h, [view(BTC, { longOi: usd(50) })], T0 - HOUR);
  assert.deepEqual(h.hourly[BTC].map((r) => r[0]), [T0 / HOUR - 1, T0 / HOUR]);
  assert.equal(h.sampledAt, T0 + 310);
});

test("history keeps 30 days hourly and 24 hours of 5-minute points, and only the markets with the most open interest", () => {
  const h = emptyHistory();
  for (let k = 0; k < HISTORY_HOURS + 50; k += 1) sampleMarkets(h, [view(BTC, { longOi: usd(1) })], T0 + k * HOUR);
  for (let k = 0; k < FINE_POINTS + 30; k += 1) sampleMarkets(h, [view(ETH, { shortOi: usd(2) })], T0 + k * FINE);
  const now = T0 + (HISTORY_HOURS + 49) * HOUR;
  pruneHistory(h, now);
  assert.equal(h.hourly[BTC].length, HISTORY_HOURS);
  assert.equal(h.hourly[BTC][0][0], Math.floor(now / HOUR) - HISTORY_HOURS + 1);
  assert.equal(h.fine[ETH], undefined, "5-minute points from a month ago are gone");
  assert.equal(h.fine[BTC].length, 24, "the last day of 5-minute buckets stays (BTC was sampled once an hour)");
  assert.ok(h.fine[BTC][0][0] > Math.floor(now / FINE) - FINE_POINTS);
  assert.ok(h.hourly[ETH] === undefined, "a market sampled only a month ago drops out");

  const many = emptyHistory();
  const ids = Array.from({ length: 6 }, (_, k) => `0x${String(k + 1).repeat(64)}`);
  sampleMarkets(many, ids.map((id, k) => view(id, { longOi: usd(1_000 * (k + 1)) })), T0);
  boundHistory(many, 4, 2);
  assert.deepEqual(Object.keys(many.hourly).sort(), ids.slice(2).sort(), "the four with the most open interest");
  assert.deepEqual(Object.keys(many.fine).sort(), ids.slice(4).sort());
});

test("market history round-trips in the file; old files and malformed points are read without failing", () => {
  const s = fresh();
  sampleMarkets(s.marketHistory, [view(BTC, { rate: TEN_PCT, longOi: usd(10), shortOi: usd(20), mid: px(100_000) })], T0);
  const text = JSON.stringify(serialize(s));
  const back = deserialize(JSON.parse(text));
  assert.equal(JSON.stringify(serialize(back)), text);
  assert.deepEqual(back.marketHistory.hourly[BTC][0].slice(2), [10, 20, 100_000]);

  const old = JSON.parse(text);
  delete old.marketHistory;
  assert.deepEqual(deserialize(old).marketHistory, emptyHistory(), "a file from before market history");
  const messy = readHistory({ v: 1, sampledAt: T0, hourly: { [BTC.toUpperCase().replace("0X", "0x")]: [[2, 1, 1, 1, null], ["x"], [1, 0, 0, 0, 5], [3, 0, 0, 0, "7"]] }, fine: { [ETH]: "nope" } });
  assert.deepEqual(messy.hourly[BTC].map((r) => r[0]), [1, 2], "valid points kept, in order; ids lower-cased");
  assert.deepEqual(messy.fine, {});
  assert.deepEqual(readHistory({ v: 2 }), emptyHistory(), "an unknown version starts empty");
});

// ─────────────────────────────── Logs and RPC ───────────────────────────────

function rawLog(eventName, args, blockNumber, logIndex = 0, extra = {}) {
  const item = EVENT_ABI.find((x) => x.name === eventName);
  const indexed = Object.fromEntries(item.inputs.filter((i) => i.indexed).map((i) => [i.name, args[i.name]]));
  const plain = item.inputs.filter((i) => !i.indexed);
  return {
    address: ENGINE,
    topics: encodeEventTopics({ abi: EVENT_ABI, eventName, args: indexed }),
    data: encodeAbiParameters(plain, plain.map((i) => args[i.name])),
    blockNumber: `0x${blockNumber.toString(16)}`,
    logIndex: `0x${logIndex.toString(16)}`,
    transactionHash: `0x${blockNumber.toString(16).padStart(64, "0")}`,
    ...extra,
  };
}

test("raw logs decode, v3.1 events included, in chain order with block timestamps", () => {
  const k = key(ALICE, BTC);
  const logs = [
    rawLog("PositionDecreased", { key: k, trader: ALICE, priceId: BTC, exitPrice: px(1), closedSize: 5n, releasedMargin: 1n, pnl: -2n, fee: 1n, payout: 0n }, 12, 1, { blockTimestamp: "0x10" }),
    rawLog("PositionOpened", { key: k, trader: ALICE, priceId: BTC, isLong: true, margin: 1n, size: 10n, entryPrice: px(1), fee: 0n }, 12, 0, { blockTimestamp: "0x10" }),
    { ...rawLog("PositionOpened", { key: k, trader: ALICE, priceId: BTC, isLong: true, margin: 1n, size: 10n, entryPrice: px(1), fee: 0n }, 13), topics: [pad("0x1234", { size: 32 })] },
  ];
  const out = decodeLogs(logs, (b, l) => (l.blockTimestamp ? Number(BigInt(l.blockTimestamp)) : 999));
  assert.deepEqual(out.map((e) => [e.name, e.logIndex, e.time]), [
    ["PositionOpened", 0, 16],
    ["PositionDecreased", 1, 16],
  ]);
  assert.equal(out[1].args.pnl, -2n);
  assert.equal(out[1].args.trader.toLowerCase(), ALICE);
});

test("deploy block search and time search are binary searches", async () => {
  let calls = 0;
  const deployed = 123_457;
  assert.equal(await findDeployBlock(async (n) => (calls++, n >= deployed), 1_000_000), deployed);
  assert.ok(calls < 25, `${calls} getCode calls`);
  await assert.rejects(findDeployBlock(async () => false, 10));
  assert.equal(await findBlockAtTime(async (n) => 1_000 + n * 0.5, 100_000, 21_000), 40_000);
});

test("range errors shrink the request; rate limits do not", () => {
  assert.equal(isRangeError({ code: -32005, message: "query returned more than 10000 results" }), true);
  assert.equal(isRangeError({ code: -32602, message: "block range is too large (max 10000)" }), true);
  assert.equal(isRangeError({ code: -32000, message: "eth_getLogs is limited to a 10,000 range" }), true);
  assert.equal(isRangeError({ code: -32005, message: "rate limit exceeded" }), false);
  assert.equal(isRangeError({ code: 429, message: "HTTP 429 from x" }), false);
  assert.equal(isRangeError({ code: -32601, message: "method not found" }), false);
});

/** A tiny JSON-RPC node: answers what the indexer asks, caps eth_getLogs ranges and rate-limits the first call. */
function fakeNode({ head, deployBlock, logs, maxRange, rateLimitFirst = true, timestamps = true, markets = null }) {
  const seen = { getLogs: 0, ranges: [], limited: 0, getCode: 0, calls: 0 };
  let first = rateLimitFirst;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const { id, method, params } = JSON.parse(body);
      const reply = (result) => res.end(JSON.stringify({ jsonrpc: "2.0", id, result }));
      const fail = (code, message) => res.end(JSON.stringify({ jsonrpc: "2.0", id, error: { code, message } }));
      if (method === "eth_chainId") return reply("0x7a69");
      if (method === "eth_blockNumber") return reply(`0x${head.toString(16)}`);
      if (method === "eth_getCode") {
        seen.getCode += 1;
        return reply(Number(BigInt(params[1])) >= deployBlock ? "0x6080" : "0x");
      }
      if (method === "eth_getBlockByNumber") {
        const n = params[0] === "latest" ? head : Number(BigInt(params[0]));
        return reply({ number: `0x${n.toString(16)}`, timestamp: `0x${(T0 + n).toString(16)}` });
      }
      if (method === "eth_call") {
        seen.calls += 1;
        if (!markets) return fail(-32000, "execution reverted");
        // One output that is an array: viem takes an array result as the list of outputs, so wrap it.
        return reply(encodeFunctionResult({ abi: engineLensAbi, functionName: "getMarkets", result: [markets] }));
      }
      if (method === "eth_getLogs") {
        if (first) {
          first = false;
          seen.limited += 1;
          res.statusCode = 429;
          res.setHeader("retry-after", "0");
          return res.end("slow down");
        }
        const from = Number(BigInt(params[0].fromBlock));
        const to = Number(BigInt(params[0].toBlock));
        seen.getLogs += 1;
        if (to - from + 1 > maxRange) return fail(-32602, `block range too large, max ${maxRange}`);
        seen.ranges.push([from, to]);
        const hit = logs.filter((l) => {
          const n = Number(BigInt(l.blockNumber));
          return n >= from && n <= to && params[0].topics[0].includes(l.topics[0]);
        });
        return reply(timestamps ? hit.map((l) => ({ ...l, blockTimestamp: `0x${(T0 + Number(BigInt(l.blockNumber))).toString(16)}` })) : hit);
      }
      fail(-32601, `method ${method} not found`);
    });
  });
  return new Promise((done) => server.listen(0, "127.0.0.1", () => done({ url: `http://127.0.0.1:${server.address().port}`, seen, close: () => server.close() })));
}

test("runIndexer: finds the deploy block, survives a 429 and a range cap, then resumes from its cursor", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dp-indexer-"));
  const statsFile = join(dir, "stats.json");
  const k = key(ALICE, BTC);
  const logs = [
    rawLog("MarketListed", { priceId: BTC, symbol: "BTC-USD", feedId: BTC, quoteFeedId: `0x${"0".repeat(64)}`, invert: false, expiry: 0n }, 5_000),
    rawLog("PositionOpened", { key: k, trader: ALICE, priceId: BTC, isLong: true, margin: usd(100), size: usd(1_000), entryPrice: px(100_000), fee: usd(0.6) }, 9_000),
    rawLog("PositionClosed", { key: k, trader: ALICE, priceId: BTC, exitPrice: px(101_000), pnl: usd(10), fee: usd(0.5), payout: usd(109.5) }, 26_000),
  ];
  const node = await fakeNode({ head: 30_010, deployBlock: 4_321, logs, maxRange: 5_000, timestamps: false });
  const quiet = () => {};
  const opts = { urls: [node.url], chainId: 31337, engine: ENGINE, statsFile, startBlock: null, deployedAt: null, maxSeconds: 60, logRange: 10_000, safetyBlocks: 10 };
  try {
    const first = await runIndexer(opts, quiet);
    assert.equal(first.state.deployBlock, 4_321);
    assert.equal(first.state.cursorBlock, 30_000, "stops SAFETY_BLOCKS behind the head");
    assert.equal(node.seen.limited, 1, "the 429 was retried");
    assert.ok(node.seen.ranges.every(([a, b]) => b - a + 1 <= 5_000), "requests shrank to the node's cap");
    const file = JSON.parse(readFileSync(statsFile, "utf8"));
    assert.equal(file.traders[ALICE].trades, 1);
    assert.equal(file.traders[ALICE].realised, usd(10).toString());
    assert.equal(file.markets[BTC].symbol, "BTC-USD");
    assert.equal(file.traders[ALICE].firstTime, T0 + 9_000, "time from the block header when logs have no timestamp");

    // A second run with nothing new reads no old ranges again.
    const before = node.seen.ranges.length;
    const second = await runIndexer({ ...opts }, quiet);
    assert.equal(second.state.cursorBlock, 30_000);
    assert.equal(node.seen.ranges.length, before);
    assert.equal(second.state.traders[ALICE].trades, 1, "nothing counted twice");

    // A file written for another engine is not resumed.
    writeFileSync(statsFile, JSON.stringify({ ...file, engine: "0x00000000000000000000000000000000000000e2" }));
    const reset = await runIndexer({ ...opts }, quiet);
    assert.equal(reset.state.deployBlock, 4_321);
    assert.equal(reset.state.traders[ALICE].trades, 1);
  } finally {
    node.close();
  }
});

test("runIndexer samples funding and open interest from the lens each run, and a failed sample costs only that point", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dp-indexer-"));
  const statsFile = join(dir, "stats.json");
  const LENS = "0x00000000000000000000000000000000000000f1";
  const markets = [view(BTC, { rate: TEN_PCT, longOi: usd(1_500), shortOi: usd(500), mid: px(100_000) }), view(ETH, { rate: -TEN_PCT, shortOi: usd(80), mid: px(4_000), symbol: "ETH-USD" })];
  const node = await fakeNode({ head: 7_200, deployBlock: 0, logs: [], maxRange: 10_000, rateLimitFirst: false, markets });
  const opts = { urls: [node.url], chainId: 31337, engine: ENGINE, lens: LENS, statsFile, startBlock: 0, deployedAt: null, maxSeconds: 60, logRange: 10_000, safetyBlocks: 0 };
  try {
    const first = await runIndexer(opts, () => {});
    const hour = Math.floor((T0 + 7_200) / HOUR);
    assert.deepEqual(first.state.marketHistory.hourly[BTC], [[hour, 999, 1_500, 500, 100_000]]);
    assert.deepEqual(first.state.marketHistory.fine[ETH][0].slice(1), [-999, 0, 80, 4_000]);
    const file = JSON.parse(readFileSync(statsFile, "utf8"));
    assert.equal(file.marketHistory.sampledAt, T0 + 7_200);
    assert.deepEqual(file.marketHistory.hourly[BTC][0], [hour, 999, 1_500, 500, 100_000]);

    // Without a lens nothing is asked; with a lens that fails, the run still writes the file and keeps old points.
    const calls = node.seen.calls;
    await runIndexer({ ...opts, lens: null }, () => {});
    assert.equal(node.seen.calls, calls);
    const broken = await fakeNode({ head: 7_300, deployBlock: 0, logs: [], maxRange: 10_000, rateLimitFirst: false, markets: null });
    try {
      const notes = [];
      const third = await runIndexer({ ...opts, urls: [broken.url] }, (m) => notes.push(m));
      assert.ok(notes.some((m) => /market sample skipped/.test(m)));
      assert.deepEqual(third.state.marketHistory.hourly[BTC], [[hour, 999, 1_500, 500, 100_000]]);
    } finally {
      broken.close();
    }
  } finally {
    node.close();
  }
});

test("runIndexer stops at its time budget and continues next run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "dp-indexer-"));
  const statsFile = join(dir, "stats.json");
  const node = await fakeNode({ head: 50_000, deployBlock: 0, logs: [], maxRange: 1_000, rateLimitFirst: false });
  const opts = { urls: [node.url], chainId: 31337, engine: ENGINE, statsFile, startBlock: 0, deployedAt: null, maxSeconds: 0, logRange: 1_000, safetyBlocks: 0 };
  try {
    const first = await runIndexer(opts, () => {});
    assert.equal(first.state.cursorBlock, -1, "no time: nothing read, nothing lost");
    const second = await runIndexer({ ...opts, maxSeconds: 60 }, () => {});
    assert.equal(second.state.cursorBlock, 50_000);
    assert.equal(second.behind, 0);
  } finally {
    node.close();
  }
});
