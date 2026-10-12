import assert from "node:assert/strict";
import { test } from "node:test";
import { MAX_UINT256, ONE, OrderType, chunk, isLiquidatable, isTriggered, toEnginePrice } from "../src/math.js";

// Expected values below are the ones asserted in the Solidity test-suite (Oracle.t.sol, PerpEngine.t.sol),
// so this file pins the keeper's arithmetic to the contract's.

test("normalises a crypto price with its confidence band", () => {
  const px = toEnginePrice({ price: 100_000n * 10n ** 8n, conf: 500n * 10n ** 8n, expo: -8, publishTime: 7 }, false);
  assert.deepEqual(px, { mid: 100_000n * ONE, bid: 99_500n * ONE, ask: 100_500n * ONE, publishTime: 7 });
});

test("handles the exponent range the contract accepts", () => {
  assert.equal(toEnginePrice({ price: 100_000n, conf: 0n, expo: 0, publishTime: 0 }, false)?.mid, 100_000n * ONE);
  assert.equal(toEnginePrice({ price: 5n * ONE, conf: 0n, expo: -18, publishTime: 0 }, false)?.mid, 5n * ONE);
  assert.equal(toEnginePrice({ price: 1n, conf: 0n, expo: 1, publishTime: 0 }, false), null);
  assert.equal(toEnginePrice({ price: 1n, conf: 0n, expo: -19, publishTime: 0 }, false), null);
});

test("rejects non-positive prices", () => {
  assert.equal(toEnginePrice({ price: 0n, conf: 0n, expo: -8, publishTime: 0 }, false), null);
  assert.equal(toEnginePrice({ price: -5n, conf: 0n, expo: -8, publishTime: 0 }, false), null);
});

test("inverts USD/JPY into JPY/USD with the band rounded outwards", () => {
  const px = toEnginePrice({ price: 150_000n, conf: 150n, expo: -3, publishTime: 0 }, true);
  assert.ok(px);
  const one = ONE * ONE;
  assert.equal(px.mid, one / (150n * ONE));
  assert.equal(px.bid, one / (15_015n * 10n ** 16n));
  assert.equal(px.ask, one / (14_985n * 10n ** 16n) + 1n);
  assert.ok(px.bid < px.mid && px.mid < px.ask);
});

test("an inverted price that underflows is rejected", () => {
  assert.equal(toEnginePrice({ price: 2n ** 63n - 1n, conf: 0n, expo: 0, publishTime: 0 }, true), null);
});

test("liquidation check follows the contract's sentinels", () => {
  const liq = 99_100n * ONE;
  assert.equal(isLiquidatable(true, liq, liq), true);
  assert.equal(isLiquidatable(true, liq, liq + 1n), false);
  assert.equal(isLiquidatable(true, MAX_UINT256, 1n), true); // funding alone has sunk it
  assert.equal(isLiquidatable(true, 0n, 1n), false); // can never be liquidated
  assert.equal(isLiquidatable(false, 109_000n * ONE, 109_000n * ONE), true);
  assert.equal(isLiquidatable(false, 109_000n * ONE, 109_000n * ONE - 1n), false);
  assert.equal(isLiquidatable(false, 0n, 1n), true);
});

test("order triggers", () => {
  const px = { mid: 100n * ONE, bid: 99n * ONE, ask: 101n * ONE, publishTime: 0 };
  // Limit long needs ask <= trigger, limit short needs bid >= trigger.
  assert.equal(isTriggered(OrderType.LimitOpen, true, 101n * ONE, px), true);
  assert.equal(isTriggered(OrderType.LimitOpen, true, 100n * ONE, px), false);
  assert.equal(isTriggered(OrderType.LimitOpen, false, 99n * ONE, px), true);
  assert.equal(isTriggered(OrderType.LimitOpen, false, 100n * ONE, px), false);
  // Take-profit and stop-loss are evaluated at mid.
  assert.equal(isTriggered(OrderType.TakeProfit, true, 100n * ONE, px), true);
  assert.equal(isTriggered(OrderType.TakeProfit, true, 100n * ONE + 1n, px), false);
  assert.equal(isTriggered(OrderType.TakeProfit, false, 100n * ONE, px), true);
  assert.equal(isTriggered(OrderType.TakeProfit, false, 100n * ONE - 1n, px), false);
  assert.equal(isTriggered(OrderType.StopLoss, true, 100n * ONE, px), true);
  assert.equal(isTriggered(OrderType.StopLoss, true, 100n * ONE - 1n, px), false);
  assert.equal(isTriggered(OrderType.StopLoss, false, 100n * ONE, px), true);
  assert.equal(isTriggered(OrderType.StopLoss, false, 100n * ONE + 1n, px), false);
  assert.equal(isTriggered(9, true, 0n, px), false);
});

test("chunk", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
});
