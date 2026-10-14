// window.ArcOps: the operator API.
import { S, store, sleep, now, chainNow, job, loop, stopLoops, lc, inc, anomaly, U, r2 } from "./core.js";
import { rpc } from "./rpc.js";
import { setup, acct, resetAccts, call, send, pollHead, pollReceipts, bal, fees } from "./chain.js";
import { makePublisher } from "./publisher.js";
import { makeKeeper } from "./keeper.js";
import { ixTick } from "./indexer.js";
import { buildAgents } from "./agents.js";
import { preflight, deploy, fund, topUp, book, wireMarkets, plan } from "./deploy.js";
import { status, report, summary, leaderboard, gas, agent, phase } from "./report.js";

const DEF = {
  rpcUrl: "https://rpc.testnet.arc.network", chainId: 5042002, viemUrl: "https://esm.sh/viem@2.21.0", viemAccountsUrl: "https://esm.sh/viem@2.21.0/accounts",
  krakenUrl: "https://api.kraken.com", collateral: "test", usdcAddress: "0x3600000000000000000000000000000000000000", agents: 100, agentCapital: 10000, vaultSeed: 5000000,
  gasPerAgent: "0.14", keeperGas: "2", publisherGas: "0.5", topUpAmount: "0.06", lowWater: "0.06", deployerReserve: "0.3", tipGwei: 1, fundBatch: 50, gasCache: true,
  txTimeoutMs: 45000, logRange: 500, ixLag: 1,
  params: { maxPriceAgeSeconds: 30, withdrawLockSeconds: 120, epochSeconds: 300, streamSeconds: 300, futureExpirySeconds: 900, maxConfBps: 50, maxOiToNavBps: 30000, minMargin: 5,
    oiCapShare: 0.6, skewScaleShare: 0.1 },
  pace: { tradesPerAgent: [5, 7], runMinutes: 30, slippage: 0.005, tickMs: 2000, stakerShare: 0.3, lpAgents: 5, lean: false, mix: null, maxFailStreak: 25, autoSweep: true, grace: 0.3 },
  publisher: { pollMs: 1000, heartbeatMs: 10000, moveBps: 5, minGapMs: 2000, staleFeedMs: 60000, maxPollAgeMs: 5000, pushFactor: 1.3 },
  keeper: { refreshMs: 2000, tickMs: 500, batchSize: 20, settleBatch: 25, maxInflight: 6, reuseOnchain: true, ageMargin: 3, stuckMs: 20000, lateMs: 10000 },
  rpc: { concurrency: 8, batchMax: 30, batchWaitMs: 10, retries: 6, timeoutMs: 15000 },
  intervals: { headMs: 1000, receiptMs: 600, indexMs: 1000, sampleMs: 5000, topUpMs: 15000 },
};
function merge(a, b) {
  const o = { ...a };
  for (const k in b || {}) o[k] = b[k] && typeof b[k] === "object" && !Array.isArray(b[k]) && a[k] && typeof a[k] === "object" ? merge(a[k], b[k]) : b[k];
  return o;
}
const newRun = () => ({ t0: 0, started: false, running: false, ended: 0, blk: null, logs: 0, gas: {}, gasUsed: 0, gasGwei: 0, txs: 0, lat: [], txErr: {}, rev: {}, loopErr: {}, anom: {},
  pub: { polls: 0, pollErr: 0, signed: 0, pushes: 0, feeds: 0, maxGap: 0, maxStale: 0, staleSamples: 0, closed: {}, err: {} },
  kp: { liqs: 0, liqTx: 0, fills: {}, noUpd: 0, delay: [], delayN: 0, settleMk: 0, settlePos: 0, epochs: 0, benign: {}, err: {}, pos: 0, ord: 0 },
  ven: { opens: 0, closes: 0, liqs: 0, orders: 0, fills: {}, vol: 0, settledPos: 0, settledMk: 0, yieldN: 0, yieldClaimed: 0, epochs: 0, epochProfit: 0, toStakers: 0, stakes: 0, claims: 0,
    lpIn: 0, lpOut: 0, nav0: null, sp0: null, nav: 0, sp: 0, oi: 0, oiMax: 0, hb: 0, ser: [] },
  top: { n: 0, usdc: 0 } });

function flush() {
  store.set("run", S.run);
  store.set("gc", S.gasCache);
  if (S.agents) for (const a of S.agents) if (a.dirty) { a.dirty = 0; store.set("a" + a.i, a.save()); }
  if (S.depDirty) { S.depDirty = 0; store.set("dep", S.dep); }
}

async function boot(cfg) {
  stopLoops();
  S.cfg = cfg;
  resetAccts();
  if (!S.V) setup(await import(/* @vite-ignore */ cfg.viemUrl), await import(/* @vite-ignore */ cfg.viemAccountsUrl));
  S.tip = BigInt(Math.round(cfg.tipGwei * 1e9));
  S.seedInt = parseInt(S.V.keccak256(S.V.toHex(cfg.seed)).slice(2, 10), 16);
  S.dep = store.get("dep");
  S.fundSt = store.get("fund");
  S.run = store.get("run") || newRun();
  S.gasCache = store.get("gc") || {};
  S.jobs = {};
  S.sweeping = false;
  S.agents = null;
  S.keeper = null;
  S.epochNext = 0;
  S.mk = []; S.mkById = {}; S.mkBySym = {};
  if (S.dep) { wireMarkets(); S.execFee = S.dep.execFee; S.minMargin = Math.round(cfg.params.minMargin * 1e6); S.mc3 = S.dep.mc3; }
  S.savedAgents = [];
  for (let i = 0; i < cfg.agents; i++) S.savedAgents.push(store.get("a" + i));
  S.keeperAddr = acct("keeper").addr;
  S.pub = makePublisher();
  await pollHead();
  const I = cfg.intervals;
  loop("head", I.headMs, pollHead, "base");
  loop("receipts", I.receiptMs, pollReceipts, "base");
  loop("publisher", cfg.publisher.pollMs, S.pub.tick, "base");
  loop("flush", 1000, async () => flush(), "base");
  if (!S.unloadHook) { S.unloadHook = 1; addEventListener("pagehide", () => { try { flush(); S.pub.persist(); } catch (e) { /* best effort */ } }); }
}

async function refreshBalances() {
  const A = S.dep.addr;
  const bs = await Promise.all(S.agents.map((a) => call(A.usdc, "balanceOf", [a.addr])));
  S.agents.forEach((a, i) => { const b = Number(bs[i]); if (b !== a.bal) { a.bal = b; a.dirty = 1; } });
  for (const a of S.agents) if (a.lp && !a.lp.out) {
    const sh = await call(A.vault, "balanceOf", [a.addr]);
    a.vlp = sh > 0n ? Number(await call(A.vault, "convertToAssets", [sh])) : 0;
  } else if (a.vlp) a.vlp = 0;
}

/** Aligns the agents' mirrors with the lens after a reload (the indexer has already replayed missed logs). */
function reconcile() {
  const P = {}, O = {};
  for (const p of S.kpPos || []) (P[p.trader] || (P[p.trader] = {}))[S.mkById[p.mk].sym] = p;
  for (const o of S.kpOrd || []) (O[o.trader] || (O[o.trader] = {}))[Number(o.id)] = o;
  for (const a of S.agents) {
    const mp = P[lc(a.addr)] || {}, mo = O[lc(a.addr)] || {};
    for (const s in a.pos) if (!mp[s]) { delete a.pos[s]; a.dirty = 1; }
    for (const s in mp) if (!a.pos[s]) { const p = mp[s]; a.pos[s] = { l: p.isLong ? 1 : 0, mg: Number(p.margin), sz: Number(p.size), e: String(p.entry), of: 0, oa: p.openedAt, t: now() }; a.dirty = 1; }
    for (const id in a.ord) if (!mo[id]) { delete a.ord[id]; S.ordOwner.delete(+id); a.dirty = 1; }
    for (const id in mo) if (!a.ord[id]) { const o = mo[id]; a.ord[id] = { m: S.mkById[o.mk].sym, ty: o.ty, l: o.isLong ? 1 : 0, tr: String(o.trig), mg: 0, sz: 0, ca: o.createdAt, t: now() }; S.ordOwner.set(+id, a); a.dirty = 1; }
  }
}

/** Builds the cohort and keeper, replays missed logs and aligns mirrors with the chain. Safe to repeat. */
async function ensureRuntime() {
  const R = S.run, c = S.cfg;
  if (!R.started) { R.started = true; R.t0 = now(); R.blk = S.dep.blk0; }
  if (!S.agents) buildAgents();
  if (!S.keeper) S.keeper = makeKeeper();
  await pollHead();
  for (let i = 0; i < 400 && R.blk < S.head.n - c.ixLag; i++) await ixTick();
  await S.keeper.refresh();
  reconcile();
}
function serviceLoops() {
  const c = S.cfg, I = c.intervals;
  if (S.loops.some((t) => t.group === "run")) return;
  S.pushOn = true;
  loop("index", I.indexMs, ixTick);
  loop("kRefresh", c.keeper.refreshMs, S.keeper.refresh);
  loop("kTick", c.keeper.tickMs, S.keeper.tick);
  loop("sample", I.sampleMs, S.keeper.sampleVenue);
  loop("topUp", () => (S.needTop ? 2500 : I.topUpMs), async () => { S.needTop = 0; await topUp(); await refreshBalances(); });
}

async function start() {
  if (!S.cfg) return { error: "init() first" };
  if (!(S.dep && S.dep.done)) return { error: "deploy() first" };
  if (!(S.fundSt && S.fundSt.done)) return { error: "fund() first" };
  if (S.loops.some((t) => t.group === "run") || S.sweeping) return status();
  const R = S.run, c = S.cfg;
  if (R.ended) return { error: "this run has ended: read summary()/report(), or init({...,reset:true}) for a new one" };
  await ensureRuntime();
  R.running = true;
  S.epochNext = Number(await call(S.dep.addr.vault, "lastEpochTime")) + c.params.epochSeconds;
  await S.keeper.sampleVenue();
  serviceLoops();
  const tok = { on: true, group: "agents" };
  S.loops.push(tok);
  for (const a of S.agents) if (!a.done && !a.fail) a.run(tok);
  loop("auto", 3000, async () => {
    const over = now() > R.t0 + c.pace.runMinutes * 60000 * (1 + c.pace.grace);
    if (c.pace.autoSweep && !S.sweeping && (S.agents.every((a) => a.done || a.fail) || over)) { if (over) anomaly("runOverTime", S.agents.filter((a) => !a.done && !a.fail).length + " agents unfinished at deadline"); sweep({ wait: 0 }); }
  });
  flush();
  return status();
}

async function finalize() {
  const A = S.dep.addr, ag = S.agents;
  await refreshBalances();
  const who = [acct("deployer").addr, acct("keeper").addr, acct("publisher").addr, A.vault, A.engine];
  const [bs, tc, thb, psy, sup, pc, oc, losses, profits, fees_, short] = await Promise.all([
    Promise.all(who.map((w) => call(A.usdc, "balanceOf", [w]))), call(A.engine, "totalClaimable"), call(A.vault, "totalHouseBalance"), call(A.vault, "pendingStakerYield"),
    call(A.usdc, "totalSupply"), call(A.engine, "positionCount"), call(A.engine, "orderCount"), call(A.vault, "totalTraderLosses"), call(A.vault, "totalTraderProfits"),
    call(A.vault, "totalFeesCollected"), call(A.vault, "totalShortfall")]);
  const sumAg = ag.reduce((x, a) => x + BigInt(a.bal), 0n);
  const total = sumAg + bs.reduce((x, y) => x + y, 0n);
  const test = S.cfg.collateral === "test";
  const f = (S.run.final = {
    losses: Number(losses), profits: Number(profits), fees: Number(fees_), shortfall: Number(short),
    checks: {
      positions: Number(pc), orders: Number(oc), flat: pc === 0n && oc === 0n,
      engineBalance: U(bs[4]), totalClaimable: U(tc), engineOk: bs[4] === tc,
      vaultBalance: U(bs[3]), houseBalance: U(thb), pendingStakerYield: U(psy), vaultOk: bs[3] === thb + psy,
      agents: U(sumAg), deployer: U(bs[0]), keeper: U(bs[1]), publisher: U(bs[2]), sum: U(total), minted: test ? U(sup) : null, conserved: test ? total === sup : null,
    },
  });
  return f.checks;
}

async function returnGas() {
  const D = acct("deployer");
  const list = S.agents.map((a) => a.ac).concat([acct("keeper"), acct("publisher")]);
  const bs = await Promise.all(list.map((a) => bal(a.addr)));
  let n = 0, tot = 0n;
  await Promise.all(list.map(async (a, i) => {
    const cost = 21000n * fees().maxFeePerGas;
    const v = bs[i] - cost;
    if (v < cost) return;
    try { await send(a, D.addr, null, null, { value: v, gas: 21000n, kind: "returnGas" }); n++; tot += v; } catch (e) { inc(S.run.txErr, "returnGas"); }
  }));
  return { accounts: n, usdc: Math.round(Number(tot) / 1e12) / 1e6 };
}

function sweep(o = {}) {
  if (!(S.dep && S.dep.done && S.fundSt && S.fundSt.done)) return { error: "nothing to sweep: deploy() and fund() first" };
  return job("sweep", async (j) => {
    const R = S.run;
    let out = { already: true, ...(R.final && R.final.checks) };
    if (!S.agents) buildAgents();
    if (!R.ended) {
      S.sweeping = true;
      S.loops = S.loops.filter((t) => { if (t.group === "agents" || t.name === "auto") { t.on = false; return false; } return true; });
      j.step = "sync with chain";
      await ensureRuntime();
      if (!S.epochNext) S.epochNext = Number(await call(S.dep.addr.vault, "lastEpochTime")) + S.cfg.params.epochSeconds;
      serviceLoops(); // publisher pushes + keeper must be alive: closes need fresh prices, liquidatable positions a liquidator
      j.step = "wait for agents to idle";
      for (let i = 0; i < 60 && S.agents.some((a) => a.busy); i++) await sleep(500);
      for (let round = 0; round < 6; round++) {
        j.step = "closing round " + (round + 1);
        await Promise.all(S.agents.map((a) => a.sweep()));
        await sleep(1500);
        await ixTick().catch(() => {});
        await S.keeper.refresh();
        reconcile();
        const mine = (S.kpPos || []).filter((p) => S.byAddr[p.trader]).length + (S.kpOrd || []).filter((x) => S.byAddr[x.trader]).length;
        if (!mine) break;
      }
      await S.keeper.sampleVenue().catch(() => {});
      j.step = "final checks";
      out = await finalize();
      R.running = false; R.ended = now();
      S.pushOn = false;
      stopLoops("run");
      S.sweeping = false;
      flush();
    }
    if (o.returnGas) { j.step = "returning gas"; out = { ...(R.final && R.final.checks), returned: await returnGas() }; }
    return out;
  }, o.wait == null ? 25000 : o.wait);
}

const guard = (fn) => async (...a) => { try { return await fn(...a); } catch (e) { return { error: String((e && e.message) || e).slice(0, 400) }; } };
const need = () => { if (!S.cfg) throw new Error("call ArcOps.init(config) or ArcOps.resume() first"); };

window.ArcOps = {
  version: S.version,
  init: guard(async (config = {}) => {
    const prev = store.get("cfg");
    if (config.reset) store.clear();
    else if (prev && config.seed && prev.seed !== config.seed) return { error: "stored state belongs to another seed; pass reset:true to discard it, or call resume()" };
    const cfg = merge(DEF, config);
    delete cfg.reset;
    if (!cfg.deployerKey || !cfg.seed) return { error: "deployerKey and seed are required" };
    if (cfg.pace.tradesPerAgent[0] < 1) return { error: "tradesPerAgent min must be >= 1" };
    store.set("cfg", cfg);
    S.V = null;
    await boot(cfg);
    return { ok: true, version: S.version, phase: phase(), deployer: acct("deployer").addr, publisher: acct("publisher").addr, keeper: acct("keeper").addr, head: S.head.n, resumedState: !!(S.dep || S.run.started) };
  }),
  resume: guard(async () => {
    const cfg = store.get("cfg");
    if (!cfg) return { error: "nothing stored: call init(config)" };
    S.V = null;
    await boot(cfg);
    if (S.run.running) await start();
    const s = status();
    s.next = !(S.dep && S.dep.done) ? "deploy()" : !(S.fundSt && S.fundSt.done) ? "fund()" : S.run.ended ? "summary()" : S.run.running ? "status()" : "start()";
    return s;
  }),
  reset: () => { stopLoops(); store.clear(); S.cfg = null; return { ok: true }; },
  preflight: guard(async () => { need(); return preflight(); }),
  deploy: guard(async (o = {}) => { need(); return job("deploy", deploy, o.wait == null ? 25000 : o.wait); }),
  fund: guard(async (o = {}) => { need(); return job("fund", fund, o.wait == null ? 25000 : o.wait); }),
  start: guard(start),
  stop: guard(async () => { need(); stopLoops("run"); stopLoops("agents"); S.run.running = false; S.pushOn = false; flush(); return status(); }),
  sweep: guard(async (o) => { need(); return sweep(o); }),
  status: guard(async () => { need(); return status(); }),
  report: guard(async (page, size) => { need(); return report(page, size); }),
  summary: guard(async () => { need(); return summary(); }),
  leaderboard: guard(async () => { need(); return leaderboard(); }),
  gas: guard(async () => { need(); return gas(); }),
  agent: guard(async (i) => { need(); return agent(i); }),
  addresses: guard(async () => { need(); return book(); }),
  checks: guard(async () => { need(); return finalize(); }),
  plan: guard(async () => { need(); return plan(); }),
  help: () => ({ order: ["init(config)", "preflight()", "deploy()", "fund()", "start()", "status() ...", "sweep()", "summary()", "leaderboard()", "report(0..n)", "gas()", "sweep({returnGas:true})"],
    also: ["resume() after a reload (re-inject the chunks first)", "stop()", "agent(i)", "addresses()", "checks()", "config()", "reset()"], longCalls: "deploy/fund/sweep return {pending:true,step} after ~25 s; call again until done" }),
  config: guard(async () => { need(); const c = JSON.parse(JSON.stringify(S.cfg)); c.deployerKey = c.seed = "<hidden>"; return c; }),
  _S: S,
};
