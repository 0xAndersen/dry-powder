// Shared state, persistence, timers, small helpers.
export const S = { version: "1.0.0", jobs: {}, loops: [] };
const LS = "arcops:";

export const store = {
  get(k) { try { const s = localStorage.getItem(LS + k); return s ? JSON.parse(s) : null; } catch (e) { return null; } },
  set(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v, (_, x) => (typeof x === "bigint" ? undefined : x))); } catch (e) { S.lsErr = (S.lsErr || 0) + 1; } },
  clear() {
    try {
      const ks = [];
      for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k.startsWith(LS)) ks.push(k); }
      ks.forEach((k) => localStorage.removeItem(k));
    } catch (e) { /* storage unavailable */ }
  },
};

// Timers through a Worker when possible: background tabs throttle main-thread timers to 1/s or worse.
let worker, wid = 0;
const waiting = new Map();
try {
  const src = "onmessage=e=>setTimeout(()=>postMessage(e.data[0]),e.data[1])";
  worker = new Worker(URL.createObjectURL(new Blob([src], { type: "text/javascript" })));
  worker.onmessage = (e) => { const r = waiting.get(e.data); if (r) { waiting.delete(e.data); r(); } };
  worker.onerror = () => { worker = null; for (const r of waiting.values()) r(); waiting.clear(); };
} catch (e) { worker = null; }
export const sleep = (ms) => new Promise((r) => {
  if (worker) { const id = ++wid; waiting.set(id, r); worker.postMessage([id, ms]); } else setTimeout(r, ms);
});
export const timerKind = () => (worker ? "worker" : "main");

export const now = () => Date.now();
/** Estimated chain clock in seconds (local clock corrected by the offset seen in block timestamps). */
export const chainNow = () => Date.now() / 1000 + (S.clockOff || 0);
export const GWEI = 1000000000n;
export const E18 = 10n ** 18n;
export const MAXU = 2n ** 256n - 1n;
export const hex = (n) => "0x" + BigInt(n).toString(16);
export const lc = (s) => s.toLowerCase();
export const U = (n) => Number(n) / 1e6; // micro collateral units -> units
export const r2 = (x) => Math.round(x * 100) / 100;
export const r4 = (x) => Math.round(x * 1e4) / 1e4;
export const fpx = (b) => Number(b) / 1e18;
/** bigint * float factor with 1e-9 resolution. */
export const mulf = (b, f) => (b * BigInt(Math.round(f * 1e9))) / 1000000000n;

export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
export function quant(arr, q) {
  if (!arr.length) return 0;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor(q * s.length))];
}
/** Bounded sample (reservoir) so latency distributions stay small in storage. */
export function sample(arr, v, cap, n) {
  if (arr.length < cap) arr.push(v);
  else { const j = Math.floor(Math.random() * n); if (j < cap) arr[j] = v; }
}
export const inc = (o, k, n = 1) => { o[k] = (o[k] || 0) + n; };

/** Records something that looks like a protocol / UX problem; aggregated by kind. */
export function anomaly(kind, detail) {
  const A = S.run.anom;
  const a = A[kind] || (A[kind] = { n: 0, t: Math.round((now() - S.run.t0) / 1000) });
  a.n++;
  if (detail) a.s = String(detail).slice(0, 110);
  a.l = Math.round((now() - S.run.t0) / 1000);
}

/** Starts fn(name) once; a second call while it runs just waits. Returns the result or a progress stub. */
export async function job(name, fn, waitMs = 25000) {
  let j = S.jobs[name];
  if (!j || j.st !== "run") {
    j = S.jobs[name] = { st: "run", step: "start", t: now() };
    j.p = fn(j).then((r) => { j.st = "done"; j.res = r; return r; }, (e) => { j.st = "error"; j.err = String(e && e.message || e).slice(0, 300); });
  }
  await Promise.race([j.p, sleep(waitMs)]);
  if (j.st === "done") return j.res;
  if (j.st === "error") return { error: j.err, step: j.step };
  return { pending: true, job: name, step: j.step, elapsedS: Math.round((now() - j.t) / 1000) };
}

/** Runs fn forever at the given cadence until S.stopFlag[name]; a failure never stops the loop. */
export function loop(name, ms, fn, group = "run") {
  const tok = { on: true, group, name };
  S.loops.push(tok);
  (async () => {
    while (tok.on) {
      const t = now();
      try { await fn(); } catch (e) { inc(S.run.loopErr, name); S.lastErr = name + ": " + String(e && e.message || e).slice(0, 160); }
      const d = (typeof ms === "function" ? ms() : ms) - (now() - t);
      await sleep(Math.max(20, d));
    }
  })();
  return tok;
}
export function stopLoops(group) {
  S.loops = S.loops.filter((t) => { if (!group || t.group === group) { t.on = false; return false; } return true; });
}
