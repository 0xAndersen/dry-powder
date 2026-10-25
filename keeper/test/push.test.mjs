import assert from "node:assert/strict";
import { createDecipheriv, createECDH, createPublicKey, hkdfSync, randomBytes, verify } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  InputError,
  StoreFull,
  bufferLeft,
  createPushApi,
  createStore,
  createWatcher,
  crossedLevel,
  encryptPayload,
  eventMessage,
  fmtAmount,
  fmtPrice,
  generateVapidKeys,
  loadVapid,
  pushDelivery,
  pushTopic,
  sendPush,
  vapidAuthorization,
  validateSubscription,
  warningMessage,
} from "../src/push.mjs";

const b64u = (b) => Buffer.from(b).toString("base64url");
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const E18 = 10n ** 18n;

/** A browser's side of a subscription: its P-256 key pair and auth secret. */
function browser(endpoint = "https://fcm.googleapis.com/fcm/send/abc123") {
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const auth = randomBytes(16);
  return { ecdh, auth, subscription: { endpoint, keys: { p256dh: b64u(ecdh.getPublicKey()), auth: b64u(auth) } } };
}

/** RFC 8291 from the receiving side, written out separately from the sender: what the browser does with a body. */
function decrypt(body, ua) {
  const salt = body.subarray(0, 16);
  const rs = body.readUInt32BE(16);
  const idlen = body[20];
  const asPublic = body.subarray(21, 21 + idlen);
  const sealed = body.subarray(21 + idlen);
  assert.equal(rs, 4096);
  assert.equal(idlen, 65);
  const shared = ua.ecdh.computeSecret(asPublic);
  const info = Buffer.concat([Buffer.from("WebPush: info\0"), ua.ecdh.getPublicKey(), asPublic]);
  const ikm = Buffer.from(hkdfSync("sha256", shared, ua.auth, info, 32));
  const cek = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: aes128gcm\0"), 16));
  const nonce = Buffer.from(hkdfSync("sha256", ikm, salt, Buffer.from("Content-Encoding: nonce\0"), 12));
  const d = createDecipheriv("aes-128-gcm", cek, nonce);
  d.setAuthTag(sealed.subarray(sealed.length - 16));
  const plain = Buffer.concat([d.update(sealed.subarray(0, sealed.length - 16)), d.final()]);
  assert.equal(plain[plain.length - 1], 2, "the last-record delimiter");
  return plain.subarray(0, plain.length - 1).toString("utf8");
}

test("payload encryption reproduces RFC 8291's example byte for byte", () => {
  const body = encryptPayload(
    Buffer.from("V2hlbiBJIGdyb3cgdXAsIEkgd2FudCB0byBiZSBhIHdhdGVybWVsb24", "base64url"),
    { p256dh: "BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4", auth: "BTBZMqHH6r4Tts7J_aSIgg" },
    { salt: Buffer.from("DGv6ra1nlYgDCS1FRnbzlw", "base64url"), serverPrivateKey: Buffer.from("yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw", "base64url") },
  );
  assert.equal(
    b64u(body),
    "DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN",
  );
});

test("a browser decrypts what the relay encrypts; each push has a fresh key and salt", () => {
  const ua = browser();
  const text = JSON.stringify({ title: "BTC-USD long: half of the buffer is gone", body: "é ✓" });
  const a = encryptPayload(text, ua.subscription.keys);
  const b = encryptPayload(text, ua.subscription.keys);
  assert.equal(decrypt(a, ua), text);
  assert.equal(decrypt(b, ua), text);
  assert.notDeepEqual(a.subarray(0, 86), b.subarray(0, 86));
  assert.throws(() => encryptPayload("x".repeat(5_000), ua.subscription.keys), /too large/);
  assert.throws(() => encryptPayload("x", { p256dh: b64u(Buffer.alloc(65)), auth: ua.subscription.keys.auth }), /P-256/);
  assert.throws(() => encryptPayload("x", { p256dh: ua.subscription.keys.p256dh, auth: "AAAA" }), /16 bytes/);
});

test("VAPID: generated keys load, the JWT verifies for the push service's origin, a mismatched pair is refused", () => {
  const keys = generateVapidKeys();
  assert.equal(Buffer.from(keys.publicKey, "base64url").length, 65);
  assert.equal(Buffer.from(keys.privateKey, "base64url").length, 32);
  const vapid = loadVapid({ ...keys, subject: "mailto:ops@example.com" });
  const now = Date.UTC(2026, 9, 25) ;
  const header = vapidAuthorization("https://updates.push.services.mozilla.com/wpush/v2/xyz", vapid, { now });
  const [, h, c, s, k] = /^vapid t=([^.]+)\.([^.]+)\.([^,]+), k=(.+)$/.exec(header);
  assert.deepEqual(JSON.parse(Buffer.from(h, "base64url")), { typ: "JWT", alg: "ES256" });
  assert.deepEqual(JSON.parse(Buffer.from(c, "base64url")), { aud: "https://updates.push.services.mozilla.com", exp: now / 1000 + 12 * 3600, sub: "mailto:ops@example.com" });
  assert.equal(k, keys.publicKey);
  const pub = Buffer.from(k, "base64url");
  const key = createPublicKey({ key: { kty: "EC", crv: "P-256", x: b64u(pub.subarray(1, 33)), y: b64u(pub.subarray(33)) }, format: "jwk" });
  assert.ok(verify("sha256", Buffer.from(`${h}.${c}`), { key, dsaEncoding: "ieee-p1363" }, Buffer.from(s, "base64url")));
  const other = generateVapidKeys();
  assert.throws(() => loadVapid({ publicKey: keys.publicKey, privateKey: other.privateKey, subject: "mailto:a@b.c" }), /does not belong/);
  assert.throws(() => loadVapid({ ...keys, subject: "ops@example.com" }), /VAPID_SUBJECT/);
  assert.throws(() => loadVapid({ publicKey: "abc", privateKey: keys.privateKey, subject: "mailto:a@b.c" }), /VAPID_PUBLIC_KEY/);
  assert.equal(pushTopic("liq-0xabc").length, 32);
  assert.match(pushTopic("liq-0xabc"), /^[A-Za-z0-9_-]+$/);
});

test("subscriptions: only known push services, real keys, a few accounts, known topics", () => {
  const ua = browser();
  const ok = validateSubscription({ subscription: ua.subscription, accounts: [ALICE, BOB.toUpperCase().replace("0X", "0x")] });
  assert.deepEqual(ok.accounts, [ALICE, BOB]);
  assert.deepEqual(ok.topics, ["liquidation", "fill", "close"]);
  assert.equal(ok.liqWarn, "half");
  assert.ok(validateSubscription({ subscription: { ...ua.subscription, endpoint: "https://web.push.apple.com/QGx" }, accounts: [ALICE], topics: ["close"], liqWarn: "quarter" }));
  assert.ok(validateSubscription({ subscription: { ...ua.subscription, endpoint: "https://db5p.notify.windows.com/w/?token=x" }, accounts: [ALICE] }));
  const bad = (patch, re) => assert.throws(() => validateSubscription({ subscription: ua.subscription, accounts: [ALICE], ...patch }), (e) => e instanceof InputError && re.test(e.message));
  bad({ subscription: { ...ua.subscription, endpoint: "http://fcm.googleapis.com/x" } }, /not a known push service/);
  bad({ subscription: { ...ua.subscription, endpoint: "https://169.254.169.254/latest" } }, /not a known push service/);
  bad({ subscription: { ...ua.subscription, endpoint: "https://evilnotify.windows.com.example/x" } }, /not a known push service/);
  bad({ subscription: { ...ua.subscription, endpoint: "not a url" } }, /not a URL/);
  bad({ subscription: { ...ua.subscription, keys: { ...ua.subscription.keys, p256dh: "AAAA" } } }, /p256dh/);
  bad({ subscription: { ...ua.subscription, keys: { ...ua.subscription.keys, auth: b64u(randomBytes(8)) } } }, /auth/);
  bad({ accounts: [] }, /accounts/);
  bad({ accounts: [ALICE, BOB, ALICE, BOB, ALICE] }, /accounts/);
  bad({ accounts: ["0x12"] }, /not an address/);
  bad({ topics: ["everything"] }, /topics/);
  bad({ liqWarn: "always" }, /liqWarn/);
  assert.throws(() => validateSubscription({ subscription: { ...ua.subscription, endpoint: "http://127.0.0.1:9/push" }, accounts: [ALICE] }), InputError);
  assert.ok(validateSubscription({ subscription: { ...ua.subscription, endpoint: "http://127.0.0.1:9/push" }, accounts: [ALICE] }, { allowLocal: true }));
});

test("the store keeps one record per endpoint, persists atomically and drops a subscription that keeps failing", () => {
  const file = join(mkdtempSync(join(tmpdir(), "push-")), "subs.json");
  const store = createStore(file, { maxSubscriptions: 2 });
  const a = validateSubscription({ subscription: browser("https://fcm.googleapis.com/fcm/send/a").subscription, accounts: [ALICE] });
  const b = validateSubscription({ subscription: browser("https://fcm.googleapis.com/fcm/send/b").subscription, accounts: [ALICE, BOB] });
  assert.deepEqual(store.upsert(a, 1), { created: true });
  assert.deepEqual(store.upsert({ ...a, topics: ["close"] }, 2), { created: false });
  assert.equal(store.get(a.endpoint).createdAt, 1);
  assert.deepEqual(store.get(a.endpoint).topics, ["close"]);
  store.upsert(b);
  assert.throws(() => store.upsert({ ...a, endpoint: "https://fcm.googleapis.com/fcm/send/c" }), StoreFull);
  assert.deepEqual([...store.byAccount().entries()].map(([k, v]) => [k, v.length]), [[ALICE, 2], [BOB, 1]]);
  store.flush();
  const again = createStore(file);
  assert.equal(again.size, 2);
  assert.deepEqual(again.get(b.endpoint).accounts, [ALICE, BOB]);
  for (let i = 0; i < 3; i++) again.failed(b.endpoint, 3);
  assert.equal(again.get(b.endpoint), null);
  again.failed(a.endpoint, 3);
  again.delivered(a.endpoint);
  again.failed(a.endpoint, 3);
  again.failed(a.endpoint, 3);
  assert.ok(again.get(a.endpoint), "a delivery resets the count");
  assert.equal(again.remove(a.endpoint), true);
  assert.equal(again.remove(a.endpoint), false);
});

test("messages: prices and amounts for a phone, one per engine event a trader cares about", () => {
  assert.equal(fmtPrice(64_123_456n * 10n ** 15n), "64,123.5");
  assert.equal(fmtPrice(3_456_789n * 10n ** 15n), "3,456.79");
  assert.equal(fmtPrice(1_0876n * 10n ** 14n), "1.0876");
  assert.equal(fmtPrice(6_543n * 10n ** 12n), "0.00654300");
  assert.equal(fmtAmount(12_345_678n), "12.34");
  assert.equal(fmtAmount(12_345_678n, true), "+12.34");
  assert.equal(fmtAmount(-1_500_000n, true), "−1.50");
  assert.equal(fmtAmount(1_234_567_000_000n), "1,234,567.00");
  const key = `0x${"ab".repeat(32)}`;
  const base = { id: "10:1", symbol: "BTC-USD", trader: ALICE };
  const open = eventMessage({ ...base, name: "PositionOpened", args: { key, isLong: true, margin: "20000000", size: "1000000000", entryPrice: String(64_000n * E18), fee: "300000" } }, { collateral: "tUSDC" });
  assert.deepEqual([open.topic, open.title, open.body, open.url], ["fill", "BTC-USD long opened", "1,000.00 tUSDC at 64,000.0, 50x.", "trade/?market=BTC-USD"]);
  const known = new Map([[key, { isLong: true, margin: 20_000_000n }]]);
  const closed = eventMessage({ ...base, name: "PositionClosed", args: { key, exitPrice: String(64_500n * E18), pnl: "7812500", fee: "300000", payout: "27512500" } }, { collateral: "tUSDC", known });
  assert.deepEqual([closed.topic, closed.title], ["close", "BTC-USD long closed: +7.51 tUSDC"]);
  const unknown = eventMessage({ ...base, name: "PositionClosed", args: { key, exitPrice: String(64_500n * E18), pnl: "7812500", fee: "300000", payout: "27512500" } });
  assert.equal(unknown.title, "BTC-USD closed: +7.51 USDC", "without the margin: the PnL less the fee");
  const liq = eventMessage({ ...base, name: "PositionLiquidated", args: { key, price: String(63_000n * E18), margin: "20000000" } }, { known });
  assert.deepEqual([liq.topic, liq.urgency, liq.title, liq.body], ["liquidation", "high", "BTC-USD long liquidated", "At 63,000.0: the 20.00 USDC margin is gone."]);
  const part = eventMessage({ ...base, name: "PositionDecreased", args: { key, exitPrice: String(65_000n * E18), closedSize: "500000000", releasedMargin: "10000000", pnl: "7000000", fee: "150000", payout: "16850000" } }, { known });
  assert.equal(part.title, "BTC-USD long reduced: +6.85 USDC");
  assert.equal(eventMessage({ ...base, name: "OrderCreated", args: {} }), null);
});

/** An EngineLens position view: long from `entry` with liquidation at `liq` (whole dollars). */
const view = (key, entry, liq, isLong = true) => ({ key, position: { priceId: `0x${"01".repeat(32)}`, isLong, entryPrice: BigInt(entry) * E18, margin: 10_000_000n, size: 1_000_000_000n }, fundingOwed: 0n, liquidationPrice: BigInt(liq) * E18 });

test("liquidation warnings follow the app's rule: once per level on the way down, re-armed after a recovery", () => {
  const v = view("0xk", 100, 90);
  assert.equal(bufferLeft(v, 100n * E18).left.toFixed(3), "1.000");
  assert.equal(bufferLeft(v, 95n * E18).left.toFixed(3), "0.526");
  assert.equal(bufferLeft(v, 89n * E18).left, 0);
  assert.equal(bufferLeft(view("0xk", 100, 0), 100n * E18), null, "a long that cannot be liquidated");
  assert.equal(bufferLeft(v, null), null);
  const short = bufferLeft(view("0xs", 100, 110, false), 105n * E18);
  assert.equal(short.left.toFixed(3), "0.476");
  const state = new Map();
  const levels = [0.5, 0.25];
  const seq = [0.8, 0.45, 0.4, 0.2, 0.1, 0.3, 0.9, 0.45].map((left) => crossedLevel(state, "k", left, levels));
  assert.deepEqual(seq, [null, 0.5, null, 0.25, null, null, null, 0.5]);
  assert.deepEqual([null, null, 0.25].map((_, i) => crossedLevel(new Map(), "k", [0.6, 0.4, 0.2][i], [0.25])), [null, null, 0.25]);
  const jump = new Map();
  assert.equal(crossedLevel(jump, "k", 0.1, levels), 0.25, "falling through both at once warns once, at the lower level");
  assert.equal(crossedLevel(jump, "k", 0.05, levels), null);
  const msg = warningMessage({ symbol: "ETH-USD", isLong: false, key: "0xs", level: 0.25, info: short });
  assert.deepEqual([msg.title, msg.urgency, msg.tag], ["ETH-USD short: three quarters of the buffer is gone", "high", "liq-0xs-0.25"]);
  assert.match(msg.body, /^Liquidation at 110\.00, 4\.76% away\./);
});

test("the watcher warns each subscription by its own setting and forwards events of watched traders only", async () => {
  const store = createStore(null);
  const half = validateSubscription({ subscription: browser("https://fcm.googleapis.com/fcm/send/half").subscription, accounts: [ALICE] });
  const quarter = validateSubscription({ subscription: browser("https://fcm.googleapis.com/fcm/send/quarter").subscription, accounts: [ALICE], liqWarn: "quarter", topics: ["liquidation"] });
  store.upsert(half);
  store.upsert(quarter);
  let mark = 100n * E18;
  let events = [];
  const id = `0x${"01".repeat(32)}`;
  const chain = {
    markets: async () => new Map([[id, { symbol: "BTC-USD", hasPrice: true, mid: mark }]]),
    positions: async (account) => (account === ALICE ? [view("0xk", 100, 90)] : []),
    events: async () => events.splice(0),
  };
  const sent = [];
  const watcher = createWatcher({ chain, store, deliver: async (sub, msg) => (sent.push([sub.liqWarn, msg.topic, msg.title]), true) });
  await watcher.tick();
  assert.deepEqual(sent, []);
  mark = 95n * E18; // 0.53 left
  await watcher.tick();
  assert.deepEqual(sent, []);
  mark = 94n * E18; // 0.43 left: the "half" subscription hears about it
  await watcher.tick();
  assert.deepEqual(sent.splice(0), [["half", "liquidation", "BTC-USD long: half of the buffer is gone"]]);
  mark = 92n * E18; // 0.22 left: both
  await watcher.tick();
  assert.deepEqual(sent.splice(0).map((s) => s[0]).sort(), ["half", "quarter"]);
  events = [
    { id: "50:0", name: "PositionClosed", symbol: "BTC-USD", trader: ALICE, args: { key: "0xk", exitPrice: String(95n * E18), pnl: "0", fee: "0", payout: "12000000" } },
    { id: "50:1", name: "PositionOpened", symbol: "BTC-USD", trader: BOB, args: { key: "0xb", isLong: true, margin: "1", size: "2", entryPrice: "3", fee: "0" } },
  ];
  await watcher.tick();
  assert.deepEqual(sent.splice(0), [["half", "close", "BTC-USD long closed: +2.00 USDC"]], "Bob is not watched; the quarter subscription only takes warnings");
  assert.equal(watcher.counters.sent, 4);
});

test("the API: VAPID key, subscribe, update, unsubscribe; CORS by origin, rate limits, bad input", async () => {
  const store = createStore(null);
  const api = createPushApi({ store, vapidPublicKey: "BPUB", origins: ["https://app.example"], perMinute: 4, status: () => ({ cursor: 7 }) });
  await new Promise((r) => api.listen(0, "127.0.0.1", r));
  const base = `http://127.0.0.1:${api.address().port}`;
  const send = (method, path, body, origin = "https://app.example") =>
    fetch(`${base}${path}`, { method, headers: { "content-type": "application/json", origin }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
  try {
    const key = await send("GET", "/vapid");
    assert.equal(key.headers.get("access-control-allow-origin"), "https://app.example");
    assert.deepEqual(await key.json(), { publicKey: "BPUB" });
    const pre = await fetch(`${base}/subscriptions`, { method: "OPTIONS", headers: { origin: "https://app.example", "access-control-request-method": "POST" } });
    assert.equal(pre.status, 204);
    assert.match(pre.headers.get("access-control-allow-methods"), /DELETE/);
    assert.equal((await send("GET", "/vapid", undefined, "https://evil.example")).status, 403);
    const ua = browser();
    const r1 = await send("POST", "/subscriptions", { subscription: ua.subscription, accounts: [ALICE] });
    assert.equal(r1.status, 201);
    assert.deepEqual(await r1.json(), { ok: true, created: true });
    const r2 = await send("POST", "/subscriptions", { subscription: ua.subscription, accounts: [ALICE, BOB], topics: ["fill"] });
    assert.deepEqual(await r2.json(), { ok: true, created: false });
    assert.deepEqual(store.get(ua.subscription.endpoint).accounts, [ALICE, BOB]);
    const bad = await send("POST", "/subscriptions", { subscription: { ...ua.subscription, endpoint: "https://example.com/x" }, accounts: [ALICE] });
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /push service/);
    const del = await send("DELETE", "/subscriptions", { endpoint: ua.subscription.endpoint });
    assert.deepEqual(await del.json(), { ok: true, removed: true });
    assert.equal((await send("DELETE", "/subscriptions", { endpoint: ua.subscription.endpoint })).status, 429, "five writes in a minute");
    const health = await (await send("GET", "/health")).json();
    assert.deepEqual(health, { ok: true, subscriptions: 0, accounts: 0, cursor: 7 });
    assert.equal((await send("GET", "/nothing")).status, 404);
  } finally {
    await new Promise((r) => api.close(r));
  }
  const open = createPushApi({ store, vapidPublicKey: "BPUB" });
  await new Promise((r) => open.listen(0, "127.0.0.1", r));
  try {
    const url = `http://127.0.0.1:${open.address().port}/subscriptions`;
    const huge = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ pad: "x".repeat(10_000) }) }).catch(() => null);
    assert.ok(huge === null || huge.status === 400);
    const notJson = await fetch(url, { method: "POST", body: "{" });
    assert.equal(notJson.status, 400);
    assert.equal((await fetch(url.replace("/subscriptions", "/vapid"), { headers: { origin: "https://anything.example" } })).headers.get("access-control-allow-origin"), "*");
  } finally {
    await new Promise((r) => open.close(r));
  }
});

test("sendPush delivers an encrypted, VAPID-signed request and reports a subscription the service dropped", async () => {
  const seen = [];
  let status = 201;
  const service = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      seen.push({ url: req.url, headers: req.headers, body: Buffer.concat(chunks) });
      res.writeHead(status);
      res.end();
    });
  });
  await new Promise((r) => service.listen(0, "127.0.0.1", r));
  const ua = browser(`http://127.0.0.1:${service.address().port}/push/abc`);
  const vapid = loadVapid({ ...generateVapidKeys(), subject: "https://ops.example/contact" });
  try {
    const message = { title: "ETH-USD long opened", body: "1,000.00 USDC at 3,456.79, 25x.", tag: "PositionOpened-1:0", url: "trade/?market=ETH-USD" };
    const r = await sendPush(ua.subscription, message, vapid, { ttl: 600, urgency: "high", topic: "liq-0xk" });
    assert.deepEqual(r, { status: 201, ok: true, gone: false });
    const got = seen[0];
    assert.equal(got.url, "/push/abc");
    assert.equal(got.headers["content-encoding"], "aes128gcm");
    assert.equal(got.headers.ttl, "600");
    assert.equal(got.headers.urgency, "high");
    assert.equal(got.headers.topic, pushTopic("liq-0xk"));
    assert.match(got.headers.authorization, new RegExp(`^vapid t=[^,]+, k=${vapid.publicKey}$`));
    const claims = JSON.parse(Buffer.from(got.headers.authorization.slice(8).split(".")[1], "base64url"));
    assert.equal(claims.aud, `http://127.0.0.1:${service.address().port}`);
    assert.deepEqual(JSON.parse(decrypt(got.body, ua)), message);
    status = 410;
    assert.deepEqual(await sendPush(ua.subscription, message, vapid), { status: 410, ok: false, gone: true });

    // The watcher's delivery: routing fields stay out of the payload, warnings carry a per-position topic, and a
    // subscription the service has forgotten is dropped.
    status = 201;
    const store = createStore(null);
    store.upsert(validateSubscription({ subscription: ua.subscription, accounts: [ALICE] }, { allowLocal: true }));
    const deliver = pushDelivery(store, vapid);
    const warning = warningMessage({ symbol: "BTC-USD", isLong: true, key: "0xk", level: 0.5, info: { liquidationPrice: 90n * E18, distance: 0.04 } });
    assert.equal(await deliver(store.get(ua.subscription.endpoint), warning), true);
    const sent = seen.at(-1);
    assert.equal(sent.headers.topic, pushTopic("liq-0xk"));
    assert.equal(sent.headers.urgency, "high");
    assert.equal(sent.headers.ttl, "600");
    assert.deepEqual(Object.keys(JSON.parse(decrypt(sent.body, ua))).sort(), ["body", "tag", "title", "url"]);
    const fill = eventMessage({ id: "1:0", name: "PositionOpened", symbol: "BTC-USD", args: { key: "0xk", isLong: true, margin: "1000000", size: "10000000", entryPrice: String(100n * E18), fee: "0" } });
    await deliver(store.get(ua.subscription.endpoint), fill);
    assert.equal(seen.at(-1).headers.topic, undefined, "fills do not replace each other");
    status = 410;
    assert.equal(await deliver(store.get(ua.subscription.endpoint), fill), false);
    assert.equal(store.size, 0);
  } finally {
    await new Promise((r) => service.close(r));
  }
});
