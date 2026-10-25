// The tool layer through a real MCP client, against a stubbed chain (no network): Turbo quotes say "no fee unless
// you win" and show the share, the guardrails hold for orders and strategies, and owner-only steps come back as
// transactions for the owner to sign.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { decodeFunctionData } from "viem";
import { agentAccountAbi, agentRegistryAbi } from "../src/abi.mjs";
import { Context, ZERO, loadConfig } from "../src/context.mjs";
import { createServer } from "../src/server.mjs";

const usd = (x) => BigInt(Math.round(x * 1e6));
const px = (x) => BigInt(Math.round(x * 1e9)) * 10n ** 9n;
const ACCOUNT = "0x00000000000000000000000000000000000000aa";
const OWNER = "0x00000000000000000000000000000000000000cc";
const AGENT = "0x00000000000000000000000000000000000000dd";
const STRATEGIES = "0x0000000000000000000000000000000000005555";
const REGISTRY = "0x0000000000000000000000000000000000006666";
const NOW = 1_800_000_000;
const id = (n) => `0x${n.repeat(64)}`;
const lower = (args) => args.map((x) => (typeof x === "string" && /^0x[0-9a-fA-F]{40}$/.test(x) ? x.toLowerCase() : x));

/** A chain with BTC-USD (Standard, 1000x) and BTC-USD-TURBO (Upside, 5000x) at 100,000. */
class FakeContext extends Context {
  constructor(env, chain = {}) {
    super(loadConfig({ DP_ACCOUNT: ACCOUNT, DP_AGENT_KEY: `0x${"1".repeat(64)}`, DP_KRAKEN_URL: "http://127.0.0.1:1", ...env }));
    this.chain = { referrer: ZERO, strategiesApproval: [0n, 0, 0n], ...chain };
  }
  async _init() {
    this.d = { engine: "0xe", lens: "0xf", usdc: "0xc", token: null, factory: "0xfa", strategies: STRATEGIES, registry: REGISTRY, collateralIsTest: true, explorer: "x", app: null, chainId: 31337 };
    this.wallet = { account: { address: AGENT } };
    this.trader = ACCOUNT;
    this.owner = OWNER;
    const c = this.chain;
    const market = (symbol, feeMode, maxLeverage) => ({ symbol, feeMode, maxLeverage, enabled: true, invert: false, expiry: 0n, feedId: id("1"), quoteFeedId: id("0"), settlementPrice: 0n, longOi: 0n, shortOi: 0n, maxOiPerSide: usd(1e9) });
    const price = { mid: px(100_000), bid: px(99_990), ask: px(100_010), publishTime: BigInt(NOW - 1) };
    const reads = {
      getMarkets: () => [
        { id: id("2"), market: market("BTC-USD", 0, 1000), fundingRate: 0n, hasPrice: true, price },
        { id: id("3"), market: market("BTC-USD-TURBO", 1, 5000), fundingRate: 0n, hasPrice: true, price },
      ],
      getTraderPositions: () => [],
      getTraderOrders: () => [[], []],
      getPosition: () => ({ trader: ZERO, isLong: false, size: 0n, margin: 0n, entryPrice: 0n }),
      quoteOpenFee: ([m, size, , margin]) => (m === id("3") ? 0n : [(size * 5n) / 10_000n, margin / 10n].reduce((a, b) => (a < b ? a : b))),
      executionFee: () => usd(0.1), minMargin: () => usd(5), maxProfitMultiple: () => 10n, baseFeeBps: () => 5n, maxSkewFeeBps: () => 10n,
      profitShareBps: () => 2_000n, referralDiscountBps: () => 500n, referralShareBps: () => 1_000n, referrerOf: () => c.referrer, claimable: () => 0n,
      agents: ([who]) => (who === STRATEGIES ? c.strategiesApproval : [BigInt(NOW + 86_400), 1000, usd(50)]),
      budgets: () => [0n, 0, 0n],
      restrictMarkets: () => false, marketAllowed: () => false, strategyOf: () => 0n, strategiesOf: () => [],
    };
    this.pub = {
      readContract: async ({ functionName, args }) => {
        if (!reads[functionName]) throw new Error(`unstubbed read ${functionName}`);
        return reads[functionName](args ?? []);
      },
      getBlock: async () => ({ timestamp: BigInt(NOW), baseFeePerGas: 20n * 10n ** 9n }),
    };
    return this;
  }
  async referencePrices() {
    return new Map();
  }
  async send() {
    throw new Error("the test chain takes no transactions");
  }
}

async function connect(env = {}, chain = {}) {
  const server = createServer(new FakeContext({ DP_MAX_LEVERAGE: "5000", DP_MAX_NOTIONAL_USD: "100000", ...env }, chain));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  return async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const body = JSON.parse(r.content[0].text);
    return r.isError ? { error: body.error } : body;
  };
}

test("dp_quote on a Turbo market: no fee unless you win, and the share", async () => {
  const call = await connect();
  const q = await call("dp_quote", { market: "BTC-TURBO", side: "long", sizeUsd: "50000", leverage: 5000 });
  assert.equal(q.market, "BTC-USD-TURBO");
  assert.equal(q.feeModel, "upside");
  assert.match(q.fees, /No fee unless you win/);
  assert.match(q.fees, /20% of its profit/);
  assert.equal(q.profitSharePct, 20);
  assert.equal(q.openFeeUsd, 0);
  assert.equal(q.closeFeeUsd, 0);
  assert.equal(q.marginUsd, 10);
  assert.equal(q.estimatedEntry, 100_000, "fills at the mid");
  assert.equal(q.maxProfitUsd, 80);
  assert.equal(q.houseShareAtProfitCapUsd, 20);
  assert.equal(q.maxLossUsd, 10.2, "margin plus the open and close keeper fees");
  assert.equal(q.liquidationMovePct, 0.018);
  const stop = await call("dp_quote", { market: "BTC-USD-TURBO", side: "long", sizeUsd: "50000", leverage: 5000, stopLoss: "99970" });
  assert.equal(stop.stopPastLiquidation, true);
  assert.match(stop.notes, /past the liquidation price/);
});

test("dp_quote with a referrer shows 19%; Standard markets show their fees", async () => {
  const call = await connect({}, { referrer: "0x00000000000000000000000000000000000000ee" });
  const q = await call("dp_quote", { market: "BTC-USD-TURBO", side: "short", sizeUsd: "1000", leverage: 100 });
  assert.equal(q.profitSharePct, 19);
  assert.match(q.fees, /19%/);
  const s = await call("dp_quote", { market: "BTC", side: "long", sizeUsd: "1000", leverage: 10 });
  assert.equal(s.feeModel, "standard");
  assert.equal(s.estimatedEntry, 100_010, "a long fills at the ask");
  assert.equal(s.openFeeUsd, 0.475, "0.5 less 5%");
  assert.equal(s.profitSharePct, undefined);
  const mk = await call("dp_markets");
  assert.equal(mk.markets.find((m) => m.symbol === "BTC-USD-TURBO").keeperOrdersOnly, "always");
});

test("guardrails: leverage, notional, take-profit inside the order's bound, a stop past liquidation", async () => {
  const call = await connect({ DP_MAX_LEVERAGE: "1000", DP_MAX_NOTIONAL_USD: "20000" });
  assert.equal((await call("dp_open", { market: "BTC-TURBO", side: "long", sizeUsd: "10000", leverage: 2000 })).error.code, "LEVERAGE_OUT_OF_RANGE");
  assert.equal((await call("dp_open", { market: "BTC-TURBO", side: "long", sizeUsd: "30000", leverage: 1000 })).error.code, "MAX_NOTIONAL_EXCEEDED");
  // A long's worst fill is the ask plus 0.5%: a take-profit below that would be refused by the engine.
  assert.equal((await call("dp_open", { market: "BTC-TURBO", side: "long", sizeUsd: "10000", leverage: 100, takeProfit: "100200" })).error.code, "INVALID_TAKE_PROFIT");
  assert.equal((await call("dp_open", { market: "BTC-TURBO", side: "long", sizeUsd: "10000", leverage: 1000, stopLoss: "99900" })).error.code, "STOP_PAST_LIQUIDATION");
  const pre = await call("dp_open", { market: "BTC-TURBO", side: "long", sizeUsd: "10000", leverage: 1000, stopLoss: "99950", expiresInSeconds: 30 });
  assert.ok(pre.confirmToken, "a preview first");
  assert.equal(pre.preview.expiresAt, new Date((NOW + 30) * 1000).toISOString());
});

test("dp_strategy_create: validation, guardrails, and the owner's approval prepared when missing", async () => {
  const call = await connect({ DP_MAX_LEVERAGE: "200", DP_MAX_NOTIONAL_USD: "5000" });
  const trend = { kind: "trend", market: "BTC-TURBO", marginUsd: "10", leverage: 100, intervalSeconds: 300, fastPeriod: 12, slowPeriod: 26 };
  assert.equal((await call("dp_strategy_create", { ...trend, slowPeriod: 10 })).error.code, "INVALID_STRATEGY");
  assert.equal((await call("dp_strategy_create", { ...trend, leverage: 300 })).error.code, "LEVERAGE_OUT_OF_RANGE");
  assert.equal((await call("dp_strategy_create", { ...trend, marginUsd: "60" })).error.code, "MAX_NOTIONAL_EXCEEDED", "6,000 per order");
  assert.equal((await call("dp_strategy_create", { kind: "copy", market: "BTC", marginUsd: "10", leverage: 10, intervalSeconds: 60, leader: "0x00000000000000000000000000000000000000bb", ratioBps: 5000, maxSizeUsd: "9000" })).error.code, "MAX_NOTIONAL_EXCEEDED", "a copy's position cap too");
  const e = (await call("dp_strategy_create", trend)).error;
  assert.equal(e.code, "STRATEGIES_NOT_APPROVED");
  const tx = e.details.ownerTx;
  assert.equal(tx.from, OWNER);
  assert.equal(tx.to, ACCOUNT);
  const { functionName, args } = decodeFunctionData({ abi: agentAccountAbi, data: tx.data });
  assert.equal(functionName, "multicall");
  const [setAgent, budget] = args[0].map((d) => decodeFunctionData({ abi: agentAccountAbi, data: d }));
  assert.equal(setAgent.functionName, "setAgent");
  assert.deepEqual(lower(setAgent.args.slice(0, 1).concat(setAgent.args.slice(2))), [STRATEGIES, 100, usd(10)]);
  assert.equal(setAgent.args[1], BigInt(NOW + 30 * 86_400), "30 days");
  assert.equal(budget.functionName, "setAgentBudget");
  assert.deepEqual(lower(budget.args), [STRATEGIES, usd(50)]);
});

test("dp_strategy_create previews once Strategies is approved", async () => {
  const call = await connect({}, { strategiesApproval: [BigInt(NOW + 86_400), 1000, usd(50)] });
  const pre = await call("dp_strategy_create", { kind: "meanRevert", market: "BTC-TURBO", marginUsd: "10", leverage: 50, intervalSeconds: 900, period: 20, bandBps: 150, exitBps: 30 });
  assert.ok(pre.confirmToken, JSON.stringify(pre));
  assert.equal(pre.preview.sizePerOrderUsd, 500);
  assert.match(pre.preview.fees, /No fee unless you win/);
  assert.equal(pre.preview.dailyBudget, "no daily cap");
});

test("dp_prepare_owner_tx: budgets, referrer and registry listings, never sent", async () => {
  const call = await connect();
  const b = await call("dp_prepare_owner_tx", { action: "set_agent_budget", dailyBudgetUsd: "250" });
  assert.deepEqual(lower(decodeFunctionData({ abi: agentAccountAbi, data: b.data }).args), [AGENT, usd(250)], "defaults to this server's key");
  const r = await call("dp_prepare_owner_tx", { action: "register_agent", name: "Turbo trend", kind: "trend", description: "12/26 EMA" });
  assert.equal(r.to, REGISTRY);
  assert.deepEqual(lower(decodeFunctionData({ abi: agentRegistryAbi, data: r.data }).args), [ACCOUNT, "Turbo trend", "12/26 EMA", "trend", ""]);
  assert.equal((await call("dp_prepare_owner_tx", { action: "register_agent", name: "x".repeat(49), kind: "trend" })).error.code, "INVALID_AGENT");
  assert.equal((await call("dp_prepare_owner_tx", { action: "approve_strategies", maxLeverage: 10 })).error.code, "BAD_ARGUMENTS");
  const ref = await call("dp_set_referrer", { referrer: "0x00000000000000000000000000000000000000ee" });
  assert.equal(ref.status, "needs-owner", "an agent cannot set the account's referrer");
  assert.equal(decodeFunctionData({ abi: agentAccountAbi, data: ref.ownerTx.data }).functionName, "setReferrer");
});

test("referral standing", async () => {
  const call = await connect();
  const r = await call("dp_referral");
  assert.equal(r.referrer, null);
  assert.deepEqual(r.withReferrer, { feeDiscountPct: 5, turboProfitSharePct: 19, referrerEarnsPctOfFees: 10 });
});
