#!/usr/bin/env node
// Bridges contracts/script/Deploy.s.sol and the rest of the stack.
//
//   DEPLOYER_KEY=0x… node keeper/scripts/forge-deployment.mjs roles
//       prints PUBLISHER_ADDRESS=… KEEPER_ADDRESS=… DEPLOYER_ADDRESS=… (the role keys derive from the deployer key,
//       the same rule as keeper/src/main.mjs and ops/run-testnet.mjs), for $GITHUB_ENV.
//
//   DEPLOYER_KEY=0x… node keeper/scripts/forge-deployment.mjs addons [contracts/deployments/5042002-addons.json]
//       merges add-ons deployed by contracts/script/DeployAddons.s.sol (TrailingStops, TwapOrders, Strategies,
//       AgentRegistry) into the deployment file.
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
const [cmd = "write", argv1] = process.argv.slice(2);
const src = argv1 ?? join(root, "contracts/deployments/5042002.json");

const deployerKey = env.DEPLOYER_KEY || "";
if (!/^0x[0-9a-fA-F]{64}$/.test(deployerKey)) throw new Error("set DEPLOYER_KEY");
const seed = env.SEED || "dp-" + createHash("sha256").update(deployerKey.toLowerCase() + "/dry-powder/seed").digest("hex");
const role = (r) => privateKeyToAccount(keccak256(toHex(`${seed}/${r}/0`))).address;
const roles = { deployer: privateKeyToAccount(deployerKey).address, publisher: role("publisher"), keeper: role("keeper") };

if (cmd === "roles") {
  console.log(`PUBLISHER_ADDRESS=${roles.publisher}\nKEEPER_ADDRESS=${roles.keeper}\nDEPLOYER_ADDRESS=${roles.deployer}`);
  process.exit(0);
}
if (cmd === "addons") {
  // Merges contracts/deployments/<chainId>-addons.json (script/DeployAddons.s.sol) into the live deployment file.
  // The add-ons must have been deployed for the engine that file describes.
  const file = argv1 ?? join(root, "contracts/deployments/5042002-addons.json");
  const a = JSON.parse(readFileSync(file, "utf8"));
  const target = join(root, "deployments/arc-testnet.json");
  const d = JSON.parse(readFileSync(target, "utf8"));
  if (String(a.engine).toLowerCase() !== String(d.engine).toLowerCase()) throw new Error(`add-ons are for engine ${a.engine}, the deployment is ${d.engine}`);
  const keys = ["trailingStops", "twapOrders", "strategies", "agentRegistry"].filter((k) => /^0x[0-9a-fA-F]{40}$/.test(a[k] || "") && !/^0x0{40}$/.test(a[k]));
  if (keys.length === 0) throw new Error("add-ons file has no add-on addresses");
  for (const k of keys) {
    console.log(`${k} ${d[k] ?? "(none)"} -> ${a[k]} in ${target}`);
    d[k] = a[k];
  }
  writeFileSync(target, JSON.stringify(d, null, 2) + "\n");
  process.exit(0);
}
if (cmd !== "write") throw new Error(`unknown command ${cmd} (roles | write | addons)`);

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
  version: "v3.2",
  collateral: f.collateral,
  engine: f.perpEngine,
  ...(f.perpEngineExt && !/^0x0{40}$/.test(f.perpEngineExt) ? { engineExt: f.perpEngineExt } : {}),
  lens: f.engineLens,
  vault: f.houseVault,
  token: f.rewardToken,
  usdc: f.usdc,
  pub: f.publisherOracle,
  oracle: f.pythOracle,
  agentFactory: f.agentFactory,
  ...(f.trailingStops && !/^0x0{40}$/.test(f.trailingStops) ? { trailingStops: f.trailingStops } : {}),
  ...(f.twapOrders && !/^0x0{40}$/.test(f.twapOrders) ? { twapOrders: f.twapOrders } : {}),
  ...(f.strategies && !/^0x0{40}$/.test(f.strategies) ? { strategies: f.strategies } : {}),
  ...(f.agentRegistry && !/^0x0{40}$/.test(f.agentRegistry) ? { agentRegistry: f.agentRegistry } : {}),
  ...(f.prizeDistributor && !/^0x0{40}$/.test(f.prizeDistributor) ? { prizeDistributor: f.prizeDistributor } : {}),
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
