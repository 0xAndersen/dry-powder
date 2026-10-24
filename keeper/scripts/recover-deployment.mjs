#!/usr/bin/env node
// Rebuilds ops/output-testnet/addresses.json from the chain alone, for a deployment made by the ops runtime
// (ops/run-testnet.mjs) whose run did not finish writing it. The runtime deploys from the deployer's first
// nonces in a fixed order (TestUSDC, PublisherOracle, PythOracle, HouseVault, RewardToken, PerpEngine,
// EngineLens); every link is then checked on-chain before anything is written.
//
//   DEPLOYER_KEY=0x… node keeper/scripts/recover-deployment.mjs     # then keeper/scripts/finish-deploy.mjs
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, defineChain, getContractAddress, http, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { engineLensAbi, houseVaultAbi, perpEngineAbi, pythOracleAbi } from "../src/abi.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const key = process.env.DEPLOYER_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key || "")) throw new Error("set DEPLOYER_KEY");
const rpcUrl = process.env.RPC_URL || "https://rpc.testnet.arc.network";
const chain = defineChain({ id: 5042002, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const pub = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 4 }) });
const deployer = privateKeyToAccount(key).address;
const at = (n) => getContractAddress({ from: deployer, nonce: BigInt(n) });
const [usdc, pubOracle, oracle, vault, token, engine, lens] = [0, 1, 2, 3, 4, 5, 6].map(at);

const read = (address, abi, functionName, args = []) => pub.readContract({ address, abi, functionName, args });
const same = (a, b) => a.toLowerCase() === b.toLowerCase();
for (const [name, a] of Object.entries({ usdc, pubOracle, oracle, vault, token, engine, lens })) {
  const code = await pub.getCode({ address: a });
  if (!code || code === "0x") throw new Error(`no contract at the expected ${name} address ${a}`);
}
const checks = [
  [same(await read(lens, engineLensAbi, "engine"), engine), "lens.engine"],
  [same(await read(engine, perpEngineAbi, "usdc"), usdc), "engine.usdc"],
  [same(await read(vault, houseVaultAbi, "engine"), engine), "vault.engine"],
  [same(await read(vault, houseVaultAbi, "rewardToken"), token), "vault.rewardToken"],
  [same(await read(oracle, pythOracleAbi, "pyth"), pubOracle), "oracle.pyth"],
];
for (const [ok, what] of checks) if (!ok) throw new Error(`layout check failed: ${what}`);

const ids = await read(engine, perpEngineAbi, "getMarketIds");
const markets = [];
for (const id of ids) markets.push({ symbol: (await read(engine, perpEngineAbi, "getMarket", [id])).symbol, id });
// Role keys as the runtime derives them (same rule as ops/run-testnet.mjs and keeper/src/main.mjs).
const seed = process.env.SEED || "dp-" + createHash("sha256").update(key.toLowerCase() + "/dry-powder/seed").digest("hex");
const role = (r) => privateKeyToAccount(keccak256(toHex(`${seed}/${r}/0`))).address;
const book = { usdc, pub: pubOracle, oracle, vault, token, engine, lens, multicall3: "0xcA11bde05977b3631167028862bE2a173976CA11", publisher: role("publisher"), keeper: role("keeper"), deployer, markets };
const out = join(root, "ops/output-testnet/addresses.json");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, JSON.stringify(book, null, 1));
console.log(`recovered ${markets.length} markets: ${markets.map((m) => m.symbol).join(", ")}`);
console.log(JSON.stringify({ engine, lens, vault, token, usdc, pub: pubOracle }));
