import assert from "node:assert/strict";
import { test } from "node:test";
import { makeMedianSource } from "../src/sources.mjs";

const feed = { key: "BTC" };
const fixed = (name, bid, ask) => ({ name, poll: async () => {}, quote: () => (bid === null ? null : { bid, ask, at: Date.now() }) });

test("three agreeing venues: the median mid, the widest band", () => {
  const src = makeMedianSource([fixed("a", 99_990, 100_010), fixed("b", 100_000, 100_020), fixed("c", 99_980, 100_000)]);
  const q = src.quote(feed);
  assert.equal((q.bid + q.ask) / 2, 100_000);
  assert.equal(q.ask - q.bid, 20);
  assert.equal(q.sources, 3);
});

test("one venue pushed 1% away is ignored", () => {
  const src = makeMedianSource([fixed("a", 101_000, 101_010), fixed("b", 100_000, 100_010), fixed("c", 100_002, 100_012)]);
  const q = src.quote(feed);
  assert.ok(Math.abs((q.bid + q.ask) / 2 - 100_006) < 1e-6);
  assert.equal(q.sources, 2);
});

test("two venues that disagree: no price at all", () => {
  let flagged = null;
  const src = makeMedianSource([fixed("a", 100_000, 100_010), fixed("b", 101_000, 101_010)], { onDisagree: (f, mids) => (flagged = mids) });
  assert.equal(src.quote(feed), null);
  assert.equal(flagged.length, 2);
});

test("a market only one venue lists keeps working", () => {
  const src = makeMedianSource([fixed("a", 1.0801, 1.0802), fixed("b", null, null)]);
  assert.equal(src.quote(feed).bid, 1.0801);
});

test("the primary must poll; the others are best effort", async () => {
  const failing = { name: "x", poll: async () => { throw new Error("down"); }, quote: () => null };
  await makeMedianSource([fixed("a", 1, 2), failing]).poll();
  await assert.rejects(makeMedianSource([failing, fixed("a", 1, 2)]).poll());
});
