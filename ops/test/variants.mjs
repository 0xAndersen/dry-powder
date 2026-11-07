// Smaller scenario runs for the paths the main acceptance run does not take:
//   node test/variants.mjs flaky      429/5xx/dropped connections + an endpoint that refuses batches + a Kraken outage
//   node test/variants.mjs nomc3      no Multicall3 on the chain (sequential funding fallback)
//   node test/variants.mjs usdc       collateral: "usdc" against an existing 6-decimal token
//   node test/variants.mjs lean       pace.lean (cheapest paths only)
import { chromium } from "playwright";
import { createWalletClient, createPublicClient, http, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { startAnvil, startKraken, startStatic, startFlakyRpc, inject, rpc, here, root } from "./harness.mjs";

const mode = process.argv[2] || "flaky";
const N = +(process.env.AGENTS || 16), MIN = +(process.env.MINUTES || 3);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fails = [], passes = [];
const check = (name, ok, detail) => { (ok ? passes : fails).push(name + (detail !== undefined ? " [" + detail + "]" : "")); log(ok ? "PASS" : "FAIL", name, detail !== undefined ? detail : ""); };

const anvil = await startAnvil(8545, { multicall3: mode !== "nomc3" });
const kraken = startKraken(8546, { outage: mode === "flaky" ? { from: 70, to: 84 } : null });
const web = await startStatic(8547);
const flaky = mode === "flaky" ? startFlakyRpc(anvil.url, 8548, { noBatch: !!process.env.NO_BATCH }) : null;
const key = generatePrivateKey();
const deployer = privateKeyToAccount(key);
await rpc(anvil.url, "anvil_setBalance", [deployer.address, "0x" + (40n * 10n ** 18n).toString(16)]);
const extra = {};
const erc = parseAbi(["function mint(address,uint256)", "function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)"]);
const pc = createPublicClient({ transport: http(anvil.url) });
if (mode === "usdc") {
  // An "existing USDC": deployed and handed to the deployer outside the runtime.
  const art = JSON.parse(readFileSync(join(root, "../contracts/out/TestUSDC.sol/TestUSDC.json"), "utf8"));
  const wc = createWalletClient({ account: deployer, transport: http(anvil.url), chain: { id: 5042002, name: "anvil", nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [anvil.url] } } } });
  const h = await wc.deployContract({ abi: art.abi, bytecode: art.bytecode.object });
  const rc = await pc.waitForTransactionReceipt({ hash: h });
  extra.usdcAddress = rc.contractAddress;
  extra.collateral = "usdc";
  extra.vaultSeed = 300000;
  extra.agentCapital = 5000;
  await pc.waitForTransactionReceipt({ hash: await wc.writeContract({ address: rc.contractAddress, abi: erc, functionName: "mint", args: [deployer.address, BigInt(300000 + 5000 * N) * 1000000n] }) });
}
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const page = await browser.newPage();
const pageErrors = [];
page.on("pageerror", (e) => { pageErrors.push(e.message); log("[pageerror]", e.message.slice(0, 300)); });
await page.goto(web.url + "/blank.html");
await inject(page);
const ev = (s) => page.evaluate(s);
const poll = async (call) => { let r; do { r = await ev(call); } while (r && r.pending); return r; };
const cfg = { rpcUrl: flaky ? flaky.url : anvil.url, chainId: 5042002, deployerKey: key, seed: mode + Date.now(), viemUrl: web.url + "/viem.js", viemAccountsUrl: web.url + "/viem-accounts.js", krakenUrl: kraken.url,
  agents: N, params: { maxPriceAgeSeconds: 20, withdrawLockSeconds: 30, epochSeconds: 45, streamSeconds: 30, futureExpirySeconds: 90 },
  pace: { runMinutes: MIN, tradesPerAgent: [5, 6], autoSweep: mode === "lean", lean: mode === "lean" }, ...extra };
log("init", JSON.stringify(await ev(`ArcOps.init(${JSON.stringify(cfg)})`)));
const pre = await ev(`ArcOps.preflight()`);
log("preflight", JSON.stringify(pre.costUsdc), "required", pre.required, "multicall3", pre.multicall3);
const book = await poll(`ArcOps.deploy()`);
if (book.error) { log("deploy failed", book.error); process.exit(1); }
const fund = await poll(`ArcOps.fund()`);
log("fund", JSON.stringify(fund));
if (fund.error) process.exit(1);
await ev(`ArcOps.start()`);
const t0 = Date.now();
let s;
while (Date.now() - t0 < MIN * 1.6 * 60000) {
  await sleep(10000);
  s = await ev(`ArcOps.status()`);
  log(Math.round((Date.now() - t0) / 1000) + "s", JSON.stringify({ ph: s.phase, a: s.agents, t: s.trades, rv: s.reverts, kp: s.keeper, pub: s.publisher, an: s.anomalies, rpc: s.rpc, le: s.loopErr, last: s.lastErr, txErr: s.txErr }));
  if (s.phase === "ended" || s.agents.done + s.agents.failed === s.agents.n) break;
}
const sw = await poll(`ArcOps.sweep({returnGas:true})`);
log("sweep", JSON.stringify(sw));
const summary = await ev(`ArcOps.summary()`);
const gas = await ev(`ArcOps.gas()`);
const pages = [];
for (let p = 0; ; p++) { const r = await ev(`ArcOps.report(${p})`); pages.push(r); if (p + 1 >= r.pages) break; }
const rows = pages.flatMap((p) => p.rows.map((r) => Object.fromEntries(p.cols.map((c, i) => [c, r[i]]))));
const c = summary.checks;
check("all agents done", rows.every((r) => r.state === "done"), rows.filter((r) => r.state !== "done").map((r) => r.id + ":" + r.state).join(",") || N);
check(">= 5 round trips and margin >= capital for every agent", rows.every((r) => r.trips >= 5 && r.margin >= (extra.agentCapital || 10000)));
check("flat; engine and vault balances reconcile", c.flat && c.engineOk && c.vaultOk);
const usdc = book.usdc;
let sum = 0n;
for (const a of [...rows.map((r) => r.addr), deployer.address, book.keeper, book.publisher, book.vault, book.engine]) sum += await pc.readContract({ address: usdc, abi: erc, functionName: "balanceOf", args: [a] });
const supply = await pc.readContract({ address: usdc, abi: erc, functionName: "totalSupply" });
check("collateral conserved (chain)", sum === supply, `${sum} vs ${supply}`);
check("no uncaught page errors", pageErrors.length === 0);
if (mode === "flaky") {
  check("RPC errors were injected, retried and counted", flaky.stats.s429 > 0 && summary.rpc.errors.http429 > 0 && summary.rpc.errors.http5xx > 0 && summary.rpc.retries > 0, JSON.stringify({ proxy: flaky.stats, seen: summary.rpc.errors, rate: summary.rpc.errorRate }));
  if (process.env.NO_BATCH) check("fell back to single requests when batches are refused", s.rpc.noBatch === true && flaky.stats.batchesRefused >= 1, flaky.stats.batchesRefused);
  check("Kraken outage: publisher backed off and recovered", summary.publisher.pollErrors > 0 && kraken.stats.refused > 0 && summary.publisher.polls > 50, `pollErrors ${summary.publisher.pollErrors}, refused ${kraken.stats.refused}`);
}
if (mode === "nomc3") check("sequential funding used", fund.multicall3 === false && gas.byType["fund:native:single"] && gas.byType["fund:mint:single"] && !gas.byType["fund:native"], JSON.stringify([gas.byType["fund:native:single"], gas.byType["fund:mint:single"]]));
if (mode === "usdc") check("existing token used as collateral (no TestUSDC deployed, transfers not mints)", !gas.byType["deploy:TestUSDC"] && gas.byType["fund:transfer"] && book.usdc.toLowerCase() === extra.usdcAddress.toLowerCase());
if (mode === "lean") check("lean pace: only direct opens/closes, auto-sweep ended the run", !gas.byType["open+brackets"] && !gas.byType["limit:resting"] && !gas.byType["exec:limit"] && summary.run.phase === "ended", JSON.stringify(Object.keys(gas.byType).filter((k) => !/deploy|fund|seed|addMarket/.test(k))));
mkdirSync(join(here, "output"), { recursive: true });
writeFileSync(join(here, "output", `variant-${mode}${process.env.NO_BATCH ? "-nobatch" : ""}.json`), JSON.stringify({ ok: !fails.length, mode, agents: N, passes, fails, preflight: pre, summary, gas, proxy: flaky && flaky.stats, kraken: kraken.stats, returned: sw.returned }, null, 1));
log(fails.length ? "FAILED" : "ALL CHECKS PASSED", JSON.stringify({ gas: gas.totalGas, at20: gas.usdcAt20gwei, est: pre.gas.total, rev: summary.reverts, anomalies: summary.anomalies.map((a) => a.kind + ":" + a.n) }));
await browser.close(); anvil.stop(); kraken.stop(); web.stop(); if (flaky) flaky.stop();
process.exit(fails.length ? 1 : 0);
