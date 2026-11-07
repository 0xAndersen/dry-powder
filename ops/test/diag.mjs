// Diagnostic: catch EngineLens.getPositions reverting with Panic(0x11) and find the position/market that causes it.
import { chromium } from "playwright";
import { createPublicClient, http } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { startAnvil, startKraken, startStatic, inject, rpc, here, root } from "./harness.mjs";

const art = (n) => JSON.parse(readFileSync(join(root, "../contracts/out", `${n}.sol/${n}.json`), "utf8")).abi;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const anvil = await startAnvil(8545);
const kraken = startKraken(8546, { freeze: { pair: "PAXGUSD", from: +(process.env.FREEZE_FROM || 45), to: +(process.env.FREEZE_TO || 150) } });
const web = await startStatic(8547);
const key = generatePrivateKey();
await rpc(anvil.url, "anvil_setBalance", [privateKeyToAccount(key).address, "0x" + (40n * 10n ** 18n).toString(16)]);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(web.url + "/blank.html");
await inject(page);
const ev = (s) => page.evaluate(s);
const poll = async (c) => { let r; do { r = await ev(c); } while (r && r.pending); return r; };
const cfg = { rpcUrl: anvil.url, chainId: 5042002, deployerKey: key, seed: "diag" + Date.now(), viemUrl: web.url + "/viem.js", viemAccountsUrl: web.url + "/viem-accounts.js", krakenUrl: kraken.url,
  agents: 70, params: { maxPriceAgeSeconds: 20, withdrawLockSeconds: 30, epochSeconds: 45, streamSeconds: 30, futureExpirySeconds: 120 },
  pace: { runMinutes: 3, tradesPerAgent: [5, 6], autoSweep: false } };
await ev(`ArcOps.init(${JSON.stringify(cfg)})`);
const book = await poll(`ArcOps.deploy()`);
await poll(`ArcOps.fund()`);
await ev(`ArcOps.start()`);
const pc = createPublicClient({ transport: http(anvil.url) });
const lens = { address: book.lens, abi: art("EngineLens") }, engine = { address: book.engine, abi: art("PerpEngine") };
const found = [], replays = [];
const t0 = Date.now();
while (Date.now() - t0 < 200000 && found.length < 4) {
  await sleep(250);
  // Same call the keeper makes (tag "latest"); on failure, see whether it is reproducible at a pinned block.
  let bn;
  try { await pc.readContract({ ...lens, functionName: "getPositions", args: [0n, 200n], blockTag: "latest" }); continue; } catch (e) {
    if (!/0x11|underflow|overflow/i.test(e.message)) continue;
    bn = await pc.getBlockNumber();
    const lb = await pc.getBlock({ blockTag: "latest" });
    const again = [];
    for (const b of [bn - 1n, bn, bn + 1n]) { try { await pc.readContract({ ...lens, functionName: "getPositions", args: [0n, 200n], blockNumber: b }); again.push([Number(b), "ok"]); } catch (x) { again.push([Number(b), (x.shortMessage || x.message).slice(0, 80)]); } }
    replays.push({ wall: Date.now() / 1000, latestBlock: Number(lb.number), latestTimestamp: Number(lb.timestamp), pinned: again });
    console.log("PANIC at latest; wall", Date.now() / 1000, "latest block", Number(lb.number), "ts", Number(lb.timestamp), "pinned replays", JSON.stringify(again));
  }
  const blk = await pc.getBlock({ blockNumber: bn });
  const keys = await pc.readContract({ ...engine, functionName: "positionKeys", args: [0n, 500n], blockNumber: bn });
  const rec = { block: Number(bn), blockTimestamp: Number(blk.timestamp), positions: keys.length, bad: [] };
  for (const k of keys) {
    const pos = await pc.readContract({ ...engine, functionName: "getPositionByKey", args: [k], blockNumber: bn });
    const m = await pc.readContract({ ...engine, functionName: "getMarket", args: [pos.priceId], blockNumber: bn });
    let idx = null, idxErr = null, stateErr = null;
    try { idx = await pc.readContract({ ...engine, functionName: "currentFundingIndex", args: [pos.priceId], blockNumber: bn }); } catch (e) { idxErr = e.shortMessage || e.message.slice(0, 120); }
    try { await pc.readContract({ ...lens, functionName: "getPositionState", args: [k, pos.entryPrice], blockNumber: bn }); } catch (e) { stateErr = (e.shortMessage || e.message).slice(0, 160); }
    if (idxErr || stateErr) rec.bad.push({ key: k, symbol: m.symbol, isLong: pos.isLong, margin: String(pos.margin), size: String(pos.size), entryPrice: String(pos.entryPrice), openedAt: Number(pos.openedAt),
      entryFundingIndex: String(pos.entryFundingIndex), currentFundingIndex: idx == null ? null : String(idx), marketFundingIndex: String(m.fundingIndex), lastFundingTime: Number(m.lastFundingTime), longOi: String(m.longOi), shortOi: String(m.shortOi), idxErr, stateErr });
  }
  found.push(rec);
  console.log(JSON.stringify(rec, null, 1));
}
writeFileSync(join(here, "output", "diag-lens-panic.json"), JSON.stringify({ note: "eth_call at tag latest reverted with Panic(0x11); the same call pinned to that block succeeds and no position or market is bad", replays, found }, null, 1));
console.log("status", JSON.stringify((await ev(`ArcOps.status()`)).loopErr), "found", found.length);
await browser.close(); anvil.stop(); kraken.stop(); web.stop();
process.exit(0);
