// ABI helpers, deterministic accounts, nonce-managed transaction sending, receipts, head poller, revert decoding.
import { S, sleep, now, hex, lc, GWEI, inc, sample, anomaly } from "./core.js";
import { rpc, RpcErr } from "./rpc.js";
import { ABI_TEXT, ERRORS, CTORS, BC } from "./gen.js";

export class Rev extends Error {
  constructor(name, onchain) { super("revert " + name); this.rev = name; this.onchain = !!onchain; }
}
export const MC3 = "0xcA11bde05977b3631167028862bE2a173976CA11";
let V, ABI, errBySel, evByTopic;

export function setup(viem, accounts) {
  V = S.V = viem;
  S.VA = accounts;
  ABI = V.parseAbi(ABI_TEXT);
  errBySel = {};
  for (const sig of ERRORS) errBySel[V.keccak256(V.toHex(sig)).slice(0, 10)] = sig.slice(0, sig.indexOf("("));
  evByTopic = {};
  for (const it of ABI) if (it.type === "event") evByTopic[V.toEventSelector(it)] = it;
}
export const enc = (fn, args) => V.encodeFunctionData({ abi: ABI, functionName: fn, args });
export const dec = (fn, data) => V.decodeFunctionResult({ abi: ABI, functionName: fn, data });
export async function call(to, fn, args = [], tag = "latest") {
  const data = await rpc("eth_call", [{ to, data: enc(fn, args) }, tag]);
  return dec(fn, data);
}
export function decodeLog(l) {
  const it = evByTopic[l.topics[0]];
  if (!it) return null;
  try { return { name: it.name, args: V.decodeEventLog({ abi: [it], data: l.data, topics: l.topics }).args }; } catch (e) { return null; }
}
export function initCode(name, args) {
  const [o, n] = BC[name];
  const code = V.toHex(window.__arcBlob.subarray(o, o + n));
  return args && args.length ? V.concat([code, V.encodeAbiParameters(CTORS[name].map((type) => ({ type })), args)]) : code;
}

// ───────────── accounts ─────────────
let accts = {};
export const resetAccts = () => { accts = {}; };
export function acct(role, i = 0) {
  const k = role + i;
  if (accts[k]) return accts[k];
  const pk = role === "deployer" ? S.cfg.deployerKey : V.keccak256(V.toHex(S.cfg.seed + "/" + role + "/" + i));
  const a = S.VA.privateKeyToAccount(pk);
  return (accts[k] = { a, addr: a.address, role, i, nonce: null, lock: Promise.resolve(), spent: 0, txs: 0 });
}

// ───────────── revert decoding ─────────────
function errData(e) {
  let d = e && e.data;
  if (d && typeof d === "object") d = d.data || (d.originalError && d.originalError.data) || d.result;
  if (typeof d === "string" && /^0x[0-9a-fA-F]*$/.test(d)) return d;
  const m = /0x[0-9a-fA-F]{8,}/.exec((e && e.message) || "");
  return m ? m[0] : null;
}
export function revertName(e) {
  if (e instanceof Rev) return e.rev;
  const d = errData(e);
  if (d && d.length >= 10) {
    const n = errBySel[d.slice(0, 10).toLowerCase()];
    if (n === "Error") { try { return "Error:" + V.decodeAbiParameters([{ type: "string" }], "0x" + d.slice(10))[0].slice(0, 40); } catch (x) { return "Error"; } }
    if (n === "Panic") return "Panic(0x" + BigInt("0x" + d.slice(10)).toString(16) + ")";
    return n || "Unknown:" + d.slice(0, 10);
  }
  const msg = (e && e.message) || "";
  if (/insufficient funds|insufficient balance|exceeds balance|out of funds/i.test(msg)) return "InsufficientFunds";
  if (/revert/i.test(msg)) return "Revert";
  if (/out of gas|gas required exceeds/i.test(msg)) return "OutOfGas";
  return null;
}

// ───────────── head poller / fees ─────────────
const offs = [];
export async function pollHead() {
  const b = await rpc("eth_getBlockByNumber", ["latest", false]);
  if (!b) return;
  const ts = Number(b.timestamp);
  S.head = { n: Number(b.number), ts, base: b.baseFeePerGas ? BigInt(b.baseFeePerGas) : 0n, at: now() };
  offs.push(ts - Date.now() / 1000);
  if (offs.length > 40) offs.shift();
  // Block timestamps lag the chain's clock by up to a block; the largest recent difference is the offset.
  S.clockOff = Math.max(...offs);
}
export const MIN_FEE = 20n * GWEI;
export function fees() {
  const tip = S.tip;
  const base = S.head ? S.head.base : 0n;
  const dbl = base * 2n;
  return { maxFeePerGas: (dbl > MIN_FEE ? dbl : MIN_FEE) + tip, maxPriorityFeePerGas: tip };
}
/** Price a transaction is expected to pay per gas right now (wei): max(base, 20 gwei floor) + tip. */
export const gasPriceNow = () => { const b = S.head ? S.head.base : 0n; return (b > MIN_FEE ? b : MIN_FEE) + S.tip; };

// ───────────── receipts ─────────────
const rc = new Map();
export async function pollReceipts() {
  if (!rc.size) return;
  const hs = [...rc.keys()];
  await Promise.all(hs.map(async (h) => {
    try {
      const r = await rpc("eth_getTransactionReceipt", [h]);
      if (r && r.blockNumber) { const w = rc.get(h); if (w) { rc.delete(h); w.res(r); } }
    } catch (e) { /* next round */ }
  }));
  const t = now();
  for (const [h, w] of rc) if (t > w.until) { rc.delete(h); w.res(null); }
}
const waitReceipt = (hash, ms) => new Promise((res) => rc.set(hash, { res, until: now() + ms }));

// ───────────── sending ─────────────
const callObj = (from, to, data, value) => { const o = { from, data, value: hex(value) }; if (to) o.to = to; return o; };
function gstat(kind, used) {
  const g = S.run.gas[kind] || (S.run.gas[kind] = [0, 0, 0]);
  g[0]++; g[1] += used; if (used > g[2]) g[2] = used;
}
/**
 * Sends one transaction from `ac` and waits for inclusion.
 * o: { value, kind (stat bucket), gk (gas-cache key), cache (allow cached gas), t0 (decision time), upd (oracle
 *      updates carried, noted on success), pipe (do not hold the account while waiting), data, gas }
 */
export async function send(ac, to, fn, args, o = {}) {
  const data = fn ? enc(fn, args) : o.data || "0x";
  const value = o.value || 0n;
  const kind = o.kind || fn || "transfer";
  const gk = o.gk || kind;
  const t0 = o.t0 || now();
  let release;
  const prev = ac.lock;
  ac.lock = new Promise((r) => (release = r));
  await prev;
  let hash, raw, gas;
  try {
    for (let attempt = 0; ; attempt++) {
      if (ac.nonce == null) ac.nonce = Number(await rpc("eth_getTransactionCount", [ac.addr, "pending"]));
      gas = o.gas;
      if (!gas) {
        const c = S.gasCache[gk];
        if (o.cache && S.cfg.gasCache && c && c[0] >= 8) gas = BigInt(Math.ceil(c[1] * 1.6));
        else {
          let est;
          try { est = Number(await rpc("eth_estimateGas", [callObj(ac.addr, to, data, value)])); } catch (e) {
            const n = e.rpc ? revertName(e) : null;
            if (n) throw new Rev(n);
            throw e;
          }
          const cc = S.gasCache[gk] || (S.gasCache[gk] = [0, 0]);
          cc[0]++; if (est > cc[1]) cc[1] = est;
          gas = BigInt(Math.ceil(est * 1.25));
        }
      }
      const tx = { chainId: S.cfg.chainId, type: "eip1559", nonce: ac.nonce, data, value, gas, ...fees() };
      if (to) tx.to = to;
      raw = await ac.a.signTransaction(tx);
      try { hash = await rpc("eth_sendRawTransaction", [raw]); } catch (e) {
        const msg = (e && e.message) || "";
        if (/already known|already imported|known transaction/i.test(msg)) { hash = S.V.keccak256(raw); }
        else if (e.rpc && /nonce|replacement|underpriced/i.test(msg) && attempt < 3) { inc(S.run.txErr, "nonce"); ac.nonce = null; await sleep(300 * (attempt + 1)); continue; }
        else if (e.rpc && /insufficient funds|exceeds balance/i.test(msg)) { ac.low = now(); throw new Rev("InsufficientFunds"); }
        else throw e;
      }
      ac.nonce++;
      break;
    }
  } catch (e) { release(); throw e; }
  if (o.pipe) release();
  let r;
  try {
    r = await waitReceipt(hash, S.cfg.txTimeoutMs);
    if (!r) {
      inc(S.run.txErr, "slow");
      try { await rpc("eth_sendRawTransaction", [raw]); } catch (e) { /* likely already known */ }
      r = await waitReceipt(hash, S.cfg.txTimeoutMs);
    }
    if (!r) { ac.nonce = null; inc(S.run.txErr, "timeout"); anomaly("txNotIncluded", kind + " " + hash); throw new Error("tx not included: " + hash); }
  } finally { if (!o.pipe) release(); }
  const used = Number(r.gasUsed);
  const price = Number(BigInt(r.effectiveGasPrice || "0x0")) / 1e9;
  gstat(kind, used);
  ac.spent += used * price;
  ac.txs++;
  S.run.gasUsed += used;
  S.run.gasGwei += used * price;
  S.run.txs++;
  const lat = now() - t0;
  sample(S.run.lat, lat, 400, S.run.txs);
  r.lat = lat;
  if (r.status !== "0x1") {
    inc(S.run.txErr, "revertedOnChain");
    let name = used >= Number(gas) * 0.98 ? "OutOfGas" : "UnknownRevert";
    try { await rpc("eth_call", [callObj(ac.addr, to, data, value), r.blockNumber]); } catch (e) { name = (e.rpc && revertName(e)) || name; }
    if (name === "OutOfGas") delete S.gasCache[gk];
    const err = new Rev(name, true);
    err.gasG = used * price;
    throw err;
  }
  if (o.upd && S.pub) S.pub.note(o.upd);
  return r;
}
export const bal = async (addr) => BigInt(await rpc("eth_getBalance", [addr, "latest"]));
export const hasCode = async (addr) => { const c = await rpc("eth_getCode", [addr, "latest"]); return !!c && c !== "0x"; };
export { lc };
