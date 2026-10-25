import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { test } from "node:test";
import { encodeAbiParameters, encodeEventTopics, keccak256, toHex } from "viem";
import { strategiesAbi, trailingStopsAbi } from "../src/abi.mjs";
import { EVENT_ABI } from "../src/indexer.mjs";
import {
  SseClient,
  WsClient,
  acceptKey,
  contractsOf,
  createBuffer,
  createFollower,
  createRelay,
  decodeContext,
  decodeLog,
  encodeFrame,
  frameParser,
  matches,
  parseEventId,
  parseFilter,
  startRelay,
} from "../src/relay.mjs";

const ENGINE = "0x00000000000000000000000000000000000000e1";
const TRAILS = "0x00000000000000000000000000000000000000e2";
const STRATS = "0x00000000000000000000000000000000000000e3";
const ALICE = "0x1111111111111111111111111111111111111111";
const BOB = "0x2222222222222222222222222222222222222222";
const BTC = keccak256(toHex("BTC-USD"));
const ETH = keccak256(toHex("ETH-USD"));
const deployment = { engine: ENGINE, trailingStops: TRAILS, strategies: STRATS, agentRegistry: "0x0000000000000000000000000000000000000000" };
const contracts = contractsOf(deployment);

/** A raw log as eth_getLogs returns it. */
function rawLog(address, abi, eventName, args, block, logIndex) {
  const item = abi.find((x) => x.type === "event" && x.name === eventName);
  const indexed = item.inputs.filter((i) => i.indexed);
  const plainInputs = item.inputs.filter((i) => !i.indexed);
  const topics = encodeEventTopics({ abi: [item], eventName, args: Object.fromEntries(indexed.map((i) => [i.name, args[i.name]])) });
  const data = encodeAbiParameters(plainInputs, plainInputs.map((i) => args[i.name]));
  return { address, topics, data, blockNumber: toHex(block), logIndex: toHex(logIndex), transactionHash: keccak256(toHex(`${block}:${logIndex}`)) };
}

const opened = (trader, priceId, block, logIndex, size = 1_000_000_000n) =>
  rawLog(ENGINE, EVENT_ABI, "PositionOpened", { key: keccak256(toHex(`${trader}${priceId}`)), trader, priceId, isLong: true, margin: 20_000_000n, size, entryPrice: 64_000n * 10n ** 18n, fee: 300_000n }, block, logIndex);
const liquidated = (trader, priceId, block, logIndex) =>
  rawLog(ENGINE, EVENT_ABI, "PositionLiquidated", { key: keccak256(toHex(`${trader}${priceId}`)), trader, liquidator: BOB, priceId, price: 63_000n * 10n ** 18n, margin: 20_000_000n, liquidatorFee: 1_000_000n, toVault: 19_000_000n }, block, logIndex);

test("logs decode into events with the market, its symbol, the trader and plain arguments", () => {
  const ctx = decodeContext(new Map([[BTC, "BTC-USD"]]));
  const ev = decodeLog(opened(ALICE, BTC, 10, 3), contracts, ctx, () => 1_700_000_000);
  assert.equal(ev.id, "10:3");
  assert.equal(ev.name, "PositionOpened");
  assert.equal(ev.contract, "engine");
  assert.equal(ev.market, BTC);
  assert.equal(ev.symbol, "BTC-USD");
  assert.equal(ev.trader, ALICE);
  assert.equal(ev.time, 1_700_000_000);
  assert.equal(ev.args.size, "1000000000");
  assert.equal(ev.args.isLong, true);
  // A listing teaches the symbol; add-ons name the account; strategy events inherit it from StrategyCreated.
  decodeLog(rawLog(ENGINE, EVENT_ABI, "MarketListed", { priceId: ETH, symbol: "ETH-USD", feedId: ETH, quoteFeedId: `0x${"0".repeat(64)}`, invert: false, expiry: 0n }, 11, 0), contracts, ctx);
  assert.equal(decodeLog(opened(BOB, ETH, 12, 0), contracts, ctx).symbol, "ETH-USD");
  const trail = decodeLog(rawLog(TRAILS, trailingStopsAbi, "StopTrailed", { account: BOB, marketId: BTC, best: 1n, stop: 2n }, 13, 0), contracts, ctx);
  assert.deepEqual([trail.contract, trail.trader, trail.market, trail.symbol], ["trailingStops", BOB, BTC, "BTC-USD"]);
  const created = strategiesAbi.find((x) => x.name === "StrategyCreated");
  const config = Object.fromEntries(created.inputs.find((i) => i.name === "config").components.map((c) => [c.name, c.type.startsWith("uint") || c.type.startsWith("int") ? 1n : c.type === "bool" ? false : c.type === "address" ? ALICE : c.type === "bytes32" ? BTC : "0x"]));
  const made = decodeLog(rawLog(STRATS, strategiesAbi, "StrategyCreated", { id: 7n, account: ALICE, marketId: BTC, config }, 14, 0), contracts, ctx);
  assert.equal(made.trader, ALICE);
  const placed = decodeLog(rawLog(STRATS, strategiesAbi, "OrderPlaced", { id: 7n, action: 1, orderId: 99n, size: 5n, price: 6n }, 15, 0), contracts, ctx);
  assert.deepEqual([placed.trader, placed.market, placed.args.orderId], [ALICE, BTC, "99"]);
  assert.equal(decodeLog({ ...opened(ALICE, BTC, 1, 0), address: "0x00000000000000000000000000000000000000ff" }, contracts, ctx), null, "not a streamed contract");
  assert.equal(decodeLog({ ...opened(ALICE, BTC, 1, 0), topics: [keccak256(toHex("Unknown()"))] }, contracts, ctx), null, "an unknown event");
  assert.deepEqual(contracts.map((c) => c.key), ["engine", "trailingStops", "strategies"], "a zero address is not streamed");
});

test("filters: markets by symbol or id, traders, event names; each optional", () => {
  const ctx = decodeContext(new Map([[BTC, "BTC-USD"], [ETH, "ETH-USD"]]));
  const a = decodeLog(opened(ALICE, BTC, 1, 0), contracts, ctx);
  const b = decodeLog(liquidated(BOB, ETH, 1, 1), contracts, ctx);
  const f = (q) => parseFilter(q);
  assert.ok(matches(a, f({})));
  assert.ok(matches(a, f({ market: "btc-usd" })));
  assert.ok(matches(b, f({ market: [ETH.toUpperCase().replace("0X", "0x")] })));
  assert.ok(!matches(b, f({ market: "BTC-USD" })));
  assert.ok(matches(a, f({ trader: ALICE.toUpperCase().replace("0X", "0x") })));
  assert.ok(!matches(b, f({ trader: [ALICE] })));
  assert.ok(matches(b, f({ event: "positionliquidated,PositionClosed" })));
  assert.ok(!matches(a, f({ event: ["PositionLiquidated"], market: "BTC-USD" })));
  assert.ok(matches(a, f({ market: ["ETH-USD", "BTC-USD"], trader: [BOB, ALICE], event: ["PositionOpened"] })));
  assert.throws(() => parseFilter({ trader: "0x1234" }), /not an address/);
  assert.throws(() => parseFilter({ market: "BTC USD;" }), /not a market/);
  assert.throws(() => parseFilter({ event: "Position-Opened" }), /not an event/);
  assert.throws(() => parseFilter({ market: Array.from({ length: 3 }, (_, i) => `M${i}`) }, { maxValues: 2 }), /at most 2/);
  assert.deepEqual(parseEventId("12:3"), { block: 12, logIndex: 3 });
  assert.equal(parseEventId("12"), null);
  assert.equal(parseEventId(undefined), null);
});

const ev = (block, logIndex, name = "PositionOpened", trader = ALICE) => ({ id: `${block}:${logIndex}`, name, block, logIndex, market: BTC, symbol: "BTC-USD", trader, args: {} });

test("the buffer keeps whole blocks, knows where it starts, and replays after an id or from a block", () => {
  const b = createBuffer(4);
  b.startAt(10);
  b.push([ev(10, 0), ev(10, 1), ev(11, 0)]);
  assert.equal(b.floor, 10);
  assert.deepEqual(b.replay({ after: { block: 10, logIndex: 0 } }).events.map((e) => e.id), ["10:1", "11:0"]);
  assert.equal(b.replay({ after: { block: 10, logIndex: 0 } }).gap, false);
  assert.equal(b.replay({ from: 9 }).gap, true, "block 9 was never read");
  b.push([ev(12, 0), ev(12, 1)]);
  // Five events for four places: all of block 10 goes, so block 10 is no longer replayable.
  assert.deepEqual(b.replay({ from: 0 }).events.map((e) => e.id), ["11:0", "12:0", "12:1"]);
  assert.equal(b.floor, 11);
  assert.equal(b.replay({ after: { block: 9, logIndex: 5 } }).gap, true);
  assert.equal(b.replay({ after: { block: 10, logIndex: 1 } }).gap, false);
  assert.deepEqual(b.latest(parseFilter({}), 2).map((e) => e.id), ["12:0", "12:1"]);
  assert.deepEqual(b.replay({}).events, []);
});

/** A chain of `blocks`: { number: [rawLog…] }; `failRanges` makes ranges wider than it error like a capped RPC. */
function fakeSource({ head, blocks = {}, maxRange = Infinity }) {
  const calls = [];
  return {
    calls,
    head: async () => head(),
    async logs(from, to, addresses) {
      calls.push([from, to]);
      if (to - from + 1 > maxRange) throw Object.assign(new Error("block range exceeds 10000"), { code: -32005 });
      const out = [];
      for (let b = from; b <= to; b++) for (const l of blocks[b] ?? []) if (addresses.includes(l.address.toLowerCase())) out.push(l);
      return out;
    },
    blockTime: async (b) => 1_700_000_000 + b,
    call: async () => {
      throw new Error("no lens here");
    },
  };
}

test("the follower reads in ranges, halves a range an RPC refuses, and waits for confirmations", async () => {
  let head = 20;
  const source = fakeSource({ head: () => head, blocks: { 5: [opened(ALICE, BTC, 5, 0)], 15: [liquidated(ALICE, BTC, 15, 2), opened(BOB, BTC, 15, 1)] }, maxRange: 4 });
  const got = [];
  const follower = createFollower({ source, contracts, ctx: decodeContext(), logRange: 8, confirmations: 2, onEvents: (e) => got.push(...e) });
  follower.startAfter(0);
  assert.equal(await follower.tick(), 3);
  assert.equal(follower.cursor, 18);
  assert.deepEqual(got.map((e) => e.id), ["5:0", "15:1", "15:2"], "oldest first within a block");
  assert.equal(got[0].time, 1_700_000_005);
  assert.ok(source.calls.every(([f, t]) => t - f + 1 <= 8));
  assert.ok(source.calls.some(([f, t]) => t - f + 1 > 4), "tried the configured range first");
  head = 21;
  assert.equal(await follower.tick(), 0);
  assert.equal(follower.cursor, 19);
});

// ─────────────────────────────── Streams over the network ───────────────────────────────

/** Reads an SSE stream into messages: { id, event, data } (comments as { comment }). */
async function sse(url, headers = {}) {
  const res = await fetch(url, { headers });
  const messages = [];
  const waiters = [];
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  (async () => {
    for (;;) {
      const { value, done } = await reader.read().catch(() => ({ done: true }));
      if (done) break;
      text += decoder.decode(value, { stream: true });
      let i;
      while ((i = text.indexOf("\n\n")) >= 0) {
        const block = text.slice(0, i);
        text = text.slice(i + 2);
        const m = {};
        for (const line of block.split("\n")) {
          if (line.startsWith(":")) m.comment = line.slice(1).trim();
          else {
            const at = line.indexOf(": ");
            const k = line.slice(0, at);
            const v = line.slice(at + 2);
            m[k] = k === "data" ? JSON.parse(v) : v;
          }
        }
        messages.push(m);
      }
      for (const w of waiters.splice(0)) w();
    }
  })();
  const until = async (pred, ms = 3_000) => {
    const end = Date.now() + ms;
    while (!pred(messages)) {
      if (Date.now() > end) throw new Error(`timed out; got ${JSON.stringify(messages).slice(0, 600)}`);
      await new Promise((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
    return messages;
  };
  return { res, messages, until, close: () => reader.cancel() };
}

async function listen(relay) {
  await new Promise((r) => relay.server.listen(0, "127.0.0.1", r));
  return `127.0.0.1:${relay.server.address().port}`;
}

test("SSE: filtered live events, a heartbeat, and a resume from Last-Event-ID with a gap notice", async () => {
  const relay = createRelay({ heartbeatMs: 60, status: () => ({ head: 30, cursor: 30 }) });
  relay.buffer.startAt(10);
  relay.publish([ev(10, 0), ev(11, 0, "PositionLiquidated"), ev(12, 0, "PositionOpened", BOB)]);
  const host = await listen(relay);
  try {
    const live = await sse(`http://${host}/events?trader=${ALICE}&event=PositionOpened,PositionClosed`);
    assert.equal(live.res.headers.get("content-type"), "text/event-stream; charset=utf-8");
    assert.equal(live.res.headers.get("access-control-allow-origin"), "*");
    await live.until((m) => m.some((x) => x.event === "hello"));
    relay.publish([ev(13, 0, "PositionOpened", BOB), ev(13, 1, "PositionClosed", ALICE), ev(14, 0, "PositionLiquidated", ALICE)]);
    await live.until((m) => m.some((x) => x.id === "13:1"));
    await live.until((m) => m.some((x) => x.comment !== undefined && /^\d+$/.test(x.comment)));
    const events = live.messages.filter((m) => m.data?.name);
    assert.deepEqual(events.map((m) => [m.id, m.event]), [["13:1", "PositionClosed"]], "only Alice's opens and closes, nothing replayed without asking");
    assert.equal(events[0].data.trader, ALICE);
    live.close();

    // Resuming: everything after 10:0 that matches; the relay never read before block 10, so a resume from 5 gets a gap.
    const resumed = await sse(`http://${host}/events`, { "last-event-id": "10:0" });
    await resumed.until((m) => m.some((x) => x.id === "14:0"));
    assert.deepEqual(resumed.messages.filter((m) => m.id).map((m) => m.id), ["11:0", "12:0", "13:0", "13:1", "14:0"]);
    assert.ok(!resumed.messages.some((m) => m.event === "gap"));
    resumed.close();
    const old = await sse(`http://${host}/events?from=5&market=BTC-USD&event=PositionLiquidated`);
    await old.until((m) => m.some((x) => x.id === "14:0"));
    assert.deepEqual(old.messages.find((m) => m.event === "gap").data, { type: "gap", from: 5, oldest: 10 });
    assert.deepEqual(old.messages.filter((m) => m.id).map((m) => m.id), ["11:0", "14:0"]);
    old.close();

    const recent = await (await fetch(`http://${host}/recent?trader=${BOB}&limit=5`)).json();
    assert.deepEqual(recent.map((e) => e.id), ["12:0", "13:0"]);
    const bad = await fetch(`http://${host}/events?trader=nobody`);
    assert.equal(bad.status, 400);
    assert.match((await bad.json()).error, /not an address/);
    const health = await (await fetch(`http://${host}/health`)).json();
    assert.equal(health.head, 30);
    assert.equal(health.buffered, 6);
  } finally {
    await relay.close();
  }
});

test("SSE: a client cap per address, and a slow consumer is cut off instead of queueing without bound", async () => {
  const relay = createRelay({ limits: { maxClientsPerIp: 1 } });
  const host = await listen(relay);
  try {
    const first = await sse(`http://${host}/events`);
    await first.until((m) => m.some((x) => x.event === "hello"));
    const second = await fetch(`http://${host}/events`);
    assert.equal(second.status, 503);
    first.close();
    await new Promise((r) => setTimeout(r, 100));
    const third = await sse(`http://${host}/events`);
    await third.until((m) => m.some((x) => x.event === "hello"));
    third.close();
  } finally {
    await relay.close();
  }
  // A response that never drains: past the queue limit the client gets an error event and the stream ends.
  const res = Object.assign(new EventEmitter(), { writableLength: 0, chunks: [], ended: null });
  res.write = (t) => {
    res.chunks.push(t);
    res.writableLength += Buffer.byteLength(t);
    return false;
  };
  res.end = (t) => {
    res.ended = t;
    res.emit("close");
  };
  let closed = 0;
  const client = new SseClient(res, parseFilter({}), { maxQueue: 3_000, onClose: () => (closed += 1) });
  for (let i = 0; i < 20; i++) client.event({ ...ev(20, i), args: { pad: "x".repeat(100) } });
  // About 360 bytes an event: eight fit under 3,000 bytes, the ninth is refused and the stream ends.
  assert.ok(res.chunks.length >= 5 && res.chunks.length < 20, `${res.chunks.length} events queued`);
  assert.ok(res.writableLength <= 3_000);
  assert.match(res.ended, /event: error[\s\S]*slow consumer/);
  assert.equal(closed, 1);
  assert.ok(client.closed);
});

/** Opens a WebSocket and collects its JSON messages. */
async function ws(url) {
  const socket = new WebSocket(url);
  const messages = [];
  socket.addEventListener("message", (e) => messages.push(JSON.parse(String(e.data))));
  await new Promise((resolve, reject) => {
    socket.addEventListener("open", resolve, { once: true });
    socket.addEventListener("error", () => reject(new Error("websocket error")), { once: true });
  });
  const until = async (pred, ms = 3_000) => {
    const end = Date.now() + ms;
    while (!pred(messages)) {
      if (Date.now() > end) throw new Error(`timed out; got ${JSON.stringify(messages).slice(0, 600)}`);
      await new Promise((r) => setTimeout(r, 20));
    }
    return messages;
  };
  return { socket, messages, until };
}

test("WebSocket: hello, replay from a block, live events, re-subscribing and ping", async () => {
  const relay = createRelay({ heartbeatMs: 50 });
  relay.buffer.startAt(10);
  relay.publish([ev(10, 0), ev(11, 0, "PositionLiquidated"), ev(12, 0, "PositionOpened", BOB)]);
  const host = await listen(relay);
  try {
    const c = await ws(`ws://${host}/ws?from=11&event=PositionLiquidated`);
    await c.until((m) => m.some((x) => x.type === "event"));
    assert.equal(c.messages[0].type, "hello");
    assert.deepEqual(c.messages[0].filter.event, ["positionliquidated"]);
    assert.deepEqual(c.messages.filter((x) => x.type === "event").map((x) => x.id), ["11:0"]);
    relay.publish([ev(13, 0, "PositionLiquidated", BOB), ev(13, 1)]);
    await c.until((m) => m.some((x) => x.id === "13:0"));
    c.socket.send(JSON.stringify({ type: "subscribe", trader: [BOB], from: 0 }));
    await c.until((m) => m.some((x) => x.type === "subscribed"));
    await c.until((m) => m.some((x) => x.type === "gap"));
    await c.until((m) => m.filter((x) => x.type === "event" && x.trader === BOB).length >= 3);
    c.socket.send(JSON.stringify({ type: "ping" }));
    await c.until((m) => m.some((x) => x.type === "pong"));
    c.socket.send(JSON.stringify({ type: "subscribe", trader: ["0x12"] }));
    await c.until((m) => m.some((x) => x.type === "error" && /not an address/.test(x.error)));
    c.socket.send("not json");
    await c.until((m) => m.some((x) => x.type === "error" && /JSON/.test(x.error)));
    // The relay pings every 50 ms and the client answers by itself: still connected after a few rounds.
    await new Promise((r) => setTimeout(r, 250));
    assert.equal(c.socket.readyState, WebSocket.OPEN);
    assert.equal(relay.clients.size, 1);
    c.socket.close();
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(relay.clients.size, 0);
    const refused = await fetch(`http://${host}/ws`, { headers: { upgrade: "websocket" } }).catch(() => null);
    assert.ok(refused === null || refused.status >= 400);
  } finally {
    await relay.close();
  }
});

test("WebSocket frames: masked client frames parse (also fragmented); bad ones close the stream", () => {
  const mask = Buffer.from([1, 2, 3, 4]);
  const clientFrame = (opcode, text, fin = true) => {
    const p = Buffer.from(text);
    const masked = Buffer.from(p.map((b, i) => b ^ mask[i & 3]));
    const len = p.length < 126 ? Buffer.from([0x80 | p.length]) : Buffer.from([0x80 | 126, p.length >> 8, p.length & 0xff]);
    return Buffer.concat([Buffer.from([(fin ? 0x80 : 0) | opcode]), len, mask, masked]);
  };
  const got = [];
  const errors = [];
  const parse = frameParser((op, p) => got.push([op, p.toString()]), (code, reason) => errors.push([code, reason]), { maxPayload: 300 });
  const whole = Buffer.concat([clientFrame(1, '{"type":"ping"}'), clientFrame(1, "abc", false), clientFrame(0, "def"), clientFrame(9, "")]);
  parse(whole.subarray(0, 7));
  parse(whole.subarray(7));
  assert.deepEqual(got, [[1, '{"type":"ping"}'], [1, "abcdef"], [9, ""]]);
  parse(clientFrame(1, "x".repeat(200)));
  assert.equal(got.length, 4, "a 200-byte message with a 16-bit length");
  parse(clientFrame(1, "x".repeat(301)));
  assert.deepEqual(errors, [[1009, "message too big"]]);
  parse(clientFrame(1, "ignored after the error"));
  assert.equal(got.length, 4);
  const unmasked = [];
  frameParser(() => {}, (code) => unmasked.push(code))(Buffer.from([0x81, 0x02, 0x68, 0x69]));
  assert.deepEqual(unmasked, [1002]);
  // Server frames: 7-bit, 16-bit and 64-bit lengths, never masked.
  assert.deepEqual([...encodeFrame(1, Buffer.from("hi"))], [0x81, 2, 0x68, 0x69]);
  assert.deepEqual([...encodeFrame(1, Buffer.alloc(200)).subarray(0, 4)], [0x81, 126, 0, 200]);
  assert.deepEqual([...encodeFrame(2, Buffer.alloc(70_000)).subarray(0, 10)], [0x82, 127, 0, 0, 0, 0, 0, 1, 0x11, 0x70]);
  // RFC 6455's example handshake.
  assert.equal(acceptKey("dGhlIHNhbXBsZSBub25jZQ=="), "s3pPLMBiTxaQ9kYGzzhZRbK+xOo=");
});

test("WebSocket: a peer that stops reading is dropped at the queue limit", () => {
  const socket = Object.assign(new EventEmitter(), { writableLength: 0, written: [], ended: false });
  socket.write = (b) => {
    socket.written.push(b);
    socket.writableLength += b.length;
    return false;
  };
  socket.end = () => (socket.ended = true);
  let closed = 0;
  const client = new WsClient(socket, parseFilter({}), { maxQueue: 2_000, onClose: () => (closed += 1), onMessage: () => {} });
  for (let i = 0; i < 50; i++) client.event({ ...ev(30, i), args: { pad: "y".repeat(100) } });
  assert.ok(client.closed);
  assert.equal(closed, 1);
  assert.ok(socket.ended);
  const last = socket.written.at(-1);
  assert.equal(last[0], 0x88, "a close frame");
  assert.equal(last.readUInt16BE(2), 1013);
});

test("startRelay follows a chain and streams what it decodes", async () => {
  let head = 100;
  const blocks = { 95: [opened(ALICE, BTC, 95, 0)], 103: [liquidated(ALICE, BTC, 103, 4)] };
  const source = fakeSource({ head: () => head, blocks });
  const relay = await startRelay({ source, deployment, port: 0, host: "127.0.0.1", pollMs: 20, backfill: 10 });
  try {
    const host = `127.0.0.1:${relay.server.address().port}`;
    const stream = await sse(`http://${host}/events?from=90`);
    await stream.until((m) => m.some((x) => x.id === "95:0"));
    assert.deepEqual(stream.messages.find((m) => m.event === "gap").data.oldest, 91, "the backfill covers the last 10 blocks");
    head = 105;
    await stream.until((m) => m.some((x) => x.id === "103:4"));
    const liq = stream.messages.find((m) => m.id === "103:4").data;
    assert.deepEqual([liq.name, liq.trader, liq.market, liq.args.price], ["PositionLiquidated", ALICE, BTC, String(63_000n * 10n ** 18n)]);
    stream.close();
    const health = await (await fetch(`http://${host}/health`)).json();
    assert.equal(health.cursor, 105);
    assert.deepEqual(health.contracts, ["engine", "trailingStops", "strategies"]);
  } finally {
    await relay.stop();
  }
});
