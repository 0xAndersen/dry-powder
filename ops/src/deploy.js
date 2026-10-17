// preflight / deploy (resumable step machine) / fund / gas top-ups.
import { S, store, now, chainNow, sleep, hex, lc, GWEI, MAXU, inc, anomaly } from "./core.js";
import { rpc } from "./rpc.js";
import { acct, call, send, enc, initCode, hasCode, bal, MC3, gasPriceNow, pollHead, fees } from "./chain.js";
import { FEEDS } from "./publisher.js";
import { STRATS, SNAMES } from "./agents.js";

// Gas measured on anvil (cancun, via-IR build) by the ops test harness; see ops/README.md.
export const GAS = {
  deploy: 11200000, // 7 creations: engine 5.39M, vault 1.79M, lens 1.48M, token 1.05M, oracle adapters 1.0M, TestUSDC 0.48M
  market: 181000, risk: 39000, firstPush: 355000, seed: 350000,
  fundNative: 37500, fundMint: 28500, // per account inside a Multicall3 batch
  approve: 46300, push6: 150000,
  // per round trip, by archetype: [agent gas, keeper gas]
  rt: { momentum: [765e3, 0], meanrev: [1010e3, 235e3], breakout: [930e3, 150e3], scalper: [1035e3, 240e3], swing: [1050e3, 60e3],
    pairs: [785e3, 0], carry: [790e3, 0], dated: [720e3, 85e3], maker: [1130e3, 1000e3], degen: [745e3, 60e3], hedger: [745e3, 0], wallet: [520e3, 1020e3] },
  lean: [760e3, 0], staker: 400000, lp: 760000, epoch: 335000, settle: 800000,
};
const fmt = (wei) => Math.round(Number(wei) / 1e12) / 1e6;
const toWei = (s) => S.V.parseEther(String(s));

export function plan() {
  const c = S.cfg, n = c.agents, t = (c.pace.tradesPerAgent[0] + c.pace.tradesPerAgent[1]) / 2 * 1.02;
  const mix = c.pace.mix || {};
  const w = SNAMES.map((k) => (mix[k] != null ? mix[k] : STRATS[k][0]));
  const tot = w.reduce((a, b) => a + b, 0);
  let ag = 0, kp = 0;
  SNAMES.forEach((k, j) => { const r = c.pace.lean ? GAS.lean : GAS.rt[k]; ag += (w[j] / tot) * r[0]; kp += (w[j] / tot) * r[1]; });
  const perAgent = GAS.approve + t * ag + c.pace.stakerShare * GAS.staker + (c.pace.lpAgents / n) * GAS.lp;
  const secs = c.pace.runMinutes * 60;
  const pushes = secs / (c.publisher.heartbeatMs / 1000) * c.publisher.pushFactor;
  const g = {
    deploy: GAS.deploy + 8 * GAS.market + GAS.risk + GAS.firstPush + GAS.seed,
    fund: (n + 2) * GAS.fundNative + (c.collateral === "test" ? n * GAS.fundMint : n * 52000),
    agents: n * perAgent,
    keeper: n * t * kp + (secs / c.params.epochSeconds) * GAS.epoch + GAS.settle,
    publisher: pushes * GAS.push6,
  };
  g.total = g.deploy + g.fund + g.agents + g.keeper + g.publisher;
  return { g, perAgent };
}

export async function preflight() {
  await pollHead();
  const d = acct("deployer");
  const [cid, b, mc, nonce] = await Promise.all([rpc("eth_chainId"), bal(d.addr), hasCode(MC3), rpc("eth_getTransactionCount", [d.addr, "latest"])]);
  let tipNet = null;
  try { tipNet = Number(BigInt(await rpc("eth_maxPriorityFeePerGas"))) / 1e9; } catch (e) { /* optional method */ }
  const price = gasPriceNow();
  const { g, perAgent } = plan();
  const c = S.cfg;
  const cost = (gas) => fmt(BigInt(Math.round(gas)) * price);
  // What must leave the deployer: its own gas plus the floats handed to the other accounts (leftovers come back in sweep).
  const floats = toWei(c.gasPerAgent) * BigInt(c.agents) + toWei(c.keeperGas) + toWei(c.publisherGas);
  const own = BigInt(Math.round(g.deploy + g.fund)) * price;
  const spend = BigInt(Math.round(g.total)) * price;
  // Peak outflow: floats go out up front and are topped up as they are used; what is left in them only
  // comes back with sweep({returnGas:true}). Measured peak is floats + ~0.65 of the run's gas.
  const need = own + floats + ((spend - own) * 65n) / 100n + toWei(c.deployerReserve);
  return {
    chainId: Number(cid), chainIdOk: Number(cid) === c.chainId, deployer: d.addr, nonce: Number(nonce), balance: fmt(b),
    baseFeeGwei: Number(S.head.base) / 1e9, gasPriceGwei: Number(price) / 1e9, networkTipGwei: tipNet, multicall3: mc,
    gas: { deploy: Math.round(g.deploy), fund: Math.round(g.fund), agents: Math.round(g.agents), keeper: Math.round(g.keeper), publisher: Math.round(g.publisher), total: Math.round(g.total) },
    costUsdc: { deploy: cost(g.deploy), fund: cost(g.fund), agents: cost(g.agents), keeper: cost(g.keeper), publisher: cost(g.publisher), total: cost(g.total) },
    perAgentUsdc: cost(perAgent), floats: { perAgent: +c.gasPerAgent, keeper: +c.keeperGas, publisher: +c.publisherGas, total: fmt(floats) },
    required: fmt(need), sufficient: b >= need, shortfall: b >= need ? 0 : fmt(need - b),
    note: "costUsdc.total is the expected net spend; required is the peak the deployer must hold (deploy+fund gas + account floats + 65% of run gas for top-ups + reserve); unspent floats return with sweep({returnGas:true})",
  };
}

const saveDep = () => store.set("dep", S.dep);
export function wireMarkets() {
  S.mk = S.dep.mk || [];
  S.mkById = {}; S.mkBySym = {};
  for (const m of S.mk) { if (m.spS) { m.spx = BigInt(m.spS); m.sp = Number(m.spx) / 1e18; } S.mkById[lc(m.id)] = m; S.mkBySym[m.sym] = m; }
}

export async function deploy(j) {
  const c = S.cfg, V = S.V, D = acct("deployer"), P = c.params;
  const dep = S.dep || (S.dep = { c: {}, addr: {}, steps: {} });
  const test = c.collateral === "test";
  await pollHead();
  if (Number(await rpc("eth_chainId")) !== c.chainId) throw new Error("wrong chain id");
  // Nothing of ours may be in flight: address prediction depends on the nonce.
  for (let i = 0; i < 30; i++) {
    const [a, b] = await Promise.all([rpc("eth_getTransactionCount", [D.addr, "latest"]), rpc("eth_getTransactionCount", [D.addr, "pending"])]);
    if (a === b) break;
    await sleep(1000);
  }
  D.nonce = null;
  if (dep.blk0 == null) { dep.blk0 = S.head.n; saveDep(); }
  S.mc3 = dep.mc3 = await hasCode(MC3);
  const at = (n) => V.getContractAddress({ from: D.addr, nonce: BigInt(n) });
  const has = async (name) => !!(dep.c[name] && (await hasCode(dep.c[name].addr)));
  const cur = async () => Number(await rpc("eth_getTransactionCount", [D.addr, "latest"]));
  async function create(name, art, args) {
    j.step = "deploy " + name;
    const want = dep.c[name];
    const n = await cur();
    if (n !== want.n) throw new Error(`nonce moved before ${name}: planned ${want.n}, chain ${n}; call deploy() again to re-plan`);
    D.nonce = n;
    const r = await send(D, null, null, null, { data: initCode(art, args), kind: "deploy:" + art });
    if (lc(r.contractAddress || "") !== lc(want.addr)) throw new Error(`address prediction failed for ${name}: ${r.contractAddress} != ${want.addr}`);
    dep.addr[name] = want.addr;
    saveDep();
  }
  const planAt = (name, n) => { dep.c[name] = { n, addr: at(n) }; };

  if (test) { if (!(await has("usdc"))) { planAt("usdc", await cur()); saveDep(); await create("usdc", "TestUSDC", []); } else dep.addr.usdc = dep.c.usdc.addr; }
  else dep.addr.usdc = c.usdcAddress;
  const usdc = dep.addr.usdc;
  const pubKey = acct("publisher").addr;
  if (!(await has("pub"))) { planAt("pub", await cur()); saveDep(); await create("pub", "PublisherOracle", [D.addr, pubKey]); } else dep.addr.pub = dep.c.pub.addr;
  if (!(await has("oracle"))) { planAt("oracle", await cur()); saveDep(); await create("oracle", "PythOracle", [dep.addr.pub]); } else dep.addr.oracle = dep.c.oracle.addr;

  // Vault, token and engine reference each other immutably: three consecutive nonces, predicted up front.
  const [hv, ht, he] = [await has("vault"), await has("token"), await has("engine")];
  if (!(hv && ht && he)) {
    const n = await cur();
    let base = n;
    if (hv && !ht && n === dep.c.vault.n + 1) base = dep.c.vault.n;
    else if (hv && ht && !he && n === dep.c.vault.n + 2) base = dep.c.vault.n;
    else if (hv || ht) anomaly("deployTrioRestarted", "nonce drift; redeploying vault/token/engine");
    planAt("vault", base); planAt("token", base + 1); planAt("engine", base + 2);
    saveDep();
    const a = { v: dep.c.vault.addr, t: dep.c.token.addr, e: dep.c.engine.addr };
    if (n <= base) await create("vault", "HouseVault", [usdc, a.e, a.t, BigInt(P.withdrawLockSeconds), BigInt(P.epochSeconds)]);
    if (n <= base + 1) await create("token", "RewardToken", [a.v, a.e, BigInt(P.streamSeconds)]);
    await create("engine", "PerpEngine", [usdc, dep.addr.oracle, a.v, a.t, D.addr]);
  }
  for (const k of ["vault", "token", "engine"]) dep.addr[k] = dep.c[k].addr;
  if (!(await has("lens"))) { planAt("lens", await cur()); saveDep(); await create("lens", "EngineLens", [dep.addr.engine]); } else dep.addr.lens = dep.c.lens.addr;
  saveDep();
  const A = dep.addr;
  D.nonce = null;

  j.step = "risk params";
  if (Number(await call(A.engine, "maxPriceAge")) !== P.maxPriceAgeSeconds) {
    await send(D, A.engine, "setRiskParams", [BigInt(P.maxPriceAgeSeconds), BigInt(P.maxConfBps), BigInt(P.maxOiToNavBps), BigInt(Math.round(P.minMargin * 1e6))], { kind: "setRiskParams" });
  }

  j.step = "markets";
  const listed = new Set((await call(A.engine, "getMarketIds")).map(lc));
  const fi = (k) => FEEDS.findIndex((f) => f.k === k);
  const seedU = c.vaultSeed;
  const oiMajor = BigInt(Math.round(seedU * P.oiCapShare * 1e6)), skew = BigInt(Math.round(seedU * P.skewScaleShare * 1e6));
  // Same leverage as contracts/script/Deploy.s.sol (above 100x the engine takes keeper orders only).
  const defs = [["BTC-USD", "BTC", null, false, 1000], ["ETH-USD", "ETH", null, false, 1000], ["SOL-USD", "SOL", null, false, 500], ["EUR-USD", "EUR", null, false, 250],
    ["JPY-USD", "JPY", null, true, 100], ["XAU-USD", "XAU", null, false, 250], ["ETH-BTC", "ETH", "BTC", false, 100]];
  const mk = dep.mk || (dep.mk = []);
  const ensure = (sym, f, q, inv, lev, exp, id) => {
    let m = mk.find((x) => x.sym === sym);
    if (!m) { m = { sym, id: id || (q == null && !exp ? FEEDS[fi(f)].id : V.keccak256(V.toHex(sym))), f: fi(f), q: q == null ? -1 : fi(q), inv, lev, exp: exp || 0 }; mk.push(m); }
    return m;
  };
  for (const [sym, f, q, inv, lev] of defs) ensure(sym, f, q, inv, lev);
  // Short-dated BTC future. Its expiry is fixed when first planned; re-planned only if it was never listed
  // and has meanwhile come too close.
  let fut = mk.find((x) => x.exp);
  if (fut && !listed.has(lc(fut.id)) && fut.exp - chainNow() < P.futureExpirySeconds * 0.5) { mk.splice(mk.indexOf(fut), 1); fut = null; }
  if (!fut) {
    const exp = Math.floor(chainNow()) + P.futureExpirySeconds;
    const d = new Date(exp * 1000);
    const sym = "BTC-USD-" + String(d.getUTCHours()).padStart(2, "0") + String(d.getUTCMinutes()).padStart(2, "0") + "Z";
    fut = ensure(sym, "BTC", null, false, 250, exp);
  }
  saveDep();
  for (const m of mk) {
    if (listed.has(lc(m.id))) continue;
    j.step = "market " + m.sym;
    const cfg = { symbol: m.sym, feedId: FEEDS[m.f].id, quoteFeedId: m.q >= 0 ? FEEDS[m.q].id : "0x" + "0".repeat(64), invert: m.inv, maxLeverage: m.lev, expiry: BigInt(m.exp),
      maxOiPerSide: oiMajor, skewScale: skew };
    await send(D, A.engine, "addMarket", [m.id, cfg], { kind: "addMarket" });
  }
  wireMarkets();
  dep.execFee = S.execFee = Number(await call(A.engine, "executionFee"));
  S.minMargin = Math.round(P.minMargin * 1e6);

  j.step = "first prices";
  if (!dep.steps.prices) {
    for (let i = 0; i < 20; i++) {
      try { await S.pub.pollOnce(); } catch (e) { await sleep(1500); continue; }
      if (S.pub.f.every((x) => x.L || x.closed)) break;
      await sleep(1000);
    }
    if (!S.pub.f.some((x) => x.L)) throw new Error("no prices from Kraken: " + (S.run.pub.lastErr || ""));
    await S.pub.maybePush(true);
    if (!S.pub.f.some((x) => x.oc.pt)) throw new Error("first price push failed: " + JSON.stringify(S.run.pub.err));
    dep.steps.prices = 1;
    saveDep();
  }

  j.step = "vault seed";
  const seed = BigInt(Math.round(seedU * 1e6));
  if ((await call(A.vault, "totalHouseBalance")) < seed) {
    let have = await call(usdc, "balanceOf", [D.addr]);
    if (have < seed) {
      if (!test) throw new Error("deployer holds less collateral than vaultSeed");
      const MAX = 1000000000000n, calls = [];
      for (let left = seed - have; left > 0n; left -= MAX) calls.push([usdc, false, enc("mint", [D.addr, left > MAX ? MAX : left])]);
      if (S.mc3) await send(D, MC3, "aggregate3", [calls.map(([target, allowFailure, callData]) => ({ target, allowFailure, callData }))], { kind: "seed:mint" });
      else for (const k of calls) await send(D, usdc, null, null, { data: k[2], kind: "seed:mint" });
    }
    if ((await call(usdc, "allowance", [D.addr, A.vault])) < seed) await send(D, usdc, "approve", [A.vault, MAXU], { kind: "approve" });
    await send(D, A.vault, "deposit", [seed, D.addr], { kind: "seed:deposit" });
  }
  dep.done = 1;
  dep.minted = test ? String(await call(usdc, "totalSupply")) : null;
  saveDep();
  return book();
}
export const book = () => ({ ...S.dep.addr, multicall3: S.dep.mc3 ? MC3 : null, publisher: acct("publisher").addr, keeper: acct("keeper").addr, deployer: acct("deployer").addr,
  markets: (S.dep.mk || []).map((m) => ({ symbol: m.sym, id: m.id, expiry: m.exp || undefined })), done: !!S.dep.done });

// ───────────── funding ─────────────
async function sendNative(list, kind) {
  // list: [addr, wei][]
  const D = acct("deployer"), n = S.cfg.fundBatch;
  if (S.mc3) {
    for (let i = 0; i < list.length; i += n) {
      const part = list.slice(i, i + n);
      const value = part.reduce((a, [, v]) => a + v, 0n);
      await send(D, MC3, "aggregate3Value", [part.map(([target, v]) => ({ target, allowFailure: false, value: v, callData: "0x" }))], { value, kind, gk: kind + part.length, pipe: true });
    }
  } else await Promise.all(list.map(([to, v]) => send(D, to, null, null, { value: v, kind: kind + ":single", gas: 21000n, pipe: true })));
}

export async function fund(j) {
  const c = S.cfg, A = S.dep.addr, D = acct("deployer");
  if (!S.dep.done) throw new Error("deploy() first");
  const F = S.fundSt || (S.fundSt = { n: {}, c: {}, pub: 0, kp: 0 });
  const save = () => store.set("fund", F);
  const test = c.collateral === "test";
  const n = c.agents;
  const ag = Array.from({ length: n }, (_, i) => acct("agent", i));
  j.step = "read balances";
  const [nb, cb] = await Promise.all([Promise.all(ag.map((a) => bal(a.addr))), Promise.all(ag.map((a) => call(A.usdc, "balanceOf", [a.addr])))]);
  const gw = toWei(c.gasPerAgent), cap = BigInt(Math.round(c.agentCapital * 1e6));
  // Native gas: anything not yet flagged and visibly unfunded.
  const needN = [];
  ag.forEach((a, i) => { if (!F.n[i]) { if (nb[i] * 10n >= gw * 8n) F.n[i] = 1; else needN.push([a.addr, gw - nb[i], i]); } });
  const others = [["pub", acct("publisher"), toWei(c.publisherGas)], ["kp", acct("keeper"), toWei(c.keeperGas)]];
  for (const [k, a, w] of others) if (!F[k]) { const b = await bal(a.addr); if (b * 10n >= w * 8n) F[k] = 1; else needN.unshift([a.addr, w - b, k]); }
  j.step = "native gas x" + needN.length;
  const fb = c.fundBatch;
  for (let i = 0; i < needN.length; i += fb) {
    const part = needN.slice(i, i + fb);
    await sendNative(part.map(([a, v]) => [a, v]), "fund:native");
    for (const [, , k] of part) { if (typeof k === "number") F.n[k] = 1; else F[k] = 1; }
    save();
    j.step = "native gas " + Math.min(needN.length, i + fb) + "/" + needN.length;
  }
  // Collateral.
  const needC = [];
  ag.forEach((a, i) => { if (!F.c[i]) { if (cb[i] >= cap) F.c[i] = 1; else needC.push([a.addr, cap - cb[i], i]); } });
  for (let i = 0; i < needC.length; i += fb) {
    const part = needC.slice(i, i + fb);
    j.step = "collateral " + i + "/" + needC.length;
    if (test && S.mc3) await send(D, MC3, "aggregate3", [part.map(([to, v]) => ({ target: A.usdc, allowFailure: false, callData: enc("mint", [to, v]) }))], { kind: "fund:mint", gk: "fund:mint" + part.length });
    else await Promise.all(part.map(([to, v]) => send(D, A.usdc, test ? "mint" : "transfer", [to, v], { kind: test ? "fund:mint:single" : "fund:transfer", pipe: true })));
    for (const [, , k] of part) F.c[k] = 1;
    save();
  }
  F.done = 1;
  if (test) { S.dep.minted = String(await call(A.usdc, "totalSupply")); saveDep(); }
  save();
  return { funded: n, nativeSent: needN.length, collateralSent: needC.length, multicall3: !!S.mc3, deployerBalance: fmt(await bal(D.addr)) };
}

/** Keeps every account able to pay for its next transaction; capped so a bug cannot drain the deployer. */
export async function topUp() {
  const c = S.cfg, T = S.run.top;
  const D = acct("deployer");
  const list = [["agent", c.gasPerAgent, c.agents], ["keeper", c.keeperGas, 1], ["publisher", c.publisherGas, 1]];
  const all = [];
  for (const [role, amt, n] of list) for (let i = 0; i < n; i++) all.push([acct(role, i), toWei(amt), role]);
  const live = all.filter(([a, , role]) => role !== "agent" || !(S.agents[a.i].done || S.agents[a.i].fail) || S.sweeping);
  const bs = await Promise.all(live.map(([a]) => bal(a.addr)));
  // An account must be able to cover gasLimit * maxFeePerGas of its largest transaction, not just the fee it pays.
  const dyn = BigInt(Math.ceil((S.run.agMax || 0) * 1.7)) * fees().maxFeePerGas;
  const low = dyn > toWei(c.lowWater) ? dyn : toWei(c.lowWater), need = [];
  S.nat = S.nat || {};
  live.forEach(([a, amt, role], i) => {
    if (role !== "agent") S.nat[role] = fmt(bs[i]);
    const floor = role === "agent" ? low : amt / 4n > low ? amt / 4n : low;
    if (bs[i] < floor) need.push([a.addr, role === "agent" ? toWei(c.topUpAmount) : amt / 2n]);
  });
  const db = await bal(D.addr);
  S.nat.deployer = fmt(db);
  if (!need.length) return;
  const sum = need.reduce((x, [, v]) => x + v, 0n);
  if (db < sum + toWei(c.deployerReserve)) { if (!T.dry) anomaly("deployerOutOfGas", "cannot top up " + need.length + " accounts"); T.dry = 1; return; }
  await sendNative(need, "fund:topup");
  T.n += need.length;
  T.usdc += fmt(sum);
}
