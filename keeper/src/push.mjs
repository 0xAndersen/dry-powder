#!/usr/bin/env node
// Web Push (roadmap 50): notifications while the app is closed. Browsers subscribe through the app's Settings; this
// relay watches the subscribed accounts and sends, through each browser's push service:
//   liquidation warnings  the app's rule: half, then three quarters, of the buffer a position started with is gone;
//   fills                 opens and additions, from market, limit, stop-entry and TWAP orders alike;
//   closes                full and partial closes, take-profits and stop-losses, and liquidations.
//
//   node src/push.mjs keys   prints a new VAPID key pair as VAPID_PUBLIC_KEY=… and VAPID_PRIVATE_KEY=… lines.
//                            The private key signs every push: keep it in the host's secret store, never in git.
//   node src/push.mjs        runs the relay: the subscription API on PORT and the watcher.
//
// API (CORS for ALLOWED_ORIGINS):
//   GET    /vapid           { publicKey }: the applicationServerKey the app subscribes with.
//   POST   /subscriptions   { subscription: PushSubscription.toJSON(), accounts: [address…], topics: ["liquidation",
//                          "fill", "close"], liqWarn: "half" | "quarter" | "off" } → 201 { ok, created }. Posting
//                          the same endpoint again replaces its accounts and topics.
//   DELETE /subscriptions   { endpoint } → { ok, removed }.
//   GET    /health          subscriptions, accounts, pushes sent and failed, the watcher's cursor.
// A push service that answers 404 or 410 has dropped the subscription: it is removed here too.
//
// Environment: VAPID_PUBLIC_KEY, VAPID_PRIVATE_KEY (base64url, from `keys`), VAPID_SUBJECT (a mailto: or https:
// contact the push services can reach, required), DEPLOYMENT, RPC_URL / RPC_URLS, CHAIN_ID, PORT (8092), HOST,
// STORE_FILE (push-subscriptions.json), ALLOWED_ORIGINS (comma list of app origins; default *), POLL_SECONDS (15),
// MAX_SUBSCRIPTIONS (5000), MAX_ACCOUNTS (4 per subscription), PUSH_HOSTS (push services allowed as endpoints;
// default: Google, Mozilla, Apple and Microsoft's), TRUST_PROXY (1: rate-limit by X-Forwarded-For).
import { createCipheriv, createECDH, createHash, createPrivateKey, createPublicKey, generateKeyPairSync, hkdfSync, randomBytes, sign, verify } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeFunctionResult, encodeFunctionData, getAddress, isAddress } from "viem";
import { engineLensAbi } from "./abi.mjs";
import { makeRpc } from "./indexer.mjs";
import { chainSettings, contractsOf, createFollower, decodeContext, rpcSource } from "./relay.mjs";

export const TOPICS = ["liquidation", "fill", "close"];
export const LIQ_WARN = ["half", "quarter", "off"];

const b64u = {
  encode: (buf) => Buffer.from(buf).toString("base64url"),
  decode: (text) => Buffer.from(String(text), "base64url"),
};

// ─────────────────────────────── VAPID (RFC 8292) ───────────────────────────────

/** A new P-256 key pair: the public key as an uncompressed point and the private scalar, both base64url. */
export function generateVapidKeys() {
  const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const jwk = privateKey.export({ format: "jwk" });
  const pub = Buffer.concat([Buffer.from([4]), b64u.decode(jwk.x), b64u.decode(jwk.y)]);
  return { publicKey: b64u.encode(pub), privateKey: jwk.d };
}

/** Checks a VAPID key pair (the private key must belong to the public one) and returns what signing needs. */
export function loadVapid({ publicKey, privateKey, subject }) {
  const pub = b64u.decode(publicKey ?? "");
  if (pub.length !== 65 || pub[0] !== 4) throw new Error("VAPID_PUBLIC_KEY is not an uncompressed P-256 public key (65 bytes, base64url): run `node src/push.mjs keys`");
  const d = b64u.decode(privateKey ?? "");
  if (d.length !== 32) throw new Error("VAPID_PRIVATE_KEY is not a P-256 private key (32 bytes, base64url)");
  if (!/^(mailto:|https:\/\/)/.test(subject ?? "")) throw new Error("VAPID_SUBJECT must be a mailto: address or an https: URL (push services contact it about problems)");
  const x = b64u.encode(pub.subarray(1, 33));
  const y = b64u.encode(pub.subarray(33));
  const key = createPrivateKey({ key: { kty: "EC", crv: "P-256", x, y, d: b64u.encode(d) }, format: "jwk" });
  const check = Buffer.from("vapid key check");
  const sig = sign("sha256", check, { key, dsaEncoding: "ieee-p1363" });
  if (!verify("sha256", check, { key: createPublicKey({ key: { kty: "EC", crv: "P-256", x, y }, format: "jwk" }), dsaEncoding: "ieee-p1363" }, sig)) {
    throw new Error("VAPID_PRIVATE_KEY does not belong to VAPID_PUBLIC_KEY");
  }
  return { key, publicKey: b64u.encode(pub), subject };
}

/** The Authorization header for one push: a JWT for the push service's origin, signed ES256. */
export function vapidAuthorization(endpoint, vapid, { now = Date.now(), validSeconds = 12 * 3600 } = {}) {
  const header = b64u.encode(JSON.stringify({ typ: "JWT", alg: "ES256" }));
  const claims = b64u.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(now / 1000) + validSeconds, sub: vapid.subject }));
  const input = `${header}.${claims}`;
  const signature = sign("sha256", Buffer.from(input), { key: vapid.key, dsaEncoding: "ieee-p1363" });
  return `vapid t=${input}.${b64u.encode(signature)}, k=${vapid.publicKey}`;
}

// ─────────────────────────────── Payload encryption (RFC 8291, aes128gcm) ───────────────────────────────

/**
 * Encrypts `payload` for one subscription's keys (p256dh, auth: base64url) as a single aes128gcm record: the body a
 * push service forwards and only that browser can read. `salt` and `serverPrivateKey` are for test vectors only.
 */
export function encryptPayload(payload, keys, { salt = randomBytes(16), serverPrivateKey = null, recordSize = 4096 } = {}) {
  const uaPublic = b64u.decode(keys?.p256dh ?? "");
  const authSecret = b64u.decode(keys?.auth ?? "");
  if (uaPublic.length !== 65 || uaPublic[0] !== 4) throw new Error("p256dh is not an uncompressed P-256 public key");
  if (authSecret.length !== 16) throw new Error("auth is not 16 bytes");
  const ecdh = createECDH("prime256v1");
  if (serverPrivateKey) ecdh.setPrivateKey(serverPrivateKey);
  else ecdh.generateKeys();
  const asPublic = ecdh.getPublicKey();
  const shared = ecdh.computeSecret(uaPublic);
  const ikm = Buffer.from(hkdfSync("sha256", shared, authSecret, Buffer.concat([Buffer.from("WebPush: info\0"), uaPublic, asPublic]), 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  // One record: the plaintext, then the 0x02 delimiter that marks the last record.
  const plain = Buffer.concat([Buffer.from(payload), Buffer.from([2])]);
  if (plain.length + 16 > recordSize) throw new Error(`payload too large (${plain.length - 1} bytes)`);
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const sealed = Buffer.concat([cipher.update(plain), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  Buffer.from(salt).copy(header, 0);
  header.writeUInt32BE(recordSize, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, sealed]);
}

/** A Topic header (at most 32 URL-safe characters): a newer push with the same topic replaces an undelivered one. */
export const pushTopic = (tag) => createHash("sha256").update(String(tag)).digest("base64url").slice(0, 32);

/** Sends one notification. `gone` means the push service no longer knows the subscription. */
export async function sendPush(subscription, message, vapid, { ttl = 3_600, urgency = "normal", topic = null, fetchImpl = fetch, timeoutMs = 10_000 } = {}) {
  const body = encryptPayload(JSON.stringify(message), subscription.keys);
  const headers = {
    "content-encoding": "aes128gcm",
    "content-type": "application/octet-stream",
    ttl: String(Math.max(0, Math.floor(ttl))),
    urgency,
    authorization: vapidAuthorization(subscription.endpoint, vapid),
  };
  if (topic) headers.topic = pushTopic(topic);
  const res = await fetchImpl(subscription.endpoint, { method: "POST", headers, body, signal: AbortSignal.timeout(timeoutMs) });
  await res.arrayBuffer().catch(() => null);
  return { status: res.status, ok: res.status >= 200 && res.status < 300, gone: res.status === 404 || res.status === 410 };
}

// ─────────────────────────────── Subscriptions ───────────────────────────────

export const DEFAULT_PUSH_HOSTS = ["fcm.googleapis.com", "updates.push.services.mozilla.com", "*.push.services.mozilla.com", "web.push.apple.com", "*.push.apple.com", "*.notify.windows.com"];

export class InputError extends Error {}

const hostAllowed = (host, allowed) => allowed.some((h) => (h.startsWith("*.") ? host.endsWith(h.slice(1)) && host.length > h.length - 1 : host === h));

/**
 * Checks a POST /subscriptions body. Endpoints must be https on a known push service (the relay POSTs to them, so
 * an arbitrary URL would let anyone aim it at other hosts); `allowLocal` admits http://127.0.0.1 for tests.
 */
export function validateSubscription(body, { pushHosts = DEFAULT_PUSH_HOSTS, maxAccounts = 4, allowLocal = false } = {}) {
  const sub = body?.subscription;
  const endpoint = typeof sub?.endpoint === "string" ? sub.endpoint : "";
  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new InputError("subscription.endpoint is not a URL");
  }
  if (endpoint.length > 1_024) throw new InputError("subscription.endpoint is too long");
  const local = allowLocal && url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost");
  if (!local && (url.protocol !== "https:" || !hostAllowed(url.hostname, pushHosts))) throw new InputError(`not a known push service: ${url.hostname}`);
  const p256dh = String(sub?.keys?.p256dh ?? "");
  const auth = String(sub?.keys?.auth ?? "");
  const pub = b64u.decode(p256dh);
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(p256dh) || pub.length !== 65 || pub[0] !== 4) throw new InputError("subscription.keys.p256dh is not a P-256 public key");
  if (!/^[A-Za-z0-9_-]+={0,2}$/.test(auth) || b64u.decode(auth).length !== 16) throw new InputError("subscription.keys.auth is not 16 bytes");
  const accounts = Array.isArray(body?.accounts) ? body.accounts : [];
  if (accounts.length === 0 || accounts.length > maxAccounts) throw new InputError(`accounts: 1 to ${maxAccounts} addresses`);
  for (const a of accounts) if (typeof a !== "string" || !isAddress(a, { strict: false })) throw new InputError(`not an address: ${String(a).slice(0, 60)}`);
  const topics = body?.topics === undefined ? [...TOPICS] : Array.isArray(body.topics) ? body.topics : null;
  if (!topics || topics.length === 0 || topics.some((t) => !TOPICS.includes(t))) throw new InputError(`topics: some of ${TOPICS.join(", ")}`);
  const liqWarn = body?.liqWarn === undefined ? "half" : body.liqWarn;
  if (!LIQ_WARN.includes(liqWarn)) throw new InputError(`liqWarn: ${LIQ_WARN.join(", ")}`);
  return {
    endpoint,
    keys: { p256dh, auth },
    accounts: [...new Set(accounts.map((a) => a.toLowerCase()))],
    topics: [...new Set(topics)],
    liqWarn,
  };
}

export class StoreFull extends Error {}

/**
 * Subscriptions by endpoint, kept in a JSON file (written atomically, a moment after each change). `file` null keeps
 * them in memory.
 */
export function createStore(file, { maxSubscriptions = 5_000, delayMs = 200 } = {}) {
  const subs = new Map();
  if (file && existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, "utf8"));
    for (const s of saved.subscriptions ?? []) if (s?.endpoint && s?.keys) subs.set(s.endpoint, s);
  }
  let timer = null;
  const flush = () => {
    clearTimeout(timer);
    timer = null;
    if (!file) return;
    const tmp = `${file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ schema: 1, subscriptions: [...subs.values()] }));
    renameSync(tmp, file);
  };
  const later = () => {
    if (!file || timer) return;
    timer = setTimeout(flush, delayMs);
    timer.unref?.();
  };
  return {
    get size() {
      return subs.size;
    },
    list: () => [...subs.values()],
    get: (endpoint) => subs.get(endpoint) ?? null,
    upsert(record, now = Date.now()) {
      const old = subs.get(record.endpoint);
      if (!old && subs.size >= maxSubscriptions) throw new StoreFull("subscription limit reached");
      subs.set(record.endpoint, { ...record, createdAt: old?.createdAt ?? now, updatedAt: now, failures: 0 });
      later();
      return { created: !old };
    },
    remove(endpoint) {
      const had = subs.delete(endpoint);
      if (had) later();
      return had;
    },
    /** Counts a failed delivery; after `max` in a row the subscription is dropped. */
    failed(endpoint, max = 20) {
      const s = subs.get(endpoint);
      if (!s) return;
      s.failures = (s.failures ?? 0) + 1;
      if (s.failures >= max) subs.delete(endpoint);
      later();
    },
    delivered(endpoint) {
      const s = subs.get(endpoint);
      if (s && s.failures) {
        s.failures = 0;
        later();
      }
    },
    /** Subscriptions grouped by watched account (lower case). */
    byAccount() {
      const out = new Map();
      for (const s of subs.values()) for (const a of s.accounts) (out.get(a) ?? out.set(a, []).get(a)).push(s);
      return out;
    },
    flush,
  };
}

// ─────────────────────────────── Messages ───────────────────────────────

const E18 = 10n ** 18n;

/** An 18-decimal price for a phone screen: about six significant digits. */
export function fmtPrice(price) {
  const v = Number(BigInt(price)) / 1e18;
  if (!Number.isFinite(v) || v === 0) return "0";
  const dp = v >= 10_000 ? 1 : v >= 100 ? 2 : v >= 1 ? 4 : Math.min(10, 2 - Math.floor(Math.log10(v)) + 3);
  return v.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
}

/** A 6-decimal collateral amount, two decimals, optionally signed. */
export function fmtAmount(amount, sign = false) {
  const a = BigInt(amount);
  const cents = (a < 0n ? -a : a) / 10_000n;
  const text = `${(cents / 100n).toLocaleString("en-US")}.${String(cents % 100n).padStart(2, "0")}`;
  return a < 0n ? `−${text}` : sign && a > 0n ? `+${text}` : text;
}

/** Buffer left levels to warn at, as the app's Settings name them. */
export const WARN_LEVELS = { half: [0.5, 0.25], quarter: [0.25] };

/**
 * How much of a position's starting buffer is left at `mark` (a fraction: 1 untouched, 0 at liquidation), from its
 * EngineLens view. Null when it cannot be liquidated by price or there is no price.
 */
export function bufferLeft(view, mark) {
  const p = view.position;
  const liq = BigInt(view.liquidationPrice);
  if (mark === null || mark === undefined || BigInt(mark) <= 0n) return null;
  if (p.isLong ? liq === 0n || liq === 2n ** 256n - 1n : liq === 0n) return null;
  const entry = BigInt(p.entryPrice);
  const m = BigInt(mark);
  const initial = Number(entry > liq ? entry - liq : liq - entry) / Number(entry);
  if (!(initial > 0)) return null;
  const distance = Number(p.isLong ? m - liq : liq - m) / Number(m);
  return { left: Math.max(0, distance) / initial, distance, liquidationPrice: liq };
}

/**
 * The app's warning rule (frontend/src/components/risk-watcher.tsx): each level warns once as the buffer falls
 * through it, and re-arms once the buffer has clearly recovered. `state` maps a key to the last level warned.
 */
export function crossedLevel(state, key, left, levels) {
  const last = state.get(key) ?? Infinity;
  if (left > Math.min(1, last + 0.15)) state.delete(key);
  const crossed = levels.filter((level) => left <= level && level < (state.get(key) ?? Infinity));
  if (crossed.length === 0) return null;
  const level = Math.min(...crossed);
  state.set(key, level);
  return level;
}

const sideOf = (isLong) => (isLong === undefined || isLong === null ? "" : isLong ? " long" : " short");
const tradeUrl = (symbol) => (symbol ? `trade/?market=${encodeURIComponent(symbol)}` : "portfolio/");

export function warningMessage({ symbol, isLong, key, level, info }) {
  const share = level <= 0.25 ? "three quarters" : "half";
  return {
    topic: "liquidation",
    title: `${symbol ?? "Position"}${sideOf(isLong)}: ${share} of the buffer is gone`,
    body: `Liquidation at ${fmtPrice(info.liquidationPrice)}, ${(Math.max(0, info.distance) * 100).toFixed(2)}% away. Add margin, reduce or close.`,
    tag: `liq-${key}-${level}`,
    url: tradeUrl(symbol),
    urgency: "high",
    ttl: 600,
  };
}

/**
 * The notification for an engine event of a watched trader, or null for events that do not notify. `known` holds
 * what the watcher last saw of each position (side, margin), which some events do not carry.
 */
export function eventMessage(ev, { collateral = "USDC", known = new Map() } = {}) {
  const a = ev.args ?? {};
  const symbol = ev.symbol ?? "Position";
  const key = String(a.key ?? "").toLowerCase();
  const pos = known.get(key);
  const tag = `${ev.name}-${ev.id}`;
  switch (ev.name) {
    case "PositionOpened": {
      const lev = BigInt(a.margin) > 0n ? Number((BigInt(a.size) * 10n) / BigInt(a.margin)) / 10 : 0;
      return { topic: "fill", title: `${symbol}${sideOf(a.isLong)} opened`, body: `${fmtAmount(a.size)} ${collateral} at ${fmtPrice(a.entryPrice)}, ${lev >= 10 ? Math.round(lev) : lev}x.`, tag, url: tradeUrl(ev.symbol), urgency: "normal", ttl: 3_600 };
    }
    case "PositionIncreased":
      return { topic: "fill", title: `${symbol}${sideOf(a.isLong)} increased`, body: `+${fmtAmount(a.addedSize)} at ${fmtPrice(a.price)}; now ${fmtAmount(a.newSize)} ${collateral}.`, tag, url: tradeUrl(ev.symbol), urgency: "normal", ttl: 3_600 };
    case "PositionDecreased": {
      const net = BigInt(a.payout) - BigInt(a.releasedMargin);
      return { topic: "close", title: `${symbol}${sideOf(pos?.isLong)} reduced: ${fmtAmount(net, true)} ${collateral}`, body: `${fmtAmount(a.closedSize)} closed at ${fmtPrice(a.exitPrice)}.`, tag, url: tradeUrl(ev.symbol), urgency: "normal", ttl: 3_600 };
    }
    case "PositionClosed": {
      // Net of the close fee: what came back beyond the margin (the PnL less the fee when the margin is unknown).
      const net = pos ? BigInt(a.payout) - BigInt(pos.margin) : BigInt(a.pnl) - BigInt(a.fee);
      return { topic: "close", title: `${symbol}${sideOf(pos?.isLong)} closed: ${fmtAmount(net, true)} ${collateral}`, body: `Exit at ${fmtPrice(a.exitPrice)}.`, tag, url: "portfolio/", urgency: "normal", ttl: 3_600 };
    }
    case "PositionLiquidated":
      return { topic: "liquidation", title: `${symbol}${sideOf(pos?.isLong)} liquidated`, body: `At ${fmtPrice(a.price)}: the ${fmtAmount(a.margin)} ${collateral} margin is gone.`, tag, url: "portfolio/", urgency: "high", ttl: 86_400 };
    default:
      return null;
  }
}

/**
 * The watcher's delivery: one push per message (its routing fields stay out of the payload the browser sees). A
 * newer liquidation warning for a position replaces an undelivered older one. A subscription the push service has
 * forgotten is dropped; one that keeps failing is dropped after a while.
 */
export function pushDelivery(store, vapid, { fetchImpl = fetch } = {}) {
  return async (sub, msg) => {
    const { urgency, ttl, topic: _kind, ...payload } = msg;
    const topic = /^liq-/.test(msg.tag ?? "") ? msg.tag.replace(/-[\d.]+$/, "") : null;
    const r = await sendPush(sub, payload, vapid, { urgency, ttl, topic, fetchImpl });
    if (r.gone) store.remove(sub.endpoint);
    else if (r.ok) store.delivered(sub.endpoint);
    else store.failed(sub.endpoint);
    return r.ok;
  };
}

// ─────────────────────────────── Watcher ───────────────────────────────

/**
 * One pass per tick: read the watched accounts' positions and the prices, warn on buffer crossings, and turn the
 * engine's new events of watched accounts into notifications. `chain` gives { markets(), positions(account),
 * events() }; `deliver(subscription, message)` sends one.
 */
export function createWatcher({ chain, store, deliver, collateral = "USDC", concurrency = 8, log = () => {} }) {
  const warned = new Map();
  const known = new Map();
  const counters = { ticks: 0, warnings: 0, events: 0, sent: 0, failed: 0 };
  return {
    counters,
    async tick() {
      counters.ticks += 1;
      const byAccount = store.byAccount();
      const out = [];
      if (byAccount.size > 0) {
        const markets = await chain.markets();
        const accounts = [...byAccount.keys()];
        const views = await mapLimit(accounts, concurrency, (a) => chain.positions(a).catch((error) => (log(`positions of ${a}: ${error?.message ?? error}`), null)));
        accounts.forEach((account, i) => {
          if (!views[i]) return;
          const subs = byAccount.get(account);
          const live = new Set();
          for (const view of views[i]) {
            const key = view.key.toLowerCase();
            live.add(key);
            const market = markets.get(view.position.priceId.toLowerCase());
            known.set(key, { isLong: view.position.isLong, margin: view.position.margin, symbol: market?.symbol ?? null });
            const info = bufferLeft(view, market?.hasPrice ? market.mid : null);
            if (!info) continue;
            for (const sub of subs) {
              if (sub.liqWarn === "off" || !sub.topics.includes("liquidation")) continue;
              const level = crossedLevel(warned, `${sub.endpoint}|${key}`, info.left, WARN_LEVELS[sub.liqWarn]);
              if (level === null) continue;
              counters.warnings += 1;
              out.push([sub, warningMessage({ symbol: market?.symbol ?? null, isLong: view.position.isLong, key, level, info })]);
            }
          }
          // Positions that closed: their warnings re-arm for whatever opens next under the same key.
          for (const sub of subs) for (const k of [...warned.keys()]) if (k.startsWith(`${sub.endpoint}|`) && !live.has(k.slice(sub.endpoint.length + 1))) warned.delete(k);
        });
      }
      // What is known of positions only serves the next few events: keep it bounded.
      while (known.size > 20_000) known.delete(known.keys().next().value);
      const events = await chain.events();
      for (const ev of events) {
        const subs = ev.trader ? byAccount.get(ev.trader.toLowerCase()) : undefined;
        const msg = subs ? eventMessage(ev, { collateral, known }) : null;
        if (ev.name === "PositionOpened" || ev.name === "PositionIncreased") known.set(String(ev.args.key).toLowerCase(), { isLong: ev.args.isLong, margin: BigInt(ev.args.newMargin ?? ev.args.margin), symbol: ev.symbol });
        if (!msg) continue;
        counters.events += 1;
        for (const sub of subs) if (sub.topics.includes(msg.topic)) out.push([sub, msg]);
      }
      await mapLimit(out, concurrency, async ([sub, msg]) => {
        const ok = await deliver(sub, msg).catch((error) => (log(`push to ${new URL(sub.endpoint).host}: ${error?.message ?? error}`), false));
        if (ok) counters.sent += 1;
        else counters.failed += 1;
      });
      return out.length;
    },
  };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

/** The watcher's chain over JSON-RPC: EngineLens reads and the engine's events since the last call. */
export function rpcChain({ source, deployment, logRange = 2_000, log = () => {} }) {
  const ctx = decodeContext();
  const pending = [];
  const follower = createFollower({ source, contracts: contractsOf({ engine: deployment.engine }), ctx, logRange, log, onEvents: (e) => pending.push(...e) });
  const lens = deployment.lens;
  const call = async (functionName, args = []) => decodeFunctionResult({ abi: engineLensAbi, functionName, data: await source.call(lens, encodeFunctionData({ abi: engineLensAbi, functionName, args })) });
  return {
    get cursor() {
      return follower.cursor;
    },
    async markets() {
      const out = new Map();
      for (const m of await call("getMarkets")) {
        const id = m.id.toLowerCase();
        ctx.symbols.set(id, m.market.symbol);
        out.set(id, { symbol: m.market.symbol, hasPrice: m.hasPrice, mid: m.price.mid });
      }
      return out;
    },
    positions: (account) => call("getTraderPositions", [getAddress(account)]),
    async events() {
      if (follower.cursor === null) follower.startAfter(await source.head());
      await follower.tick();
      return pending.splice(0);
    },
  };
}

// ─────────────────────────────── API ───────────────────────────────

/**
 * The subscription API. `origins` lists the app origins allowed to call it from a browser ("*" for any).
 * Writes are rate-limited per client address.
 */
export function createPushApi({ store, vapidPublicKey, validate = (b) => validateSubscription(b), origins = ["*"], perMinute = 30, trustProxy = false, status = () => ({}) }) {
  const hits = new Map();
  const limited = (ip) => {
    const now = Date.now();
    const h = hits.get(ip);
    if (!h || now - h.start > 60_000) {
      hits.set(ip, { start: now, n: 1 });
      if (hits.size > 10_000) hits.delete(hits.keys().next().value);
      return false;
    }
    h.n += 1;
    return h.n > perMinute;
  };
  const corsFor = (origin) => {
    const any = origins.includes("*");
    const allowed = any || (origin && origins.includes(origin));
    const base = { "access-control-allow-methods": "GET, POST, DELETE, OPTIONS", "access-control-allow-headers": "content-type", "access-control-max-age": "600" };
    if (any) return { allowed: true, headers: { ...base, "access-control-allow-origin": "*" } };
    return { allowed: Boolean(allowed), headers: allowed ? { ...base, "access-control-allow-origin": origin, vary: "origin" } : { vary: "origin" } };
  };
  const readJson = (req) =>
    new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on("data", (c) => {
        size += c.length;
        if (size > 8_192) {
          reject(new InputError("body too large"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
        } catch {
          reject(new InputError("the body is not JSON"));
        }
      });
      req.on("error", reject);
    });

  return createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://push");
    const origin = req.headers.origin;
    const cors = corsFor(origin);
    const reply = (code, body) => {
      res.writeHead(code, { ...cors.headers, "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    };
    if (req.method === "OPTIONS") {
      res.writeHead(cors.allowed ? 204 : 403, cors.headers);
      return res.end();
    }
    if (origin && !cors.allowed) return reply(403, { error: "origin not allowed" });
    try {
      if (req.method === "GET" && url.pathname === "/vapid") return reply(200, { publicKey: vapidPublicKey });
      if (req.method === "GET" && url.pathname === "/health") return reply(200, { ok: true, subscriptions: store.size, accounts: store.byAccount().size, ...status() });
      if (url.pathname !== "/subscriptions") return reply(404, { error: "not found" });
      const ip = (trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "") || req.socket.remoteAddress || "?";
      if (req.method === "POST") {
        if (limited(ip)) return reply(429, { error: "too many requests" });
        const record = validate(await readJson(req));
        return reply(201, { ok: true, ...store.upsert(record) });
      }
      if (req.method === "DELETE") {
        if (limited(ip)) return reply(429, { error: "too many requests" });
        const body = await readJson(req);
        if (typeof body?.endpoint !== "string") throw new InputError("endpoint is required");
        return reply(200, { ok: true, removed: store.remove(body.endpoint) });
      }
      return reply(405, { error: "method not allowed" });
    } catch (error) {
      if (error instanceof InputError) return reply(400, { error: error.message });
      if (error instanceof StoreFull) return reply(503, { error: error.message });
      return reply(500, { error: "internal error" });
    }
  });
}

// ─────────────────────────────── Run ───────────────────────────────

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain && process.argv[2] === "keys") {
  const k = generateVapidKeys();
  console.log(`VAPID_PUBLIC_KEY=${k.publicKey}\nVAPID_PRIVATE_KEY=${k.privateKey}`);
} else if (isMain) {
  const env = process.env;
  const log = (...m) => console.log(new Date().toISOString(), "[push]", ...m);
  const vapid = loadVapid({ publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT });
  const { deployment, urls } = chainSettings(env);
  if (!/^0x[0-9a-fA-F]{40}$/.test(deployment.lens ?? "")) throw new Error("the deployment has no lens (ENGINE_LENS_ADDRESS)");
  const store = createStore(resolve(env.STORE_FILE || "push-subscriptions.json"), { maxSubscriptions: Number(env.MAX_SUBSCRIPTIONS || 5_000) });
  const pushHosts = env.PUSH_HOSTS ? env.PUSH_HOSTS.split(/[\s,]+/).filter(Boolean) : DEFAULT_PUSH_HOSTS;
  const maxAccounts = Number(env.MAX_ACCOUNTS || 4);
  const chain = rpcChain({ source: rpcSource(makeRpc(urls, { log })), deployment, log });
  const collateral = deployment.collateral === "test" ? "tUSDC" : "USDC";
  const watcher = createWatcher({ chain, store, deliver: pushDelivery(store, vapid), collateral, log });
  const api = createPushApi({
    store,
    vapidPublicKey: vapid.publicKey,
    validate: (b) => validateSubscription(b, { pushHosts, maxAccounts }),
    origins: (env.ALLOWED_ORIGINS || "*").split(/[\s,]+/).filter(Boolean),
    trustProxy: env.TRUST_PROXY === "1",
    status: () => ({ cursor: chain.cursor, ...watcher.counters }),
  });
  const port = Number(env.PORT || 8092);
  api.listen(port, env.HOST || "0.0.0.0", () => log(`subscription API on :${port}; ${store.size} subscriptions`));
  const every = Math.max(5, Number(env.POLL_SECONDS || 15)) * 1000;
  let stopping = false;
  const loop = async () => {
    while (!stopping) {
      try {
        const n = await watcher.tick();
        if (n > 0) log(`${n} notifications (${watcher.counters.sent} sent, ${watcher.counters.failed} failed so far)`);
      } catch (error) {
        log(`tick failed: ${String(error?.message ?? error).split("\n")[0]}`);
      }
      await new Promise((r) => setTimeout(r, every));
    }
  };
  void loop();
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      stopping = true;
      store.flush();
      api.close(() => process.exit(0));
    });
  }
}
