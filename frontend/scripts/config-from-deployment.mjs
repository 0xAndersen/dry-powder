#!/usr/bin/env node
// Writes the static bundle's config.json from a deployment file (deployments/arc-testnet.json).
//   node scripts/config-from-deployment.mjs ../deployments/arc-testnet.json out/config.json
import { readFileSync, writeFileSync } from "node:fs";

const [src = "../deployments/arc-testnet.json", dest = "out/config.json"] = process.argv.slice(2);
const d = JSON.parse(readFileSync(src, "utf8"));
const config = {
  perpEngineAddress: d.engine,
  engineLensAddress: d.lens,
  houseVaultAddress: d.vault,
  rewardTokenAddress: d.token,
  usdcAddress: d.usdc,
  ...(d.agentFactory ? { agentFactoryAddress: d.agentFactory } : {}),
  ...(d.trailingStops ? { trailingStopsAddress: d.trailingStops } : {}),
  ...(d.twapOrders ? { twapOrdersAddress: d.twapOrders } : {}),
  rpcUrl: d.rpcUrl,
  chainId: d.chainId,
  oracleMode: "publisher",
  collateralSymbol: d.collateral === "test" ? "tUSDC" : "USDC",
  collateralIsTest: d.collateral === "test",
  krakenUrl: "https://api.kraken.com",
  explorerUrl: d.explorerUrl,
  ...(d.deployedAt ? { deployedAt: d.deployedAt } : {}),
};
writeFileSync(dest, JSON.stringify(config, null, 2) + "\n");
console.log(`wrote ${dest}`);
