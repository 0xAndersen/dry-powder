// Local stand-ins for everything the tab talks to: anvil (Arc), a Kraken ticker mock, a static origin.
import { spawn } from "node:child_process";
import http from "node:http";
import { readFileSync, existsSync, mkdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

export const here = dirname(fileURLToPath(import.meta.url));
export const root = join(here, "..");
export const CHAIN_ID = 5042002;
export const MC3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function rpc(url, method, params = []) {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
  const j = await r.json();
  if (j.error) throw new Error(method + ": " + j.error.message);
  return j.result;
}

export async function startAnvil(port = 8545, { multicall3 = true, pinBaseFee = true } = {}) {
  const bin = join(process.env.HOME, ".foundry/bin/anvil");
  const proc = spawn(bin, ["--block-time", "1", "--chain-id", String(CHAIN_ID), "--port", String(port), "--base-fee", "20000000000", "--gas-limit", "60000000", "--silent"], { stdio: "ignore" });
  const url = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 50; i++) { try { await rpc(url, "eth_chainId"); break; } catch (e) { await sleep(200); } }
  if (multicall3) {
    const art = JSON.parse(readFileSync(join(here, "mc3/out/Multicall3.sol/Multicall3.json"), "utf8"));
    await rpc(url, "anvil_setCode", [MC3, art.deployedBytecode.object]);
  }
  // Arc has a 20 gwei base-fee floor; anvil would let the base fee decay, so pin it every block.
  let pin = null;
  if (pinBaseFee) pin = setInterval(() => rpc(url, "anvil_setNextBlockBaseFeePerGas", ["0x4a817c800"]).catch(() => {}), 400);
  return { url, stop: () => { if (pin) clearInterval(pin); proc.kill("SIGKILL"); } };
}

/** Random-walk Kraken ticker for the six pairs, in Kraken's response shape, with occasional jumps. */
export function startKraken(port = 8546, { sigma = 0.0006, jumpEverySec = 55, freeze = null, outage = null } = {}) {
  const pairs = {
    XXBTZUSD: { q: "XBTUSD", p: 65000, d: 1 }, XETHZUSD: { q: "ETHUSD", p: 3200, d: 2 }, SOLUSD: { q: "SOLUSD", p: 150, d: 2 },
    ZEURZUSD: { q: "EURUSD", p: 1.085, d: 5 }, ZUSDZJPY: { q: "USDJPY", p: 150.2, d: 3 }, PAXGUSD: { q: "PAXGUSD", p: 2650, d: 2 },
  };
  const t0 = Date.now();
  let n = 0;
  const gauss = () => Math.sqrt(-2 * Math.log(1 - Math.random())) * Math.cos(2 * Math.PI * Math.random());
  const stats = { requests: 0, jumps: 0 };
  const timer = setInterval(() => {
    const el = (Date.now() - t0) / 1000;
    for (const k in pairs) {
      const x = pairs[k];
      if (freeze && freeze.pair === k && el > freeze.from && el < freeze.to) continue;
      x.p *= Math.exp(gauss() * sigma * Math.sqrt(0.25));
      if (Math.random() < 0.25 / jumpEverySec) { x.p *= 1 + (Math.random() < 0.5 ? -1 : 1) * (0.007 + Math.random() * 0.008); stats.jumps++; }
      x.v = (x.v || 100) + Math.random();
      x.t = (x.t || 1000) + 1;
    }
    n++;
  }, 250);
  const srv = http.createServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    if (!req.url.startsWith("/0/public/Ticker")) { res.statusCode = 404; return res.end("{}"); }
    stats.requests++;
    const el = (Date.now() - t0) / 1000;
    if (outage && el > outage.from && el < outage.to) {
      stats.refused = (stats.refused || 0) + 1;
      if (stats.refused % 2) { res.statusCode = 503; return res.end("busy"); }
      res.setHeader("content-type", "application/json");
      return res.end(JSON.stringify({ error: ["EGeneral:Too many requests"] }));
    }
    const want = new URL(req.url, "http://x").searchParams.get("pair").split(",");
    const result = {};
    for (const k in pairs) {
      const x = pairs[k];
      if (!want.includes(x.q)) continue;
      const half = x.p * 0.00004; // 0.8 bp wide book
      const f = (v) => v.toFixed(x.d + 1);
      result[k] = { a: [f(x.p + half), "1", "1.000"], b: [f(x.p - half), "1", "1.000"], c: [f(x.p), "0.01000000"], v: [x.v.toFixed(4), x.v.toFixed(4)],
        p: [f(x.p), f(x.p)], t: [x.t, x.t], l: [f(x.p * 0.98), f(x.p * 0.98)], h: [f(x.p * 1.02), f(x.p * 1.02)], o: f(x.p) };
    }
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ error: [], result }));
  });
  srv.listen(port);
  return { url: `http://127.0.0.1:${port}`, stats, pairs, stop: () => { clearInterval(timer); srv.close(); } };
}

/** Neutral origin: a blank page plus locally bundled ESM builds of viem (stand-ins for esm.sh). */
export async function startStatic(port = 8547) {
  const dir = join(here, ".cache");
  mkdirSync(dir, { recursive: true });
  for (const [out, entry] of [["viem.js", "viem"], ["viem-accounts.js", "viem/accounts"]]) {
    if (existsSync(join(dir, out))) continue;
    await build({ stdin: { contents: `export * from "${entry}";`, resolveDir: root }, bundle: true, format: "esm", outfile: join(dir, out), minify: true, logLevel: "error" });
  }
  const srv = http.createServer((req, res) => {
    const u = req.url.split("?")[0];
    if (u === "/" || u === "/blank.html") { res.setHeader("content-type", "text/html"); return res.end("<!doctype html><title>blank</title><body>neutral origin</body>"); }
    const f = join(dir, u.slice(1));
    if (u.endsWith(".js") && existsSync(f)) { res.setHeader("content-type", "text/javascript"); res.setHeader("access-control-allow-origin", "*"); return res.end(readFileSync(f)); }
    res.statusCode = 404; res.end("not found");
  });
  srv.listen(port);
  return { url: `http://127.0.0.1:${port}`, stop: () => srv.close() };
}

/** Injects the runtime exactly the way the operator does: one evaluate per chunk file, then boot.js. */
export async function inject(page) {
  const man = JSON.parse(readFileSync(join(root, "dist/manifest.json"), "utf8"));
  for (let i = 1; i <= man.chunks; i++) {
    const s = readFileSync(join(root, "dist/chunks", String(i).padStart(2, "0") + ".js"), "utf8");
    if (s.length > 24000) throw new Error("chunk over 24000 chars");
    const r = await page.evaluate(s);
    if (r !== "ok " + String(i).padStart(2, "0")) throw new Error("chunk " + i + " returned " + r);
  }
  const b = await page.evaluate(readFileSync(join(root, "dist/boot.js"), "utf8"));
  if (!String(b).startsWith("booted ArcOps")) throw new Error("boot failed: " + b);
  return man;
}

/** A deliberately unreliable JSON-RPC front for anvil: 429s, 5xx, dropped connections, optional "no batches". */
export function startFlakyRpc(target, port = 8548, { p429 = 0.05, p5xx = 0.03, pDrop = 0.01, noBatch = false } = {}) {
  const stats = { requests: 0, s429: 0, s5xx: 0, dropped: 0, batchesRefused: 0 };
  const srv = http.createServer((req, res) => {
    res.setHeader("access-control-allow-origin", "*");
    res.setHeader("access-control-allow-headers", "content-type");
    if (req.method === "OPTIONS") { res.statusCode = 204; return res.end(); }
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", async () => {
      stats.requests++;
      const x = Math.random();
      if (x < pDrop) { stats.dropped++; return req.socket.destroy(); }
      if (x < pDrop + p429) { stats.s429++; res.statusCode = 429; return res.end("slow down"); }
      if (x < pDrop + p429 + p5xx) { stats.s5xx++; res.statusCode = 503; return res.end("unavailable"); }
      res.setHeader("content-type", "application/json");
      if (noBatch && body.trimStart().startsWith("[")) { stats.batchesRefused++; return res.end(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32600, message: "batch requests are not supported" } })); }
      try {
        const r = await fetch(target, { method: "POST", headers: { "content-type": "application/json" }, body });
        res.end(await r.text());
      } catch (e) { res.statusCode = 502; res.end("bad gateway"); }
    });
  });
  srv.listen(port);
  return { url: `http://127.0.0.1:${port}`, stats, stop: () => srv.close() };
}
