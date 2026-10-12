// The trader cohort: ~12 strategy archetypes with randomised parameters, one async loop per agent.
import { S, sleep, now, chainNow, rng, inc, sample, anomaly, mulf, fpx, MAXU, lc } from "./core.js";
import { acct, call, send } from "./chain.js";
import { through } from "./indexer.js";

// name: [weight, markets (first = primary), leverage range, hold fraction of the trade cycle]
export const STRATS = {
  momentum: [10, ["BTC-USD", "ETH-USD", "SOL-USD"], [5, 20], [0.35, 0.6]],
  meanrev: [10, ["ETH-USD", "BTC-USD", "XAU-USD", "SOL-USD"], [5, 15], [0.3, 0.55]],
  breakout: [8, ["SOL-USD", "BTC-USD", "ETH-USD"], [8, 25], [0.4, 0.65]],
  scalper: [10, ["BTC-USD", "ETH-USD", "SOL-USD"], [20, 50], [0.2, 0.4]],
  swing: [8, ["BTC-USD", "XAU-USD", "ETH-USD", "EUR-USD"], [2, 5], [0.6, 0.85]],
  pairs: [8, ["ETH-BTC", "ETH-USD", "BTC-USD"], [5, 20], [0.4, 0.6]],
  carry: [8, ["EUR-USD", "JPY-USD"], [3, 12], [0.6, 0.85]],
  dated: [8, ["FUT", "BTC-USD", "ETH-USD"], [3, 15], [0.4, 0.6]],
  maker: [8, ["BTC-USD", "ETH-USD", "SOL-USD", "XAU-USD"], [5, 15], [0.35, 0.55]],
  degen: [8, ["BTC-USD", "ETH-USD"], [60, 100], [0.6, 0.9]],
  hedger: [7, ["BTC-USD", "ETH-USD", "SOL-USD"], [4, 12], [0.45, 0.7]],
  wallet: [7, ["BTC-USD", "ETH-USD", "EUR-USD", "XAU-USD", "JPY-USD"], [2, 10], [0.4, 0.6]],
};
export const SNAMES = Object.keys(STRATS);
const BP = 1e-4;

// ───────────── indicators over the 1 Hz mid history ─────────────
const tail = (h, n) => h.slice(Math.max(0, h.length - Math.max(2, Math.round(n))));
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = mean(a); return Math.sqrt(a.reduce((x, y) => x + (y - m) * (y - m), 0) / a.length); };
function ema(h, n) { const a = tail(h, n * 3), k = 2 / (Math.max(2, n) + 1); let e = a[0]; for (const v of a) e += k * (v - e); return e; }
const ret = (h, n) => { const a = tail(h, n + 1); return a[a.length - 1] / a[0] - 1; };
/** Per-second return volatility. */
function vol(h) { const a = tail(h, 120); if (a.length < 5) return 3 * BP; const r = []; for (let i = 1; i < a.length; i++) r.push(a[i] / a[i - 1] - 1); return Math.max(sd(r), 0.2 * BP); }
const zs = (h, n) => { const a = tail(h, n), s = sd(a); return s ? (a[a.length - 1] - mean(a)) / s : 0; };
const sgn = (x) => (x > 0 ? 1 : x < 0 ? -1 : 0);

export function emptyStats() {
  return { op: 0, cl: 0, lq: 0, se: 0, ord: 0, fill: 0, can: 0, trips: 0, cm: 0, vol: 0, fee: 0, fund: 0, pnlT: 0, best: null, worst: null,
    wins: 0, house: 0, stkd: 0, yld: 0, mk: {}, rev: {}, lat: [], latN: 0, gasG: 0, txs: 0, forced: 0 };
}

export class Agent {
  constructor(i, st, saved) {
    const r = (this.r = rng(S.seedInt + i * 7919));
    const d = STRATS[st];
    this.i = i; this.st = st;
    this.ac = acct("agent", i);
    this.addr = this.ac.addr;
    const [t0, t1] = S.cfg.pace.tradesPerAgent;
    this.tgt = t0 + Math.floor(r() * (t1 - t0 + 1));
    this.lev = d[2][0] + r() * (d[2][1] - d[2][0]);
    this.hf = d[3][0] + r() * (d[3][1] - d[3][0]);
    this.k = [r(), r(), r(), r()]; // style knobs
    this.fl = { stk: r() < S.cfg.pace.stakerShare || st === "degen" ? 1 : 0, lp: 0 };
    this.cap = S.cfg.agentCapital * 1e6;
    Object.assign(this, { s: emptyStats(), pos: {}, ord: {}, plan: {}, ap: 0, lp: null, stakes: 0, claims: 0, nextAt: 0, done: 0, fail: 0, bal: this.cap, streak: 0, tries: 0 }, saved || {});
    this.r = Math.random; // live decisions are not replayed after a reload
  }
  save() {
    const { s, pos, ord, plan, ap, lp, stakes, claims, nextAt, done, fail, bal, tries, vlp, eq } = this;
    return { s, pos, ord, plan, ap, lp, stakes, claims, nextAt, done, fail, bal, tries, vlp, eq };
  }
  // Time budget: cycle per trade, maximum hold, signal lookback (seconds of history).
  get R() { return S.cfg.pace.runMinutes * 60000; }
  get C() { return (0.85 * this.R) / this.tgt; }
  get late() { return now() > S.run.t0 + this.R; }
  hold() {
    if (this.late) return 6000 + this.k[0] * 6000;
    const left = S.run.t0 + 0.92 * this.R - now(), rem = Math.max(1, this.tgt - this.s.trips);
    return Math.max(8000, Math.min(this.C * this.hf, (left / rem) * 0.8));
  }
  get L() { return Math.max(15, Math.min(600, (this.C / 1000) * 0.8)); }
  finished() {
    return this.s.trips >= this.tgt && this.s.cm >= this.cap && Object.keys(this.s.mk).length >= 2 && !Object.keys(this.pos).length && !Object.keys(this.ord).length;
  }
  schedule() {
    if (this.late) { this.nextAt = now() + 800 + this.r() * 1500; return; }
    const left = S.run.t0 + 0.9 * this.R - now(), rem = Math.max(1, this.tgt - this.s.trips);
    const gap = Math.max(1000, Math.min(this.C, left / rem - this.C * this.hf));
    this.nextAt = now() + gap * (0.4 + 0.8 * this.r());
  }

  async tx(to, fn, args, o = {}) {
    try {
      const r = await send(this.ac, to, fn, args, { cache: true, ...o });
      const s = this.s;
      sample(s.lat, r.lat, 48, ++s.latN);
      s.gasG += Number(r.gasUsed) * Number(BigInt(r.effectiveGasPrice || "0x0")) / 1e9;
      s.txs++;
      if (Number(r.gasUsed) > (S.run.agMax || 0)) S.run.agMax = Number(r.gasUsed);
      this.streak = 0;
      this.dirty = 1;
      await through(Number(r.blockNumber));
      return r;
    } catch (e) {
      const n = e.rev || (e.rpc ? "RpcError" : "SendError");
      inc(this.s.rev, n); inc(S.run.rev, n);
      if (n === "OraclePriceStale") anomaly("oracleStaleRevert", this.st + " #" + this.i + " " + fn);
      if (n === "SendError") S.lastErr = "agent " + this.i + " " + fn + ": " + String(e.message).slice(0, 100);
      this.lastRev = n;
      if (n !== "InsufficientFunds") this.streak++;
      this.dirty = 1;
      if (n === "InsufficientFunds") { this.cool = now() + 6000; S.needTop = 1; }
      if (e.gasG) { this.s.gasG += e.gasG; this.s.txs++; inc(S.run.rev, "(revertedOnChain)"); }
      return null;
    }
  }
  async refreshBal() { this.bal = Number(await call(S.dep.addr.usdc, "balanceOf", [this.addr])); return this.bal; }

  // ───────────── housekeeping: approvals, vault LP, HOUSE staking ─────────────
  async house() {
    const A = S.dep.addr, t = now();
    if (!this.ap) { if (await this.tx(A.usdc, "approve", [A.engine, MAXU], { kind: "approve" })) this.ap = 1; else return false; }
    if (this.fl.lp && !this.lp) {
      const amt = Math.floor(this.cap * (0.15 + 0.1 * this.k[1]));
      if (!(await this.tx(A.usdc, "approve", [A.vault, MAXU], { kind: "approve" }))) return false;
      if (await this.tx(A.vault, "deposit", [BigInt(amt), this.addr], { kind: "lpDeposit" })) { this.lp = { amt, unlock: chainNow() + S.cfg.params.withdrawLockSeconds + 2 }; S.run.ven.lpIn += amt; }
    } else if (this.lp && !this.lp.out && chainNow() > this.lp.unlock && (t > S.run.t0 + 0.55 * this.R || S.sweeping)) await this.lpOut();
    const free = this.s.house - this.s.stkd;
    if (this.fl.stk && free >= 1 && this.stakes < 2 && (!this.stakes || free > this.s.stkd)) {
      const b = await call(A.token, "balanceOf", [this.addr]);
      if (b > 0n && (await this.tx(A.token, "stake", [b], { kind: "stake" }))) { this.s.stkd = this.s.house; this.stakes++; S.run.ven.stakes++; }
    }
    if (this.s.stkd > 0 && S.run.ven.yieldN > 0 && this.claims < 2 && (!this.clT || t - this.clT > 0.3 * this.R)) await this.claim();
    return true;
  }
  async claim() {
    this.clT = now();
    const e = await call(S.dep.addr.token, "earned", [this.addr]);
    if (e > 0n && (await this.tx(S.dep.addr.token, "claimYield", [], { kind: "claimYield" }))) { this.claims++; S.run.ven.claims++; }
  }
  async lpOut() {
    const A = S.dep.addr;
    const [sh, mr] = await Promise.all([call(A.vault, "balanceOf", [this.addr]), call(A.vault, "maxRedeem", [this.addr])]);
    const x = sh < mr ? sh : mr;
    if (sh === 0n) { this.lp.out = 1; return; }
    if (x === 0n) return;
    if (await this.tx(A.vault, "redeem", [x, this.addr, this.addr], { kind: "lpRedeem" })) { if (x === sh) this.lp.out = 1; S.run.ven.lpOut++; }
  }

  // ───────────── decisions ─────────────
  market(skip) {
    const list = STRATS[this.st][1].map((s) => (s === "FUT" ? (S.mk.find((m) => m.exp) || {}).sym : s)).filter(Boolean);
    const ok = (sym) => { const m = S.mkBySym[sym]; return m && sym !== skip && !this.pos[sym] && S.pub.price(m) && !(m.exp && (m.spx || chainNow() > m.exp - 12)) && !(this.bad && this.bad[sym] > now()); };
    const c = list.filter(ok);
    if (!c.length) return null;
    if (this.st === "dated" && ok(list[0])) return list[0];
    const fresh = c.filter((s) => !this.s.mk[s]);
    if (this.s.trips >= 1 && Object.keys(this.s.mk).length < 2 && fresh.length) return fresh[0];
    return this.r() < 0.55 ? c[0] : c[Math.floor(this.r() * c.length)];
  }
  /** Direction from the archetype's own indicator: [signal (0 = none yet), lean (used when out of patience)]. */
  signal(sym) {
    const h = S.pub.hist[sym] || [], L = this.L, k = this.k;
    if (h.length < 6) return [0, this.r() < 0.5 ? 1 : -1];
    const v = vol(h), p = h[h.length - 1];
    switch (this.st) {
      case "momentum": case "dated": { const d = (ema(h, L / 4) - ema(h, L)) / p; return [Math.abs(d) > v * (0.5 + k[0]) ? sgn(d) : 0, sgn(d)]; }
      case "meanrev": case "pairs": { const z = zs(h, L); return [Math.abs(z) > 0.8 + k[0] ? -sgn(z) : 0, -sgn(z)]; }
      case "breakout": { const a = tail(h, L).slice(0, -2); if (a.length < 3) return [0, sgn(ret(h, 3))]; const hi = Math.max(...a), lo = Math.min(...a); return [p > hi ? 1 : p < lo ? -1 : 0, sgn(ret(h, L / 2))]; }
      case "scalper": { const d = ret(h, 3 + Math.round(k[0] * 5)); return [sgn(d), sgn(d)]; }
      case "swing": { const d = ret(h, L * 3); return [Math.abs(d) > v * 4 ? sgn(d) : 0, sgn(d)]; }
      case "carry": { const fr = S.mkBySym[sym].fr || 0; const d = fr ? -sgn(fr) : sgn(ret(h, L)); return [d, d]; }
      case "degen": { const d = k[1] < 0.5 ? sgn(ret(h, 5)) : -sgn(ret(h, 20)); return [d, d]; }
      case "hedger": { const d = sgn(ret(h, L)); return [d, d]; }
      default: { const d = sgn(ret(h, L * 2)); return [d, d]; }
    }
  }
  decide() {
    const t = now(), pat = Math.max(3000, this.C * 0.15);
    const sym = this.market();
    if (!sym) return null;
    let [d, lean] = this.signal(sym);
    let forced = 0;
    if (!d) { if (t < this.nextAt + pat && !this.late) return null; d = lean || (this.r() < 0.5 ? 1 : -1); forced = 1; }
    const m = S.mkBySym[sym], h = S.pub.hist[sym] || [], k = this.k;
    const H = this.hold(), v = vol(h), sH = v * Math.sqrt(H / 1000);
    let lev = Math.min(this.lev * (this.cut || 1), m.lev);
    if (lev < 1.05) lev = 1.05;
    const it = { sym, long: d > 0, lev, via: 0, tp: 0, sl: 0, x: { H, stp: 0.5, tpm: 1.5, st: this.st, f: forced } };
    const capSl = (x) => Math.min(x, 0.7 / lev);
    switch (this.st) {
      case "momentum": it.x.stp = 0.25 + 0.3 * k[1]; it.x.tpm = 0.5 + k[2]; it.x.sig = 1; break;
      case "meanrev": { const z = Math.abs(zs(h, this.L)); it.tp = Math.max(4 * BP, z * sd(tail(h, this.L)) / h[h.length - 1] * (0.4 + 0.4 * k[1])); it.sl = capSl(Math.max(5 * BP, it.tp * (1.2 + k[2]))); it.x.br = 1; break; }
      case "breakout": it.sl = capSl(Math.max(5 * BP, sH * (0.5 + 0.6 * k[1]))); it.x.br = 1; it.x.trail = it.sl; break;
      case "scalper": it.tp = Math.max(3 * BP, sH * (0.3 + 0.5 * k[1])); it.sl = capSl(Math.max(3 * BP, it.tp * (0.6 + 0.6 * k[2]))); it.x.br = 1; break;
      // Brackets set after the open with setTriggerOrder: both on the first two trades, then the stop only.
      case "swing": it.x.post = [this.s.op < 2 ? Math.max(8 * BP, sH * (1.5 + k[1])) : 0, capSl(Math.max(8 * BP, sH * (1 + k[2])))]; it.x.H = H * 1.2; break;
      case "pairs": {
        it.x.sig = 2; it.x.stp = 0.4;
        // Away from the cross itself, express the same ratio view through one USD leg.
        if (sym !== "ETH-BTC") { const dc = -sgn(zs(S.pub.hist["ETH-BTC"] || [1, 1], this.L)) || d; it.long = sym === "ETH-USD" ? dc > 0 : dc < 0; it.x.sig = 0; }
        break;
      }
      case "carry": it.x.stp = 0.6; it.x.tpm = 3; break;
      case "dated": if (m.exp) { it.x.via = "settle"; it.x.H = 1e12; } else { it.x.sig = 1; } break;
      case "maker": it.via = 1; break;
      case "degen": it.x.stp = 9; it.x.tpm = 0.8 + 2 * k[2]; break;
      case "hedger": { const o = this.market(sym); if (o) { it.hedge = o; } it.x.stp = 0.6; break; }
      case "wallet": it.via = 2; it.x.via = "order"; it.x.stp = 0.4 + 0.3 * k[1]; it.x.tpm = 0.6 + k[2]; it.lev = Math.min(m.lev, [2, 3, 5, 10][Math.floor(k[0] * 4)]); break;
    }
    if (S.cfg.pace.lean) { it.via = 0; it.tp = it.sl = 0; it.x = { H, stp: it.x.stp, tpm: it.x.tpm, st: this.st }; delete it.hedge; }
    return it;
  }
  margin(lev, parts = 1) {
    const need = Math.max(0, this.cap - this.s.cm), rem = Math.max(1, this.tgt - this.s.trips);
    const want = Math.max((need / rem) * (1.03 + 0.22 * this.r()), this.cap * 0.08);
    const room = (this.bal - 2e6) / (1 + lev * 0.0016) / parts;
    const mg = Math.floor(Math.min(want, room * 0.97));
    return mg >= S.minMargin ? mg : 0;
  }

  // ───────────── actions ─────────────
  async openDirect(it) {
    const m = S.mkBySym[it.sym], t0 = now();
    const upd = await S.pub.fresh(m);
    const px = upd && S.pub.price(m);
    if (!px) return null;
    const mg = this.margin(it.lev);
    if (!mg) return this.ruined();
    const ref = it.long ? px.ask : px.bid, up = it.long ? 1 : -1;
    const p = { priceId: m.id, isLong: it.long, margin: BigInt(mg), size: BigInt(Math.floor(mg * it.lev)),
      acceptablePrice: mulf(ref, 1 + up * S.cfg.pace.slippage), takeProfit: it.tp ? mulf(ref, 1 + up * it.tp) : 0n, stopLoss: it.sl ? mulf(ref, 1 - up * it.sl) : 0n };
    const nb = (it.tp ? 1 : 0) + (it.sl ? 1 : 0);
    this.plan[it.sym] = it.x;
    const r = await this.tx(S.dep.addr.engine, "openPosition", [p, upd.map((u) => u.upd)], { kind: nb ? "open+brackets" : "open", gk: "open" + upd.length + nb, upd, t0 });
    if (!r) this.openFailed(it);
    return r;
  }
  openFailed(it) {
    const n = this.lastRev;
    if (n === "MarketOiCapExceeded" || n === "VaultOiCapExceeded") this.cut = (this.cut || 1) * 0.5;
    if (n === "MarketExpired" || n === "MarketDisabled" || n === "OraclePriceStale" || n === "OracleConfidenceTooWide") (this.bad || (this.bad = {}))[it.sym] = now() + 20000;
    this.nextAt = now() + 1500 + this.r() * 2500;
  }
  ruined() {
    if (Object.keys(this.pos).length || Object.keys(this.ord).length) { this.nextAt = now() + 4000; return null; }
    if (this.s.cm >= this.cap && this.s.trips >= this.tgt) { this.done = 1; return null; }
    this.fail = "ruined"; this.dirty = 1; return null;
  }
  /** Limit orders: resting two-sided quotes (maker) or a marketable order that the keeper fills (wallet). */
  async limit(it, sides) {
    const m = S.mkBySym[it.sym];
    const px = S.pub.price(m);
    if (!px) return null;
    const h = S.pub.hist[it.sym] || [], v = vol(h);
    const mg = this.margin(it.lev, sides.length);
    if (!mg) return this.ruined();
    this.plan[it.sym] = it.x;
    let ok = null;
    for (const long of sides) {
      const up = long ? 1 : -1;
      let trig, tp = 0n, sl = 0n, kind;
      if (it.via === 2) { trig = mulf(long ? px.ask : px.bid, 1 + up * S.cfg.pace.slippage); kind = "limit:marketable"; }
      else {
        const off = Math.max(1.5 * BP, v * Math.sqrt(Math.max(4, this.C * 0.00012)) * (0.3 + 0.4 * this.k[1]) / (1 + this.tries));
        trig = mulf(px.mid, 1 - up * off);
        const t = Math.max(4 * BP, off * (1.5 + this.k[2])), s = Math.min(Math.max(6 * BP, off * (2.5 + this.k[3])), 0.7 / it.lev);
        tp = mulf(trig, 1 + up * t); sl = mulf(trig, 1 - up * s);
        it.x.br = 1;
        kind = "limit:resting";
      }
      const p = { priceId: m.id, isLong: long, margin: BigInt(mg), size: BigInt(Math.floor(mg * it.lev)), triggerPrice: trig, takeProfit: tp, stopLoss: sl };
      const r = await this.tx(S.dep.addr.engine, "createLimitOrder", [p], { kind, gk: kind + (tp ? 2 : 0) });
      if (r) ok = r; else { this.openFailed(it); break; }
    }
    return ok;
  }
  async close(sym, reason) {
    const p = this.pos[sym], m = S.mkBySym[sym], t0 = now();
    if (!p) return null;
    let upd = [];
    if (!m.spx) {
      upd = await S.pub.fresh(m);
      if (!upd) return null;
      // Mirror of PriceNotAfterOpen: the price must be published in a later second than the open.
      if (upd.some((u) => u.pt <= p.oa)) return null;
    }
    const px = S.pub.price(m);
    const acc = this.k[3] < 0.3 ? 0n : mulf(p.l ? px.bid : px.ask, 1 - (p.l ? 1 : -1) * S.cfg.pace.slippage);
    // With keeper-executable orders attached the position can vanish under us: always simulate that close.
    const linked = Object.values(this.ord).filter((o) => o.m === sym && o.ty).length;
    const r = await this.tx(S.dep.addr.engine, "closePosition", [m.id, acc, upd.map((u) => u.upd)], { kind: "close", gk: "close" + upd.length + linked, upd, t0, cache: !linked });
    if (!r) {
      const n = this.lastRev;
      if (n === "PriceNotAfterOpen") { p.na = (p.na || 0) + 1; if (p.na === 3) anomaly("stuckPriceNotAfterOpen", "#" + this.i + " " + sym); }
      if (n === "PositionNotFound") await this.reconcile();
    }
    return r;
  }
  async trigger(sym, ty, price) {
    const m = S.mkBySym[sym];
    return this.tx(S.dep.addr.engine, "setTriggerOrder", [m.id, ty, price], { kind: "trigger:" + ["", "tp", "sl", "close"][ty], gk: "trig" + ty });
  }
  async cancel(id) {
    const r = await this.tx(S.dep.addr.engine, "cancelOrder", [BigInt(id)], { kind: "cancelOrder" });
    // Gone already (filled or cancelled with its position): the indexer removes the mirror when the event arrives.
    if (!r && this.lastRev === "OrderNotFound") await this.reconcile();
    return r;
  }
  /** A close found nothing to close: the keeper got there first. Wait for the indexer to deliver that event. */
  async reconcile() {
    await through(S.head.n + S.cfg.ixLag);
  }

  async enter() {
    const it = this.decide();
    if (!it) return;
    await this.refreshBal();
    if (it.x.f) this.s.forced++;
    if (it.via === 1) { if (await this.limit(it, [true, false])) this.quoteT = now(); return; }
    if (it.via === 2) { await this.limit(it, [it.long]); return; }
    const r = await this.openDirect(it);
    if (r && it.hedge && S.pub.price(S.mkBySym[it.hedge])) {
      await this.refreshBal();
      await this.openDirect({ ...it, sym: it.hedge, long: !it.long, x: { ...it.x } });
    }
  }

  async manage() {
    const t = now();
    for (const sym of Object.keys(this.pos)) {
      const p = this.pos[sym], m = S.mkBySym[sym], x = this.plan[sym] || { H: this.hold(), stp: 0.5, tpm: 1.5 };
      const age = t - p.t;
      if (x.via === "settle") {
        // Held into settlement; the keeper closes it. If that takes very long, say so and close it ourselves.
        if (!S.sweeping) {
          if (m.spx && chainNow() > m.exp + 90) { if (!x.w) { x.w = 1; anomaly("settlementSlow", "#" + this.i + " " + sym); } await this.close(sym); }
          continue;
        }
      }
      const px = S.pub.price(m);
      if (!px) continue;
      const e = fpx(BigInt(p.e)), mid = fpx(px.mid);
      const rr = (p.l ? 1 : -1) * (mid / e - 1) * (p.sz / p.mg); // return on margin
      if (x.post && !x.pd) {
        const up = p.l ? 1 : -1;
        x.pd = 1;
        if (x.post[0]) await this.trigger(sym, 1, mulf(px.mid, 1 + up * x.post[0]));
        if (this.pos[sym]) await this.trigger(sym, 2, mulf(px.mid, 1 - up * x.post[1]));
        continue;
      }
      if (x.trail && !x.tr && rr > x.trail * (p.sz / p.mg) && p.l === (mid > e ? 1 : 0)) {
        x.tr = 1; // move the stop to break-even
        await this.trigger(sym, 2, mulf(BigInt(p.e), 1 + (p.l ? 1 : -1) * 0.5 * BP));
        continue;
      }
      let out = age > x.H || rr <= -x.stp || rr >= x.tpm;
      if (!out && x.sig && age > 5000) {
        const h = S.pub.hist[sym] || [];
        if (x.sig === 1) { const d = sgn(ema(h, this.L / 4) - ema(h, this.L)); out = d !== 0 && d !== (p.l ? 1 : -1) && age > x.H * 0.4; }
        else out = Math.abs(zs(h, this.L)) < 0.2 && age > x.H * 0.3;
      }
      if (S.sweeping) out = true;
      if (!out) continue;
      if (x.via === "order" && !S.sweeping) {
        if (!x.sent) {
          const bound = this.k[3] < 0.5 ? 0n : mulf(p.l ? px.bid : px.ask, 1 - (p.l ? 1 : -1) * S.cfg.pace.slippage);
          if (await this.trigger(sym, 3, bound)) x.sent = now();
        } else if (t - x.sent > S.cfg.keeper.stuckMs + 5000) {
          const o = Object.values(this.ord).find((q) => q.m === sym && q.ty === 3);
          anomaly("closeOrderNotExecuted", "#" + this.i + " " + sym + (p.l ? " long" : " short") + " bound " + (o && o.tr !== "0" ? fpx(BigInt(o.tr)).toPrecision(7) : "none") + " now " + fpx(p.l ? px.bid : px.ask).toPrecision(7));
          await this.close(sym);
        }
      } else await this.close(sym);
    }
    for (const id of Object.keys(this.ord)) {
      const o = this.ord[id];
      if (!o || o.ty !== 0) continue;
      const age = t - o.t, pat = Math.max(6000, this.C * 0.2);
      const m = S.mkBySym[o.m];
      if (this.pos[o.m] || S.sweeping || (m.exp && chainNow() > m.exp)) { await this.cancel(id); continue; }
      if (this.st === "maker" ? age > pat : age > S.cfg.keeper.stuckMs + 5000) {
        if (this.st !== "maker") { const q = S.pub.price(m); anomaly("marketOrderNotFilled", "#" + this.i + " order " + id + " " + o.m + (o.l ? " long" : " short") + " limit " + fpx(BigInt(o.tr)).toPrecision(7) + " now " + (q ? fpx(o.l ? q.ask : q.bid).toPrecision(7) : "no price")); }
        if (await this.cancel(id)) this.tries = Math.min(4, this.tries + 0.5);
      }
    }
  }

  onClose(sym, net, liq) {
    delete this.plan[sym];
    this.tries = 0;
    if (!Object.keys(this.pos).some((s) => (this.plan[s] || {}).via !== "settle")) this.schedule();
  }

  async step() {
    if (this.cool && now() < this.cool) return;
    if (!(await this.house())) return;
    const active = Object.keys(this.pos).filter((s) => (this.plan[s] || {}).via !== "settle").length + Object.values(this.ord).filter((o) => o.ty === 0).length;
    if (Object.keys(this.pos).length || Object.keys(this.ord).length) await this.manage();
    if (active) return;
    if (this.finished()) { this.done = 1; this.dirty = 1; return; }
    if (this.s.trips >= this.tgt && this.s.cm >= this.cap && Object.keys(this.s.mk).length >= 2) return; // only waiting for settlement
    if (now() < this.nextAt) return;
    await this.enter();
  }

  async run(tok) {
    await sleep(this.r() * 3000);
    while (tok.on && !this.done && !this.fail) {
      this.busy = 1;
      try { await this.step(); } catch (e) { inc(S.run.loopErr, "agent"); S.lastErr = "agent " + this.i + ": " + String(e.message || e).slice(0, 140); this.streak++; }
      this.busy = 0;
      if (this.streak >= S.cfg.pace.maxFailStreak) { this.fail = this.lastRev || "errors"; this.dirty = 1; }
      await sleep(S.cfg.pace.tickMs * (0.6 + 0.8 * Math.random()));
    }
  }

  /** End of run: cancel resting orders, close every position, pull LP funds, claim yield. */
  async sweep() {
    for (let round = 0; round < 40; round++) {
      const np = Object.keys(this.pos).length, no = Object.values(this.ord).filter((o) => o.ty === 0).length;
      if (!np && !no) break;
      try { await this.manage(); } catch (e) { inc(S.run.loopErr, "sweep"); }
      await sleep(900 + Math.random() * 600);
    }
    try {
      if (this.lp && !this.lp.out && chainNow() > this.lp.unlock) await this.lpOut();
      if (this.s.stkd > 0 && S.run.ven.yieldN > 0) await this.claim();
      await this.refreshBal();
    } catch (e) { inc(S.run.loopErr, "sweep"); }
    this.dirty = 1;
  }
}

/** Deterministic cohort: strategies by weight, shuffled with the seed. */
export function buildAgents() {
  const n = S.cfg.agents, mix = S.cfg.pace.mix || {}, r = rng(S.seedInt);
  const w = SNAMES.map((k) => (mix[k] != null ? mix[k] : STRATS[k][0]));
  const tot = w.reduce((a, b) => a + b, 0);
  const list = [];
  SNAMES.forEach((k, j) => { const c = Math.round((w[j] / tot) * n); for (let i = 0; i < c; i++) list.push(k); });
  while (list.length < n) list.push(SNAMES[list.length % SNAMES.length]);
  list.length = n;
  for (let i = n - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [list[i], list[j]] = [list[j], list[i]]; }
  S.agents = list.map((st, i) => new Agent(i, st, S.savedAgents && S.savedAgents[i]));
  let lp = S.cfg.pace.lpAgents;
  for (const a of S.agents) if (lp > 0 && (a.st === "swing" || a.st === "carry")) { a.fl.lp = 1; lp--; }
  S.byAddr = {};
  S.ordOwner = new Map();
  for (const a of S.agents) { S.byAddr[lc(a.addr)] = a; for (const id in a.ord) S.ordOwner.set(+id, a); }
}
