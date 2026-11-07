// Operator-facing views. Everything here returns small JSON: results travel back through a narrow channel.
import { S, now, quant, r2, r4, U, fpx, timerKind } from "./core.js";
import { rpcInfo } from "./rpc.js";
import { SNAMES } from "./agents.js";

const usd = (gwei) => Math.round(gwei / 1e3) / 1e6; // gas * gwei -> native USDC
const top = (o, n) => Object.fromEntries(Object.entries(o).sort((a, b) => b[1] - a[1]).slice(0, n));

/** Equity an agent still has inside the protocol: open positions at mid, order escrows, LP shares. */
export function openEquity(a) {
  let e = a.vlp || 0;
  for (const sym in a.pos) {
    const p = a.pos[sym], m = S.mkBySym[sym], px = m && S.pub.price(m);
    e += p.mg;
    if (px) e += Math.max(-p.mg, (p.l ? 1 : -1) * (fpx(px.mid) / fpx(BigInt(p.e)) - 1) * p.sz);
  }
  for (const id in a.ord) { const o = a.ord[id]; e += o.ty === 0 ? o.mg + Math.ceil(o.sz * 0.0015) + S.execFee : S.execFee; }
  return e;
}
export const pnlOf = (a) => a.bal + openEquity(a) - a.cap;
const state = (a) => (a.fail ? "failed:" + a.fail : a.done ? "done" : "active");

export function phase() {
  if (!S.cfg) return "boot";
  if (S.sweeping) return "sweeping";
  if (S.run.ended) return "ended";
  if (S.run.running) return "running";
  if (S.fundSt && S.fundSt.done) return "funded";
  if (S.dep && S.dep.done) return "deployed";
  return "init";
}

export function status() {
  const R = S.run, ag = S.agents || [], ri = rpcInfo();
  const done = ag.filter((a) => a.done).length, failed = ag.filter((a) => a.fail).length;
  const trips = ag.map((a) => a.s.trips);
  const errs = Object.values(ri.err).reduce((a, b) => a + b, 0);
  const jobs = {};
  for (const k in S.jobs) jobs[k] = S.jobs[k].st === "run" ? "run:" + S.jobs[k].step : S.jobs[k].st === "error" ? "error:" + S.jobs[k].err.slice(0, 80) : S.jobs[k].st;
  return {
    v: S.version, phase: phase(), uptimeS: R.t0 ? Math.round(((R.ended || now()) - R.t0) / 1000) : 0, runS: S.cfg.pace.runMinutes * 60,
    head: S.head ? S.head.n : null, indexed: R.blk, baseFeeGwei: S.head ? Number(S.head.base) / 1e9 : null,
    agents: { n: ag.length, done, active: ag.length - done - failed, failed, tripsMin: trips.length ? Math.min(...trips) : 0, tripsAvg: trips.length ? r2(trips.reduce((a, b) => a + b, 0) / trips.length) : 0,
      marginShort: ag.filter((a) => a.s.cm < a.cap).length },
    trades: { opens: R.ven.opens, closes: R.ven.closes, liqs: R.ven.liqs, orders: R.ven.orders, fills: R.ven.fills },
    volume: Math.round(U(R.ven.vol)), oi: Math.round(U(R.ven.oi)), openPos: R.kp.pos, openOrd: R.kp.ord, nav: Math.round(U(R.ven.nav)),
    publisher: { polls: R.pub.polls, pollErr: R.pub.pollErr, pushes: R.pub.pushes, lastOkS: S.pub ? Math.round((now() - S.pub.lastOk()) / 1000) : null,
      closed: S.pub ? S.pub.f.filter((x) => x.closed).map((x) => x.k) : [], err: R.pub.err },
    keeper: { liqs: R.kp.liqs, fills: R.kp.fills, settledMkt: R.kp.settleMk, settledPos: R.kp.settlePos, epochs: R.kp.epochs, err: R.kp.err },
    reverts: top(R.rev, 8), txs: R.txs, txErr: R.txErr, gasUsdc: usd(R.gasGwei),
    rpc: { req: ri.req, http: ri.http, errors: errs, errRate: ri.http ? r4(errs / ri.http) : 0, retries: ri.retries, noBatch: ri.noBatch },
    native: S.nat || {}, topUps: R.top.n, anomalies: Object.fromEntries(Object.entries(R.anom).map(([k, v]) => [k, v.n])),
    loopErr: R.loopErr, lastErr: S.lastErr || null, jobs, timers: timerKind(), visible: typeof document !== "undefined" ? document.visibilityState : null, lsErr: S.lsErr || 0,
  };
}

const COLS = ["id", "addr", "strategy", "markets", "opens", "closes", "liqs", "settled", "orders", "fills", "trips", "target", "margin", "volume", "pnl", "tradePnl", "fees", "funding",
  "house", "staked", "yield", "best", "worst", "winPct", "reverts", "latMedMs", "latP95Ms", "gasUsdc", "txs", "balance", "state"];
function row(a) {
  const s = a.s;
  return [a.i, a.addr, a.st + (a.fl.lp ? "+lp" : "") + (a.fl.stk ? "+stk" : ""), Object.entries(s.mk).map(([k, n]) => S.mk.indexOf(S.mkBySym[k]) + ":" + n).join(" "),
    s.op, s.cl, s.lq, s.se, s.ord, s.fill, s.trips, a.tgt, Math.round(U(s.cm)), Math.round(U(s.vol)), r2(U(pnlOf(a))), r2(U(s.pnlT)), r2(U(s.fee)), r2(U(s.fund)),
    Math.round(s.house), Math.round(s.stkd), r2(U(s.yld)), s.best == null ? null : r2(U(s.best)), s.worst == null ? null : r2(U(s.worst)), s.trips ? Math.round((100 * s.wins) / s.trips) : 0,
    s.rev, Math.round(quant(s.lat, 0.5)), Math.round(quant(s.lat, 0.95)), usd(s.gasG), s.txs, r2(U(a.bal)), state(a)];
}
export function report(page = 0, size = 20) {
  const ag = S.agents || [];
  const pages = Math.ceil(ag.length / size);
  return { page, pages, markets: (S.mk || []).map((m) => m.sym), cols: COLS, rows: ag.slice(page * size, (page + 1) * size).map(row),
    note: "amounts in collateral units; pnl = balance + open equity - capital; tradePnl = sum of closed trades net of fees; funding > 0 means paid; trips = positions opened and since closed by any path" };
}
export function agent(i) {
  const a = S.agents[i];
  return { row: Object.fromEntries(COLS.map((c, j) => [c, row(a)[j]])), pos: a.pos, ord: a.ord, plan: a.plan, lev: r2(a.lev), lastRev: a.lastRev || null, lp: a.lp, nextInS: Math.round((a.nextAt - now()) / 1000) };
}
export function leaderboard() {
  const l = (S.agents || []).map((a) => [a.i, a.st, r2(U(pnlOf(a))), a.s.trips, a.s.lq]).sort((x, y) => y[2] - x[2]);
  return { cols: ["id", "strategy", "pnl", "trips", "liqs"], top: l.slice(0, 10), bottom: l.slice(-10).reverse() };
}

export function gas() {
  const R = S.run, by = {};
  let tot = 0;
  for (const k of Object.keys(R.gas).sort()) { const [n, sum, max] = R.gas[k]; by[k] = [n, Math.round(sum / n), max, r4((sum * 20) / 1e9)]; tot += sum; }
  return { cols: ["count", "avgGas", "maxGas", "usdcAt20gwei"], byType: by, totalGas: tot, usdcAt20gwei: r4((tot * 20) / 1e9), usdcAt21gwei: r4((tot * 21) / 1e9), paidUsdc: usd(R.gasGwei), txs: R.txs };
}

export function summary() {
  const R = S.run, v = R.ven, ag = S.agents || [], ri = rpcInfo(), k = R.kp, p = R.pub;
  const errs = Object.values(ri.err).reduce((a, b) => a + b, 0);
  const strat = {};
  for (const n of SNAMES) strat[n] = [0, 0, 0, 0, 0];
  for (const a of ag) { const s = strat[a.st]; s[0]++; s[1] += U(pnlOf(a)); s[2] += a.s.trips; s[3] += a.s.lq; s[4] += U(a.s.vol); }
  for (const n in strat) { strat[n][1] = Math.round(strat[n][1]); strat[n][4] = Math.round(strat[n][4]); }
  const step = Math.max(1, Math.ceil(v.ser.length / 36));
  const g = gas();
  const f = R.final || {};
  const pn = ag.map((a) => U(pnlOf(a)));
  return {
    run: { phase: phase(), startedAt: R.t0 ? new Date(R.t0).toISOString() : null, seconds: R.t0 ? Math.round(((R.ended || now()) - R.t0) / 1000) : 0, chainId: S.cfg.chainId,
      agents: ag.length, done: ag.filter((a) => a.done).length, failed: ag.filter((a) => a.fail).length, blocks: [S.dep && S.dep.blk0, R.blk] },
    trades: { opens: v.opens, closes: v.closes, liquidations: v.liqs, settledPositions: v.settledPos, ordersCreated: v.orders,
      fills: { limit: v.fills[0] || 0, takeProfit: v.fills[1] || 0, stopLoss: v.fills[2] || 0, close: v.fills[3] || 0 },
      roundTrips: ag.reduce((a, b) => a + b.s.trips, 0), tripsMin: ag.length ? Math.min(...ag.map((a) => a.s.trips)) : 0, forcedEntries: ag.reduce((a, b) => a + b.s.forced, 0) },
    volume: Math.round(U(v.vol)), marginDeployed: Math.round(U(ag.reduce((a, b) => a + b.s.cm, 0))),
    agentsPnl: { total: Math.round(pn.reduce((a, b) => a + b, 0)), best: r2(Math.max(0, ...pn)), worst: r2(Math.min(0, ...pn)), winners: pn.filter((x) => x > 0).length },
    openInterest: { cols: ["tSec", "oi", "nav"], series: v.ser.filter((_, i) => i % step === 0), max: Math.round(U(v.oiMax)), last: Math.round(U(v.oi)) },
    vault: { navStart: r2(U(v.nav0 || 0)), navEnd: r2(U(v.nav)), sharePriceStart: U(v.sp0 || 0), sharePriceEnd: U(v.sp), traderLosses: r2(U(f.losses || 0)), traderProfits: r2(U(f.profits || 0)),
      fees: r2(U(f.fees || 0)), housePnl: r2(U((f.losses || 0) + (f.fees || 0) - (f.profits || 0))), stakerYieldAllocated: r2(U(v.toStakers)), stakerYieldClaimed: r2(U(v.yieldClaimed)),
      epochs: v.epochs, shortfall: U(f.shortfall || 0), houseStaked: Math.round(v.staked || 0), stakes: v.stakes, yieldClaims: v.claims, lpDeposits: r2(U(v.lpIn)), lpRedeems: v.lpOut },
    keeper: { liquidations: k.liqs, liquidationTxs: k.liqTx, fills: k.fills, fillsWithoutUpdate: k.noUpd, medianDelayMs: Math.round(quant(k.delay, 0.5)), p95DelayMs: Math.round(quant(k.delay, 0.95)),
      lensRetries: k.lensRetry || 0, marketsSettled: k.settleMk, settleDelayS: k.settleDelay == null ? null : k.settleDelay, positionsSettled: k.settlePos, epochs: k.epochs, benign: k.benign, errors: k.err },
    publisher: { polls: p.polls, pollErrors: p.pollErr, signed: p.signed, pushes: p.pushes, feedsPushed: p.feeds, maxOnchainGapS: p.maxGap, maxStalenessSeenS: p.maxStale, staleSamples: p.staleSamples,
      feedClosures: p.closed, errors: p.err },
    reverts: R.rev, txErrors: R.txErr,
    rpc: { calls: ri.req, http: ri.http, batches: ri.batches, errors: ri.err, errorRate: ri.http ? r4(errs / ri.http) : 0, retries: ri.retries, failed: ri.fail },
    latencyMs: { cols: ["p50", "p90", "p95", "p99", "max"], decisionToInclusion: [0.5, 0.9, 0.95, 0.99, 1].map((q) => Math.round(quant(R.lat, q))) },
    gas: { total: g.totalGas, txs: R.txs, paidUsdc: g.paidUsdc, usdcAt20gwei: g.usdcAt20gwei, topUps: R.top.n, topUpUsdc: r4(R.top.usdc), byType: Object.fromEntries(Object.entries(g.byType).map(([t, x]) => [t, [x[0], x[1]]])) },
    strategies: { cols: ["agents", "pnl", "trips", "liqs", "volume"], rows: strat },
    checks: f.checks || null,
    anomalies: Object.entries(R.anom).map(([kind, a]) => ({ kind, n: a.n, firstS: a.t, lastS: a.l, sample: a.s })),
  };
}
