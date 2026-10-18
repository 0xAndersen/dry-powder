// Unit tests for the SDK's risk math against the engine's rules (no network).
import assert from "node:assert/strict";
import { test } from "node:test";
import { assessRisk, feeCap, liquidationPrice, marginFor, needsKeeperOrders, price, profitCapPrice, riskLevel, usd } from "../dist/index.js";

const ENTRY = price(100_000);

test("1000x is liquidated by a 0.09% move, and needs keeper orders", () => {
  const r = assessRisk({ entry: ENTRY, size: usd(10_000), margin: usd(10), isLong: true });
  assert.equal(r.leverage, 1000);
  assert.equal(r.keeperOrdersOnly, true);
  assert.equal(r.liquidationPrice, price(99_910));
  assert.ok(Math.abs(r.liquidationMove - 0.0009) < 1e-9);
  assert.equal(r.level, "extreme");
  // Margin plus both fees at their 10% cap.
  assert.equal(r.maxLoss, usd(10) + usd(1) + usd(1));
  assert.equal(r.maxProfit, usd(100));
  assert.ok(Math.abs(r.profitCapMove - 0.01) < 1e-9);
});

test("100x is the most that can trade directly", () => {
  assert.equal(needsKeeperOrders(usd(1_000), usd(10)), false);
  assert.equal(needsKeeperOrders(usd(1_000) + 1n, usd(10)), true);
});

test("fee cap is 10% of margin", () => {
  assert.equal(feeCap(usd(10)), usd(1));
});

test("short liquidation is above entry; a 1x long liquidates after a 90% fall", () => {
  assert.equal(liquidationPrice(ENTRY, usd(100), usd(1_000), false), price(109_000));
  assert.equal(liquidationPrice(ENTRY, usd(100), usd(100), true), price(10_000));
});

test("profit cap price", () => {
  assert.equal(profitCapPrice(ENTRY, usd(10), usd(1_000), true), price(110_000));
  assert.equal(profitCapPrice(ENTRY, usd(10), usd(50), false), null);
});

test("a stop past liquidation is flagged", () => {
  const r = assessRisk({ entry: ENTRY, size: usd(10_000), margin: usd(10), isLong: true, stopLoss: price(99_800) });
  assert.equal(r.stopPastLiquidation, true);
  const ok = assessRisk({ entry: ENTRY, size: usd(10_000), margin: usd(10), isLong: true, stopLoss: price(99_950) });
  assert.equal(ok.stopPastLiquidation, false);
  assert.equal(ok.lossAtStop, -usd(5));
});

test("risk bands match the app", () => {
  assert.equal(riskLevel(0.2), "low");
  assert.equal(riskLevel(0.05), "moderate");
  assert.equal(riskLevel(0.015), "high");
  assert.equal(riskLevel(0.005), "extreme");
  assert.equal(riskLevel(null), "low");
});

test("margin rounds up so leverage is never exceeded", () => {
  assert.equal(marginFor(usd(1_000), 3), 333_333_334n);
});
