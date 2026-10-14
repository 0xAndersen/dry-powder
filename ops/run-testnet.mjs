// Runs the whole ops runtime against Arc Testnet from YOUR machine: deploy -> fund -> publisher + keeper +
// 100 trader agents -> sweep -> reports. It opens a local Chromium (Playwright), loads a neutral page and
// drives window.ArcOps exactly as the acceptance test does, only with the real RPC, Kraken and esm.sh.
//
//   cd ops && npm ci && npx playwright install chromium
//   DEPLOYER_KEY=0x... node run-testnet.mjs            # add HEADLESS=0 to watch the tab
//
// Optional: AGENTS (100), MINUTES (30), EXPIRY_SECONDS (900), SEED (default: derived from DEPLOYER_KEY), RPC_URL, COLLATERAL (test|usdc),
// RESET=1 (discard a previous run stored in the browser profile). The profile is kept in ./.profile so a
// crashed run can be continued by starting the script again with the same SEED.
import { chromium } from "playwright";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inject, here } from "./test/harness.mjs";

// In GitHub Actions, failures are also written as annotations (readable without the log archive).
const annotate = (msg) => { if (process.env.GITHUB_ACTIONS) console.log(`::error::${String(msg).replace(/\n/g, " ").slice(0, 900)}`); };
process.on("uncaughtException", (e) => { annotate(e?.message ?? e); console.error(e); process.exit(1); });
process.on("unhandledRejection", (e) => { annotate(e?.message ?? e); console.error(e); process.exit(1); });
const key = process.env.DEPLOYER_KEY;
if (!/^0x[0-9a-fA-F]{64}$/.test(key || "")) {
  annotate(key ? "DEPLOYER_KEY is not a 0x-prefixed 32-byte hex key" : "DEPLOYER_KEY secret is missing: add it under Settings -> Secrets and variables -> Actions");
  throw new Error("set DEPLOYER_KEY to the 0x-prefixed deployer private key");
}
const outDir = join(here, "..", "output-testnet");
mkdirSync(outDir, { recursive: true });
const save = (n, o) => writeFileSync(join(outDir, n), JSON.stringify(o, null, 1));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ctx = await chromium.launchPersistentContext(join(here, "..", ".profile"), { headless: process.env.HEADLESS !== "0" });
const page = ctx.pages()[0] || (await ctx.newPage());
page.on("pageerror", (e) => log("[pageerror]", e.message.slice(0, 300)));
await page.goto("https://example.com");
log("injected", JSON.stringify(await inject(page)));
const ev = (s) => page.evaluate(s);
const poll = async (call) => { let r; do { r = await ev(call); if (r && r.pending) log(call, "pending:", r.step); } while (r && r.pending); return r; };
const must = (r, what) => { if (!r || r.error) { log(what, "failed:", JSON.stringify(r)); annotate(`${what} failed: ${JSON.stringify(r)}`); process.exit(1); } return r; };

const minutes = +(process.env.MINUTES || 30);
const cfg = {
  rpcUrl: process.env.RPC_URL || "https://rpc.testnet.arc.network",
  chainId: 5042002,
  deployerKey: key,
  // Role keys (publisher, keeper, agents) derive from the seed, so it must be secret: by default it derives
  // from the deployer key (the keeper uses the same rule, see keeper/src/main.mjs).
  seed: process.env.SEED || "dp-" + createHash("sha256").update(key.toLowerCase() + "/dry-powder/seed").digest("hex"),
  collateral: process.env.COLLATERAL || "test",
  agents: +(process.env.AGENTS || 100),
  agentCapital: 10000,
  vaultSeed: 5000000,
  params: { maxPriceAgeSeconds: 30, withdrawLockSeconds: 300, epochSeconds: 300, streamSeconds: 300, futureExpirySeconds: +(process.env.EXPIRY_SECONDS || 900) },
  pace: { tradesPerAgent: [5, 7], runMinutes: minutes },
  ...(process.env.RESET ? { reset: true } : {}),
};
let init = await ev(`ArcOps.init(${JSON.stringify(cfg)})`);
if (init && init.error && /stored state/.test(init.error)) { log("continuing the stored run"); init = await ev(`ArcOps.resume()`); }
log("init", JSON.stringify(must(init, "init")));

const pre = must(await ev(`ArcOps.preflight()`), "preflight");
save("preflight.json", pre);
log("preflight", JSON.stringify(pre));
if (process.env.GITHUB_ACTIONS) console.log(`::notice::preflight ${JSON.stringify(pre).slice(0, 900)}`);
if (!pre.chainIdOk) { log("wrong chain"); annotate("wrong chain id from the RPC"); process.exit(1); }
if (!pre.sufficient) { log(`deployer needs ${pre.shortfall} more native USDC`); annotate(`deployer needs ${pre.shortfall} more native USDC (faucet.circle.com)`); process.exit(1); }

const book = must(await poll(`ArcOps.deploy()`), "deploy");
save("addresses.json", book);
log("deployed", JSON.stringify(book));
const q = new URLSearchParams({ engine: book.engine, lens: book.lens, vault: book.vault, token: book.token, collateral: book.usdc, mode: "publisher", chain: "5042002", rpc: cfg.rpcUrl });
log("frontend (static build served from frontend/out): /trade/?" + q.toString());
log("funded", JSON.stringify(must(await poll(`ArcOps.fund()`), "fund")));
must(await ev(`ArcOps.start()`), "start");

for (;;) {
  await sleep(30000);
  const s = await ev(`ArcOps.status()`).catch((e) => ({ error: String(e) }));
  log("status", JSON.stringify(s));
  if (process.env.GITHUB_ACTIONS && s && s.phase) console.log(`::notice::status ${JSON.stringify(s).slice(0, 600)}`);
  if (s && s.phase === "ended") break;
}
const sweep = await poll(`ArcOps.sweep({returnGas:true})`);
save("sweep.json", sweep);
log("sweep", JSON.stringify(sweep));
save("summary.json", await ev(`ArcOps.summary()`));
save("leaderboard.json", await ev(`ArcOps.leaderboard()`));
save("gas.json", await ev(`ArcOps.gas()`));
const pages = [];
for (let p = 0; ; p++) { const r = await ev(`ArcOps.report(${p})`); if (!r || !r.rows || r.rows.length === 0) break; pages.push(r); }
save("report-pages.json", pages);
log("reports written to", outDir);
await ctx.close();
