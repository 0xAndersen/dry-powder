// End-to-end check of the SDK against the local stack (frontend/e2e/with-keeper.sh starts chain + keeper):
//   cd sdk && npm run build && node test/smoke.mjs
// A wallet trades 1000x BTC through keeper orders with a stop, then Turbo at 5000x (no fee unless you win) with
// a stop and an expiry, takes margin out of a position and sets a referrer. Then an owner creates an agent
// account, approves an agent key with a daily budget; the agent trades 500x from it, runs into the budget,
// lets an order expire, and starts a strategy the owner approved; the owner lists the account in the registry.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http } from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { DryPowder, DryPowderError, fromPrice, fromUsd, pct, usd } from "../dist/index.js";

const ROOT = new URL("../..", import.meta.url).pathname;
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8645";
const MNEMONIC = "test test test test test test test test test test test junk"; // anvil, local only
const acct = (i) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
const addrs = JSON.parse(readFileSync(join(ROOT, "frontend/e2e/.state/addresses.json"), "utf8"));
const step = (s) => console.log(`[sdk] ${s}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const deployment = { ...addrs, chainId: 31337, rpcUrl: RPC, collateral: "test" };

// Fresh accounts (the scripted traders use anvil's), funded with gas by the deployer.
const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
const funder = createWalletClient({ chain: foundry, transport: http(RPC), account: acct(0) });
const fresh = async () => {
  const a = privateKeyToAccount(generatePrivateKey());
  await pub.waitForTransactionReceipt({ hash: await funder.sendTransaction({ to: a.address, value: 10n ** 18n }) });
  return a;
};
const [wallet, ownerKey, agentKey, friend] = [await fresh(), await fresh(), await fresh(), await fresh()];

// ── A wallet at 1000x ──
const dp = await DryPowder.connect({ deployment, account: wallet });
await dp.faucet(usd(1_000));
const markets = await dp.markets();
assert.ok(markets.length >= 12);
const btc = await dp.market("BTC");
assert.equal(btc.maxLeverage, 1000);
assert.equal(btc.feeModel, "standard");
const entry = (btc.price ?? btc.lastPrice).ask;
const stop = (entry * 99_950n) / 100_000n; // 0.05% below: inside the 0.09% liquidation distance
const q = await dp.quote({ market: "BTC", side: "long", margin: usd(10), leverage: 1000, stopLoss: stop });
step(`quote 1000x: size ${fromUsd(q.size)}, liquidated after ${pct(q.risk.liquidationMove)}, most you can lose ${fromUsd(q.risk.maxLoss)}`);
assert.equal(q.risk.keeperOrdersOnly, true);
assert.equal(q.risk.level, "extreme");
assert.ok(q.risk.liquidationMove < 0.001);
assert.ok(q.risk.maxLoss <= usd(12) + 5n * 10n ** 5n);
const posIn = async (client, m) => (await client.positions()).find((p) => p.marketId.toLowerCase() === m.id.toLowerCase());

// 1. Open 1000x through a keeper order, close through a keeper Close order.
const opened = await dp.open({ market: "BTC", side: "long", margin: usd(10), leverage: 1000 });
step(`order ${opened.orderId} placed`);
assert.equal(await dp.waitForFill(opened.orderId, 60_000), "done");
const pos = await posIn(dp, btc);
assert.ok(pos, "the keeper filled the 1000x order");
assert.equal(pos.size, usd(10_000));
step(`filled at ${fromPrice(pos.entryPrice)}; liquidation ${fromPrice(pos.liquidationPrice)}`);
const closed = await dp.close("BTC");
assert.ok(closed.orderId, "above 100x the SDK closes with a keeper order");
assert.equal(await dp.waitForFill(closed.orderId, 60_000), "done");
assert.equal(await posIn(dp, btc), undefined, "the close order closed the position");
step("closed through the keeper");

// 2. Turbo at 5000x: no fee to open or close, mid fills, a stop inside the 0.018% liquidation distance, and an
// order that cannot fill after 60 s.
const turbo = await dp.market("BTC-TURBO");
assert.equal(turbo.feeModel, "upside");
assert.equal(turbo.maxLeverage, 5000);
const mid = (turbo.price ?? turbo.lastPrice).mid;
const tStop = (mid * 99_990n) / 100_000n;
const tq = await dp.quote({ market: "BTC-TURBO", side: "long", margin: usd(10), leverage: 5000, stopLoss: tStop, expiresIn: 60 });
assert.equal(tq.openFee, 0n);
assert.equal(tq.required, usd(10) + 2n * 100_000n, "margin and two keeper fees (order and stop), no fee budget");
assert.equal(tq.risk.maxProfit, usd(80), "10x margin less the 20% share");
assert.equal(tq.risk.stopPastLiquidation, false);
assert.match(tq.feeNote, /No fee unless you win/);
assert.ok(tq.expiresAt > 0);
step(`turbo quote: ${tq.feeNote}`);
const before = await dp.balance();
const t = await dp.open({ market: "BTC-TURBO", side: "long", margin: usd(10), leverage: 5000, stopLoss: tStop, expiresIn: 60 });
const tOrder = (await dp.orders()).find((o) => o.id === t.orderId);
if (tOrder) assert.equal(tOrder.expiresAt, t.quote.expiresAt, "the order carries its expiry");
if ((await dp.waitForFill(t.orderId, 60_000)) === "resting") {
  await dp.cancel(t.orderId); // the price ran through the stop before the fill: the engine leaves it resting
  step("turbo order left resting (price ran through the stop); cancelled");
} else if (await posIn(dp, turbo)) {
  try {
    const c = await dp.close("BTC-TURBO");
    assert.ok(c.orderId, "Turbo closes through a keeper order");
    await dp.waitForFill(c.orderId, 60_000);
    step(`turbo position opened and closed: ${fromUsd((await dp.balance()) - before)} net`);
  } catch (e) {
    if (!(e instanceof DryPowderError && e.code === "PositionNotFound")) throw e;
    step("turbo position opened; its stop closed it first");
  }
} else step("turbo position opened and stopped out at once");
assert.equal(await posIn(dp, turbo), undefined);

// 3. Margin out of a 10x position, once a newer price is on-chain.
const e1 = await dp.open({ market: "ETH", side: "long", margin: usd(50), leverage: 10 });
assert.equal(await dp.waitForFill(e1.orderId, 60_000), "done");
const eth = await dp.market("ETH");
const max = await dp.maxRemovableMargin("ETH");
step(`ETH 10x: at most ${fromUsd(max)} of 50 can come out`);
assert.ok(max > usd(30) && max < usd(50));
await assert.rejects(dp.removeMargin("ETH", max + usd(1)), (e) => e instanceof DryPowderError && e.code === "InsufficientMargin");
await dp.removeMargin("ETH", usd(10));
assert.equal((await posIn(dp, eth)).margin, usd(40));
step("took 10 out: 12.5x");
const ec = await dp.close("ETH", { viaKeeper: true });
await dp.waitForFill(ec.orderId, 60_000);

// 4. A referrer, once.
await dp.setReferrer(friend.address);
assert.equal((await dp.referral()).referrer, friend.address);
await assert.rejects(dp.setReferrer(acct(0).address), (e) => e.code === "ReferrerAlreadySet");
const tq2 = await dp.quote({ market: "BTC-TURBO", side: "long", margin: usd(10), leverage: 100 });
assert.equal(tq2.profitShareBps, 1900);
step("referrer set: the Turbo share is 19%");

// ── An agent account, with a daily budget ──
const owner = await DryPowder.connect({ deployment, account: ownerKey });
const account = await owner.createAgentAccount();
const ownerInAccount = await DryPowder.connect({ deployment, account: ownerKey, agentAccount: account });
await ownerInAccount.faucet(usd(500));
await owner.approveAgent(account, agentKey.address, { expiresInSeconds: 86_400, maxLeverage: 1000, maxMarginPerOrder: usd(50), dailyBudget: usd(8) });
assert.deepEqual(await owner.agentBudget(account, agentKey.address), { perDay: usd(8), spentToday: 0n, remainingToday: usd(8) });
const agent = await DryPowder.connect({ deployment, account: agentKey, agentAccount: account });
const o2 = await agent.open({ market: "ETH", side: "short", margin: usd(5), leverage: 500 });
assert.equal(await agent.waitForFill(o2.orderId, 60_000), "done");
assert.equal((await agent.positions()).length, 1);
assert.equal((await owner.agentBudget(account, agentKey.address)).remainingToday, usd(3));
step("agent account opened 500x ETH short; 3 of its 8 daily budget left");
await assert.rejects(agent.open({ market: "ETH", side: "short", margin: usd(5), leverage: 500 }), (e) => e instanceof DryPowderError && e.code === "DailyBudgetExceeded");
step("a second 5 USDC order is refused: DailyBudgetExceeded");
const c2 = await agent.close("ETH");
assert.equal(await agent.waitForFill(c2.orderId, 60_000), "done");
assert.equal((await agent.positions()).length, 0);

// An order that expires: a limit far below the market, good for 5 s, then cancelled with its escrow.
await owner.setAgentBudget(account, agentKey.address, 0n);
const balBefore = await agent.balance();
const far = await agent.open({ market: "ETH", side: "long", margin: usd(5), leverage: 2, limitPrice: ((eth.price ?? eth.lastPrice).mid * 50n) / 100n, expiresIn: 5 });
await sleep(7_000);
await funder.sendTransaction({ to: acct(0).address, value: 0n }); // a block past the expiry
const expired = await agent.expiredOrders();
assert.deepEqual(expired.map((o) => o.id), [far.orderId]);
await agent.cancelExpired();
assert.equal(await agent.balance(), balBefore, "the escrow came back in full");
step("expired order cancelled with a full refund");

// ── A strategy the owner approved, started by the agent ──
await owner.approveStrategies(account, { expiresInSeconds: 86_400, maxLeverage: 100, maxMarginPerOrder: usd(10), dailyBudget: usd(30) });
const { id } = await agent.createStrategy({ kind: "trend", market: "BTC-TURBO", margin: usd(10), leverage: 100, interval: 60, fastPeriod: 2, slowPeriod: 4, stopLossBps: 20 });
let s = await agent.strategy(id);
assert.equal(s.status, "active");
assert.equal(s.symbol, "BTC-USD-TURBO");
assert.equal(s.spec.kind, "trend");
await assert.rejects(agent.createStrategy({ kind: "copy", market: "BTC-TURBO", margin: usd(10), leverage: 10, interval: 60, leader: wallet.address, ratioBps: 10_000, maxSize: usd(100) }), (e) => e.code === "MarketTaken");
await assert.rejects(agent.createStrategy({ kind: "trend", market: "ETH", margin: usd(20), leverage: 10, interval: 60, fastPeriod: 2, slowPeriod: 4 }), (e) => e.code === "NotApproved");
await agent.pauseStrategy(id);
assert.equal((await agent.strategy(id)).status, "paused");
await agent.resumeStrategy(id);
await agent.stopStrategy(id);
s = (await agent.strategies()).find((x) => x.id === id);
assert.equal(s.status, "stopped");
step(`strategy ${id}: created, paused, resumed, stopped`);

// ── The registry ──
await owner.registerAgent(account, { name: "SDK smoke", kind: "trend", description: "Turbo trend, 2/4 EMA" });
assert.equal((await owner.agentListing(account)).name, "SDK smoke");
assert.ok((await owner.agentListings({ limit: 200 })).some((l) => l.account === account));
await owner.unregisterAgent(account);
assert.equal(await owner.agentListing(account), null);
step("listed and unlisted in the agent registry");

step("SDK smoke passed");
