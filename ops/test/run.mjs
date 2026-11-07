// Full acceptance run: 100 agents against anvil (chain id 5042002, Multicall3 at its canonical address),
// a mock Kraken and a neutral static origin, driven through page.evaluate exactly like the operator's tool.
import { chromium } from "playwright";
import { createPublicClient, http, parseAbi, formatEther, toFunctionSelector } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { startAnvil, startKraken, startStatic, inject, rpc, here } from "./harness.mjs";

const AGENTS = +(process.env.AGENTS || 100), MIN = +(process.env.MINUTES || 7), MC = process.env.NO_MC3 ? false : true;
const outDir = join(here, process.env.OUT || "output");
mkdirSync(outDir, { recursive: true });
const save = (n, o) => writeFileSync(join(outDir, n), JSON.stringify(o, null, 1));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const fails = [], passes = [];
const check = (name, ok, detail) => { (ok ? passes : fails).push(name + (detail !== undefined ? " [" + detail + "]" : "")); log(ok ? "PASS" : "FAIL", name, detail !== undefined ? detail : ""); };

const anvil = await startAnvil(8545, { multicall3: MC });
const kraken = startKraken(8546, { freeze: process.env.NO_FREEZE ? null : { pair: "PAXGUSD", from: +(process.env.FREEZE_FROM || 250), to: +(process.env.FREEZE_TO || 335) } });
const web = await startStatic(8547);
const key = generatePrivateKey();
const deployer = privateKeyToAccount(key).address;
await rpc(anvil.url, "anvil_setBalance", [deployer, "0x" + (40n * 10n ** 18n).toString(16)]); // the real budget
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM || undefined });
const ctx = await browser.newContext();
const page = await ctx.newPage();
const pageErrors = [];
page.on("pageerror", (e) => { pageErrors.push(e.message); log("[pageerror]", e.message.slice(0, 200)); });
await page.goto(web.url + "/blank.html");
const manifest = await inject(page);
log("injected", JSON.stringify(manifest));
let maxStatus = 0;
const ev = (s) => page.evaluate(s);
const poll = async (call) => { let r; do { r = await ev(call); if (r && r.pending) log(call, "pending:", r.step); } while (r && r.pending); return r; };

const cfg = {
  rpcUrl: anvil.url, chainId: 5042002, deployerKey: key, seed: "acceptance-" + Date.now(), viemUrl: web.url + "/viem.js", viemAccountsUrl: web.url + "/viem-accounts.js",
  krakenUrl: kraken.url, collateral: "test", agents: AGENTS, agentCapital: 10000, vaultSeed: 5000000,
  params: { maxPriceAgeSeconds: 20, withdrawLockSeconds: 60, epochSeconds: 90, streamSeconds: 60, futureExpirySeconds: +(process.env.EXPIRY || 230) },
  pace: { tradesPerAgent: [5, 7], runMinutes: MIN, autoSweep: false },
};
const init = await ev(`ArcOps.init(${JSON.stringify(cfg)})`);
log("init", JSON.stringify(init));
const pre = await ev(`ArcOps.preflight()`);
log("preflight", JSON.stringify(pre));
save("preflight.json", pre);
check("preflight: chain id 5042002, balance sufficient, nothing sent", pre.chainIdOk && pre.sufficient && pre.nonce === 0 && (await rpc(anvil.url, "eth_getTransactionCount", [deployer, "latest"])) === "0x0");
check("multicall3 " + (MC ? "present" : "absent (sequential fallback)"), pre.multicall3 === MC);

const t0 = Date.now();
const book = await poll(`ArcOps.deploy()`);
if (book.error) { log("deploy error", book.error); process.exit(1); }
log("deployed in", Math.round((Date.now() - t0) / 1000) + "s", JSON.stringify(book).slice(0, 300));
check("deploy is idempotent (second call sends nothing)", await (async () => { const n = await rpc(anvil.url, "eth_getTransactionCount", [deployer, "latest"]); const b2 = await poll(`ArcOps.deploy()`); return b2.engine === book.engine && n === (await rpc(anvil.url, "eth_getTransactionCount", [deployer, "latest"])); })());
save("addresses.json", book);
const t1 = Date.now();
const fund = await poll(`ArcOps.fund()`);
if (fund.error) { log("fund error", fund.error); process.exit(1); }
log("funded in", Math.round((Date.now() - t1) / 1000) + "s", JSON.stringify(fund));
const st0 = await ev(`ArcOps.start()`);
if (st0.error) { log("start error", st0.error); process.exit(1); }
const tRun = Date.now();
log("started");

// How much of every open is the vault NAV read behind the OI cap? (totalAssets -> unrealizedTraderPnl loops the markets)
const probe = {};
async function gasProbe() {
  const est = async (to, sig) => Number(await rpc(anvil.url, "eth_estimateGas", [{ to, data: toFunctionSelector(sig) }])) - 21000;
  const ids = await rpc(anvil.url, "eth_call", [{ to: book.lens, data: toFunctionSelector("getMarkets()") }, "latest"]);
  return { vaultTotalAssetsGas: await est(book.vault, "totalAssets()"), engineUnrealizedTraderPnlGas: await est(book.engine, "unrealizedTraderPnl()"), openInterest: (await ev(`ArcOps.status()`)).oi, lensGetMarketsBytes: ids.length / 2 };
}
let resumed = false, before = null, last = null;
while (true) {
  await sleep(10000);
  const el = (Date.now() - tRun) / 1000;
  if (!resumed && el > MIN * 60 * 0.35) {
    // Accidental reload: all page state is lost; the operator re-injects the chunks and calls resume().
    before = await ev(`ArcOps.status()`);
    await page.reload();
    check("after reload the runtime is gone", await ev(`typeof window.ArcOps`) === "undefined");
    await sleep(3000);
    await inject(page);
    const r = await ev(`ArcOps.resume()`);
    resumed = true;
    log("resumed", JSON.stringify({ phase: r.phase, next: r.next, agents: r.agents, trades: r.trades, indexed: r.indexed }));
    check("resume: running again with progress intact", r.phase === "running" && r.agents.n === AGENTS && r.trades.opens >= before.trades.opens && r.agents.done >= before.agents.done && r.txs >= before.txs, `opens ${before.trades.opens}->${r.trades.opens}`);
    continue;
  }
  if (resumed && !probe.mid && el > MIN * 60 * 0.5) probe.mid = await gasProbe();
  const s = (last = await ev(`ArcOps.status()`));
  const len = JSON.stringify(s).length;
  if (len > maxStatus) maxStatus = len;
  log(Math.round(el) + "s", JSON.stringify({ ag: s.agents, t: s.trades, oi: s.oi, rev: s.reverts, kp: s.keeper, pub: [s.publisher.pushes, s.publisher.closed], an: s.anomalies, rpc: s.rpc.errors, nat: s.native, top: s.topUps, le: s.loopErr, last: s.lastErr, len }));
  if (s.agents.done + s.agents.failed === s.agents.n) break;
  if (el > MIN * 60 * 1.5) { log("deadline reached with agents unfinished"); break; }
}
const sweep = await poll(`ArcOps.sweep()`);
log("sweep", JSON.stringify(sweep));
probe.flat = await gasProbe();
log("gas probe", JSON.stringify(probe));
const status = await ev(`ArcOps.status()`);
const summary = await ev(`ArcOps.summary()`);
const leaderboard = await ev(`ArcOps.leaderboard()`);
const gas = await ev(`ArcOps.gas()`);
const pages = [];
let maxPage = 0;
for (let p = 0; ; p++) { const r = await ev(`ArcOps.report(${p})`); pages.push(r); maxPage = Math.max(maxPage, JSON.stringify(r).length); if (p + 1 >= r.pages) break; }
const rows = pages.flatMap((p) => p.rows.map((r) => Object.fromEntries(p.cols.map((c, i) => [c, r[i]]))));
const nativeBefore = BigInt(await rpc(anvil.url, "eth_getBalance", [deployer, "latest"]));
const ret = await poll(`ArcOps.sweep({returnGas:true})`);
log("returnGas", JSON.stringify(ret.returned));
const nativeAfter = BigInt(await rpc(anvil.url, "eth_getBalance", [deployer, "latest"]));
save("status.json", status); save("summary.json", summary); save("leaderboard.json", leaderboard); save("gas.json", gas);
save("report-pages.json", pages); save("agents.json", rows);

// ───────────── independent verification straight from the chain ─────────────
const pc = createPublicClient({ transport: http(anvil.url) });
const abi = parseAbi(["function balanceOf(address) view returns (uint256)", "function totalSupply() view returns (uint256)", "function positionCount() view returns (uint256)",
  "function orderCount() view returns (uint256)", "function totalClaimable() view returns (uint256)", "function totalHouseBalance() view returns (uint256)",
  "function pendingStakerYield() view returns (uint256)", "function totalStaked() view returns (uint256)", "function lastEpochTime() view returns (uint256)", "function deployedAt() view returns (uint256)",
  "function getMarketIds() view returns (bytes32[])"]);
const rd = (address, functionName, args = []) => pc.readContract({ address, abi, functionName, args });
const balOf = (a) => rd(book.usdc, "balanceOf", [a]);
const [nPos, nOrd, engBal, claimable, vaultBal, thb, psy, supply, staked] = await Promise.all([rd(book.engine, "positionCount"), rd(book.engine, "orderCount"), balOf(book.engine),
  rd(book.engine, "totalClaimable"), balOf(book.vault), rd(book.vault, "totalHouseBalance"), rd(book.vault, "pendingStakerYield"), rd(book.usdc, "totalSupply"), rd(book.token, "totalStaked")]);
let sumAgents = 0n;
for (let i = 0; i < rows.length; i += 25) for (const b of await Promise.all(rows.slice(i, i + 25).map((r) => balOf(r.addr)))) sumAgents += b;
const others = await Promise.all([deployer, book.keeper, book.publisher].map(balOf));
const fut = book.markets.find((m) => m.expiry);
const futMarket = await pc.readContract({ address: book.engine, abi: parseAbi(["struct M { bool enabled; bool invert; uint16 maxLeverage; uint64 lastFundingTime; uint64 expiry; bytes32 feedId; bytes32 quoteFeedId; uint256 maxOiPerSide; uint256 skewScale; uint256 longOi; uint256 shortOi; uint256 longUnits; uint256 shortUnits; int256 fundingIndex; uint256 settlementPrice; string symbol; }", "function getMarket(bytes32) view returns (M)"]), functionName: "getMarket", args: [fut.id] });

const mIdx = Object.fromEntries(pages[0].markets.map((s, i) => [s, i]));
const traded = (sym) => rows.filter((r) => r.markets.split(" ").some((x) => +x.split(":")[0] === mIdx[sym])).length;
check("payload: chunks <= 24000 chars each", manifest.chunkChars.every((c) => c <= 24000), `${manifest.chunks} chunks, ${manifest.totalChars} chars incl. boot`);
check("status() always under 2 KB", maxStatus < 2048, maxStatus);
check("summary() under 8 KB", JSON.stringify(summary).length < 8192, JSON.stringify(summary).length);
check("report(page) under 8 KB, 20 agents per page", maxPage < 8192 && pages[0].rows.length === Math.min(20, AGENTS), maxPage);
check("leaderboard() tiny", JSON.stringify(leaderboard).length < 1500, JSON.stringify(leaderboard).length);
check(`all ${AGENTS} agents reported`, rows.length === AGENTS);
check("no agent failed", rows.every((r) => r.state === "done"), rows.filter((r) => r.state !== "done").map((r) => r.id + ":" + r.strategy + ":" + r.state).join(",") || "all done");
check("every agent completed >= 5 round trips", rows.every((r) => r.trips >= 5), "min " + Math.min(...rows.map((r) => r.trips)));
check("every agent's cumulative margin >= its capital", rows.every((r) => r.margin >= 10000), "min " + Math.min(...rows.map((r) => r.margin)));
check("every agent traded >= 2 markets", rows.every((r) => r.markets.split(" ").length >= 2));
check("dated future settled on-chain", futMarket.settlementPrice > 0n, fut.symbol + " @ " + Number(futMarket.settlementPrice) / 1e18);
check("dated future positions were settled by the keeper", summary.keeper.positionsSettled > 0 && summary.trades.settledPositions > 0 && futMarket.longOi === 0n && futMarket.shortOi === 0n, summary.keeper.positionsSettled);
check("liquidations occurred", summary.trades.liquidations > 0, summary.trades.liquidations);
const f = summary.trades.fills;
check("keeper filled orders of every type", f.limit > 0 && f.takeProfit > 0 && f.stopLoss > 0 && f.close > 0, JSON.stringify(f));
check("staking happened and yield was claimed", summary.vault.stakes > 0 && staked > 0n && summary.vault.yieldClaims > 0, `${summary.vault.stakes} stakes, ${summary.vault.yieldClaims} claims`);
check("vault epoch settled (with staker yield)", summary.vault.epochs > 0 && summary.vault.stakerYieldAllocated > 0, `${summary.vault.epochs} epochs, ${summary.vault.stakerYieldAllocated} to stakers`);
check("LP agents deposited and redeemed", summary.vault.lpDeposits > 0 && summary.vault.lpRedeems > 0);
const kinds = ["open", "open+brackets", "close", "limit:resting", "limit:marketable", "trigger:tp", "trigger:sl", "trigger:close", "cancelOrder", "stake", "claimYield", "lpDeposit", "lpRedeem", "liquidateBatch", "settleMarket", "settlePositions", "settleEpoch", "push"];
check("every call path exercised", kinds.every((k) => gas.byType[k]), kinds.filter((k) => !gas.byType[k]).join(",") || kinds.length + " tx types");
check("cross, inverted and dated markets traded", traded("ETH-BTC") > 0 && traded("JPY-USD") > 0 && traded(fut.symbol) > 0, `ETH-BTC ${traded("ETH-BTC")}, JPY-USD ${traded("JPY-USD")}, ${fut.symbol} ${traded(fut.symbol)} agents`);
check("no agent positions or orders remain (chain)", nPos === 0n && nOrd === 0n, `${nPos} positions, ${nOrd} orders`);
check("engine collateral == totalClaimable (chain)", engBal === claimable, `${engBal} vs ${claimable}`);
check("vault collateral == totalHouseBalance + pendingStakerYield (chain)", vaultBal === thb + psy, `${vaultBal} vs ${thb}+${psy}`);
const total = sumAgents + others[0] + others[1] + others[2] + vaultBal + engBal;
check("conservation: agents + deployer + keeper + publisher + vault + engine == total minted (chain)", total === supply, `${total} vs ${supply}`);
check("runtime's own checks agree", summary.checks && summary.checks.flat && summary.checks.engineOk && summary.checks.vaultOk && summary.checks.conserved);
check("resume() was exercised", resumed);
check("no uncaught page errors", pageErrors.length === 0, pageErrors.length);
const spent = 40 - Number(formatEther(nativeAfter));
check("whole run fits the 40 USDC deployer budget at a pinned 20 gwei base fee", nativeAfter > 0n && pre.sufficient, `net native spent ${spent.toFixed(4)} (deployer ${formatEther(nativeBefore)} before gas return, ${formatEther(nativeAfter)} after)`);

const result = { ok: fails.length === 0, agents: AGENTS, runMinutes: MIN, multicall3: MC, manifest, maxStatusBytes: maxStatus, maxReportPageBytes: maxPage, summaryBytes: JSON.stringify(summary).length,
  probe, preflightGas: pre.gas, durations: { deployS: Math.round((t1 - t0) / 1000), runS: summary.run.seconds }, nativeSpent: spent, returned: ret.returned, krakenMock: kraken.stats, passes, fails };
save("result.json", result);
log(fails.length ? "FAILED " + fails.length : "ALL CHECKS PASSED", JSON.stringify({ spent, gas: gas.totalGas, at20: gas.usdcAt20gwei }));
await browser.close(); anvil.stop(); kraken.stop(); web.stop();
process.exit(fails.length ? 1 : 0);
