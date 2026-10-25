#!/usr/bin/env node
// Season prizes from the command line (roadmap 81). The logic is keeper/src/prizes.mjs; run `npm ci` in keeper/ first.
//
//   build    Ranks a season from the indexer's stats.json, applies the prize table and writes the season's results
//            (root, total, deadline, each winner's amount and proof) and the updated index into --out.
//   fund     Adds tUSDC to a season's pool (--mint mints it first: test collateral only).
//   publish  Publishes a results file on-chain (--fund tops the pool up to the total first).
//   close    After a season's claim deadline, rolls what is left of it into a later season (--season N --to M).
//   status   Prints a season as the PrizeDistributor holds it.
//
// Examples:
//   node ops/scripts/prizes.mjs build --stats status/stats.json --table '[500,300,150,100,50]' --season last \
//     --deadline-days 14 --exclude-agents --out prizes
//   DEPLOYER_KEY=0x… node ops/scripts/prizes.mjs publish --results prizes/season-3.json --fund --mint
//
// Environment: DEPLOYMENT (default deployments/arc-testnet.json: chainId, rpcUrl, prizeDistributor, usdc,
// agentRegistry, deployer, keeper, publisher), RPC_URL (overrides the file's), DEPLOYER_KEY (fund and publish; it
// must own the PrizeDistributor to publish), PRIZE_DISTRIBUTOR_ADDRESS (overrides the file's).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  DAY,
  clients,
  closeSeason,
  fundSeason,
  lastFinishedSeason,
  parseTable,
  publishSeason,
  readResults,
  registeredAgents,
  seasonByNumber,
  seasonOnChain,
  seasonResults,
  standings,
  updateIndex,
} from "../../keeper/src/prizes.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "../..");
const env = process.env;
const [command, ...rest] = process.argv.slice(2);

function args(list) {
  const out = {};
  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (!a.startsWith("--")) throw new Error(`unexpected argument ${a}`);
    const k = a.slice(2);
    const next = list[i + 1];
    if (next === undefined || next.startsWith("--")) out[k] = true;
    else {
      out[k] = next;
      i++;
    }
  }
  return out;
}

function deployment() {
  const file = resolve(env.DEPLOYMENT || join(root, "deployments/arc-testnet.json"));
  const d = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const distributor = env.PRIZE_DISTRIBUTOR_ADDRESS || d.prizeDistributor;
  return { ...d, rpcUrl: env.RPC_URL || d.rpcUrl, chainId: Number(env.CHAIN_ID || d.chainId || 5042002), distributor };
}

async function readJson(source) {
  if (/^https?:\/\//.test(source)) {
    const r = await fetch(source, { signal: AbortSignal.timeout(30_000) });
    if (!r.ok) throw new Error(`${source}: HTTP ${r.status}`);
    return r.json();
  }
  return JSON.parse(readFileSync(source, "utf8"));
}

const usdc = (v) => `${(Number(v) / 1e6).toLocaleString("en-US", { maximumFractionDigits: 6 })}`;

async function build(o) {
  const d = deployment();
  if (!o.stats) throw new Error("--stats <file or URL> is required");
  if (!o.table) throw new Error("--table '[500,300,…]' (whole USDC per rank) is required");
  const stats = await readJson(o.stats);
  if (stats.schema !== undefined && stats.schema !== 1) throw new Error(`stats.json schema ${stats.schema}: this script reads schema 1 (keeper/src/indexer.mjs)`);
  const launch = Number(stats.deployTime);
  if (!launch) throw new Error("stats.json has no deployTime: was it written by keeper/src/indexer.mjs?");
  if (d.engine && stats.engine && d.engine.toLowerCase() !== String(stats.engine).toLowerCase()) {
    throw new Error(`stats.json is for engine ${stats.engine}, the deployment's is ${d.engine}`);
  }
  const now = Math.floor(Date.now() / 1000);
  const season = o.season === undefined || o.season === "last" ? lastFinishedSeason(now, launch) : seasonByNumber(Number(o.season), launch);
  if (!season) throw new Error("no season has ended yet (the pre-season is still running)");
  if (season.end > now && !o.force) throw new Error(`season ${season.number} ends ${new Date(season.end * 1000).toISOString()}: build it after that (or pass --force)`);
  if ((stats.cursorTime ?? 0) < season.end && !o.force) {
    throw new Error(`stats.json reaches ${new Date((stats.cursorTime ?? 0) * 1000).toISOString()}, before the season's end: wait for the indexer (or --force)`);
  }
  const table = parseTable(o.table.startsWith("[") ? o.table : readFileSync(o.table, "utf8"));
  // Lower case throughout; the results file lists them checksummed.
  const exclude = new Set(String(o.exclude || "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean));
  for (const a of exclude) if (!/^0x[0-9a-f]{40}$/.test(a)) throw new Error(`--exclude: not an address: ${a}`);
  // The venue's own keys never win.
  for (const k of ["deployer", "keeper", "publisher"]) if (d[k]) exclude.add(String(d[k]).toLowerCase());
  const minTrades = Number(o["min-trades"]) || 1;
  if (o["exclude-agents"]) {
    if (!d.agentRegistry) throw new Error("--exclude-agents needs the deployment's agentRegistry");
    const { pub } = clients({ rpcUrl: d.rpcUrl, chainId: d.chainId });
    // Everyone who could place (positive net, enough trades), best first, until the table can be filled without them.
    const candidates = standings(stats, season).filter((r) => r.net > 0n && r.trades >= minTrades && !exclude.has(r.account.toLowerCase()));
    let others = 0;
    for (let i = 0; i < candidates.length && others < table.length; i += 50) {
      const batch = candidates.slice(i, i + 50).map((r) => r.account);
      const agents = await registeredAgents(pub, d.agentRegistry, batch);
      for (const a of agents) exclude.add(a);
      others += batch.length - agents.size;
    }
  }
  const deadline = Number(o.deadline) || now + (Number(o["deadline-days"]) || 14) * DAY;
  const results = seasonResults({
    stats,
    season,
    table,
    deadline,
    distributor: d.distributor ?? null,
    chainId: d.chainId,
    exclude,
    minTrades,
    launch,
  });
  const out = resolve(o.out || "prizes");
  mkdirSync(out, { recursive: true });
  const file = `season-${results.season}.json`;
  writeFileSync(join(out, file), JSON.stringify(results, null, 2) + "\n");
  const indexFile = join(out, "index.json");
  const index = existsSync(indexFile) ? JSON.parse(readFileSync(indexFile, "utf8")) : null;
  writeFileSync(indexFile, JSON.stringify(updateIndex(index, results, file), null, 2) + "\n");
  console.log(`season ${results.season} (${new Date(results.start * 1000).toISOString()} to ${new Date(results.end * 1000).toISOString()}): ${results.winners.length} winners, ${usdc(results.total)} in total`);
  for (const w of results.winners) console.log(`  #${w.rank} ${w.account} ${usdc(w.amount)} (net ${usdc(w.net)}, ${w.trades} trades)`);
  console.log(`root ${results.root}; claimable until ${new Date(results.deadline * 1000).toISOString()}; wrote ${join(out, file)} and ${indexFile}`);
  if (env.GITHUB_OUTPUT) writeFileSync(env.GITHUB_OUTPUT, `season=${results.season}\nfile=${file}\n`, { flag: "a" });
}

function chainWith(o, needKey) {
  const d = deployment();
  if (!d.distributor) throw new Error("no PrizeDistributor: set PRIZE_DISTRIBUTOR_ADDRESS or deploy v3.2");
  if (!d.rpcUrl) throw new Error("set RPC_URL");
  if (needKey && !env.DEPLOYER_KEY) throw new Error("set DEPLOYER_KEY");
  return { d, ...clients({ rpcUrl: d.rpcUrl, chainId: d.chainId, key: needKey ? env.DEPLOYER_KEY : null }), log: (m) => console.log(m) };
}

async function fund(o) {
  const { d, pub, wallet, log } = chainWith(o, true);
  if (o.season === undefined || !o.amount) throw new Error("--season N --amount <whole USDC> are required");
  const [amount] = parseTable(`[${o.amount}]`);
  await fundSeason({ pub, wallet, distributor: d.distributor, usdc: d.usdc, season: Number(o.season), amount, mint: Boolean(o.mint), log });
}

async function publish(o) {
  const { d, pub, wallet, log } = chainWith(o, true);
  if (!o.results) throw new Error("--results <season-N.json> is required");
  const results = readResults(JSON.parse(readFileSync(o.results, "utf8")));
  if (results.distributor && results.distributor.toLowerCase() !== d.distributor.toLowerCase()) {
    throw new Error(`the results are for distributor ${results.distributor}, this deployment's is ${d.distributor}`);
  }
  if (results.deadline <= Math.floor(Date.now() / 1000)) throw new Error("the claim deadline has passed: rebuild with a later one");
  await publishSeason({ pub, wallet, distributor: d.distributor, usdc: d.usdc, results, fund: Boolean(o.fund), mint: Boolean(o.mint), log });
}

async function close(o) {
  const { d, pub, wallet, log } = chainWith(o, true);
  if (o.season === undefined || o.to === undefined) throw new Error("--season N --to M are required");
  await closeSeason({ pub, wallet, distributor: d.distributor, season: Number(o.season), toSeason: Number(o.to), log });
}

async function status(o) {
  const { d, pub } = chainWith(o, false);
  const s = await seasonOnChain(pub, d.distributor, Number(o.season ?? 0));
  console.log(JSON.stringify({ season: Number(o.season ?? 0), ...s, funded: String(s.funded), allocated: String(s.allocated), claimed: String(s.claimed) }, null, 2));
}

const commands = { build, fund, publish, close, status };
if (!commands[command]) {
  console.error("usage: prizes.mjs build|fund|publish|close|status [--options]; see the header of ops/scripts/prizes.mjs");
  process.exit(2);
}
await commands[command](args(rest)).then(
  // viem's receipt timeout keeps a timer alive after the receipt arrives: exit instead of waiting for it.
  () => process.exit(0),
  (e) => {
    console.error(`prizes ${command}: ${e?.shortMessage ?? e?.message ?? e}`);
    process.exit(1);
  },
);
