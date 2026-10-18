#!/usr/bin/env node
// Bridges contracts/script/Deploy.s.sol and the rest of the stack.
//
//   DEPLOYER_KEY=0x… node keeper/scripts/forge-deployment.mjs roles
//       prints PUBLISHER_ADDRESS=… KEEPER_ADDRESS=… DEPLOYER_ADDRESS=… (the role keys derive from the deployer key,
//       the same rule as keeper/src/main.mjs and ops/run-testnet.mjs), for $GITHUB_ENV.
//
//   DEPLOYER_KEY=0x… node keeper/scripts/forge-deployment.mjs write [contracts/deployments/5042002.json]
//       turns the Forge script's output into deployments/arc-testnet.json, the file the keeper, the MCP server,
//       the SDK and the frontend build read. The previous deployment is archived under deployments/history/.
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const env = process.env;
const [cmd = "write", src = join(root, "contracts/deployments/5042002.json")] = process.argv.slice(2);

const deployerKey = env.DEPLOYER_KEY || "";
if (!/^0x[0-9a-fA-F]{64}$/.test(deployerKey)) throw new Error("set DEPLOYER_KEY");
const seed = env.SEED || "dp-" + createHash("sha256").update(deployerKey.toLowerCase() + "/dry-powder/seed").digest("hex");
const role = (r) => privateKeyToAccount(keccak256(toHex(`${seed}/${r}/0`))).address;
const roles = { deployer: privateKeyToAccount(deployerKey).address, publisher: role("publisher"), keeper: role("keeper") };

if (cmd === "roles") {
  console.log(`PUBLISHER_ADDRESS=${roles.publisher}\nKEEPER_ADDRESS=${roles.keeper}\nDEPLOYER_ADDRESS=${roles.deployer}`);
  process.exit(0);
}
if (cmd !== "write") throw new Error(`unknown command ${cmd} (roles | write)`);

const f = JSON.parse(readFileSync(src, "utf8"));
const outFile = join(root, "deployments/arc-testnet.json");
const prev = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : null;
if (prev?.engine && prev.engine.toLowerCase() !== f.perpEngine.toLowerCase()) {
  const day = (prev.deployedAt || new Date().toISOString()).slice(0, 10);
  mkdirSync(join(root, "deployments/history"), { recursive: true });
  copyFileSync(outFile, join(root, `deployments/history/arc-testnet-${day}-${prev.engine.slice(2, 8).toLowerCase()}.json`));
}
const [owner, repo] = (env.GITHUB_REPOSITORY || "0xAndersen/dry-powder").split("/");
const deployment = {
  network: "arc-testnet",
  chainId: Number(f.chainId),
  rpcUrl: env.RPC_URL || "https://rpc.testnet.arc.io",
  explorerUrl: "https://explorer.testnet.arc.io",
  appUrl: env.APP_URL || `https://${owner.toLowerCase()}.github.io/${repo}/`,
  deployedAt: prev?.engine?.toLowerCase() === f.perpEngine.toLowerCase() ? prev.deployedAt : new Date().toISOString(),
  version: "v3.1",
  collateral: f.collateral,
  engine: f.perpEngine,
  lens: f.engineLens,
  vault: f.houseVault,
  token: f.rewardToken,
  usdc: f.usdc,
  pub: f.publisherOracle,
  oracle: f.pythOracle,
  agentFactory: f.agentFactory,
  ...(f.trailingStops && !/^0x0{40}$/.test(f.trailingStops) ? { trailingStops: f.trailingStops } : {}),
  publisher: roles.publisher,
  keeper: roles.keeper,
  deployer: roles.deployer,
  markets: f.marketSymbols.map((symbol, i) => ({ symbol, id: f.marketIds[i] })),
};
for (const k of ["engine", "lens", "vault", "token", "usdc", "pub", "oracle", "agentFactory"]) {
  if (!/^0x[0-9a-fA-F]{40}$/.test(deployment[k] || "") || /^0x0{40}$/.test(deployment[k])) throw new Error(`deployment is missing ${k}`);
}
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(deployment, null, 2) + "\n");
console.log(`wrote ${outFile}: engine ${deployment.engine}, ${deployment.markets.length} markets`);
