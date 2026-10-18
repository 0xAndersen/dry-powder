import assert from "node:assert/strict";
import { test } from "node:test";
import { gapsBracket, isLiquidatable, triggered } from "../src/operator.mjs";
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
  // StopOpen (v3.1): a long breaks out once the ask is at or above the trigger, a short once the bid is at or below.
  assert.equal(triggered(4, true, 100n, px(98, 100)), true);
  assert.equal(triggered(4, true, 101n, px(98, 100)), false);
  assert.equal(triggered(4, false, 98n, px(98, 100)), true);
  assert.equal(triggered(4, false, 97n, px(98, 100)), false);
});

test("an open order that would fill through its own bracket is left resting", () => {
  const order = (isLong, takeProfit, stopLoss) => ({ isLong, takeProfit: BigInt(takeProfit), stopLoss: BigInt(stopLoss) });
  assert.equal(gapsBracket(order(true, 0, 0), px(98, 100)), false);
  assert.equal(gapsBracket(order(true, 105, 95), px(98, 100)), false);
  assert.equal(gapsBracket(order(true, 100, 0), px(98, 100)), true, "long fills at the ask, on its take-profit");
  assert.equal(gapsBracket(order(true, 0, 100), px(98, 100)), true, "long fills at or under its stop");
  assert.equal(gapsBracket(order(false, 95, 105), px(98, 100)), false);
  assert.equal(gapsBracket(order(false, 98, 0), px(98, 100)), true, "short fills at the bid, on its take-profit");
  assert.equal(gapsBracket(order(false, 0, 97), px(98, 100)), true, "short fills at or above its stop");
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

test("gas headroom: a quarter more plus room for fresh storage slots", async () => {
  const { withHeadroom } = await import("../src/operator.mjs");
  assert.equal(withHeadroom(400_000n), 550_000n);
  assert.ok(withHeadroom(21_000n) > 21_000n * 2n);
});

test("a trailing stop moves only by a meaningful step", async () => {
  const { trailStepTooSmall } = await import("../src/operator.mjs");
  const E = 10n ** 18n;
  assert.equal(trailStepTooSmall(100_000n * E, 100_050n * E, 10), true, "0.05% is not worth a transaction");
  assert.equal(trailStepTooSmall(100_000n * E, 100_100n * E, 10), false, "0.1% is");
  assert.equal(trailStepTooSmall(100_000n * E, 99_800n * E, 10), false, "either direction (shorts trail down)");
});
