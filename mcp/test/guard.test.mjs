import assert from "node:assert/strict";
import { test } from "node:test";
import { ConfirmationStore, Guardrails, ToolError, fingerprint } from "../src/guard.mjs";
import { loadConfig } from "../src/context.mjs";

const m = { symbol: "BTC-USD", enabled: true, settled: false, expiry: 0, maxLeverage: 100 };
const code = (fn) => { try { fn(); } catch (e) { assert.ok(e instanceof ToolError); return e.code; } return null; };

test("guardrails: markets, notional, leverage, slippage, price band", () => {
  const g = new Guardrails({ allowedMarkets: ["ETH-USD"], maxNotional: 1_000_000_000n, maxLeverage: 10, maxSlippageBps: 100 });
  assert.equal(code(() => g.checkMarket(m)), "MARKET_NOT_ALLOWED");
  assert.equal(code(() => g.checkMarket({ ...m, symbol: "ETH-USD", enabled: false })), "MARKET_DISABLED");
  assert.equal(code(() => g.checkMarket({ ...m, symbol: "ETH-USD", settled: true })), "MARKET_SETTLED");
  assert.equal(code(() => g.checkNotional(1_000_000_001n)), "MAX_NOTIONAL_EXCEEDED");
  assert.equal(code(() => g.checkNotional(1_000_000_000n)), null);
  assert.equal(code(() => g.checkLeverage(m, 11)), "LEVERAGE_OUT_OF_RANGE");
  assert.equal(code(() => g.checkLeverage({ ...m, maxLeverage: 5 }, 6)), "LEVERAGE_OUT_OF_RANGE");
  assert.equal(code(() => g.checkLeverage(m, 10)), null);
  assert.equal(code(() => g.checkSlippage(101)), "SLIPPAGE_TOO_HIGH");
  const ref = 100_000n * 10n ** 18n;
  assert.equal(code(() => g.checkBand(m, true, (ref * 10_100n) / 10_000n, ref)), null);
  assert.equal(code(() => g.checkBand(m, true, (ref * 10_101n) / 10_000n, ref)), "PRICE_OUTSIDE_BAND");
  assert.equal(code(() => g.checkBand(m, false, (ref * 9_899n) / 10_000n, ref)), "PRICE_OUTSIDE_BAND");
  assert.equal(code(() => g.checkBand(m, true, ref / 2n, ref)), null, "a long limit below the market is fine");
});

test("confirmation tokens: single use, bound to the arguments, expire", () => {
  let now = 0;
  const s = new ConfirmationStore(1000, () => now);
  const a = { market: "BTC", sizeUsd: "10" };
  const { token } = s.issue("dp_open", fingerprint(a), null);
  assert.equal(code(() => s.consume(token, "dp_open", fingerprint({ ...a, sizeUsd: "11" }))), "TOKEN_MISMATCH");
  assert.equal(code(() => s.consume(token, "dp_open", fingerprint(a))), "UNKNOWN_TOKEN", "a mismatch burns the token");
  const t2 = s.issue("dp_open", fingerprint(a), null).token;
  assert.equal(code(() => s.consume(t2, "dp_close", fingerprint(a))), "UNKNOWN_TOKEN");
  const t3 = s.issue("dp_open", fingerprint(a), null).token;
  now = 2000;
  assert.equal(code(() => s.consume(t3, "dp_open", fingerprint(a))), "TOKEN_EXPIRED");
  assert.equal(fingerprint({ b: 1, a: 2, confirmToken: "x" }), fingerprint({ a: 2, b: 1 }));
});

test("config: agent key format, market shorthand, defaults", () => {
  const c = loadConfig({ DP_ALLOWED_MARKETS: "btc, ETH-BTC" });
  assert.deepEqual(c.guard.allowedMarkets, ["BTC-USD", "ETH-BTC"]);
  assert.equal(c.requireConfirm, true);
  assert.equal(loadConfig({ DP_ALLOWED_MARKETS: "*" }).guard.allowedMarkets, undefined);
  assert.equal(loadConfig({ DP_REQUIRE_CONFIRM: "false" }).requireConfirm, false);
  assert.equal(code(() => loadConfig({ DP_AGENT_KEY: "0x1234" })), "CONFIG_ERROR");
});
