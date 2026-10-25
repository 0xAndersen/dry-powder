// Unit tests for the v3.2 additions: Upside (Turbo) risk and settlement, DRY rebates on net results, margin
// removal, strategy configs and their validation, listings, encoders and typed errors. No network: the quote test
// stubs the client's reads.
import assert from "node:assert/strict";
import { test } from "node:test";
import { decodeFunctionData, encodeFunctionData, zeroAddress } from "viem";
import {
  DryPowder,
  DryPowderError,
  agentAccountAbi,
  assessRisk,
  errorNameOf,
  liquidationPrice,
  needsKeeperOrders,
  price,
  profitCapPrice,
  rebateBase,
  rebateFor,
  rebateRate,
  recordResult,
  removableMargin,
  settle,
  strategiesAbi,
  strategyConfig,
  strategyInfo,
  strategySpec,
  toDryPowderError,
  usd,
  validateListing,
  validateStrategy,
} from "../dist/index.js";

const ENTRY = price(100_000);
const ACCOUNT = "0x00000000000000000000000000000000000000aa";
const LEADER = "0x00000000000000000000000000000000000000bb";

test("Upside: no fees in the worst case, the share off the best case, same liquidation and cap prices", () => {
  const base = { entry: ENTRY, size: usd(50_000), margin: usd(10), isLong: true, executionFees: usd(0.2) };
  const std = assessRisk(base);
  const up = assessRisk({ ...base, feeModel: "upside", openFee: usd(1), closeFee: usd(1) });
  assert.equal(up.maxLoss, usd(10.2), "margin plus keeper fees: fees passed in are ignored");
  assert.equal(std.maxLoss, usd(12.2));
  assert.equal(up.maxProfit, usd(80), "10x margin less 20%");
  assert.equal(up.shareAtCap, usd(20));
  assert.equal(up.profitShareBps, 2000);
  assert.equal(up.liquidationPrice, std.liquidationPrice);
  assert.equal(up.liquidationPrice, liquidationPrice(ENTRY, usd(10), usd(50_000), true));
  assert.equal(up.profitCapMove, std.profitCapMove);
  assert.equal(up.leverage, 5000);
  assert.equal(up.level, "extreme");
  assert.equal(std.feeModel, "standard");
  assert.equal(std.shareAtCap, 0n);
});

test("Upside with a referrer: the share is 5% lower", () => {
  const r = assessRisk({ entry: ENTRY, size: usd(1_000), margin: usd(10), isLong: false, feeModel: "upside", referred: true });
  assert.equal(r.profitShareBps, 1900);
  assert.equal(r.shareAtCap, usd(19));
  assert.equal(r.maxProfit, usd(81));
});

test("Upside markets need keeper orders at any leverage", () => {
  assert.equal(needsKeeperOrders(usd(10), usd(10), "upside"), true);
  assert.equal(needsKeeperOrders(usd(10), usd(10)), false);
  assert.equal(needsKeeperOrders(usd(1_001), usd(10), "standard"), true);
});

test("settle: Upside wins pay the share (rounded up), losses cost only the margin", () => {
  assert.deepEqual(settle({ pnl: usd(33.333333), margin: usd(10), feeModel: "upside" }), { pnl: usd(33.333333), fee: 6_666_667n, payout: usd(10) + usd(33.333333) - 6_666_667n, toReferrer: 0n });
  assert.deepEqual(settle({ pnl: -usd(4), margin: usd(10), feeModel: "upside" }), { pnl: -usd(4), fee: 0n, payout: usd(6), toReferrer: 0n });
  assert.equal(settle({ pnl: -usd(40), margin: usd(10), feeModel: "upside" }).payout, 0n, "a loss stops at the margin");
  const capped = settle({ pnl: usd(500), margin: usd(10), feeModel: "upside" });
  assert.equal(capped.pnl, usd(100), "profit capped at 10x margin");
  assert.equal(capped.payout, usd(10) + usd(80));
  // With a referrer: 5% off the share, and 10% of what is left of it to the referrer.
  const ref = settle({ pnl: usd(100), margin: usd(10), feeModel: "upside", referred: true });
  assert.equal(ref.fee, usd(19));
  assert.equal(ref.toReferrer, usd(1.9));
  assert.equal(ref.payout, usd(91));
});

test("settle: Standard markets take the close fee from what is left of the margin", () => {
  assert.deepEqual(settle({ pnl: usd(5), margin: usd(10), closeFee: usd(0.5) }), { pnl: usd(5), fee: usd(0.5), payout: usd(14.5), toReferrer: 0n });
  assert.deepEqual(settle({ pnl: -usd(9.8), margin: usd(10), closeFee: usd(0.5) }), { pnl: -usd(9.8), fee: usd(0.2), payout: 0n, toReferrer: 0n });
  const ref = settle({ pnl: 0n, margin: usd(10), closeFee: usd(1), referred: true });
  assert.equal(ref.fee, usd(0.95));
  assert.equal(ref.toReferrer, usd(0.095));
});

test("DRY rebates: the curve, the 1% notional cap and losses only below the previous low", () => {
  assert.equal(rebateFor(usd(100)), 9_999_500_024_998_750_062_496n);
  assert.equal(rebateRate(0n), 100n * 10n ** 18n);
  assert.equal(rebateRate(1_000_000_000_000n), 50n * 10n ** 18n, "halved after 1,000,000 USDC rebated");
  assert.equal(rebateBase(usd(10_000), usd(250)), usd(100), "a close reports at most 1% of its notional");
  assert.equal(rebateBase(usd(10_000), usd(40)), usd(40));
  let l = { net: 0n, low: 0n };
  const a = recordResult(l, -usd(100));
  assert.equal(a.newLoss, usd(100));
  assert.equal(a.minted, rebateFor(usd(100)));
  l = a;
  const b = recordResult(l, usd(60));
  assert.equal(b.minted, 0n);
  assert.equal(b.low, -usd(100));
  const c = recordResult(b, -usd(50));
  assert.equal(c.newLoss, 0n);
  assert.equal(c.net, -usd(90));
  assert.equal(c.minted, 0n, "the win must be lost back first");
  const d = recordResult(c, -usd(30));
  assert.equal(d.newLoss, usd(20));
  assert.equal(d.low, -usd(120));
});

test("removable margin: initial margin at min(market, 100x), the loss at the exit price, the minimum, an agent's cap", () => {
  const p = { size: usd(1_000), margin: usd(100), entry: ENTRY, isLong: true, exitPrice: ENTRY, marketMaxLeverage: 1000 };
  assert.equal(removableMargin(p), usd(90), "keeps 1000/100 = 10");
  assert.equal(removableMargin({ ...p, exitPrice: price(99_000) }), usd(80), "a 1% loss (10) stays as well");
  assert.equal(removableMargin({ ...p, exitPrice: price(101_000) }), usd(90), "profit never comes out");
  assert.equal(removableMargin({ ...p, marketMaxLeverage: 50 }), usd(80), "the market's own limit below 100x");
  assert.equal(removableMargin({ ...p, agentMaxLeverage: 20 }), usd(50), "an agent keeps 1000/20 = 50");
  assert.equal(removableMargin({ ...p, fundingOwed: usd(5) }), usd(85), "funding owed counts as loss");
  assert.equal(removableMargin({ ...p, size: usd(100), margin: usd(8) }), usd(3), "the 5 USDC minimum");
  assert.equal(removableMargin({ ...p, size: usd(50_000), margin: usd(10) }), 0n, "5000x: nothing until it is under 100x");
  // Short: the loss is measured at the ask.
  assert.equal(removableMargin({ ...p, isLong: false, exitPrice: price(100_500) }), usd(85));
});

const MARKET = { enabled: true, maxLeverage: 5000, expiry: 0, symbol: "BTC-USD-TURBO" };
const trend = { kind: "trend", market: "BTC-USD-TURBO", margin: usd(10), leverage: 50, interval: 300, fastPeriod: 12, slowPeriod: 26, bandBps: 20, stopLossBps: 50 };
const copy = { kind: "copy", market: "BTC-USD-TURBO", margin: usd(20), leverage: 10, interval: 60, leader: LEADER, ratioBps: 5_000, maxSize: usd(2_000) };
const mr = { kind: "meanRevert", market: "ETH-USD", margin: usd(10), leverage: 5, interval: 900, period: 20, bandBps: 150, exitBps: 30, takeProfitBps: 200 };

test("strategy configs: valid specs pass every Strategies._validate rule", () => {
  for (const s of [trend, copy, mr]) assert.deepEqual(validateStrategy(strategyConfig(s), MARKET, usd(5), ACCOUNT, 0), [], s.kind);
  const c = strategyConfig(trend);
  assert.equal(c.kind, 0);
  assert.equal(c.period, 12);
  assert.equal(c.slowPeriod, 26);
  assert.equal(c.maxSlippageBps, 50, "default slippage");
  assert.equal(c.allowShort, true, "shorts by default");
  assert.equal(c.leader, zeroAddress);
  assert.equal(strategyConfig(copy).kind, 2);
  assert.equal(strategyConfig(mr).exitBps, 30);
});

test("strategy configs: each broken rule is reported", () => {
  const problems = (s, m = MARKET, now = 0) => validateStrategy(strategyConfig(s), m, usd(5), ACCOUNT, now).join(" | ");
  assert.match(problems({ ...trend, interval: 30 }), /interval/);
  assert.match(problems({ ...trend, slowPeriod: 12 }), /slowPeriod/);
  assert.match(problems({ ...trend, fastPeriod: 1, slowPeriod: 5 }), /fastPeriod/);
  assert.match(problems({ ...trend, leverage: 6000 }), /above BTC-USD-TURBO's 5000x/);
  assert.match(problems({ ...trend, margin: usd(4) }), /minimum/);
  assert.match(problems({ ...trend, takeProfitBps: 40 }), /wider than maxSlippageBps/);
  assert.match(problems({ ...trend, stopLossBps: 5 }), /stopLossBps/);
  assert.match(problems({ ...trend, maxSlippageBps: 600 }), /maxSlippageBps/);
  assert.match(problems({ ...mr, exitBps: 150 }), /exitBps/);
  assert.match(problems({ ...mr, bandBps: 0 }), /bandBps/);
  assert.match(problems({ ...copy, leader: ACCOUNT }), /own account/);
  assert.match(problems({ ...copy, ratioBps: 200_000 }), /ratioBps/);
  assert.match(problems({ ...copy, maxSize: 0n }), /maxSize/);
  assert.match(problems(trend, { ...MARKET, enabled: false }), /not taking new positions/);
  assert.match(problems(trend, { ...MARKET, expiry: 10 }, 10), /expired/);
  assert.equal(problems(trend, { ...MARKET, expiry: 10 }, 9), "");
  // A field another kind uses must stay 0.
  assert.match(validateStrategy({ ...strategyConfig(copy), period: 5 }, MARKET, usd(5), ACCOUNT, 0).join(), /period is not used/);
});

test("strategy configs round-trip through the contract encoding", () => {
  const config = strategyConfig(copy);
  const marketId = `0x${"11".repeat(32)}`;
  const data = encodeFunctionData({ abi: strategiesAbi, functionName: "create", args: [ACCOUNT, marketId, config] });
  const { args } = decodeFunctionData({ abi: strategiesAbi, data });
  assert.equal(args[0].toLowerCase(), ACCOUNT);
  assert.deepEqual({ ...args[2], leader: args[2].leader.toLowerCase() }, { ...config, leader: LEADER });
  const back = strategySpec(args[2], "BTC-USD-TURBO");
  assert.equal(back.kind, "copy");
  assert.equal(back.ratioBps, 5_000);
  assert.equal(back.maxSize, usd(2_000));
  const info = strategyInfo(7n, {
    account: ACCOUNT, marketId, config: args[2],
    state: { status: 1, target: 1, holding: 0, todo: true, refusals: 0, pendingAction: 0, pendingSide: 1, nextAt: 1_000n, actAt: 0n, samples: 3, pendingOrder: 42n, pendingSince: 900n, targetSize: usd(500), actions: 1, emaFast: 0n, emaSlow: 0n, lastPrice: ENTRY, blockedAt: 0n },
  }, "BTC-USD-TURBO");
  assert.equal(info.status, "active");
  assert.equal(info.target, "long");
  assert.equal(info.pendingAction, "open");
  assert.equal(info.nextSampleAt, 1000);
  assert.equal(info.spec.market, "BTC-USD-TURBO");
});

test("good-til-time orders and margin removal encode for the agent account", () => {
  const p = { priceId: `0x${"22".repeat(32)}`, isLong: true, margin: usd(10), size: usd(50_000), triggerPrice: price(100_500), takeProfit: 0n, stopLoss: price(99_990), stopEntry: false };
  const data = encodeFunctionData({ abi: agentAccountAbi, functionName: "createLimitOrderUntil", args: [p, 1_700_000_000n] });
  const d = decodeFunctionData({ abi: agentAccountAbi, data });
  assert.equal(d.functionName, "createLimitOrderUntil");
  assert.equal(d.args[1], 1_700_000_000n);
  assert.deepEqual(d.args[0], p);
  const rm = decodeFunctionData({ abi: agentAccountAbi, data: encodeFunctionData({ abi: agentAccountAbi, functionName: "removeMargin", args: [p.priceId, usd(5), []] }) });
  assert.deepEqual(rm.args, [p.priceId, usd(5), []]);
  const budget = decodeFunctionData({ abi: agentAccountAbi, data: encodeFunctionData({ abi: agentAccountAbi, functionName: "setAgentBudget", args: [LEADER, usd(100)] }) });
  assert.deepEqual(budget.args, [LEADER, usd(100)]);
});

test("registry listings are checked against the contract's byte limits", () => {
  assert.deepEqual(validateListing({ name: "Turbo trend", kind: "trend", description: "12/26 EMA on BTC Turbo" }), []);
  assert.match(validateListing({ name: "", kind: "trend" }).join(), /name/);
  assert.match(validateListing({ name: "x".repeat(49), kind: "trend" }).join(), /name/);
  assert.match(validateListing({ name: "é".repeat(25), kind: "trend" }).join(), /name/, "bytes, not characters");
  assert.match(validateListing({ name: "a", kind: "" }).join(), /kind/);
  assert.match(validateListing({ name: "a", kind: "k", description: "d".repeat(281) }).join(), /description/);
  assert.match(validateListing({ name: "a", kind: "k", uri: "u".repeat(257) }).join(), /uri/);
});

test("typed errors: contract names from viem's cause chain, with hints", () => {
  const viemLike = Object.assign(new Error("execution reverted"), { shortMessage: "reverted", cause: { cause: { data: { errorName: "DailyBudgetExceeded" } } } });
  assert.equal(errorNameOf(viemLike), "DailyBudgetExceeded");
  const e = toDryPowderError(viemLike);
  assert.ok(e instanceof DryPowderError);
  assert.equal(e.code, "DailyBudgetExceeded");
  assert.match(e.message, /daily margin budget/);
  assert.equal(e.cause, viemLike);
  assert.equal(errorNameOf(new Error('The contract function "x" reverted with the following reason:\nOrdersOnly')), "OrdersOnly");
  const plain = new Error("network down");
  assert.equal(toDryPowderError(plain), plain);
  assert.equal(new DryPowderError("OrdersOnly").hint.includes("keeper orders"), true);
  assert.equal(new DryPowderError("UNKNOWN_MARKET", "no market X").message, "no market X");
});

test("transient RPC errors are retried for reads, never for sends or reverts", async () => {
  const { custom } = await import("viem");
  const { retryTransient } = await import("../dist/index.js");
  const calls = { eth_call: 0, eth_sendRawTransaction: 0, eth_estimateGas: 0 };
  const failing = { eth_call: 2, eth_sendRawTransaction: 1 };
  const t = retryTransient(custom({
    async request({ method }) {
      calls[method] += 1;
      if (method === "eth_estimateGas") throw Object.assign(new Error("execution reverted"), { code: 3, data: "0x" });
      if (calls[method] <= failing[method]) throw { code: -32602, message: "BlockOutOfRangeError: block height is 468 but requested was 467" };
      return "0x01";
    },
  }, { retryCount: 0 }))({ retryCount: 0 });
  assert.equal(await t.request({ method: "eth_call", params: [] }), "0x01");
  assert.equal(calls.eth_call, 3, "two transient failures, then the answer");
  await assert.rejects(t.request({ method: "eth_sendRawTransaction", params: ["0x"] }), /BlockOutOfRange/);
  assert.equal(calls.eth_sendRawTransaction, 1, "a send is never repeated");
  await assert.rejects(t.request({ method: "eth_estimateGas", params: [] }), /reverted/);
  assert.equal(calls.eth_estimateGas, 1, "a revert is not transient");
});

// ── quote() on a Turbo market, with the client's reads stubbed ──

function stubbed({ referrer = zeroAddress } = {}) {
  const id = (n) => `0x${n.repeat(64)}`;
  const px = { mid: price(100_000), bid: price(99_990), ask: price(100_010), publishTime: 999n };
  const market = (symbol, feeMode, maxLeverage) => ({ symbol, feeMode, maxLeverage, enabled: true, invert: false, expiry: 0n, quoteFeedId: id("0"), settlementPrice: 0n, longOi: 0n, shortOi: 0n, maxOiPerSide: usd(1e9) });
  const reads = {
    getMarkets: () => [
      { id: id("1"), market: market("BTC-USD", 0, 1000), fundingRate: 0n, hasPrice: true, price: px },
      { id: id("2"), market: market("BTC-USD-TURBO", 1, 5000), fundingRate: 0n, hasPrice: true, price: px },
    ],
    getTraderPositions: () => [],
    quoteOpenFee: ([mid, size, , margin]) => (mid === id("2") ? 0n : [(size * 5n) / 10_000n, margin / 10n].reduce((a, b) => (a < b ? a : b))),
    executionFee: () => usd(0.1),
    minMargin: () => usd(5),
    maxProfitMultiple: () => 10n,
    baseFeeBps: () => 5n,
    maxSkewFeeBps: () => 10n,
    profitShareBps: () => 2000n,
    referralDiscountBps: () => 500n,
    referralShareBps: () => 1000n,
    referrerOf: () => referrer,
  };
  return async (dp) => {
    dp.publicClient.readContract = async ({ functionName, args }) => {
      if (!reads[functionName]) throw new Error(`unstubbed read ${functionName}`);
      return reads[functionName](args ?? []);
    };
    dp.publicClient.getBlock = async () => ({ timestamp: 1_000_000n, baseFeePerGas: 20n * 10n ** 9n });
    return dp;
  };
}

const DEPLOYMENT = { chainId: 31337, rpcUrl: "http://127.0.0.1:1", engine: `0x${"e".repeat(40)}`, lens: `0x${"f".repeat(40)}`, vault: `0x${"a".repeat(40)}`, token: `0x${"b".repeat(40)}`, usdc: `0x${"c".repeat(40)}` };

test("quote on a Turbo market: mid entry, no fees, the share stated, expiry from chain time", async () => {
  const dp = await stubbed()(await DryPowder.connect({ deployment: DEPLOYMENT, agentAccount: ACCOUNT }));
  const q = await dp.quote({ market: "BTC-TURBO", side: "long", margin: usd(10), leverage: 5000, expiresIn: 30 });
  assert.equal(q.market.symbol, "BTC-USD-TURBO");
  assert.equal(q.feeModel, "upside");
  assert.equal(q.entry, price(100_000), "fills at the mid");
  assert.equal(q.triggerPrice, (price(100_010) * 10_050n) / 10_000n, "the bound starts from the ask");
  assert.equal(q.openFee, 0n);
  assert.equal(q.required, usd(10) + usd(0.1), "margin plus one keeper fee: no fee budget");
  assert.equal(q.profitShareBps, 2000);
  assert.equal(q.risk.maxLoss, usd(10) + usd(0.2), "margin and the open and close keeper fees");
  assert.equal(q.risk.maxProfit, usd(80));
  assert.equal(q.risk.keeperOrdersOnly, true);
  assert.equal(q.expiresAt, 1_000_030);
  assert.match(q.feeNote, /No fee unless you win/);
  assert.match(q.feeNote, /20%/);
  assert.equal(q.risk.liquidationPrice, liquidationPrice(price(100_000), usd(10), usd(50_000), true));
  assert.equal(profitCapPrice(q.entry, q.margin, q.size, true) > q.entry, true);
});

test("quote with a referrer: discounted share in Turbo, discounted fees in Standard", async () => {
  const dp = await stubbed({ referrer: LEADER })(await DryPowder.connect({ deployment: DEPLOYMENT, agentAccount: ACCOUNT }));
  const t = await dp.quote({ market: "BTC-USD-TURBO", side: "short", margin: usd(10), leverage: 100 });
  assert.equal(t.referred, true);
  assert.equal(t.profitShareBps, 1900);
  assert.match(t.feeNote, /19%/);
  assert.equal(t.expiresAt, 0);
  const s = await dp.quote({ market: "BTC", side: "long", margin: usd(100), leverage: 10 });
  assert.equal(s.feeModel, "standard");
  assert.equal(s.entry, price(100_010), "a long fills at the ask");
  assert.equal(s.openFee, usd(0.5) - usd(0.025), "0.5 less 5%");
  assert.equal(s.required, usd(100) + usd(1.5) + usd(0.1), "the fee budget is escrowed undiscounted");
  assert.match(s.feeNote, /to open/);
  await assert.rejects(dp.quote({ market: "BTC", side: "long", margin: usd(100), leverage: 10, expiresAt: 999_999 }), (e) => e instanceof DryPowderError && e.code === "InvalidParam");
  await assert.rejects(dp.quote({ market: "BTC", side: "long", margin: usd(4), leverage: 10 }), (e) => e.code === "MarginTooLow");
  await assert.rejects(dp.quote({ market: "DOGE", side: "long", margin: usd(10), leverage: 2 }), (e) => e.code === "UNKNOWN_MARKET");
});
