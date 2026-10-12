#!/usr/bin/env node
// Dry Powder operator: price publisher + keeper for a deployment that uses the PublisherOracle.
//
//   DEPLOYMENT=../deployments/arc-testnet.json PUBLISHER_KEY=0x… KEEPER_KEY=0x… node src/main.mjs
//
// Keys: PUBLISHER_KEY and KEEPER_KEY directly, or SEED (the ops runtime's seed: role keys are
// keccak256(seed + "/publisher/0") and keccak256(seed + "/keeper/0")), or DEPLOYER_KEY alone (the seed then
// derives from it, as ops/run-testnet.mjs does). FUNDER_KEY (default: DEPLOYER_KEY) tops the two up with
// native USDC for gas when they run low.
// RUN_SECONDS stops it cleanly after that long (for scheduled runners); otherwise it runs until killed.
// PORT serves GET /health (JSON) for uptime checks.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { createPublicClient, createWalletClient, defineChain, http, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { makeKraken } from "./feeds.mjs";
import { makeOperator } from "./operator.mjs";

const env = process.env;
const num = (k, d) => (env[k] === undefined || env[k] === "" ? d : Number(env[k]));
const log = (scope, ...a) => console.log(`${new Date().toISOString()} [${scope}]`, ...a);

function addresses() {
  const file = env.DEPLOYMENT;
  const d = file ? JSON.parse(readFileSync(file, "utf8")) : {};
  const pick = (k, e) => env[e] || d[k];
  const a = {
    engine: pick("engine", "PERP_ENGINE_ADDRESS"),
    lens: pick("lens", "ENGINE_LENS_ADDRESS"),
    vault: pick("vault", "HOUSE_VAULT_ADDRESS"),
    oracle: pick("pub", "PUBLISHER_ORACLE_ADDRESS") || d.publisherOracle,
  };
  for (const [k, v] of Object.entries(a)) if (!/^0x[0-9a-fA-F]{40}$/.test(v || "")) throw new Error(`missing ${k} address (DEPLOYMENT file or env)`);
  return { ...a, rpcUrl: env.RPC_URL || d.rpcUrl, chainId: num("CHAIN_ID", d.chainId ?? 5042002) };
}

const roleKey = (seed, role) => keccak256(toHex(`${seed}/${role}/0`));
// Same rule as ops/run-testnet.mjs: without SEED, the seed derives from the deployer key.
const seed = env.SEED || (env.DEPLOYER_KEY ? "dp-" + createHash("sha256").update(env.DEPLOYER_KEY.toLowerCase() + "/dry-powder/seed").digest("hex") : null);
function key(name, role) {
  if (env[name]) return env[name];
  if (seed) return roleKey(seed, role);
  throw new Error(`set ${name}, SEED or DEPLOYER_KEY`);
}

const a = addresses();
const rpcUrl = a.rpcUrl || "https://rpc.testnet.arc.network";
const chain = defineChain({
  id: a.chainId,
  name: a.chainId === 5042002 ? "Arc Testnet" : `chain ${a.chainId}`,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
});
const transport = http(rpcUrl, { retryCount: 3, retryDelay: 400, timeout: 20_000 });
const pub = createPublicClient({ chain, transport, pollingInterval: 500 });
const wallet = (pk) => createWalletClient({ chain, transport, account: privateKeyToAccount(pk) });
const publisher = wallet(key("PUBLISHER_KEY", "publisher"));
const keeper = wallet(key("KEEPER_KEY", "keeper"));
const funder = env.FUNDER_KEY || env.DEPLOYER_KEY ? wallet(env.FUNDER_KEY || env.DEPLOYER_KEY) : null;

const opts = {
  heartbeatSeconds: num("HEARTBEAT_SECONDS", 60),
  moveBps: num("MOVE_BPS", 15),
  settleMarketDelaySeconds: num("SETTLE_MARKET_DELAY_SECONDS", 0),
  settleEpochs: !["0", "false"].includes(String(env.SETTLE_EPOCHS ?? "1")),
  settlePositionsDelaySeconds: num("SETTLE_POSITIONS_DELAY_SECONDS", 600),
  batchSize: num("BATCH_SIZE", 20),
  priorityFeeGwei: num("PRIORITY_FEE_GWEI", 1),
  minFeeGwei: num("MIN_FEE_GWEI", 25),
  minGas: num("MIN_GAS_USDC", 1),
  topUp: num("TOP_UP_USDC", 3),
  dryRun: env.DRY_RUN === "1" || env.DRY_RUN === "true",
};
const kraken = makeKraken(env.KRAKEN_URL || "https://api.kraken.com", num("STALE_FEED_MS", 60_000));
const op = makeOperator({ pub, publisher, keeper, funder, chainId: a.chainId, addresses: a, kraken, opts, log });

const actual = await pub.getChainId();
if (actual !== a.chainId) throw new Error(`RPC is chain ${actual}, expected ${a.chainId}`);
log("start", JSON.stringify({ rpcUrl, chainId: a.chainId, engine: a.engine, oracle: a.oracle, publisher: publisher.account.address, keeper: keeper.account.address, funder: funder?.account.address ?? null, opts }));

let last = { at: 0 };
let stopping = false;
const started = Date.now();
const runFor = num("RUN_SECONDS", 0) * 1000;
const tickMs = num("TICK_MS", 1500);

if (env.PORT) {
  createServer((req, res) => {
    const body = JSON.stringify({ ok: Date.now() - last.at < 60_000, last, stats: op.stats, kraken: op.krakenOk(), uptimeS: Math.round((Date.now() - started) / 1000) });
    res.writeHead(req.url === "/health" ? 200 : 404, { "content-type": "application/json" }).end(body);
  }).listen(Number(env.PORT));
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (stopping = true));

let lastReport = 0;
let failures = 0;
while (!stopping && (!runFor || Date.now() - started < runFor)) {
  const t0 = Date.now();
  try {
    last = { at: Date.now(), ...(await op.tick()) };
    failures = 0;
  } catch (e) {
    failures++;
    log("tick", "failed:", String(e?.shortMessage ?? e?.message ?? e).split("\n")[0]);
    if (failures > 50) throw e;
  }
  if (Date.now() - lastReport > 60_000) {
    lastReport = Date.now();
    log("status", JSON.stringify({ ...last, ...op.stats }));
  }
  await new Promise((r) => setTimeout(r, Math.max(200, tickMs - (Date.now() - t0)) * (failures ? Math.min(8, failures) : 1)));
}
log("stop", JSON.stringify(op.stats));
process.exit(0);
