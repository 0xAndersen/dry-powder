// Event indexer: the single writer of per-agent trade statistics and position/order mirrors.
import { S, now, chainNow, hex, lc, inc, anomaly, sleep, fpx } from "./core.js";
import { rpc } from "./rpc.js";
import { decodeLog } from "./chain.js";

const waiters = [];
/** Resolves once every log up to block `bn` has been applied. */
export function through(bn) {
  if (S.run.blk >= bn) return Promise.resolve();
  return Promise.race([new Promise((res) => waiters.push([bn, res])), sleep(20000)]);
}
const N = (b) => Number(b);

function closeTrade(a, sym, net, liq) {
  const s = a.s;
  s.trips++;
  s.pnlT += net;
  if (net > 0) s.wins++;
  if (s.best == null || net > s.best) s.best = net;
  if (s.worst == null || net < s.worst) s.worst = net;
  delete a.pos[sym];
  a.dirty = 1;
  if (a.onClose) a.onClose(sym, net, liq);
}

function apply(l) {
  const d = decodeLog(l);
  if (!d) return;
  const x = d.args, v = S.run.ven;
  const ts = l.blockTimestamp ? N(l.blockTimestamp) : Math.ceil(chainNow());
  const m = x.priceId ? S.mkById[lc(x.priceId)] : null;
  const who = x.trader || x.account;
  const a = who ? S.byAddr[lc(who)] : null;
  switch (d.name) {
    case "PositionOpened": {
      v.opens++; v.vol += N(x.size);
      if (!a || !m) break;
      a.pos[m.sym] = { l: x.isLong ? 1 : 0, mg: N(x.margin), sz: N(x.size), e: String(x.entryPrice), of: N(x.fee), oa: ts, t: now(), b: N(l.blockNumber) };
      const s = a.s;
      s.op++; s.cm += N(x.margin); s.vol += N(x.size); s.fee += N(x.fee); inc(s.mk, m.sym);
      a.dirty = 1;
      break;
    }
    case "PositionClosed": {
      v.closes++;
      if (!a || !m) break;
      const p = a.pos[m.sym];
      const s = a.s;
      s.cl++; s.fee += N(x.fee);
      if (m.spx && x.exitPrice === m.spx) { s.se++; v.settledPos++; }
      if (!p) { closeTrade(a, m.sym, N(x.pnl) - N(x.fee), 0); break; } // mirror lost: still a completed round trip
      v.vol += p.sz; s.vol += p.sz;
      // Funding = exact price PnL (engine rounding) minus the reported PnL, unless the profit cap bit.
      const e = BigInt(p.e), sz = BigInt(p.sz), ex = x.exitPrice;
      const profit = p.l ? ex >= e : ex <= e;
      const diff = ex > e ? ex - e : e - ex;
      const mag = profit ? (sz * diff) / e : (sz * diff + e - 1n) / e;
      const pp = profit ? mag : -mag;
      if (x.pnl < BigInt(p.mg) * 10n) s.fund += N(pp - x.pnl);
      closeTrade(a, m.sym, N(x.payout) - p.mg - p.of, 0);
      break;
    }
    case "PositionLiquidated": {
      v.liqs++;
      if (lc(x.liquidator) === lc(S.keeperAddr)) S.run.kp.liqs++;
      if (!a) break;
      const mm = S.mkById[lc(x.priceId)];
      const p = mm && a.pos[mm.sym];
      a.s.lq++;
      let net = -N(x.margin) - (p ? p.of : 0);
      if (a.lc && a.lc[0] === l.transactionHash) { a.s.fee += a.lc[1]; net -= a.lc[1]; }
      if (mm) closeTrade(a, mm.sym, net, 1);
      break;
    }
    case "OrderCreated": {
      v.orders++;
      if (!a || !m) break;
      const id = N(x.orderId), ty = N(x.orderType);
      a.ord[id] = { m: m.sym, ty, l: x.isLong ? 1 : 0, tr: String(x.triggerPrice), mg: N(x.margin), sz: N(x.size), ca: ts, t: now() };
      S.ordOwner.set(id, a);
      a.s.ord++;
      a.dirty = 1;
      break;
    }
    case "OrderUpdated": {
      const o = S.ordOwner.get(N(x.orderId));
      if (o && o.ord[N(x.orderId)]) { o.ord[N(x.orderId)].tr = String(x.triggerPrice); o.ord[N(x.orderId)].ca = ts; o.dirty = 1; }
      break;
    }
    case "OrderCancelled": {
      const id = N(x.orderId);
      if (a && a.ord[id]) {
        if (a.ord[id].ty) { if (a.lc && a.lc[0] === l.transactionHash) a.lc[1] += S.execFee; else a.lc = [l.transactionHash, S.execFee]; }
        delete a.ord[id]; a.s.can++; a.dirty = 1;
      }
      S.ordOwner.delete(id);
      break;
    }
    case "OrderExecuted": {
      const id = N(x.orderId);
      if (a) {
        const o = a.ord[id];
        if (o) { inc(v.fills, o.ty); delete a.ord[id]; }
        a.s.fill++; a.s.fee += S.execFee; a.dirty = 1;
      }
      S.ordOwner.delete(id);
      break;
    }
    case "MarketSettled":
      if (m) { m.spx = x.settlementPrice; m.sp = fpx(x.settlementPrice); m.spS = String(x.settlementPrice); v.settledMk++; S.depDirty = 1; }
      break;
    case "PaymentDeferred": anomaly("paymentDeferred", who); break;
    case "LossRebateMinted": if (a) { a.s.house += N(x.minted) / 1e18; a.dirty = 1; } break;
    case "YieldClaimed": if (a) { a.s.yld += N(x.amount); a.dirty = 1; } v.yieldClaimed += N(x.amount); break;
    case "YieldNotified": v.yieldN += N(x.amount); break;
    case "EpochSettled": v.epochs++; v.epochProfit += N(x.profit); v.toStakers += N(x.toStakers); break;
    case "PayoutShortfall": anomaly("payoutShortfall", N(x.shortfall)); break;
  }
}

let range = 0;
export async function ixTick() {
  if (!S.head) return;
  const head = S.head.n - S.cfg.ixLag;
  for (let guard = 0; guard < 50; guard++) {
    const from = S.run.blk + 1;
    if (from > head) break;
    if (!range) range = S.cfg.logRange;
    const to = Math.min(head, from + range - 1);
    let logs;
    try {
      logs = await rpc("eth_getLogs", [{ fromBlock: hex(from), toBlock: hex(to), address: [S.dep.addr.engine, S.dep.addr.token, S.dep.addr.vault] }]);
    } catch (e) {
      if (range > 1) range = Math.max(1, range >> 1);
      throw e;
    }
    logs.sort((p, q) => N(p.blockNumber) - N(q.blockNumber) || N(p.logIndex) - N(q.logIndex));
    for (const l of logs) { try { apply(l); } catch (e) { inc(S.run.loopErr, "apply"); S.lastErr = "apply: " + e.message; } }
    S.run.blk = to;
    S.run.logs += logs.length;
  }
  for (let i = waiters.length - 1; i >= 0; i--) if (S.run.blk >= waiters[i][0]) { waiters[i][1](); waiters.splice(i, 1); }
}
