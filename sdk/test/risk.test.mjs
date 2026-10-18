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

// ── v3.1: adding to a position, partial closes, ladders ──
import { closeSizeOf, ladderPrices, mergedPosition, partialClose } from "../dist/index.js";

test("adding to a long: entry is size over units (the harmonic mean), rounded up", () => {
  const m = mergedPosition({ position: { size: usd(10_000), margin: usd(1_000), entry: price(100_000), isLong: true }, add: { size: usd(10_000), margin: usd(1_000), price: price(110_000) } });
  assert.equal(m.size, usd(20_000));
  assert.equal(m.margin, usd(2_000));
  assert.equal(m.leverage, 10);
  // 20,000 / (10,000/100,000 + 10,000/110,000) = 104,761.904761904761904761...
  assert.ok(m.entry >= 104_761_904_761_904_761_904_761n && m.entry <= 104_761_904_761_904_761_904_763n);
  // At 110,000 the merged position is worth the first part's +1,000.
  const pnl = (m.size * (price(110_000) - m.entry)) / m.entry;
  assert.ok(pnl <= usd(1_000) && pnl >= usd(1_000) - 2n);
  assert.ok(m.liquidationPrice > 0n && m.liquidationPrice < m.entry);
});

test("adding to a short rounds the entry down", () => {
  const m = mergedPosition({ position: { size: usd(10_000), margin: usd(1_000), entry: price(100_000), isLong: false }, add: { size: usd(10_000), margin: usd(1_000), price: price(90_000) } });
  const pnl = (m.size * (m.entry - price(90_000))) / m.entry;
  assert.ok(pnl <= usd(1_000) && pnl >= usd(1_000) - 2n);
});

test("partial close: margin in proportion, everything when the rest would be under the minimum", () => {
  assert.deepEqual(partialClose({ size: usd(10_000), margin: usd(1_000) }, usd(4_000)), { whole: false, releasedMargin: usd(400), remaining: { size: usd(6_000), margin: usd(600) } });
  assert.equal(partialClose({ size: usd(1_000), margin: usd(10) }, usd(600)).whole, true, "4 USDC would remain; the minimum is 5");
  assert.equal(partialClose({ size: usd(1_000), margin: usd(10) }, 0n).whole, true);
  assert.equal(partialClose({ size: usd(1_000), margin: usd(10) }, usd(1_001)).whole, true);
});

test("close size from size or fraction", () => {
  assert.equal(closeSizeOf(usd(1_000), {}), 0n);
  assert.equal(closeSizeOf(usd(1_000), { fraction: 0.25 }), usd(250));
  assert.equal(closeSizeOf(usd(1_000), { fraction: 1 }), 0n);
  assert.equal(closeSizeOf(usd(1_000), { size: usd(2_000) }), 0n, "more than the position closes it all");
  assert.throws(() => closeSizeOf(usd(1_000), { fraction: 0 }));
  assert.throws(() => closeSizeOf(usd(1_000), { size: 1n, fraction: 0.5 }));
});

test("ladder prices are evenly spaced and end exactly at `to`", () => {
  assert.deepEqual(ladderPrices(price(100), price(96), 5), [price(100), price(99), price(98), price(97), price(96)]);
  assert.deepEqual(ladderPrices(price(100), price(110), 1), [price(100)]);
  assert.throws(() => ladderPrices(price(100), price(110), 0));
});
