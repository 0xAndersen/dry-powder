// Kraken -> signed PublisherOracle updates -> in-page price service + economical on-chain heartbeat.
import { S, sleep, now, chainNow, E18, inc, store, anomaly } from "./core.js";
import { acct, send } from "./chain.js";

export const FEEDS = [
  ["BTC", "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43", -8, "XBTUSD", "XXBTZUSD"],
  ["ETH", "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace", -8, "ETHUSD", "XETHZUSD"],
  ["SOL", "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d", -8, "SOLUSD", "SOLUSD"],
  ["EUR", "0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b", -5, "EURUSD", "ZEURZUSD"],
  ["JPY", "0xef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52", -3, "USDJPY", "ZUSDZJPY"],
  ["XAU", "0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2", -3, "PAXGUSD", "PAXGUSD"],
].map(([k, id, expo, pair, alt], i) => ({ i, k, id, expo, pair, alt }));

const T1 = ["uint256", "address", "bytes32", "int64", "uint64", "int32", "uint64"].map((type) => ({ type }));
const T2 = ["bytes32", "int64", "uint64", "int32", "uint64", "bytes"].map((type) => ({ type }));

export function makePublisher() {
  const V = S.V;
  const P = S.cfg.publisher;
  const st = S.run.pub;
  const f = FEEDS.map((d) => ({ ...d, bid: 0, ask: 0, at: 0, fp: "", chg: 0, closed: false, L: null, oc: { pt: 0, m: 0 } }));
  const hist = {};
  let streak = 0, lastOk = 0, lastPush = 0, pushing = false, polling = false, lastSave = 0;

  async function sign(x, pt) {
    const mid = (x.bid + x.ask) / 2;
    const sc = 10 ** -x.expo;
    const price = BigInt(Math.round(mid * sc));
    let conf = BigInt(Math.ceil(Math.max(Math.abs(x.ask - x.bid) / 2, mid * 1e-4) * sc));
    if (conf < 1n) conf = 1n;
    const signer = acct("publisher").a;
    const digest = V.keccak256(V.encodeAbiParameters(T1, [BigInt(S.cfg.chainId), S.dep.addr.pub, x.id, price, conf, x.expo, BigInt(pt)]));
    const sig = await signer.signMessage({ message: { raw: digest } });
    const scale = 10n ** BigInt(18 + x.expo);
    st.signed++;
    x.L = {
      i: x.i, pt, price, conf, m: mid, src: x.at,
      upd: V.encodeAbiParameters(T2, [x.id, price, conf, x.expo, BigInt(pt), sig]),
      mid: price * scale, bid: (price - conf) * scale, ask: (price + conf) * scale,
    };
    return x.L;
  }
  const usable = (x) => x.at && !x.closed && now() - lastOk < P.maxPollAgeMs;

  async function pollOnce() {
    const url = S.cfg.krakenUrl + "/0/public/Ticker?pair=" + FEEDS.map((d) => d.pair).join(",");
    const r = await fetch(url);
    if (!r.ok) throw new Error("kraken http " + r.status);
    const j = await r.json();
    if (j.error && j.error.length) throw new Error("kraken " + j.error[0]);
    const t = now();
    lastOk = t;
    st.polls++;
    for (const x of f) {
      const k = j.result[x.alt] || j.result[x.pair];
      if (!k) continue;
      const fp = [k.a, k.b, k.c, k.v && k.v[0], k.t && k.t[0]].join("|");
      if (fp !== x.fp) { x.fp = fp; x.chg = t; }
      x.ask = +k.a[0]; x.bid = +k.b[0]; x.at = t;
      // A ticker that has not changed at all for a minute is a closed market: never label it fresh.
      const closed = t - x.chg > P.staleFeedMs;
      if (closed !== x.closed) { x.closed = closed; inc(st.closed, x.k); if (S.run.started) anomaly(closed ? "feedClosed" : "feedReopened", x.k); }
    }
    if (S.dep && S.dep.addr && S.dep.addr.pub) {
      const pt = Math.floor(chainNow());
      for (const x of f) if (usable(x) && x.bid > 0 && (!x.L || x.L.pt < pt)) await sign(x, pt);
    }
    for (const m of S.mk || []) {
      const v = midf(m);
      if (v) { const h = hist[m.sym] || (hist[m.sym] = []); h.push(v); if (h.length > 1500) h.splice(0, 300); }
    }
    if (t - lastSave > 15000) persist();
  }

  /** Price history tail and each ticker's last-change time survive a reload (a shut market must stay shut). */
  function persist() {
    lastSave = now();
    const o = {};
    for (const k in hist) o[k] = hist[k].slice(-300);
    store.set("px", o);
    store.set("pf", f.map((x) => [x.fp, x.chg]));
  }

  /** Float mid of a market from the raw quotes (history only). */
  function midf(m) {
    if (m.sp) return m.sp;
    const a = f[m.f];
    if (!usable(a) || !a.bid) return 0;
    let v = (a.bid + a.ask) / 2;
    if (m.q >= 0) { const b = f[m.q]; if (!usable(b) || !b.bid) return 0; v /= (b.bid + b.ask) / 2; }
    return m.inv ? 1 / v : v;
  }

  /** Engine-view price of a market from the latest signed updates: same arithmetic as PythOracle.peek. */
  function price(m) {
    if (m.spx) return { mid: m.spx, bid: m.spx, ask: m.spx, pt: Math.floor(chainNow()), settled: true };
    const a = f[m.f].L;
    if (!a || !usable(f[m.f])) return null;
    let { mid, bid, ask, pt } = a;
    if (m.q >= 0) {
      const b = f[m.q].L;
      if (!b || !usable(f[m.q])) return null;
      bid = (bid * E18) / b.ask;
      ask = (ask * E18 + b.bid - 1n) / b.bid;
      mid = (mid * E18) / b.mid;
      if (b.pt < pt) pt = b.pt;
    }
    if (m.inv) {
      const one = E18 * E18;
      const nb = one / ask;
      ask = (one + bid - 1n) / bid;
      bid = nb;
      mid = one / mid;
    }
    return { mid, bid, ask, pt };
  }
  /** Same, from the prices currently stored on-chain (what a transaction without an update would see). */
  function onchain(m) {
    const a = f[m.f].oc;
    if (!a.pt) return null;
    const keep = [f[m.f].L, m.q >= 0 ? f[m.q].L : null];
    f[m.f].L = a.L;
    let r = null;
    if (m.q >= 0) { if (f[m.q].oc.pt) { f[m.q].L = f[m.q].oc.L; r = price(m); } } else r = price(m);
    f[m.f].L = keep[0];
    if (m.q >= 0) f[m.q].L = keep[1];
    return r;
  }

  /** Freshest signed updates for a market's feed(s), re-stamped to the current second. Null if a feed is shut. */
  async function fresh(m) {
    const ids = m.q >= 0 ? [m.f, m.q] : [m.f];
    const pt = Math.floor(chainNow());
    const out = [];
    for (const i of ids) {
      const x = f[i];
      if (!usable(x) || !x.bid) return null;
      if (!x.L || x.L.pt < pt) await sign(x, pt);
      out.push(x.L);
    }
    return out;
  }
  /** Called when a transaction carrying updates was included: tracks what the oracle now stores. */
  function note(upd) {
    for (const L of upd) {
      const x = f[L.i];
      if (L.pt > x.oc.pt) {
        if (x.oc.pt && S.run.started) { const gap = L.pt - x.oc.pt; if (gap > st.maxGap) st.maxGap = gap; }
        x.oc = { pt: L.pt, m: L.m, L };
      }
    }
  }

  async function maybePush(force) {
    if (pushing || (!S.pushOn && !force)) return;
    const hb = P.heartbeatMs / 1000, gap = P.minGapMs / 1000;
    const due = [], rest = [];
    for (const x of f) {
      const L = x.L;
      if (!L || !usable(x) || L.pt <= x.oc.pt) continue;
      const age = L.pt - x.oc.pt;
      const moved = x.oc.pt ? Math.abs(L.m / x.oc.m - 1) * 1e4 : 1e9;
      if (force || age >= hb || (moved > P.moveBps && age >= gap)) due.push(L);
      else if (L.price !== x.oc.L.price && age >= hb / 2) rest.push(L);
    }
    if (!due.length) return;
    if (!force && now() - lastPush < P.minGapMs) return;
    const upd = due.concat(rest);
    pushing = true;
    lastPush = now();
    try {
      const from = S.fundSt && S.fundSt.pub ? acct("publisher") : acct("deployer");
      await send(from, S.dep.addr.pub, "updatePriceFeeds", [upd.map((u) => u.upd)], { kind: "push", gk: "push" + upd.length, cache: true, upd, pipe: true });
      st.pushes++;
      st.feeds += upd.length;
    } catch (e) { inc(st.err, e.rev || "send"); } finally { pushing = false; }
  }

  async function tick() {
    if (polling) return;
    polling = true;
    try {
      await pollOnce();
      streak = 0;
    } catch (e) {
      streak++;
      st.pollErr++;
      st.lastErr = String(e.message || e).slice(0, 80);
      await sleep(Math.min(30000, P.pollMs * 2 ** streak));
    } finally { polling = false; }
    maybePush();
  }
  const saved = store.get("px"), pf = store.get("pf");
  if (saved) for (const k in saved) hist[k] = saved[k];
  if (pf) f.forEach((x, i) => { if (pf[i]) { x.fp = pf[i][0]; x.chg = pf[i][1]; } });
  return { f, hist, persist, tick, pollOnce, price, onchain, fresh, note, maybePush, midf, lastOk: () => lastOk };
}
