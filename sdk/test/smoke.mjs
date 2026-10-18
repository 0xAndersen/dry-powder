// End-to-end check of the SDK against the local stack (frontend/e2e/with-keeper.sh starts chain + keeper):
//   cd sdk && npm run build && node test/smoke.mjs
// A wallet trades 1000x BTC through keeper orders with a stop; then an owner creates an agent account, approves
// an agent key, and the agent trades 500x from it (opened and closed through keeper orders).
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPublicClient, createWalletClient, http } from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { DryPowder, agentAccountFactoryAbi, fromPrice, fromUsd, pct, price, usd } from "../dist/index.js";

const ROOT = new URL("../..", import.meta.url).pathname;
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8645";
const MNEMONIC = "test test test test test test test test test test test junk"; // anvil, local only
const acct = (i) => mnemonicToAccount(MNEMONIC, { addressIndex: i });
const addrs = JSON.parse(readFileSync(join(ROOT, "frontend/e2e/.state/addresses.json"), "utf8"));
const step = (s) => console.log(`[sdk] ${s}`);

// Local deployment + a fresh agent account factory.
const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
const art = JSON.parse(readFileSync(join(ROOT, "contracts/out/AgentAccount.sol/AgentAccountFactory.json"), "utf8"));
const hash = await createWalletClient({ chain: foundry, transport: http(RPC), account: acct(0) }).deployContract({ abi: agentAccountFactoryAbi, bytecode: art.bytecode.object, args: [addrs.usdc, addrs.engine] });
const agentFactory = (await pub.waitForTransactionReceipt({ hash })).contractAddress;
const deployment = { ...addrs, chainId: 31337, rpcUrl: RPC, agentFactory, collateral: "test" };

// Fresh accounts (the scripted traders use anvil's), funded with gas by the deployer.
const funder = createWalletClient({ chain: foundry, transport: http(RPC), account: acct(0) });
const fresh = async () => {
  const a = privateKeyToAccount(generatePrivateKey());
  await pub.waitForTransactionReceipt({ hash: await funder.sendTransaction({ to: a.address, value: 10n ** 18n }) });
  return a;
};
const [wallet, ownerKey, agentKey] = [await fresh(), await fresh(), await fresh()];

// ── A wallet at 1000x ──
const dp = await DryPowder.connect({ deployment, account: wallet });
await dp.faucet(usd(1_000));
const markets = await dp.markets();
assert.ok(markets.length >= 8);
const btc = await dp.market("BTC");
assert.equal(btc.maxLeverage, 1000);
const entry = (btc.price ?? btc.lastPrice).ask;
const stop = (entry * 99_950n) / 100_000n; // 0.05% below: inside the 0.09% liquidation distance
const q = await dp.quote({ market: "BTC", side: "long", margin: usd(10), leverage: 1000, stopLoss: stop });
step(`quote 1000x: size ${fromUsd(q.size)}, liquidated after ${pct(q.risk.liquidationMove)}, most you can lose ${fromUsd(q.risk.maxLoss)}`);
assert.equal(q.risk.keeperOrdersOnly, true);
assert.equal(q.risk.level, "extreme");
assert.ok(q.risk.liquidationMove < 0.001);
assert.ok(q.risk.maxLoss <= usd(12) + 5n * 10n ** 5n);
const btcPos = async () => (await dp.positions()).find((p) => p.marketId.toLowerCase() === btc.id.toLowerCase());

// 1. Open 1000x through a keeper order, close through a keeper Close order.
const opened = await dp.open({ market: "BTC", side: "long", margin: usd(10), leverage: 1000 });
step(`order ${opened.orderId} placed`);
assert.equal(await dp.waitForFill(opened.orderId, 60_000), "done");
const pos = await btcPos();
assert.ok(pos, "the keeper filled the 1000x order");
assert.equal(pos.size, usd(10_000));
step(`filled at ${fromPrice(pos.entryPrice)}; liquidation ${fromPrice(pos.liquidationPrice)}`);
const closed = await dp.close("BTC");
assert.ok(closed.orderId, "above 100x the SDK closes with a keeper order");
assert.equal(await dp.waitForFill(closed.orderId, 60_000), "done");
if (await btcPos()) {
  const j = (x) => JSON.stringify(x, (_, v) => (typeof v === "bigint" ? v.toString() : v));
  console.log(`[sdk] still open after close order ${closed.orderId} left the book: ${j(await btcPos())}`);
  assert.fail("the close order did not close the position");
}
step("closed through the keeper");

// 2. A stop rides along with the order and is attached on fill (it may fire at once at 1000x).
const now = await dp.market("BTC");
const stop2 = ((now.price ?? now.lastPrice).bid * 99_950n) / 100_000n;
const withStop = await dp.open({ market: "BTC", side: "long", margin: usd(10), leverage: 1000, stopLoss: stop2 });
if ((await dp.waitForFill(withStop.orderId, 60_000)) === "resting") {
  // The price fell through the stop before the fill: the engine keeps such an order resting rather than open
  // and stop out at once.
  await dp.cancel(withStop.orderId);
  step("price gapped through the stop; order left resting and cancelled");
}
const p2 = await btcPos();
if (p2) {
  assert.ok(p2.stopLossOrderId > 0n, "the stop is attached");
  const c2 = await dp.close("BTC");
  await dp.waitForFill(c2.orderId, 60_000);
  step("stop attached on fill");
} else step("stop attached on fill (or already filled)");

// ── An agent account ──
const owner = await DryPowder.connect({ deployment, account: ownerKey });
const account = await owner.createAgentAccount();
const ownerInAccount = await DryPowder.connect({ deployment, account: ownerKey, agentAccount: account });
await ownerInAccount.faucet(usd(500));
await owner.approveAgent(account, agentKey.address, { expiresInSeconds: 86_400, maxLeverage: 1000, maxMarginPerOrder: usd(50) });
const agent = await DryPowder.connect({ deployment, account: agentKey, agentAccount: account });
const o2 = await agent.open({ market: "ETH", side: "short", margin: usd(5), leverage: 500 });
assert.equal(await agent.waitForFill(o2.orderId, 60_000), "done");
assert.equal((await agent.positions()).length, 1);
step("agent account opened 500x ETH short");
const c2 = await agent.close("ETH");
assert.equal(await agent.waitForFill(c2.orderId, 60_000), "done");
assert.equal((await agent.positions()).length, 0);
step("SDK smoke passed");
