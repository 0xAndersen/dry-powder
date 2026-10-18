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
import { createPublicClient, createWalletClient, defineChain, fallback, http, keccak256, toHex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { makeKraken } from "./feeds.mjs";
import { makeBitstamp, makeCoinbase, makeMedianSource } from "./sources.mjs";
import { makeGasSponsor } from "./sponsor.mjs";
import { makeOperator } from "./operator.mjs";

const env = process.env;
const num = (k, d) => (env[k] === undefined || env[k] === "" ? d : Number(env[k]));
const log = (scope, ...a) => console.log(`${new Date().toISOString()} [${scope}]`, ...a);
// In GitHub Actions, problems are also written as annotations (readable without the log archive).
let annotations = 0;
const annotate = (level, msg) => {
  if (!env.GITHUB_ACTIONS || annotations++ > 25) return;
  console.log(`::${level}::${String(msg).replace(/\n/g, " ").slice(0, 900)}`);
};
const fatal = (msg) => { annotate("error", msg); return new Error(msg); };
process.on("uncaughtException", (e) => { annotate("error", `keeper crashed: ${e?.stack ?? e}`); console.error(e); process.exit(1); });
process.on("unhandledRejection", (e) => { annotate("error", `keeper crashed: ${e?.stack ?? e}`); console.error(e); process.exit(1); });

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
  const optional = { factory: env.AGENT_FACTORY_ADDRESS || d.agentFactory || null, usdc: env.USDC_ADDRESS || d.usdc || null };
  for (const [k, v] of Object.entries(a)) if (!/^0x[0-9a-fA-F]{40}$/.test(v || "")) throw fatal(`missing ${k} address (DEPLOYMENT file or env)`);
  return { ...a, ...optional, rpcUrl: env.RPC_URL || d.rpcUrl, chainId: num("CHAIN_ID", d.chainId ?? 5042002) };
}

const roleKey = (seed, role) => keccak256(toHex(`${seed}/${role}/0`));
// Same rule as ops/run-testnet.mjs: without SEED, the seed derives from the deployer key.
const seed = env.SEED || (env.DEPLOYER_KEY ? "dp-" + createHash("sha256").update(env.DEPLOYER_KEY.toLowerCase() + "/dry-powder/seed").digest("hex") : null);
function key(name, role) {
  if (env[name]) return env[name];
  if (seed) return roleKey(seed, role);
  throw fatal(`set ${name}, SEED or DEPLOYER_KEY`);
}

const a = addresses();
// Arc Testnet public RPCs (docs.arc.io), tried in order; a failing one is skipped until it recovers.
const ARC_TESTNET_RPCS = [
  "https://rpc.testnet.arc.io",
  "https://rpc.quicknode.testnet.arc.io",
  "https://rpc.drpc.testnet.arc.io",
  "https://rpc.blockdaemon.testnet.arc.io",
  "https://5042002.rpc.thirdweb.com",
];
const rpcUrls = [...new Set([
  ...(env.RPC_URLS ? env.RPC_URLS.split(/[\s,]+/).filter(Boolean) : []),
  ...(a.rpcUrl ? [a.rpcUrl] : []),
  ...(a.chainId === 5042002 ? ARC_TESTNET_RPCS : []),
])];
if (!rpcUrls.length) throw fatal("set RPC_URL or RPC_URLS");
const rpcUrl = rpcUrls[0];
const chain = defineChain({
  id: a.chainId,
  name: a.chainId === 5042002 ? "Arc Testnet" : `chain ${a.chainId}`,
  nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
  rpcUrls: { default: { http: [rpcUrl] } },
  contracts: { multicall3: { address: env.MULTICALL3 || "0xcA11bde05977b3631167028862bE2a173976CA11" } },
});
// Public RPCs rate-limit (Arc's answers 429): retry with exponential backoff, and batch every read issued in
// the same tick into one Multicall3 eth_call.
const transport = fallback(
  rpcUrls.map((u) => http(u, { retryCount: 2, retryDelay: 750, timeout: 15_000 })),
  { rank: false, retryCount: 3, retryDelay: 1_000 },
);
const MC3 = chain.contracts.multicall3.address;
const probe = createPublicClient({ chain, transport });
const hasMc3 = ((await probe.getCode({ address: MC3 }).catch(() => undefined)) ?? "0x").length > 2;
// Receipt polling: every send waits for its receipt, so this bounds how many fills fit in a tick. Public RPCs
// rate-limit, so 1 s on Arc; a local chain mines instantly.
const pollingInterval = num("POLL_MS", a.chainId === 31337 ? 150 : 1_000);
const pub = createPublicClient({ chain, transport, pollingInterval, ...(hasMc3 ? { batch: { multicall: { wait: 50 } } } : {}) });
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
// Prices: Kraken alone (tests, local chains) or, on Arc Testnet by default, the median of Kraken, Coinbase and
// Bitstamp with a deviation guard, so no single venue's book can move the price (PRICE_SOURCES overrides).
const sourceNames = (env.PRICE_SOURCES || (a.chainId === 5042002 ? "kraken,coinbase,bitstamp" : "kraken")).split(",").map((x) => x.trim().toLowerCase());
const krakenOnly = makeKraken(env.KRAKEN_URL || "https://api.kraken.com", num("STALE_FEED_MS", 60_000));
const extraSources = [
  ...(sourceNames.includes("coinbase") ? [makeCoinbase(env.COINBASE_URL || undefined)] : []),
  ...(sourceNames.includes("bitstamp") ? [makeBitstamp(env.BITSTAMP_URL || undefined)] : []),
];
const kraken = extraSources.length
  ? makeMedianSource([{ name: "kraken", ...krakenOnly }, ...extraSources], {
      maxDeviationBps: num("MAX_SOURCE_DEVIATION_BPS", 50),
      onDisagree: (feed, mids) => log("price", `sources disagree on ${feed.key} (${mids.map((m) => m.toPrecision(8)).join(" vs ")}): not publishing it`),
    })
  : krakenOnly;
const op = makeOperator({ pub, publisher, keeper, funder, chainId: a.chainId, addresses: a, kraken, opts, log });

// Gas for instant-trading session keys (Arc Testnet by default; SPONSOR_GAS=0 turns it off).
const sponsorOn = !["0", "false"].includes(String(env.SPONSOR_GAS ?? (a.chainId === 5042002 ? "1" : "0"))) && funder && a.factory && a.usdc;
const usdc18 = (x) => BigInt(Math.round(Number(x) * 1e6)) * 10n ** 12n;
const sponsor = sponsorOn
  ? makeGasSponsor({
      pub,
      funder,
      factory: a.factory,
      usdc: a.usdc,
      log,
      opts: {
        floor: usdc18(env.SPONSOR_FLOOR_USDC ?? 0.05),
        topUp: usdc18(env.SPONSOR_TOP_UP_USDC ?? 0.25),
        perKeyDaily: usdc18(env.SPONSOR_PER_KEY_DAILY_USDC ?? 1),
        globalDaily: usdc18(env.SPONSOR_DAILY_USDC ?? 25),
        minCollateral: BigInt(Math.round(Number(env.SPONSOR_MIN_COLLATERAL ?? 10) * 1e6)),
        lookbackBlocks: BigInt(env.SPONSOR_LOOKBACK_BLOCKS ?? 150_000),
        chunk: BigInt(env.SPONSOR_LOG_CHUNK ?? 2_000),
      },
    })
  : null;
const actual = await pub.getChainId().catch((e) => { throw fatal(`no RPC reachable (${rpcUrls.join(", ")}): ${e?.shortMessage ?? e?.message ?? e}`); });
if (actual !== a.chainId) throw fatal(`RPC is chain ${actual}, expected ${a.chainId}`);
annotate("notice", `keeper started: publisher ${publisher.account.address}, keeper ${keeper.account.address}`);
log("start", JSON.stringify({ multicall: hasMc3, sources: sourceNames, gasSponsor: Boolean(sponsor), rpcUrls, chainId: a.chainId, engine: a.engine, oracle: a.oracle, publisher: publisher.account.address, keeper: keeper.account.address, funder: funder?.account.address ?? null, opts }));

let last = { at: 0 };
let stopping = false;
const started = Date.now();
const runFor = num("RUN_SECONDS", 0) * 1000;
const tickMs = num("TICK_MS", 3000);

if (env.PORT) {
  createServer((req, res) => {
    const body = JSON.stringify({ ok: Date.now() - last.at < 60_000, last, stats: op.stats, kraken: op.krakenOk(), sources: sourceNames, sponsor: sponsor?.stats ?? null, uptimeS: Math.round((Date.now() - started) / 1000) });
    res.writeHead(req.url === "/health" ? 200 : 404, { "content-type": "application/json" }).end(body);
  }).listen(Number(env.PORT));
}
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => (stopping = true));

let lastSponsor = 0;

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
    if (failures <= 3 || failures % 20 === 0) annotate("warning", `tick failed (${failures}): ${String(e?.shortMessage ?? e?.message ?? e).split("\n").slice(0, 3).join(" ")}`);
    if (failures > 50) throw e;
  }
  if (sponsor && Date.now() - lastSponsor > 30_000) {
    lastSponsor = Date.now();
    await sponsor.tick().catch((e) => log("sponsor", "failed:", String(e?.shortMessage ?? e?.message ?? e).split("\n")[0]));
  }
  if (Date.now() - lastReport > 60_000) {
    lastReport = Date.now();
    log("status", JSON.stringify({ ...last, ...op.stats, ...(sponsor ? { sponsor: sponsor.stats } : {}) }));
  }
  await new Promise((r) => setTimeout(r, Math.max(200, tickMs - (Date.now() - t0)) * (failures ? Math.min(8, failures) : 1)));
}
log("stop", JSON.stringify(op.stats));
process.exit(0);
