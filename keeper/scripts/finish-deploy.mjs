#!/usr/bin/env node
// After ops/run-testnet.mjs has deployed the venue: deploys the AgentAccountFactory for that engine (once) and
// writes deployments/arc-testnet.json, the file the keeper, the MCP server and the frontend build read.
//
//   DEPLOYER_KEY=0x… node keeper/scripts/finish-deploy.mjs [ops/output-testnet/addresses.json]
import { existsSync, readFileSync, writeFileSync, mkdirSync, copyFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createPublicClient, createWalletClient, defineChain, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const env = process.env;
const src = process.argv[2] ?? join(root, "ops/output-testnet/addresses.json");
const outFile = join(root, "deployments/arc-testnet.json");
const book = JSON.parse(readFileSync(src, "utf8"));
const prev = existsSync(outFile) ? JSON.parse(readFileSync(outFile, "utf8")) : {};
const rpcUrl = env.RPC_URL || "https://rpc.testnet.arc.io";
const chainId = Number(env.CHAIN_ID || 5042002);
const chain = defineChain({ id: chainId, name: "Arc Testnet", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
const pub = createPublicClient({ chain, transport: http(rpcUrl, { retryCount: 4 }) });

let agentFactory = prev.engine?.toLowerCase() === book.engine.toLowerCase() ? prev.agentFactory : undefined;
if (agentFactory && (await pub.getCode({ address: agentFactory }))?.length > 2) {
  console.log(`agent factory already deployed for this engine: ${agentFactory}`);
} else {
  if (!/^0x[0-9a-fA-F]{64}$/.test(env.DEPLOYER_KEY || "")) throw new Error("set DEPLOYER_KEY");
  const art = JSON.parse(readFileSync(join(root, "contracts/out/AgentAccount.sol/AgentAccountFactory.json"), "utf8"));
  const wallet = createWalletClient({ chain, transport: http(rpcUrl, { retryCount: 4 }), account: privateKeyToAccount(env.DEPLOYER_KEY) });
  const block = await pub.getBlock();
  const base = block.baseFeePerGas ?? 20n * 10n ** 9n;
  const hash = await wallet.deployContract({ abi: art.abi, bytecode: art.bytecode.object, args: [book.usdc, book.engine], maxFeePerGas: base * 2n + 10n ** 9n, maxPriorityFeePerGas: 10n ** 9n });
  const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 120_000 });
  if (receipt.status !== "success" || !receipt.contractAddress) throw new Error(`factory deploy failed: ${hash}`);
  agentFactory = receipt.contractAddress;
  console.log(`agent factory deployed: ${agentFactory} (${hash})`);
}

const owner = (env.GITHUB_REPOSITORY || "0xAndersen/dry-powder").split("/");
const appUrl = env.APP_URL || `https://${owner[0].toLowerCase()}.github.io/${owner[1]}/`;
const deployment = {
  network: "arc-testnet",
  chainId,
  rpcUrl,
  explorerUrl: "https://explorer.testnet.arc.io",
  appUrl,
  deployedAt: prev.engine?.toLowerCase() === book.engine.toLowerCase() ? prev.deployedAt : new Date().toISOString(),
  collateral: "test",
  engine: book.engine,
  lens: book.lens,
  vault: book.vault,
  token: book.token,
  usdc: book.usdc,
  pub: book.pub,
  oracle: book.oracle,
  agentFactory,
  publisher: book.publisher,
  keeper: book.keeper,
  deployer: book.deployer,
  markets: book.markets,
};
mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, JSON.stringify(deployment, null, 2) + "\n");
console.log(`wrote ${outFile}`);

// Keep the run's reports next to the deployment for the record.
const runDir = join(root, "deployments/arc-testnet-run");
const outDir = dirname(src);
mkdirSync(runDir, { recursive: true });
for (const f of ["summary.json", "leaderboard.json", "gas.json", "preflight.json", "sweep.json", "report-pages.json"]) {
  if (existsSync(join(outDir, f))) copyFileSync(join(outDir, f), join(runDir, f));
}
