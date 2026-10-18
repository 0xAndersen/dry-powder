// Runs a swarm of risk-capped agents, each with its own wallet and its own parameters, then prints a leaderboard.
//
//   FUNDER_KEY=0x… AGENTS=8 RUN_MINUTES=20 node swarm.mjs
//
// Wallets derive from SEED (default: from FUNDER_KEY), so a rerun reuses them. FUNDER_KEY pays each wallet's gas
// (native USDC on Arc); on test deployments every agent mints its own test collateral. Testnet only.
import { spawn } from "node:child_process";
import { DryPowder, fromUsd } from "@dry-powder/sdk";
import { createWalletClient, fallback, http, keccak256, parseEther, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const env = process.env;
if (!env.FUNDER_KEY) throw new Error("set FUNDER_KEY (a throwaway testnet key with native USDC for gas)");
const N = Number(env.AGENTS ?? 8);
const MINUTES = Number(env.RUN_MINUTES ?? 20);
const seed = env.SEED ?? keccak256(toHex(`${env.FUNDER_KEY.toLowerCase()}/dry-powder/swarm`));
const keyOf = (i) => keccak256(toHex(`${seed}/agent/${i}`));

const markets = ["BTC-USD", "ETH-USD", "SOL-USD", "XAU-USD", "EUR-USD"];
const plans = Array.from({ length: N }, (_, i) => ({
  i,
  key: keyOf(i),
  MARKET: markets[i % markets.length],
  STOP_DISTANCE: String([0.002, 0.004, 0.008][i % 3]),
  RISK_PER_TRADE: String([0.005, 0.01, 0.02][Math.floor(i / 3) % 3]),
  LOOKBACK: String([10, 20, 40][i % 3]),
}));

const dp = await DryPowder.connect({ deployment: env.DEPLOYMENT });
const funder = createWalletClient({ chain: dp.chain, transport: fallback(dp.chain.rpcUrls.default.http.map((u) => http(u))), account: privateKeyToAccount(env.FUNDER_KEY) });
for (const p of plans) {
  const addr = privateKeyToAccount(p.key).address;
  if ((await dp.publicClient.getBalance({ address: addr })) < parseEther("0.5")) {
    const hash = await funder.sendTransaction({ to: addr, value: parseEther("1") });
    await dp.publicClient.waitForTransactionReceipt({ hash });
  }
}
console.log(`${N} agents funded; running for ${MINUTES} min`);

const start = new Map();
for (const p of plans) start.set(p.i, await dp.balance(privateKeyToAccount(p.key).address));
const runs = plans.map(
  (p) =>
    new Promise((resolve) => {
      const child = spawn(process.execPath, ["risk-capped-agent.mjs"], {
        env: { ...env, KEY: p.key, MARKET: p.MARKET, STOP_DISTANCE: p.STOP_DISTANCE, RISK_PER_TRADE: p.RISK_PER_TRADE, LOOKBACK: p.LOOKBACK, RUN_MINUTES: String(MINUTES) },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const tag = `[agent ${String(p.i).padStart(2)} ${p.MARKET}]`;
      child.stdout.on("data", (d) => process.stdout.write(String(d).replace(/^/gm, `${tag} `)));
      child.stderr.on("data", (d) => process.stderr.write(String(d).replace(/^/gm, `${tag} `)));
      child.on("exit", resolve);
    }),
);
await Promise.all(runs);

const rows = [];
for (const p of plans) {
  const a = privateKeyToAccount(p.key).address;
  const now = await dp.balance(a);
  rows.push({ agent: p.i, market: p.MARKET, stop: p.STOP_DISTANCE, risk: p.RISK_PER_TRADE, pnl: fromUsd(now - (start.get(p.i) ?? 0n)) });
}
rows.sort((a, b) => b.pnl - a.pnl);
console.table(rows);
