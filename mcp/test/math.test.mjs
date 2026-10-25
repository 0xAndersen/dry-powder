import assert from "node:assert/strict";
import { test } from "node:test";
import { normalizeSymbol } from "../src/context.mjs";
import { describeStrategy, effectiveShareBps, liquidationPrice, marginFor, removableMargin, settle, strategyConfig, validateStrategy } from "../src/math.mjs";

const usd = (x) => BigInt(Math.round(x * 1e6));
const px = (x) => BigInt(Math.round(x * 1e9)) * 10n ** 9n;
const ACCOUNT = "0x00000000000000000000000000000000000000aa";
const LEADER = "0x00000000000000000000000000000000000000bb";

test("Turbo settlement: the share of a win (rounded up, 5% off with a referrer), nothing on a loss", () => {
  assert.deepEqual(settle({ pnl: usd(50), margin: usd(10), upside: true }), { pnl: usd(50), fee: usd(10), payout: usd(50), toReferrer: 0n });
  assert.deepEqual(settle({ pnl: -usd(3), margin: usd(10), upside: true }), { pnl: -usd(3), fee: 0n, payout: usd(7), toReferrer: 0n });
  assert.equal(settle({ pnl: usd(1_000), margin: usd(10), upside: true }).payout, usd(90), "capped at 10x margin, less 20%");
  const ref = settle({ pnl: usd(100), margin: usd(10), upside: true, referred: true });
  assert.equal(ref.fee, usd(19));
  assert.equal(ref.toReferrer, usd(1.9));
  assert.equal(settle({ pnl: 1n, margin: usd(10), upside: true }).fee, 1n, "rounded up");
  assert.equal(effectiveShareBps(2_000n, true, 500n), 1_900n);
  assert.equal(effectiveShareBps(2_000n, false, 500n), 2_000n);
});

test("Standard settlement: the close fee out of what is left", () => {
  assert.deepEqual(settle({ pnl: -usd(9.9), margin: usd(10), closeFee: usd(0.5) }), { pnl: -usd(9.9), fee: usd(0.1), payout: 0n, toReferrer: 0n });
  assert.equal(settle({ pnl: usd(2), margin: usd(10), closeFee: usd(0.5) }).payout, usd(11.5));
});

test("5000x: liquidated by a 0.018% move", () => {
  const liq = liquidationPrice(px(100_000), usd(10), usd(50_000), true);
  assert.equal(liq, px(99_982));
  assert.equal(marginFor(usd(50_000), 5000), usd(10));
  assert.equal(liquidationPrice(px(100_000), usd(10), usd(50_000), false), px(100_018));
});

test("removable margin matches the engine's rule", () => {
  const p = { size: usd(1_000), margin: usd(100), entry: px(100_000), isLong: true, exitPrice: px(99_000), marketMaxLeverage: 5000, minMargin: usd(5) };
  assert.equal(removableMargin(p), usd(80));
  assert.equal(removableMargin({ ...p, agentMaxLeverage: 20 }), usd(50));
  assert.equal(removableMargin({ ...p, margin: usd(15) }), 0n);
});

test("strategy configs and the contract's validation", () => {
  const market = { symbol: "BTC-USD-TURBO", enabled: true, maxLeverage: 5000, expiry: 0 };
  const trend = strategyConfig({ kind: "trend", interval: 300, margin: usd(10), leverage: 100, fastPeriod: 12, slowPeriod: 26, bandBps: 10, stopLossBps: 50 });
  assert.deepEqual(validateStrategy(trend, market, usd(5), ACCOUNT, 0), []);
  assert.equal(trend.kind, 0);
  assert.equal(trend.leader, "0x0000000000000000000000000000000000000000");
  const copy = strategyConfig({ kind: "copy", interval: 60, margin: usd(20), leverage: 10, leader: LEADER, ratioBps: 5_000, maxSize: usd(2_000), bandBps: 99 });
  assert.equal(copy.bandBps, 0, "fields of other kinds are dropped");
  assert.deepEqual(validateStrategy(copy, market, usd(5), ACCOUNT, 0), []);
  const mr = strategyConfig({ kind: "meanRevert", interval: 900, margin: usd(10), leverage: 5, period: 20, bandBps: 150, exitBps: 30 });
  assert.deepEqual(validateStrategy(mr, market, usd(5), ACCOUNT, 0), []);
  const bad = (c) => validateStrategy(c, market, usd(5), ACCOUNT, 0).join(" | ");
  assert.match(bad({ ...trend, slowPeriod: 12 }), /slowPeriod/);
  assert.match(bad({ ...trend, interval: 59 }), /intervalSeconds/);
  assert.match(bad({ ...trend, takeProfitBps: 40 }), /wider than maxSlippageBps/);
  assert.match(bad({ ...trend, leverage: 6000 }), /5000x/);
  assert.match(bad({ ...copy, leader: ACCOUNT }), /own account/);
  assert.match(bad({ ...mr, exitBps: 150 }), /exitBps/);
  assert.match(bad(strategyConfig({ kind: "grid", interval: 60, margin: usd(10), leverage: 1 })), /kind/);
});

test("strategy state reads back in plain words", () => {
  const config = strategyConfig({ kind: "trend", interval: 300, margin: usd(10), leverage: 100, fastPeriod: 12, slowPeriod: 26 });
  const s = describeStrategy(3n, { marketId: "0x01", config, state: { status: 2, target: 2, holding: 0, todo: true, refusals: 3, pendingAction: 2, pendingSide: 0, nextAt: 1_700_000_000n, actAt: 0n, samples: 30, pendingOrder: 0n, pendingSince: 0n, targetSize: 0n, actions: 4, emaFast: 0n, emaSlow: 0n, lastPrice: px(100_000), blockedAt: 0n } }, "BTC-USD-TURBO");
  assert.equal(s.status, "paused");
  assert.equal(s.target, "short");
  assert.equal(s.pendingOrder, null);
  assert.equal(s.lastPrice, 100_000);
  assert.equal(s.fastPeriod, 12);
  assert.equal(s.marginUsd, 10);
});

test("transient RPC errors are retried, sends never", async () => {
  const { custom } = await import("viem");
  const { retryTransient } = await import("../src/context.mjs");
  let reads = 0;
  let sends = 0;
  const t = retryTransient(custom({
    async request({ method }) {
      if (method === "eth_sendRawTransaction") sends += 1;
      else reads += 1;
      if (method === "eth_sendRawTransaction" || reads < 3) throw { code: -32602, message: "BlockOutOfRangeError: block height is 9 but requested was 8" };
      return "0x2";
    },
  }, { retryCount: 0 }))({ retryCount: 0 });
  assert.equal(await t.request({ method: "eth_call", params: [] }), "0x2");
  assert.equal(reads, 3);
  await assert.rejects(t.request({ method: "eth_sendRawTransaction", params: ["0x"] }));
  assert.equal(sends, 1);
});

test("market shorthand", () => {
  assert.equal(normalizeSymbol("btc"), "BTC-USD");
  assert.equal(normalizeSymbol("btc-turbo"), "BTC-USD-TURBO");
  assert.equal(normalizeSymbol("ETH-USD-TURBO"), "ETH-USD-TURBO");
  assert.equal(normalizeSymbol("eth-btc"), "ETH-BTC");
});
