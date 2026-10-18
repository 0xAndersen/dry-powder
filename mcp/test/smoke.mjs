// End-to-end check of the MCP server through a real MCP client, against the local stack:
//   frontend/e2e/with-keeper.sh is the usual way to get a chain + keeper; or start them by hand, then
//   node mcp/test/smoke.mjs
// It deploys an AgentAccountFactory, gives an owner an agent account funded with test USDC, approves an agent
// key with a policy, and lets the MCP server trade from it.
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
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

const art = JSON.parse(readFileSync(join(ROOT, "contracts/out/AgentAccount.sol/AgentAccountFactory.json"), "utf8"));
const hash = await w(deployer).deployContract({ abi: agentAccountFactoryAbi, bytecode: art.bytecode.object, args: [addrs.usdc, addrs.engine] });
const factory = (await pub.waitForTransactionReceipt({ hash })).contractAddress;
await send(owner, { address: factory, abi: agentAccountFactoryAbi, functionName: "createAccount", args: [owner.address] });
const account = await pub.readContract({ address: factory, abi: agentAccountFactoryAbi, functionName: "accountOf", args: [owner.address] });
await send(owner, { address: addrs.usdc, abi: testUSDCAbi, functionName: "mint", args: [account, 20_000_000_000n] });
const block = await pub.getBlock();
await send(owner, { address: account, abi: agentAccountAbi, functionName: "setAgent", args: [agent.address, block.timestamp + 86_400n, 20, 2_000_000_000n] });

const dir = mkdtempSync(join(tmpdir(), "dp-mcp-"));
const deployment = join(dir, "deployment.json");
writeFileSync(deployment, JSON.stringify({ ...addrs, chainId: 31337, rpcUrl: RPC, agentFactory: factory, collateral: "test" }));

async function connect(env) {
  const server = createServer(new Context(loadConfig({ DP_DEPLOYMENT: deployment, DP_KRAKEN_URL: KRAKEN, DP_FILL_TIMEOUT_SECONDS: "45", ...env })));
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "smoke", version: "0" });
  await Promise.all([server.connect(a), client.connect(b)]);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    const body = JSON.parse(r.content[0].text);
    return r.isError ? { error: body.error } : body;
  };
  return { client, call };
}

const { client, call } = await connect({ DP_ACCOUNT: account, DP_AGENT_KEY: agentKey, DP_MAX_NOTIONAL_USD: "5000", DP_MAX_LEVERAGE: "10" });
const tools = (await client.listTools()).tools.map((t) => t.name).sort();
assert.deepEqual(tools, ["dp_account", "dp_add_margin", "dp_cancel", "dp_close", "dp_faucet", "dp_limit", "dp_markets", "dp_open", "dp_quote", "dp_set_tpsl"]);

const mk = await call("dp_markets");
assert.ok(mk.markets.length >= 7, "markets listed");
assert.equal(mk.mode, "agent-account");
console.log("markets:", mk.markets.map((m) => `${m.symbol}@${m.referencePrice}`).join(" "));

const q = await call("dp_quote", { market: "ETH", side: "long", sizeUsd: "2000", leverage: 5 });
assert.equal(q.marginUsd, 400);
console.log("quote:", q);

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
const acc = await call("dp_account");
assert.equal(acc.positions.length, 1);
assert.equal(acc.positions[0].market, "ETH-USD");
assert.ok(acc.positions[0].takeProfitOrderId && acc.positions[0].stopLossOrderId);
assert.equal(acc.agentPolicy.maxLeverage, 20);
console.log("account:", JSON.stringify(acc.positions[0]));

// Close half first (v3.1 partial close), then the rest.
const hpre = await call("dp_close", { market: "ETH", percent: 50 });
const half = await call("dp_close", { market: "ETH", percent: 50, confirmToken: hpre.confirmToken });
console.log("half close:", half);
assert.equal(half.status, "partly closed", JSON.stringify(half));
assert.equal(half.remainingSizeUsd, 1000);

const cpre = await call("dp_close", { market: "ETH" });
const closed = await call("dp_close", { market: "ETH", confirmToken: cpre.confirmToken });
console.log("close:", closed);
assert.equal(closed.status, "closed", JSON.stringify(closed));

// The owner key is refused as an agent key: it could withdraw.
const asOwner = await connect({ DP_ACCOUNT: account, DP_AGENT_KEY: ownerKey });
assert.equal((await asOwner.call("dp_markets")).error.code, "CONFIG_ERROR");

// An agent can never move funds out: the account refuses withdraw() from it.
await assert.rejects(pub.simulateContract({ account: agent, address: account, abi: agentAccountAbi, functionName: "withdraw", args: [addrs.usdc, agent.address, 1n] }), /NotOwner/);
console.log("mcp smoke: all checks passed");
process.exit(0);
