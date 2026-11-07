// Minimal reproduction: PerpEngine.currentFundingIndex (and so every EngineLens position view) reverts with
// Panic(0x11) when evaluated at a block timestamp earlier than the market's lastFundingTime.
import { chromium } from "playwright";
import { encodeFunctionData, parseAbi } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { startAnvil, startKraken, startStatic, inject, rpc, here } from "./harness.mjs";

const anvil = await startAnvil(8545), kraken = startKraken(8546), web = await startStatic(8547);
const key = generatePrivateKey();
await rpc(anvil.url, "anvil_setBalance", [privateKeyToAccount(key).address, "0x" + (40n * 10n ** 18n).toString(16)]);
const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(web.url + "/blank.html");
await inject(page);
const ev = (s) => page.evaluate(s);
await ev(`ArcOps.init(${JSON.stringify({ rpcUrl: anvil.url, deployerKey: key, seed: "repro" + Date.now(), viemUrl: web.url + "/viem.js", viemAccountsUrl: web.url + "/viem-accounts.js", krakenUrl: kraken.url, agents: 1 })})`);
let book; do { book = await ev(`ArcOps.deploy()`); } while (book.pending);
const abi = parseAbi(["function currentFundingIndex(bytes32) view returns (int256)"]);
const data = encodeFunctionData({ abi, functionName: "currentFundingIndex", args: [book.markets[0].id] });
const latest = await rpc(anvil.url, "eth_getBlockByNumber", ["latest", false]);
const raw = async (params) => { const r = await fetch(anvil.url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "eth_call", params }) }); return r.json(); };
const out = { market: book.markets[0].symbol, engine: book.engine, latestTimestamp: Number(latest.timestamp),
  atLatest: await raw([{ to: book.engine, data }, "latest"]),
  // same state, block clock one hour in the past (block override), i.e. before the market's lastFundingTime
  withEarlierClock: await raw([{ to: book.engine, data }, "latest", {}, { time: "0x" + (Number(latest.timestamp) - 3600).toString(16) }]) };
console.log(JSON.stringify(out, null, 1));
writeFileSync(join(here, "output", "repro-funding-index.json"), JSON.stringify(out, null, 1));
await browser.close(); anvil.stop(); kraken.stop(); web.stop();
process.exit(0);
