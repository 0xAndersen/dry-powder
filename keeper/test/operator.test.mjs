import assert from "node:assert/strict";
import { test } from "node:test";
import { isLiquidatable, triggered } from "../src/operator.mjs";
import { FEEDS, quoteToPrice } from "../src/feeds.mjs";

const px = (bid, ask) => ({ bid: BigInt(bid), ask: BigInt(ask), mid: BigInt((bid + ask) / 2) });

test("trigger conditions mirror PerpEngine", () => {
  // LimitOpen: long fills at or below the trigger on the ask, short at or above on the bid.
  assert.equal(triggered(0, true, 100n, px(98, 100)), true);
  assert.equal(triggered(0, true, 99n, px(98, 100)), false);
  assert.equal(triggered(0, false, 98n, px(98, 100)), true);
  // TakeProfit on the mid.
  assert.equal(triggered(1, true, 99n, px(98, 100)), true);
  assert.equal(triggered(1, false, 99n, px(98, 100)), true);
  assert.equal(triggered(1, true, 100n, px(98, 100)), false);
  // StopLoss on the mid.
  assert.equal(triggered(2, true, 99n, px(98, 100)), true);
  assert.equal(triggered(2, false, 100n, px(98, 100)), false);
  // Close: 0 means any price; otherwise the worst acceptable price.
  assert.equal(triggered(3, true, 0n, px(98, 100)), true);
  assert.equal(triggered(3, true, 99n, px(98, 100)), false);
  assert.equal(triggered(3, false, 101n, px(98, 100)), true);
});

test("liquidation price semantics match the lens", () => {
  assert.equal(isLiquidatable(true, 0n, 1n), false, "long with lp 0 can never be liquidated");
  assert.equal(isLiquidatable(false, 0n, 1n), true, "short with lp 0 always is");
  assert.equal(isLiquidatable(true, 90n, 91n), false);
  assert.equal(isLiquidatable(true, 90n, 90n), true);
  assert.equal(isLiquidatable(false, 110n, 110n), true);
  assert.equal(isLiquidatable(false, 110n, 109n), false);
});

test("quote to oracle price: mid, conf = max(half spread, 1 bp)", () => {
  const btc = FEEDS[0];
  const { price, conf } = quoteToPrice(btc, 100_000, 100_002);
  assert.equal(price, 100_001n * 10n ** 8n);
  assert.equal(conf, BigInt(Math.ceil(10.0001 * 1e8)));
  const eur = FEEDS.find((f) => f.key === "EUR");
  const q = quoteToPrice(eur, 1.1, 1.1);
  assert.equal(q.price, 110_000n);
  assert.equal(q.conf, 11n);
});
