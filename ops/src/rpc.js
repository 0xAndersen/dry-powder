// JSON-RPC over fetch: micro-batching, global concurrency limit, exponential backoff, error accounting.
import { S, sleep, inc } from "./core.js";

export class RpcErr extends Error {
  constructor(msg, code, data) { super(msg); this.code = code; this.data = data; this.rpc = true; }
}
export const rs = { req: 0, http: 0, batches: 0, retries: 0, err: {}, fail: 0 };
let active = 0, id = 1, pending = [], timer = false, noBatch = false;
const waitq = [];
const acquire = () => (active < S.cfg.rpc.concurrency ? (active++, Promise.resolve()) : new Promise((r) => waitq.push(r)));
const release = () => { const n = waitq.shift(); if (n) n(); else active--; };

async function post(body) {
  const o = S.cfg.rpc;
  for (let attempt = 0; ; attempt++) {
    await acquire();
    let res, kind;
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), o.timeoutMs);
      rs.http++;
      const r = await fetch(S.cfg.rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal });
      clearTimeout(to);
      if (r.status === 429) kind = "http429";
      else if (r.status >= 500) kind = "http5xx";
      else if (!r.ok) kind = "http" + r.status;
      else res = await r.json();
    } catch (e) {
      kind = e && e.name === "AbortError" ? "timeout" : "network";
    } finally { release(); }
    if (res !== undefined) return res;
    inc(rs.err, kind);
    if (attempt >= o.retries) { rs.fail++; throw new RpcErr("rpc transport: " + kind, kind); }
    rs.retries++;
    await sleep(Math.min(8000, 200 * 2 ** attempt) * (0.5 + Math.random()));
  }
}

const limited = (e) => e && (e.code === -32005 || e.code === 429 || /rate.?limit|too many|capacity|busy/i.test(e.message || ""));

async function single(c) {
  for (let attempt = 0; ; attempt++) {
    let j;
    try { j = await post({ jsonrpc: "2.0", id: id++, method: c.m, params: c.p }); } catch (e) { return c.rej(e); }
    if (j && j.error) {
      if (limited(j.error) && attempt < 5) { inc(rs.err, "rateLimited"); rs.retries++; await sleep(300 * 2 ** attempt * (0.5 + Math.random())); continue; }
      return c.rej(new RpcErr(j.error.message || "rpc error", j.error.code, j.error.data));
    }
    return c.res(j ? j.result : null);
  }
}

async function flush() {
  const calls = pending;
  pending = [];
  if (!calls.length) return;
  if (calls.length === 1 || noBatch) { calls.forEach(single); return; }
  rs.batches++;
  const base = id;
  id += calls.length;
  let arr;
  try {
    arr = await post(calls.map((c, i) => ({ jsonrpc: "2.0", id: base + i, method: c.m, params: c.p })));
  } catch (e) { calls.forEach((c) => c.rej(e)); return; }
  if (!Array.isArray(arr)) {
    // Endpoint does not do batches (or refused this one): fall back to single requests from now on.
    if (!(arr && arr.error && limited(arr.error))) noBatch = true;
    inc(rs.err, "batchRefused");
    calls.forEach(single);
    return;
  }
  const by = new Map(arr.map((r) => [r.id, r]));
  calls.forEach((c, i) => {
    const r = by.get(base + i);
    if (!r) return single(c);
    if (r.error) { if (limited(r.error)) { inc(rs.err, "rateLimited"); return single(c); } return c.rej(new RpcErr(r.error.message || "rpc error", r.error.code, r.error.data)); }
    c.res(r.result);
  });
}

/** One JSON-RPC call. Calls made within a few ms of each other travel in one HTTP request. */
export function rpc(m, p = []) {
  rs.req++;
  return new Promise((res, rej) => {
    pending.push({ m, p, res, rej });
    if (pending.length >= S.cfg.rpc.batchMax) flush();
    else if (!timer) { timer = true; sleep(S.cfg.rpc.batchWaitMs).then(() => { timer = false; flush(); }); }
  });
}
export const rpcInfo = () => ({ ...rs, noBatch });
