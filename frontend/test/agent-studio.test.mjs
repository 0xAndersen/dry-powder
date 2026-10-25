// Agent Studio: strategy defaults and checks (they must mirror Strategies._validate), the approval plan, listings,
// and the backtest replay (its signal must match the contract's integer arithmetic).
// Run from frontend/ with: node --test test/agent-studio.test.mjs   (Node 22.18+ strips the TypeScript types on import)
import assert from "node:assert/strict";
import test from "node:test";
import { pickResolution, runBacktest } from "../src/lib/backtest.ts";
import {
  STRATEGY_LIMITS,
  bpsText,
  defaultsFor,
  everyText,
  fromConfig,
  planPolicy,
  toConfig,
  validateDraft,
  validateListing,
} from "../src/lib/strategies.ts";

const market = (over = {}) => ({ id: "0x01", symbol: "BTC-USD", base: "BTC", kind: "perp", maxLeverage: 1000, upside: false, enabled: true, expiry: 0, ...over });
const MARKETS = [
  market(),
  market({ symbol: "EUR-USD", base: "EUR", kind: "fx", maxLeverage: 500 }),
  market({ symbol: "XAU-USD", base: "XAU", kind: "perp", maxLeverage: 500 }),
  market({ symbol: "JPY-USD", base: "JPY", kind: "fx", maxLeverage: 100 }),
  market({ symbol: "BTC-USD-TURBO", base: "BTC", kind: "turbo", maxLeverage: 5000, upside: true }),
  market({ symbol: "XAU-USD-TURBO", base: "XAU", kind: "turbo", maxLeverage: 2500, upside: true }),
];
const LEADER = "0x00000000000000000000000000000000000000aa";
const ACCOUNT = "0x00000000000000000000000000000000000000bb";
const ctx = (m = market(), over = {}) => ({ market: m, minMargin: 10_000_000n, now: 1_700_000_000, account: ACCOUNT, collateralSymbol: "tUSDC", ...over });

/** Strategies._validate, transcribed: true when the contract would accept the config. */
function contractAccepts(c, m, account, minMargin, now) {
  const L = STRATEGY_LIMITS;
  if (c.interval < L.minInterval || c.interval > L.maxInterval || c.maxSlippageBps === 0 || c.maxSlippageBps > L.maxSlippageBps || c.leverage === 0 || c.margin < minMargin) return false;
  if (!m.enabled || c.leverage > m.maxLeverage || (m.expiry !== 0 && now >= m.expiry)) return false;
  if (c.stopLossBps !== 0 && (c.stopLossBps < L.minBracketBps || c.stopLossBps > L.maxBracketBps)) return false;
  if (c.takeProfitBps !== 0 && (c.takeProfitBps <= c.maxSlippageBps || c.takeProfitBps < L.minBracketBps || c.takeProfitBps > L.maxBracketBps)) return false;
  const zero = "0x0000000000000000000000000000000000000000";
  if (c.kind === 0) {
    return !(c.period < L.minPeriod || c.slowPeriod > L.maxPeriod || c.period >= c.slowPeriod || c.bandBps > L.maxBandBps || c.exitBps !== 0 || c.ratioBps !== 0 || c.leader !== zero || c.maxSize !== 0n);
  }
  if (c.kind === 1) {
    return !(c.period < L.minPeriod || c.period > L.maxPeriod || c.slowPeriod !== 0 || c.bandBps === 0 || c.bandBps > L.maxBandBps || c.exitBps >= c.bandBps || c.ratioBps !== 0 || c.leader !== zero || c.maxSize !== 0n);
  }
  return !(c.leader === zero || c.leader.toLowerCase() === account.toLowerCase() || c.ratioBps === 0 || c.ratioBps > L.maxRatioBps || c.maxSize === 0n || c.period !== 0 || c.slowPeriod !== 0 || c.bandBps !== 0 || c.exitBps !== 0);
}

test("the defaults of every template on every kind of market pass the contract's checks", () => {
  for (const m of MARKETS) {
    for (const kind of ["trend", "meanRevert", "copy"]) {
      const d = defaultsFor(kind, m, { minMargin: 10_000_000n });
      if (kind === "copy") d.leader = LEADER;
      assert.deepEqual(validateDraft(d, ctx(m)), [], `${kind} on ${m.symbol}`);
      assert.ok(contractAccepts(toConfig(d), m, ACCOUNT, 10_000_000n, 1_700_000_000), `${kind} on ${m.symbol} (contract)`);
      assert.ok(d.leverage >= 1 && d.leverage <= m.maxLeverage);
      if (d.stopLossBps) assert.ok(d.stopLossBps * d.leverage <= 4_500, "the stop sits at most half way to liquidation");
    }
  }
  // Upside markets get more leverage than their Standard twins; quieter markets get tighter bands.
  assert.ok(defaultsFor("trend", MARKETS[4]).leverage > defaultsFor("trend", MARKETS[0]).leverage);
  assert.ok(defaultsFor("meanRevert", MARKETS[1]).bandBps < defaultsFor("meanRevert", MARKETS[0]).bandBps);
  // A minimum margin above the default wins; the personal cap limits leverage.
  assert.equal(defaultsFor("trend", market(), { minMargin: 250_000_000n }).margin, 250_000_000n);
  assert.equal(defaultsFor("trend", MARKETS[4], { maxLeverage: 4 }).leverage, 4);
});

test("the form's checks refuse exactly what the contract refuses", () => {
  const base = { ...defaultsFor("trend", market()), interval: 300, slippageBps: 50 };
  const cases = [
    [{ interval: 59 }, "interval"],
    [{ interval: 86_401 }, "interval"],
    [{ slippageBps: 0 }, "slippageBps"],
    [{ slippageBps: 501 }, "slippageBps"],
    [{ leverage: 0 }, "leverage"],
    [{ leverage: 1001 }, "leverage"],
    [{ margin: 9_999_999n }, "margin"],
    [{ stopLossBps: 9 }, "stopLossBps"],
    [{ stopLossBps: 5_001 }, "stopLossBps"],
    [{ takeProfitBps: 50 }, "takeProfitBps"],
    [{ takeProfitBps: 5_001 }, "takeProfitBps"],
    [{ period: 1 }, "period"],
    [{ period: 21, slowPeriod: 21 }, "slowPeriod"],
    [{ slowPeriod: 201 }, "slowPeriod"],
    [{ bandBps: 2_001 }, "bandBps"],
  ];
  for (const [change, field] of cases) {
    const d = { ...base, ...change };
    const issues = validateDraft(d, ctx());
    assert.ok(issues.some((i) => i.field === field), `${JSON.stringify(change, (_, v) => (typeof v === "bigint" ? `${v}` : v))} flags ${field}`);
    assert.equal(contractAccepts(toConfig(d), market(), ACCOUNT, 10_000_000n, 1_700_000_000), false);
  }
  assert.deepEqual(validateDraft({ ...base, takeProfitBps: 51 }, ctx()), []);
  assert.deepEqual(validateDraft({ ...base, bandBps: 0 }, ctx()), [], "a trend band may be zero");

  const mr = defaultsFor("meanRevert", market());
  for (const [change, field] of [[{ bandBps: 0 }, "bandBps"], [{ exitBps: mr.bandBps }, "exitBps"], [{ period: 201 }, "period"]]) {
    const d = { ...mr, ...change };
    assert.ok(validateDraft(d, ctx()).some((i) => i.field === field));
    assert.equal(contractAccepts(toConfig(d), market(), ACCOUNT, 10_000_000n, 1_700_000_000), false);
  }

  const copy = { ...defaultsFor("copy", market()), leader: LEADER };
  for (const [change, field] of [[{ leader: null }, "leader"], [{ leader: ACCOUNT }, "leader"], [{ ratioBps: 0 }, "ratioBps"], [{ ratioBps: 100_001 }, "ratioBps"], [{ maxSize: 0n }, "maxSize"]]) {
    const d = { ...copy, ...change };
    assert.ok(validateDraft(d, ctx()).some((i) => i.field === field));
  }

  assert.ok(validateDraft(base, ctx(market({ enabled: false }))).some((i) => i.field === "market"));
  assert.ok(validateDraft(base, ctx(market({ expiry: 1_600_000_000 }))).some((i) => i.field === "market"));
  assert.ok(validateDraft(base, ctx(null)).some((i) => i.field === "market"));
  const capped = validateDraft({ ...base, leverage: 30 }, ctx(market(), { personalMaxLeverage: 25 }));
  assert.match(capped[0].message, /own cap is 25x/);
});

test("drafts become the contract's Config with unused fields zeroed, and back", () => {
  const trend = { ...defaultsFor("trend", market()), exitBps: 7, ratioBps: 9, leader: LEADER, maxSize: 5n };
  const c = toConfig(trend);
  assert.equal(c.kind, 0);
  assert.equal(c.exitBps, 0);
  assert.equal(c.ratioBps, 0);
  assert.equal(c.leader, "0x0000000000000000000000000000000000000000");
  assert.equal(c.maxSize, 0n);
  const copy = { ...defaultsFor("copy", market()), leader: LEADER, period: 5, slowPeriod: 9, bandBps: 3, exitBps: 1 };
  const cc = toConfig(copy);
  assert.deepEqual([cc.kind, cc.period, cc.slowPeriod, cc.bandBps, cc.exitBps, cc.leader], [2, 0, 0, 0, 0, LEADER]);
  assert.deepEqual(fromConfig(cc), { ...copy, period: 0, slowPeriod: 0, bandBps: 0, exitBps: 0 });
});

test("the approval plan keeps the larger of each limit and skips a signature when nothing needs to change", () => {
  const now = 1_700_000_000;
  const keepFor = 30 * 86_400;
  const first = planPolicy({ current: null, need: { leverage: 5, margin: 100_000_000n }, now, keepFor });
  assert.equal(first.change, true);
  assert.deepEqual(first.next, { expiry: BigInt(now + keepFor), maxLeverage: 5, maxMargin: 100_000_000n });

  const current = { expiry: BigInt(now + keepFor - 3_600), maxLeverage: 10, maxMargin: 500_000_000n };
  const covered = planPolicy({ current, need: { leverage: 5, margin: 100_000_000n }, now, keepFor });
  assert.equal(covered.change, false, "an hour short of the wanted expiry is close enough");

  const more = planPolicy({ current, need: { leverage: 20, margin: 100_000_000n }, live: [{ leverage: 10, margin: 800_000_000n }], now, keepFor });
  assert.equal(more.change, true);
  assert.deepEqual(more.next, { expiry: BigInt(now + keepFor), maxLeverage: 20, maxMargin: 800_000_000n });

  const lapsed = planPolicy({ current: { expiry: BigInt(now - 1), maxLeverage: 50, maxMargin: 1n }, need: { leverage: 5, margin: 100_000_000n }, live: [{ leverage: 8, margin: 200_000_000n }], now, keepFor });
  assert.equal(lapsed.change, true);
  assert.match(lapsed.reason, /lapsed/);
  assert.deepEqual(lapsed.next, { expiry: BigInt(now + keepFor), maxLeverage: 8, maxMargin: 200_000_000n }, "a lapsed approval does not carry its old limits over");
});

test("listings are checked in bytes, as the registry checks them", () => {
  assert.deepEqual(validateListing({ name: "Trend bot", description: "", kind: "trend", uri: "" }), []);
  assert.ok(validateListing({ name: "", description: "", kind: "trend", uri: "" }).some((i) => i.field === "name"));
  assert.ok(validateListing({ name: "é".repeat(25), description: "", kind: "trend", uri: "" }).some((i) => i.field === "name"), "25 two-byte letters are 50 bytes");
  assert.deepEqual(validateListing({ name: "é".repeat(24), description: "", kind: "trend", uri: "" }), []);
  assert.ok(validateListing({ name: "x", description: "d".repeat(281), kind: "trend", uri: "" }).some((i) => i.field === "description"));
  assert.ok(validateListing({ name: "x", description: "", kind: "", uri: "" }).some((i) => i.field === "kind"));
  assert.ok(validateListing({ name: "x", description: "", kind: "trend", uri: `https://${"a".repeat(250)}` }).some((i) => i.field === "uri"));
});

test("words for settings", () => {
  assert.equal(bpsText(15), "0.15%");
  assert.equal(bpsText(100), "1%");
  assert.equal(bpsText(50), "0.5%");
  assert.equal(bpsText(1_250), "12.5%");
  assert.equal(everyText(900), "15 min");
  assert.equal(everyText(86_400), "1 day");
  assert.equal(everyText(120), "2 min");
});

// ─────────────────────────────── Backtest ───────────────────────────────

const FEES = { mode: "standard", baseFeeBps: 5, feeCapBps: 1_000, spreadBps: 2, executionFee: 0.1, profitShareBps: 2_000, maxProfitMultiple: 10 };
const UPSIDE = { ...FEES, mode: "upside" };
const flatCandle = (time, price) => ({ time, open: price, high: price, low: price, close: price });
const series = (prices, step = 60) => prices.map((p, i) => flatCandle(1_700_000_000 + i * step, p));

/** A seeded random walk. */
function walk(n, start, vol, seed = 7) {
  let x = seed;
  const rand = () => ((x = (x * 1_103_515_245 + 12_345) % 2_147_483_648) / 2_147_483_648);
  const out = [];
  let p = start;
  for (let i = 0; i < n; i++) {
    p *= 1 + (rand() - 0.5) * vol;
    out.push(p);
  }
  return out;
}

/** Strategies._sample for trend and mean reversion in 1e18 integers, as the contract computes it. */
function contractTargets(kind, prices, c) {
  const WAD = 10n ** 18n;
  const BPS = 10_000n;
  const emaStep = (e, p, period) => {
    const alpha = (2n * WAD) / (BigInt(period) + 1n);
    return (p * alpha + e * (WAD - alpha)) / WAD;
  };
  let target = 0; // flat, long, short = 0, 1, 2
  let samples = 0;
  let fast = 0n;
  let slow = 0n;
  const out = [];
  for (const price of prices) {
    const mid = BigInt(Math.round(price * 1e6)) * 10n ** 12n;
    let want = target;
    if (kind === "trend") {
      const a = samples === 0 ? mid : emaStep(fast, mid, c.period);
      const b = samples === 0 ? mid : emaStep(slow, mid, c.slowPeriod);
      fast = a;
      slow = b;
      samples++;
      if (samples >= c.slowPeriod) {
        if (a * BPS > b * (BPS + BigInt(c.bandBps))) want = 1;
        else if (a * BPS < b * (BPS - BigInt(c.bandBps))) want = c.allowShort ? 2 : 0;
      }
    } else {
      const a = fast;
      if (samples >= c.period) {
        const p = mid * BPS;
        if (p < a * (BPS - BigInt(c.bandBps))) want = 1;
        else if (p > a * (BPS + BigInt(c.bandBps))) want = c.allowShort ? 2 : 0;
        else if (want === 1 && p >= a * (BPS - BigInt(c.exitBps))) want = 0;
        else if (want === 2 && p <= a * (BPS + BigInt(c.exitBps))) want = 0;
      }
      fast = samples === 0 ? mid : emaStep(a, mid, c.period);
      samples++;
    }
    target = want;
    out.push(["flat", "long", "short"][target]);
  }
  return out;
}

/** The side the replay holds after each reading, with no stops so it only follows the signal. */
function replayTargets(kind, prices, c) {
  const r = runBacktest(series(prices), 60, { kind, interval: 60, margin: 100, leverage: 2, allowShort: c.allowShort, stopLossBps: 0, takeProfitBps: 0, period: c.period, slowPeriod: c.slowPeriod ?? 0, bandBps: c.bandBps, exitBps: c.exitBps ?? 0 }, FEES);
  return r.points.map((p) => p.held);
}

test("the replay's signal matches the contract's integer arithmetic, reading for reading", () => {
  const prices = walk(720, 100_000, 0.004);
  const trend = { period: 9, slowPeriod: 21, bandBps: 10, allowShort: true };
  assert.deepEqual(replayTargets("trend", prices, trend), contractTargets("trend", prices, trend));
  const longOnly = { ...trend, allowShort: false };
  assert.deepEqual(replayTargets("trend", prices, longOnly), contractTargets("trend", prices, longOnly));
  const mr = { period: 20, bandBps: 40, exitBps: 10, allowShort: true };
  const mrTargets = contractTargets("meanRevert", prices, mr);
  assert.deepEqual(replayTargets("meanRevert", prices, mr), mrTargets);
  assert.ok(mrTargets.includes("long") && mrTargets.includes("short"), "the walk exercises both sides");
});

test("readings are taken once per interval, on candle closes", () => {
  const prices = walk(120, 50, 0.01, 3);
  const r = runBacktest(series(prices), 60, { kind: "trend", interval: 300, margin: 100, leverage: 2, allowShort: true, stopLossBps: 0, takeProfitBps: 0, period: 3, slowPeriod: 5, bandBps: 0, exitBps: 0 }, FEES);
  assert.equal(r.readings, 24);
  assert.equal(r.warmup, 5);
  assert.equal(r.tooShort, false);
  assert.equal(pickResolution(1_800, [1, 5, 15, 60, 240, 1_440]), 900);
  assert.equal(pickResolution(14_400, [1, 5, 15, 60, 240, 1_440]), 14_400);
  assert.equal(pickResolution(60, [1, 5, 15, 60, 240, 1_440]), 60);
  const short = runBacktest(series(prices.slice(0, 10)), 60, { kind: "trend", interval: 60, margin: 100, leverage: 2, allowShort: true, stopLossBps: 0, takeProfitBps: 0, period: 9, slowPeriod: 21, bandBps: 0, exitBps: 0 }, FEES);
  assert.equal(short.tooShort, true);
  assert.equal(short.trades.length, 0);
});

test("a trend in a steady rise goes long after the warm-up and pays fees on both sides", () => {
  const prices = Array.from({ length: 60 }, (_, i) => 100 * (1 + i * 0.001));
  const cfg = { kind: "trend", interval: 60, margin: 100, leverage: 5, allowShort: true, stopLossBps: 0, takeProfitBps: 0, period: 3, slowPeriod: 8, bandBps: 0, exitBps: 0 };
  const r = runBacktest(series(prices), 60, cfg, FEES);
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  assert.equal(t.side, "long");
  assert.equal(t.exit, "open");
  assert.equal(t.entryTime, series(prices)[7].time + 60, "it acts at the eighth reading");
  // Entry at the ask (+1 bp half spread), exit valued at the bid; 5 bp each side plus the keeper fee each side.
  const entry = prices[7] * 1.0001;
  const exit = prices[59] * 0.9999;
  const gross = (500 * (exit - entry)) / entry;
  assert.ok(Math.abs(t.gross - gross) < 1e-9);
  assert.ok(Math.abs(t.fees - (0.25 + 0.1 + 0.25 + 0.1)) < 1e-9);
  assert.ok(Math.abs(r.net - (gross - 0.7)) < 1e-9);
  assert.equal(r.liquidations, 0);
});

test("high leverage is liquidated on the candle's low, and the stop goes first when it sits above", () => {
  const candles = series(Array.from({ length: 20 }, () => 100));
  // Readings 1..3 rise so a 2/3 trend goes long; then a candle dips 1% intrabar.
  candles[1] = flatCandle(candles[1].time, 101);
  candles[2] = flatCandle(candles[2].time, 102);
  for (let i = 3; i < 20; i++) candles[i] = flatCandle(candles[i].time, 102);
  candles[6] = { ...candles[6], low: 102 * 0.99 };
  const cfg = { kind: "trend", interval: 60, margin: 100, leverage: 500, allowShort: true, stopLossBps: 0, takeProfitBps: 0, period: 2, slowPeriod: 3, bandBps: 0, exitBps: 0 };
  const liq = runBacktest(candles, 60, cfg, FEES);
  assert.equal(liq.liquidations, 1);
  const t = liq.trades.find((x) => x.exit === "liquidation");
  assert.equal(t.gross, -100);
  assert.ok(Math.abs(t.net - (-100 - 10 - 0.1)) < 1e-9, "5 bp of 50,000 is capped at 10% of the margin, plus the keeper fee");

  const stopped = runBacktest(candles, 60, { ...cfg, leverage: 100, stopLossBps: 30 }, FEES);
  assert.equal(stopped.liquidations, 0);
  const s = stopped.trades.find((x) => x.exit === "stop");
  assert.ok(s && s.gross < 0 && s.gross > -100);
  assert.ok(stopped.maxDrawdown > 0);
});

test("Upside markets charge nothing on a loss and a share of a win, and profit stops at the cap", () => {
  const up = Array.from({ length: 30 }, (_, i) => (i < 4 ? 100 + i : 200));
  const cfg = { kind: "trend", interval: 60, margin: 10, leverage: 50, allowShort: true, stopLossBps: 0, takeProfitBps: 0, period: 2, slowPeriod: 3, bandBps: 0, exitBps: 0 };
  const r = runBacktest(series(up), 60, cfg, UPSIDE);
  const t = r.trades[0];
  assert.equal(t.side, "long");
  assert.equal(t.gross, 100, "capped at 10x the margin");
  assert.ok(Math.abs(t.fees - (0.1 + 0.1 + 20)) < 1e-9, "two keeper fees and 20% of the capped profit");

  // Long at 102, then the fall flips it short at 100: the long closes at a loss.
  const loss = runBacktest(series([100, 101, 102, 101, 100, 99, 98]), 60, { ...cfg, leverage: 2 }, UPSIDE);
  const lt = loss.trades[0];
  assert.equal(lt.side, "long");
  assert.equal(lt.exit, "signal");
  assert.ok(Math.abs(lt.gross - (20 * (100 - 102)) / 102) < 1e-9, "Upside fills at the mid");
  assert.ok(Math.abs(lt.fees - 0.2) < 1e-9, "a losing Upside trade pays only the keeper");
  assert.equal(loss.trades[1].side, "short");
});

test("mean reversion buys the dip and leaves inside the exit band", () => {
  const prices = [...Array(10).fill(100), 98, 98.5, 99.7, 100, 100, 100];
  const cfg = { kind: "meanRevert", interval: 60, margin: 100, leverage: 2, allowShort: false, stopLossBps: 0, takeProfitBps: 0, period: 5, slowPeriod: 0, bandBps: 100, exitBps: 30 };
  const r = runBacktest(series(prices), 60, cfg, FEES);
  assert.equal(r.trades.length, 1);
  const t = r.trades[0];
  assert.equal(t.side, "long");
  assert.equal(t.exit, "signal");
  assert.ok(t.entryPrice < 98.1 && t.exitPrice > 99.6);
  assert.ok(t.net > 0);
});
