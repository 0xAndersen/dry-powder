// In-page keeper: liquidations, order execution, dated-market settlement, vault epochs, plus the venue sampler.
import { S, now, chainNow, sleep, lc, MAXU, inc, anomaly, sample, fpx } from "./core.js";
import { rpc } from "./rpc.js";
import { acct, call, send, enc, dec } from "./chain.js";

// Reverts that mean "lost a race" or "not yet"; anything else from the keeper is reported.
const BENIGN = new Set(["NothingToLiquidate", "OrderNotFound", "TriggerNotMet", "PriceBeforeOrder", "PriceNotAfterOpen",
  "PositionLiquidatable", "PositionExists", "OraclePriceStale", "InvalidTrigger", "EnforcedPause", "MarketDisabled",
  "LeverageOutOfRange", "MarginTooLow", "MarketOiCapExceeded", "VaultOiCapExceeded", "MarketExpired", "PositionNotFound",
  "EpochNotOver", "MarketAlreadySettled", "PriceBeforeExpiry", "MarketNotExpired"]);
const TY = ["limit", "tp", "sl", "close"];

/** Mirrors keeper/src/math.ts: sentinel rules for the lens liquidation price. */
export const isLiq = (isLong, lp, mid) => (isLong ? lp === MAXU || mid <= lp : mid >= lp);
/** Mirrors PerpEngine._fillLimit / _fillTrigger price conditions (type 3 = Close with a worst-price bound). */
export function triggered(ty, isLong, trig, px) {
  if (ty === 0) return isLong ? px.ask <= trig : px.bid >= trig;
  // Stop-entry (v3.1): a long once the ask is at or above the trigger, a short once the bid is at or below it.
  if (ty === 4) return isLong ? px.ask >= trig : px.bid <= trig;
  if (ty === 1) return isLong ? px.mid >= trig : px.mid <= trig;
  if (ty === 2) return isLong ? px.mid <= trig : px.mid >= trig;
  return trig === 0n || (isLong ? px.bid >= trig : px.ask <= trig);
}

export function makeKeeper() {
  const K = S.cfg.keeper;
  const st = S.run.kp;
  const me = acct("keeper");
  let positions = [], orders = [], refreshing = false, ticking = false, inflight = 0, epochBusy = false;
  const back = new Map(), first = new Map(), busy = new Set(), warned = new Set();
  const ready = (id) => { const b = back.get(id); return !b || now() >= b[1]; };
  const defer = (id) => { const n = ((back.get(id) || [0])[0]) + 1; back.set(id, [n, now() + Math.min(30000, 250 * 2 ** n)]); };

  async function refresh() {
    if (refreshing) return;
    refreshing = true;
    try {
      const { engine, lens } = S.dep.addr;
      const [pc, oc] = await Promise.all([call(engine, "positionCount"), call(engine, "orderCount")]);
      // A lens read can fail transiently (seen on anvil: a call racing block production reverts with
      // Panic 0x11 in currentFundingIndex); retry at once instead of working from a stale book for a cycle.
      const again = async (fn, args) => { for (let i = 0; ; i++) { try { return await call(lens, fn, args); } catch (e) { if (i >= 2) throw e; st.lensRetry = (st.lensRetry || 0) + 1; await sleep(120); } } };
      const pp = [], op = [];
      for (let o = 0n; o < pc; o += 200n) pp.push(again("getPositions", [o, 200n]));
      for (let o = 0n; o < oc; o += 200n) op.push(again("getOrders", [o, 200n]));
      const P = new Map(), O = new Map();
      for (const page of await Promise.all(pp)) for (const v of page) {
        const p = v.position;
        P.set(v.key, { key: v.key, trader: lc(p.trader), mk: lc(p.priceId), isLong: p.isLong, margin: p.margin, size: p.size, entry: p.entryPrice, openedAt: Number(p.openedAt), lp: v.liquidationPrice, fo: v.fundingOwed });
      }
      for (const [ids, page] of await Promise.all(op)) page.forEach((o, i) => {
        O.set(ids[i], { id: ids[i], trader: lc(o.trader), mk: lc(o.priceId), ty: Number(o.orderType), isLong: o.isLong, createdAt: Number(o.createdAt), trig: o.triggerPrice, sl: o.stopLoss });
      });
      positions = [...P.values()];
      orders = [...O.values()];
      S.kpPos = positions; S.kpOrd = orders;
      st.pos = positions.length; st.ord = orders.length;
      if (back.size > 3000) back.clear();
      for (const id of first.keys()) if (!O.has(id)) first.delete(id);
    } finally { refreshing = false; }
  }

  function fail(what, e, id) {
    const n = e.rev;
    if (n && BENIGN.has(n)) inc(st.benign, n);
    else { inc(st.err, n || "send"); st.lastErr = what + ": " + String(e.message || e).slice(0, 80); }
    if (id) defer(id);
  }

  async function liquidate(batch) {
    const mks = [...new Set(batch.map((p) => p.mk))].map((id) => S.mkById[id]);
    const upd = [];
    for (const m of mks) { if (m.spx) continue; const u = await S.pub.fresh(m); if (u) for (const x of u) if (!upd.includes(x)) upd.push(x); }
    const keys = batch.map((p) => p.key);
    try {
      const r = await send(me, S.dep.addr.engine, "liquidateBatch", [keys, upd.map((u) => u.upd)], { kind: "liquidateBatch", upd, pipe: true });
      st.liqTx++;
      const gone = new Set(keys);
      positions = positions.filter((p) => !gone.has(p.key));
      return r;
    } catch (e) { keys.forEach((k) => fail("liq", e, k)); }
  }

  async function exec(o, m, viaChain) {
    const id = "o" + o.id;
    busy.add(id);
    inflight++;
    try {
      let upd = [];
      if (!viaChain && !m.spx) { upd = await S.pub.fresh(m); if (!upd) return; }
      const r = await send(me, S.dep.addr.engine, "executeOrder", [o.id, upd.map((u) => u.upd)], { kind: "exec:" + TY[o.ty], gk: "exec" + o.ty + upd.length, upd, pipe: true });
      inc(st.fills, TY[o.ty]);
      if (!upd.length) st.noUpd++;
      const t0 = first.get(o.id);
      if (t0 > 1) { const d = now() - t0; sample(st.delay, d, 300, ++st.delayN); if (d > K.lateMs) anomaly("lateFill", TY[o.ty] + " order " + o.id + " " + d + "ms"); }
      orders = orders.filter((q) => q.id !== o.id);
      return r;
    } catch (e) { fail("exec", e, id); } finally { busy.delete(id); inflight--; }
  }

  async function settle(m) {
    const t = chainNow();
    if (!m.spx) {
      if (t < m.exp + 1 || !ready("s" + m.sym)) return;
      const upd = await S.pub.fresh(m);
      if (!upd || upd[0].pt < m.exp) return;
      try {
        await send(me, S.dep.addr.engine, "settleMarket", [m.id, upd.map((u) => u.upd)], { kind: "settleMarket", upd });
        st.settleMk++;
        st.settleDelay = Math.round((chainNow() - m.exp) * 10) / 10;
      } catch (e) {
        fail("settleMarket", e, "s" + m.sym);
        if (e.rev === "MarketAlreadySettled") { const mm = await call(S.dep.addr.engine, "getMarket", [m.id]); m.spx = mm.settlementPrice; m.sp = fpx(m.spx); m.spS = String(m.spx); S.depDirty = 1; }
      }
      return;
    }
    const ps = positions.filter((p) => p.mk === lc(m.id) && ready(p.key));
    for (let i = 0; i < ps.length; i += K.settleBatch) {
      const keys = ps.slice(i, i + K.settleBatch).map((p) => p.key);
      try {
        await send(me, S.dep.addr.engine, "settlePositions", [keys], { kind: "settlePositions", gk: "settleP" + keys.length });
        st.settlePos += keys.length;
        const gone = new Set(keys);
        positions = positions.filter((p) => !gone.has(p.key));
      } catch (e) { keys.forEach((k) => fail("settlePositions", e, k)); }
    }
  }

  async function epoch() {
    if (epochBusy || !S.epochNext || chainNow() < S.epochNext + 1) return;
    epochBusy = true;
    try {
      await send(me, S.dep.addr.vault, "settleEpoch", [], { kind: "settleEpoch", pipe: true });
      st.epochs++;
    } catch (e) { fail("epoch", e); }
    try { S.epochNext = Number(await call(S.dep.addr.vault, "lastEpochTime")) + S.cfg.params.epochSeconds; } catch (e) { S.epochNext = chainNow() + 5; }
    epochBusy = false;
  }

  async function tick() {
    if (ticking || !S.pub) return;
    ticking = true;
    try {
      const px = {}, ocx = {};
      const P = (id) => (id in px ? px[id] : (px[id] = S.pub.price(S.mkById[id])));
      const tNow = chainNow();
      // Liquidations first: they protect the vault, and a liquidatable position's orders cannot execute.
      const liq = positions.filter((p) => { if (!ready(p.key)) return false; const q = P(p.mk); return q && isLiq(p.isLong, p.lp, q.mid); });
      liq.sort((a, b) => (a.margin === b.margin ? 0 : a.margin > b.margin ? -1 : 1));
      const jobs = [];
      for (let i = 0; i < liq.length; i += K.batchSize) jobs.push(liquidate(liq.slice(i, i + K.batchSize)));
      const doomed = new Set(liq.map((p) => p.key));
      const byOwner = new Map(positions.map((p) => [p.trader + p.mk, p]));
      for (const o of orders) {
        const id = "o" + o.id;
        if (inflight >= K.maxInflight) break;
        if (busy.has(id) || !ready(id)) continue;
        const m = S.mkById[o.mk];
        const q = P(o.mk);
        if (!m || !q) continue;
        const pos = byOwner.get(o.trader + o.mk);
        let minPt = o.createdAt;
        const opens = o.ty === 0 || o.ty === 4;
        if (opens) {
          if (pos && pos.isLong !== o.isLong) continue; // PositionExists: a same-side fill adds to the position
          if (m.exp && tNow >= m.exp) { if (!warned.has(o.id)) { warned.add(o.id); anomaly("limitOnExpiredMarket", "order " + o.id + " can never fill"); } continue; }
        } else {
          if (!pos || doomed.has(pos.key)) continue;
          if (pos.openedAt + 1 > minPt) minPt = pos.openedAt + 1;
        }
        const ok = (z) => z && (z.settled || z.pt >= minPt) && triggered(o.ty, pos && !opens ? pos.isLong : o.isLong, o.trig, z) &&
          !(opens && o.sl !== 0n && (o.isLong ? o.sl >= z.ask : o.sl <= z.bid)) &&
          !(pos && isLiq(pos.isLong, pos.lp, z.mid));
        if (!ok(q)) { if (first.has(o.id) && !triggered(o.ty, pos && !opens ? pos.isLong : o.isLong, o.trig, q)) first.delete(o.id); continue; }
        if (!first.has(o.id)) first.set(o.id, now());
        // If the price already stored on-chain satisfies the order, execute without paying for an update.
        let viaChain = false;
        if (K.reuseOnchain && !m.spx) {
          const z = o.mk in ocx ? ocx[o.mk] : (ocx[o.mk] = S.pub.onchain(m));
          viaChain = !!z && tNow - z.pt <= S.cfg.params.maxPriceAgeSeconds - K.ageMargin && ok(z);
        }
        jobs.push(exec(o, m, viaChain));
      }
      for (const m of S.mk) if (m.exp) jobs.push(settle(m));
      jobs.push(epoch());
      // Orders whose condition has held for a long time without a fill are a finding, not noise.
      for (const [id, t0] of first) if (t0 > 1 && now() - t0 > K.stuckMs) { first.set(id, 1); anomaly("orderNotFilled", "order " + id + " triggered >" + K.stuckMs / 1000 + "s; last " + (st.lastErr || "")); }
      await Promise.all(jobs);
    } finally { ticking = false; }
  }

  // Venue sampler: open interest, vault value, per-market state (also what agents read for funding / OI).
  let stride = 1, sn = 0;
  async function sampleVenue() {
    const { engine, lens, vault, token } = S.dep.addr;
    const [mv, oi, nav, hb, sp, ts] = await Promise.all([call(lens, "getMarkets"), call(engine, "totalOpenInterest"), call(vault, "totalAssets"),
      call(vault, "totalHouseBalance"), call(vault, "sharePrice"), call(token, "totalStaked")]);
    const v = S.run.ven;
    const tNow = S.head ? S.head.ts : chainNow();
    for (const x of mv) {
      const m = S.mkById[lc(x.id)];
      if (!m) continue;
      m.lo = Number(x.market.longOi); m.so = Number(x.market.shortOi); m.fr = Number(x.fundingRate); m.hp = x.hasPrice;
      if (x.market.settlementPrice && !m.spx) { m.spx = x.market.settlementPrice; m.sp = fpx(m.spx); m.spS = String(m.spx); S.depDirty = 1; }
      if (!S.run.started || m.spx) continue;
      const shut = S.pub.f[m.f].closed || (m.q >= 0 && S.pub.f[m.q].closed);
      if (x.hasPrice) { const age = tNow - Number(x.price.publishTime); if (age > S.run.pub.maxStale) S.run.pub.maxStale = age; }
      else if (!shut && S.pushOn) { S.run.pub.staleSamples++; anomaly("oracleStaleOnChain", m.sym); }
    }
    v.nav = Number(nav); v.hb = Number(hb); v.sp = Number(sp); v.oi = Number(oi); v.staked = Number(ts) / 1e18;
    if (v.nav0 == null) { v.nav0 = v.nav; v.sp0 = v.sp; }
    if (v.oi > v.oiMax) v.oiMax = v.oi;
    if (S.run.started && sn++ % stride === 0) {
      v.ser.push([Math.round((now() - S.run.t0) / 1000), Math.round(v.oi / 1e6), Math.round(v.nav / 1e6)]);
      if (v.ser.length > 120) { v.ser = v.ser.filter((_, i) => i % 2 === 0); stride *= 2; }
    }
  }
  return { refresh, tick, sampleVenue, me };
}
