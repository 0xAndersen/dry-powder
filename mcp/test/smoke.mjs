// End-to-end check of the MCP server through a real MCP client, against the local stack:
//   frontend/e2e/with-keeper.sh is the usual way to get a chain + keeper; or start them by hand, then
//   node mcp/test/smoke.mjs
// It gives an owner an agent account (from the deployment's factory, which the Strategies contract and the
// registry accept) funded with test USDC, approves an agent key with a policy, and lets the MCP server trade
// from it: Standard and Turbo orders, expiry, margin in and out, a strategy, the referrer and a registry listing
// (the owner signs the transactions the server prepares).
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createPublicClient, createWalletClient, http } from "viem";
import { generatePrivateKey, mnemonicToAccount, privateKeyToAccount } from "viem/accounts";
import { foundry } from "viem/chains";
import { agentAccountAbi, agentAccountFactoryAbi, testUSDCAbi } from "../src/abi.mjs";
import { Context, loadConfig } from "../src/context.mjs";
import { createServer } from "../src/server.mjs";

const ROOT = new URL("../..", import.meta.url).pathname;
const RPC = process.env.RPC_URL ?? "http://127.0.0.1:8645";
const KRAKEN = process.env.KRAKEN_URL ?? "http://127.0.0.1:8647";
const MNEMONIC = "test test test test test test test test test test test junk"; // anvil, local only
const deployer = mnemonicToAccount(MNEMONIC, { addressIndex: 0 });

const addrs = JSON.parse(readFileSync(join(ROOT, "frontend/e2e/.state/addresses.json"), "utf8"));
const pub = createPublicClient({ chain: foundry, transport: http(RPC) });
const w = (a) => createWalletClient({ chain: foundry, transport: http(RPC), account: a });
const send = async (a, req) => pub.waitForTransactionReceipt({ hash: await w(a).writeContract(req) });
const sign = async (a, tx) => {
  const r = await pub.waitForTransactionReceipt({ hash: await w(a).sendTransaction({ to: tx.to, data: tx.data }) });
  assert.equal(r.status, "success", `owner transaction: ${tx.description}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Fresh keys funded with gas by the deployer: anvil's other accounts belong to the scripted traders, and sharing
// one would race their nonces.
const fresh = async () => {
  const key = generatePrivateKey();
  const a = privateKeyToAccount(key);
  await pub.waitForTransactionReceipt({ hash: await w(deployer).sendTransaction({ to: a.address, value: 10n ** 18n }) });
  return { a, key };
};
const { a: owner, key: ownerKey } = await fresh();
const { a: agent, key: agentKey } = await fresh();

const factory = addrs.agentFactory;
await send(owner, { address: factory, abi: agentAccountFactoryAbi, functionName: "createAccount", args: [owner.address] });
const account = await pub.readContract({ address: factory, abi: agentAccountFactoryAbi, functionName: "accountOf", args: [owner.address] });
await send(owner, { address: addrs.usdc, abi: testUSDCAbi, functionName: "mint", args: [account, 20_000_000_000n] });
const block = await pub.getBlock();
await send(owner, { address: account, abi: agentAccountAbi, functionName: "setAgent", args: [agent.address, block.timestamp + 86_400n, 20, 2_000_000_000n] });

const dir = mkdtempSync(join(tmpdir(), "dp-mcp-"));
const deployment = join(dir, "deployment.json");
writeFileSync(deployment, JSON.stringify({ ...addrs, chainId: 31337, rpcUrl: RPC, collateral: "test" }));

async function connect(env) {
  const server = createServer(new Context(loadConfig({ DP_DEPLOYMENT: deployment, DP_KRAKEN_URL: KRAKEN, DP_FILL_TIMEOUT_SECONDS: "45", ...env })));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const body = JSON.parse(r.content[0].text);
    if (r.isError) console.log(`[tool error] ${name}: ${body.error.code} ${body.error.message.slice(0, 300)}`);
    return r.isError ? { error: body.error } : body;
  };
  return { client, call };
}
/** A state-changing call through the two-step confirmation. */
const confirmed = async (call, name, args) => {
  const pre = await call(name, args);
  assert.ok(pre.confirmToken, `${name} preview: ${JSON.stringify(pre)}`);
  return call(name, { ...args, confirmToken: pre.confirmToken });
};

const { client, call } = await connect({ DP_ACCOUNT: account, DP_AGENT_KEY: agentKey, DP_MAX_NOTIONAL_USD: "5000", DP_MAX_LEVERAGE: "10" });
const tools = (await client.listTools()).tools.map((t) => t.name).sort();
assert.deepEqual(tools, [
  "dp_account", "dp_add_margin", "dp_agents", "dp_cancel", "dp_claim", "dp_close", "dp_faucet", "dp_limit", "dp_markets", "dp_open", "dp_order_expiry",
  "dp_prepare_owner_tx", "dp_quote", "dp_referral", "dp_remove_margin", "dp_set_referrer", "dp_set_tpsl", "dp_strategies", "dp_strategy_control", "dp_strategy_create",
]);

const mk = await call("dp_markets");
assert.ok(mk.markets.length >= 11, "markets listed");
assert.equal(mk.mode, "agent-account");
const turbo = mk.markets.find((m) => m.symbol === "BTC-USD-TURBO");
assert.equal(turbo.feeModel, "upside");
assert.match(turbo.fees, /No fee unless you win/);
console.log("markets:", mk.markets.map((m) => `${m.symbol}@${m.referencePrice}`).join(" "));

const q = await call("dp_quote", { market: "ETH", side: "long", sizeUsd: "2000", leverage: 5 });
assert.equal(q.marginUsd, 400);
const tq = await call("dp_quote", { market: "BTC-TURBO", side: "long", sizeUsd: "100", leverage: 10 });
assert.equal(tq.openFeeUsd, 0);
assert.equal(tq.profitSharePct, 20);
assert.match(tq.fees, /No fee unless you win/);
console.log("turbo quote:", tq.fees);

// Guardrails: the MCP cap, then the on-chain agent policy (maxLeverage 20 > DP_MAX_LEVERAGE 10 here).
assert.equal((await call("dp_open", { market: "ETH", side: "long", sizeUsd: "6000", leverage: 5 })).error.code, "MAX_NOTIONAL_EXCEEDED");
assert.equal((await call("dp_open", { market: "ETH", side: "long", sizeUsd: "2000", leverage: 15 })).error.code, "LEVERAGE_OUT_OF_RANGE");

// Two-step confirmation.
const args = { market: "ETH-USD", side: "long", sizeUsd: "2000", leverage: 5 };
const pre = await call("dp_open", args);
assert.ok(pre.confirmToken, "preview returns a token");
assert.equal((await call("dp_open", { ...args, sizeUsd: "2100", confirmToken: pre.confirmToken })).error.code, "TOKEN_MISMATCH");
const pre2 = await call("dp_open", args);
const filled = await call("dp_open", { ...args, confirmToken: pre2.confirmToken });
console.log("open:", filled);
assert.equal(filled.status, "filled", JSON.stringify(filled));

const tpsl = await call("dp_set_tpsl", { market: "ETH", takeProfit: String(Math.round(filled.entryPrice * 1.2)), stopLoss: String(Math.round(filled.entryPrice * 0.8)) });
assert.ok(tpsl.takeProfit && tpsl.stopLoss);
assert.equal((await call("dp_set_tpsl", { market: "ETH", takeProfit: String(Math.round(filled.entryPrice * 0.5)) })).error.code, "INVALID_TAKE_PROFIT");
const acc = await call("dp_account");
assert.equal(acc.positions.length, 1);
assert.equal(acc.positions[0].market, "ETH-USD");
assert.ok(acc.positions[0].takeProfitOrderId && acc.positions[0].stopLossOrderId);
assert.equal(acc.agentPolicy.maxLeverage, 20);
console.log("account:", JSON.stringify(acc.positions[0]));

// Margin out (v3.2): 400 -> 300 on 2,000 is 6.67x, inside DP_MAX_LEVERAGE; 9.5x of profit-free margin stays.
assert.equal((await call("dp_remove_margin", { market: "ETH", amountUsd: "250" })).error.code, "LEVERAGE_OUT_OF_RANGE");
const removed = await confirmed(call, "dp_remove_margin", { market: "ETH", amountUsd: "100" });
console.log("remove margin:", removed);
assert.equal(removed.status, "removed", JSON.stringify(removed));
assert.equal((await call("dp_account")).positions[0].marginUsd, 300);

// Close half first (v3.1 partial close), then the rest.
const half = await confirmed(call, "dp_close", { market: "ETH", percent: 50 });
console.log("half close:", half);
assert.equal(half.status, "partly closed", JSON.stringify(half));
assert.equal(half.remainingSizeUsd, 1000);
const closed = await confirmed(call, "dp_close", { market: "ETH" });
console.log("close:", closed);
assert.equal(closed.status, "closed", JSON.stringify(closed));

// Turbo: no fee unless you win, a stop and an order good for a minute; then a close.
const tOpen = await confirmed(call, "dp_open", { market: "BTC-TURBO", side: "short", sizeUsd: "1000", leverage: 10, expiresInSeconds: 60 });
console.log("turbo open:", tOpen);
assert.equal(tOpen.status, "filled", JSON.stringify(tOpen));
assert.ok(tOpen.preview.expiresAt);
const tClose = await confirmed(call, "dp_close", { market: "BTC-TURBO" });
console.log("turbo close:", tClose);
assert.equal(tClose.status, "closed", JSON.stringify(tClose));

// Order expiry: a resting limit far from the market, its expiry pulled in to 5 s, then swept with a refund.
const ref = mk.markets.find((m) => m.symbol === "ETH-USD").referencePrice;
const limit = await confirmed(call, "dp_limit", { market: "ETH", side: "long", sizeUsd: "500", leverage: 5, price: String(Math.round(ref * 0.5)), expiresInSeconds: 600 });
assert.equal(limit.status, "resting", JSON.stringify(limit));
const exp = await call("dp_order_expiry", { orderId: limit.orderId, expiresInSeconds: 5 });
assert.ok(exp.expiresAt && exp.tx, JSON.stringify(exp));
await sleep(8_000);
await send(deployer, { address: addrs.usdc, abi: testUSDCAbi, functionName: "mint", args: [deployer.address, 1n] }); // a block past the expiry
const swept = await call("dp_cancel", { expired: true });
console.log("expired orders:", swept);
assert.deepEqual(swept.cancelled, [limit.orderId]);

// A strategy: refused until the owner approves Strategies; the owner signs the prepared transaction.
const spec = { kind: "trend", market: "BTC-TURBO", marginUsd: "10", leverage: 10, intervalSeconds: 60, fastPeriod: 2, slowPeriod: 4, stopLossBps: 50 };
const refused = await call("dp_strategy_create", spec);
assert.equal(refused.error.code, "STRATEGIES_NOT_APPROVED", JSON.stringify(refused));
await sign(owner, refused.error.details.ownerTx);
const created = await confirmed(call, "dp_strategy_create", spec);
console.log("strategy:", created);
assert.equal(created.status, "created", JSON.stringify(created));
let st = await call("dp_strategies");
assert.equal(st.approval.approved, true);
assert.equal(st.approval.dailyBudgetUsd, 50);
assert.equal(st.strategies.find((s) => s.id === created.id).status, "active");
assert.equal((await call("dp_strategy_create", spec)).error.code, "MARKET_TAKEN");
assert.equal((await call("dp_strategy_control", { id: created.id, action: "pause" })).status, "paused", "pausing needs no confirmation");
assert.equal((await confirmed(call, "dp_strategy_control", { id: created.id, action: "resume" })).status, "active");
assert.equal((await confirmed(call, "dp_strategy_control", { id: created.id, action: "stop" })).status, "stopped");

// Owner-only: the agent's daily budget, the account's referrer and a registry listing, all signed by the owner.
await sign(owner, await call("dp_prepare_owner_tx", { action: "set_agent_budget", dailyBudgetUsd: "1000" }));
assert.equal((await call("dp_account")).agentPolicy.dailyBudgetUsd, 1000);
const referral = await call("dp_set_referrer", { referrer: deployer.address });
assert.equal(referral.status, "needs-owner");
await sign(owner, referral.ownerTx);
const standing = await call("dp_referral");
assert.equal(standing.referrer?.toLowerCase(), deployer.address.toLowerCase(), JSON.stringify(standing));
await sign(owner, await call("dp_prepare_owner_tx", { action: "register_agent", name: "MCP smoke", kind: "llm", description: "Trades through dry-powder-mcp" }));
const listing = await call("dp_agents", { account });
assert.equal(listing.listed, true);
assert.equal(listing.name, "MCP smoke");

// The owner key is refused as an agent key: it could withdraw.
const asOwner = await connect({ DP_ACCOUNT: account, DP_AGENT_KEY: ownerKey });
assert.equal((await asOwner.call("dp_markets")).error.code, "CONFIG_ERROR");

// An agent can never move funds out: the account refuses withdraw() from it.
await assert.rejects(pub.simulateContract({ account: agent, address: account, abi: agentAccountAbi, functionName: "withdraw", args: [addrs.usdc, agent.address, 1n] }), /NotOwner/);
console.log("mcp smoke: all checks passed");
process.exit(0);
