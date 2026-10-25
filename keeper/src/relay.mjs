#!/usr/bin/env node
// Event stream for bots (roadmap 93): the engine's and the add-ons' events, decoded, over Server-Sent Events and
// WebSocket. A bot subscribes to the markets, traders and event names it cares about and reacts to fills,
// liquidations, orders, strategy actions and prize claims as blocks arrive, without scanning logs itself. After a
// disconnect it resumes from the last event it saw, as far back as the relay's buffer reaches.
//
//   DEPLOYMENT=../deployments/arc-testnet.json PORT=8091 node src/relay.mjs
//
// Endpoints (CORS is open: everything served is public chain data):
//   GET /events?market=BTC-USD&trader=0x…&event=PositionOpened,PositionClosed&from=<block>
//       text/event-stream. Each event is `id: <block>:<logIndex>`, `event: <name>`, `data: <JSON below>`. A comment
//       every HEARTBEAT_SECONDS keeps proxies from closing the stream. Reconnecting with Last-Event-ID (EventSource
//       does it by itself) replays what was missed; `from` replays from a block. Filters are optional, repeat or take
//       comma lists; a market is a symbol or a market id.
//   GET /ws?…the same query…
//       WebSocket. The relay sends {"type":"hello",…}, then {"type":"event",…event} for each event. Send
//       {"type":"subscribe","market":[…],"trader":[…],"event":[…],"from":<block>} to change the filters (and replay),
//       {"type":"ping"} for a {"type":"pong"}. The relay pings every HEARTBEAT_SECONDS and drops a peer that stops
//       answering.
//   GET /recent?…the same query…&limit=100   the latest buffered events that match, oldest first, as JSON.
//   GET /health                              head, cursor, buffer and client counts.
//
// An event: { id, name, contract ("engine" | "trailingStops" | "twapOrders" | "strategies" | "agentRegistry" |
// "prizeDistributor"), address, block, logIndex, tx, time, market, symbol, trader, args }, integers as decimal
// strings. When a replay asks for blocks older than the buffer, a `gap` event (SSE) or {"type":"gap"} message says
// where the buffer starts: read the earlier logs from an RPC.
//
// Limits, so one client cannot hurt the others: MAX_CLIENTS (500), MAX_CLIENTS_PER_IP (20), MAX_BUFFERED_EVENTS
// (10000), MAX_QUEUE_BYTES (1 MiB of unsent data per client: a client that falls that far behind is disconnected
// instead of growing the relay's memory), MAX_FILTER_VALUES (50 per filter).
//
// Environment: DEPLOYMENT (deployment JSON: engine, lens, add-on addresses, chainId, rpcUrl), RPC_URL / RPC_URLS,
// CHAIN_ID, PORT (8091), HOST (0.0.0.0), POLL_MS (2000), BACKFILL_BLOCKS (5000: what the buffer holds on start),
// START_BLOCK (instead of BACKFILL_BLOCKS), LOG_RANGE (2000 blocks per eth_getLogs, halved on range errors),
// CONFIRMATIONS (0: Arc blocks are final), HEARTBEAT_SECONDS (15), TRUST_PROXY (1: count clients by the first
// X-Forwarded-For address), plus the limits above. ops/relay/ has a compose file.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { decodeEventLog, decodeFunctionResult, encodeFunctionData, getAddress } from "viem";
import { agentRegistryAbi, engineLensAbi, prizeDistributorAbi, strategiesAbi, trailingStopsAbi, twapOrdersAbi } from "./abi.mjs";
import { EVENT_ABI, isRangeError, makeRpc } from "./indexer.mjs";

// ─────────────────────────────── Contracts and decoding ───────────────────────────────

/** The contracts whose events are streamed, by their key in the deployment file. */
export const CONTRACTS = [
  { key: "engine", abi: EVENT_ABI },
  { key: "trailingStops", abi: trailingStopsAbi },
  { key: "twapOrders", abi: twapOrdersAbi },
  { key: "strategies", abi: strategiesAbi },
  { key: "agentRegistry", abi: agentRegistryAbi },
  { key: "prizeDistributor", abi: prizeDistributorAbi },
];

const ADDRESS = /^0x[0-9a-fA-F]{40}$/;
const ZERO = /^0x0{40}$/;

/** The streamed contracts present in a deployment: [{ key, address (lower case), abi }]. */
export function contractsOf(deployment) {
  const out = [];
  for (const c of CONTRACTS) {
    const address = deployment?.[c.key];
    if (typeof address === "string" && ADDRESS.test(address) && !ZERO.test(address)) out.push({ key: c.key, address: address.toLowerCase(), abi: c.abi.filter((x) => x.type === "event") });
  }
  return out;
}

/** Bigints to decimal strings, recursively (viem decodes tuples to objects and arrays to arrays). */
export function plain(value) {
  if (typeof value === "bigint") return value.toString();
  if (Array.isArray(value)) return value.map(plain);
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = plain(v);
    return out;
  }
  return value;
}

/**
 * What decoding needs to know beyond one log: market symbols by id, and strategy ids' accounts and markets (only
 * StrategyCreated names them; later strategy events carry the id). Updated by the events themselves.
 */
export function decodeContext(symbols = new Map()) {
  return { symbols, strategies: new Map() };
}

const hex = (v) => (typeof v === "string" ? v.toLowerCase() : null);

/** Decodes one raw log of a streamed contract into a relay event, or null for logs it does not know. */
export function decodeLog(log, contracts, ctx, timeOf = () => 0) {
  const address = String(log.address ?? "").toLowerCase();
  const contract = contracts.find((c) => c.address === address);
  if (!contract) return null;
  let decoded;
  try {
    decoded = decodeEventLog({ abi: contract.abi, data: log.data, topics: log.topics });
  } catch {
    return null;
  }
  const args = decoded.args ?? {};
  const block = Number(BigInt(log.blockNumber));
  const logIndex = Number(BigInt(log.logIndex));
  let market = hex(args.priceId ?? args.marketId ?? null);
  let trader = args.trader ?? args.account ?? null;
  if (contract.key === "strategies" && args.id !== undefined) {
    const id = String(args.id);
    if (decoded.eventName === "StrategyCreated") ctx.strategies.set(id, { account: args.account, market: hex(args.marketId) });
    const known = ctx.strategies.get(id);
    if (known) {
      trader ??= known.account;
      market ??= known.market;
    }
  }
  if (contract.key === "engine" && decoded.eventName === "MarketListed" && market) ctx.symbols.set(market, String(args.symbol));
  return {
    id: `${block}:${logIndex}`,
    name: decoded.eventName,
    contract: contract.key,
    address: getAddress(address),
    block,
    logIndex,
    tx: log.transactionHash ?? null,
    time: Math.floor(Number(timeOf(block)) || 0),
    market,
    symbol: market ? (ctx.symbols.get(market) ?? null) : null,
    trader: trader ? getAddress(trader) : null,
    args: plain(args),
  };
}

// ─────────────────────────────── Filters ───────────────────────────────

const ID32 = /^0x[0-9a-fA-F]{64}$/;

function values(input, max) {
  const list = (Array.isArray(input) ? input : input === undefined || input === null ? [] : [input])
    .flatMap((v) => String(v).split(","))
    .map((v) => v.trim())
    .filter(Boolean);
  if (list.length > max) throw new FilterError(`at most ${max} values per filter`);
  return list;
}

export class FilterError extends Error {}

/**
 * A subscription's filters from query parameters or a subscribe message: markets (ids or symbols), traders and
 * event names. An empty filter matches everything.
 */
export function parseFilter({ market, trader, event } = {}, { maxValues = 50 } = {}) {
  const ids = new Set();
  const symbols = new Set();
  for (const m of values(market, maxValues)) {
    if (ID32.test(m)) ids.add(m.toLowerCase());
    else if (/^[A-Za-z0-9._-]{1,40}$/.test(m)) symbols.add(m.toUpperCase());
    else throw new FilterError(`not a market id or symbol: ${m.slice(0, 80)}`);
  }
  const traders = new Set();
  for (const t of values(trader, maxValues)) {
    if (!ADDRESS.test(t)) throw new FilterError(`not an address: ${t.slice(0, 80)}`);
    traders.add(t.toLowerCase());
  }
  const events = new Set();
  for (const e of values(event, maxValues)) {
    if (!/^[A-Za-z][A-Za-z0-9]{0,63}$/.test(e)) throw new FilterError(`not an event name: ${e.slice(0, 80)}`);
    events.add(e.toLowerCase());
  }
  return { ids, symbols, traders, events };
}

export function matches(ev, f) {
  if (f.events.size > 0 && !f.events.has(ev.name.toLowerCase())) return false;
  if (f.traders.size > 0 && !(ev.trader && f.traders.has(ev.trader.toLowerCase()))) return false;
  if (f.ids.size > 0 || f.symbols.size > 0) {
    const byId = ev.market !== null && f.ids.has(ev.market);
    const bySymbol = ev.symbol !== null && f.symbols.has(ev.symbol.toUpperCase());
    if (!byId && !bySymbol) return false;
  }
  return true;
}

export const describeFilter = (f) => ({ market: [...f.ids, ...f.symbols], trader: [...f.traders], event: [...f.events] });

// ─────────────────────────────── Buffer ───────────────────────────────

/** The id an event was sent under ("block:logIndex"), parsed; null when it is not one. */
export function parseEventId(raw) {
  const m = /^(\d{1,12}):(\d{1,9})$/.exec(String(raw ?? "").trim());
  return m ? { block: Number(m[1]), logIndex: Number(m[2]) } : null;
}

/**
 * The last `max` events, oldest first. `floor` is the first block whose events are all here: replays from before it
 * get a gap notice. Trimming drops whole blocks, so a block is never half in the buffer.
 */
export function createBuffer(max = 10_000) {
  let events = [];
  let floor = 0;
  return {
    get size() {
      return events.length;
    },
    get floor() {
      return floor;
    },
    /** The relay starts reading at `block`: nothing before it was seen. */
    startAt(block) {
      floor = Math.max(floor, block);
    },
    push(list) {
      for (const ev of list) events.push(ev);
      if (events.length > max) {
        const cut = events[events.length - max - 1].block;
        events = events.filter((e) => e.block > cut);
        floor = Math.max(floor, cut + 1);
      }
    },
    /** Events after `after` ({block, logIndex}) or from block `from`, and whether older ones are missing. */
    replay({ after = null, from = null } = {}) {
      if (after) {
        const gap = after.block + 1 < floor;
        return { gap, events: events.filter((e) => e.block > after.block || (e.block === after.block && e.logIndex > after.logIndex)) };
      }
      if (from !== null) return { gap: from < floor, events: events.filter((e) => e.block >= from) };
      return { gap: false, events: [] };
    },
    latest(filter, limit) {
      const out = [];
      for (let i = events.length - 1; i >= 0 && out.length < limit; i--) if (matches(events[i], filter)) out.push(events[i]);
      return out.reverse();
    },
  };
}

// ─────────────────────────────── Chain ───────────────────────────────

/** Deployment and RPC settings from the environment (the same variables as the indexer and the keeper). */
export function chainSettings(env) {
  const file = env.DEPLOYMENT;
  const d = file ? JSON.parse(readFileSync(resolve(file), "utf8")) : {};
  for (const key of ["engine", "lens", "trailingStops", "twapOrders", "strategies", "agentRegistry", "prizeDistributor"]) {
    const name = `${key.replace(/[A-Z]/g, (c) => `_${c}`).toUpperCase()}_ADDRESS`;
    if (env[name]) d[key] = env[name];
  }
  if (env.PERP_ENGINE_ADDRESS) d.engine = env.PERP_ENGINE_ADDRESS;
  if (env.ENGINE_LENS_ADDRESS) d.lens = env.ENGINE_LENS_ADDRESS;
  if (!ADDRESS.test(d.engine ?? "")) throw new Error("missing engine address (DEPLOYMENT file or PERP_ENGINE_ADDRESS)");
  const chainId = Number(env.CHAIN_ID || d.chainId || 5042002);
  const urls = [
    ...new Set([
      ...(env.RPC_URLS ? env.RPC_URLS.split(/[\s,]+/).filter(Boolean) : []),
      ...(env.RPC_URL ? [env.RPC_URL] : []),
      ...(d.rpcUrl ? [d.rpcUrl] : []),
      ...(chainId === 5042002 ? ["https://rpc.testnet.arc.io", "https://rpc.quicknode.testnet.arc.io", "https://rpc.drpc.testnet.arc.io"] : []),
    ]),
  ];
  if (urls.length === 0) throw new Error("set RPC_URL or RPC_URLS");
  return { deployment: d, chainId, urls };
}

const toHex = (n) => `0x${n.toString(16)}`;

/** The relay's view of the chain over JSON-RPC: head, logs of some addresses, block times, eth_call. */
export function rpcSource(rpc) {
  const times = new Map();
  return {
    async head() {
      return Number(BigInt(await rpc.call("eth_blockNumber", [])));
    },
    async logs(from, to, addresses) {
      return rpc.call("eth_getLogs", [{ fromBlock: toHex(from), toBlock: toHex(to), address: addresses }]);
    },
    async blockTime(block) {
      if (times.has(block)) return times.get(block);
      const b = await rpc.call("eth_getBlockByNumber", [toHex(block), false]);
      const t = b ? Number(BigInt(b.timestamp)) : 0;
      times.set(block, t);
      if (times.size > 2_000) times.delete(times.keys().next().value);
      return t;
    },
    async call(to, data) {
      return rpc.call("eth_call", [{ to, data }, "latest"]);
    },
  };
}

/** Market symbols by lower-case id, from EngineLens.getMarkets(). */
export async function marketSymbols(source, lens) {
  const out = new Map();
  if (!lens) return out;
  const data = await source.call(lens, encodeFunctionData({ abi: engineLensAbi, functionName: "getMarkets" }));
  for (const m of decodeFunctionResult({ abi: engineLensAbi, functionName: "getMarkets", data })) out.set(m.id.toLowerCase(), m.market.symbol);
  return out;
}

/**
 * Follows the chain: each tick reads the logs of `contracts` from the cursor to the head (less `confirmations`), in
 * ranges of at most `logRange` blocks (halved on a range error), decodes them and hands them to `onEvents`.
 */
export function createFollower({ source, contracts, ctx, onEvents, logRange = 2_000, confirmations = 0, log = () => {} }) {
  const addresses = contracts.map((c) => c.address);
  let cursor = null;
  let range = logRange;
  let head = 0;
  return {
    get cursor() {
      return cursor;
    },
    get head() {
      return head;
    },
    /** Starts after block `block` (events from block + 1 on). */
    startAfter(block) {
      cursor = block;
    },
    async tick() {
      head = await source.head();
      const target = head - confirmations;
      if (cursor === null) cursor = target;
      let delivered = 0;
      while (cursor < target) {
        const to = Math.min(target, cursor + range);
        let raw;
        try {
          raw = await source.logs(cursor + 1, to, addresses);
        } catch (error) {
          if (isRangeError(error) && range > 1) {
            range = Math.max(1, Math.floor(range / 2));
            log(`log range halved to ${range}`);
            continue;
          }
          throw error;
        }
        const blocks = [...new Set(raw.map((l) => Number(BigInt(l.blockNumber))))];
        const times = new Map();
        for (const b of blocks) times.set(b, await source.blockTime(b));
        const events = raw
          .map((l) => decodeLog(l, contracts, ctx, (b) => times.get(b)))
          .filter(Boolean)
          .sort((a, b) => a.block - b.block || a.logIndex - b.logIndex);
        cursor = to;
        if (events.length > 0) onEvents(events);
        delivered += events.length;
      }
      return delivered;
    },
  };
}

// ─────────────────────────────── WebSocket (RFC 6455, the parts a relay needs) ───────────────────────────────

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export function acceptKey(key) {
  return createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
}

/** One unmasked frame (server to client), final, with `opcode`. */
export function encodeFrame(opcode, payload = Buffer.alloc(0)) {
  const body = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const n = body.length;
  const head = n < 126 ? Buffer.from([0x80 | opcode, n]) : n < 65_536 ? Buffer.from([0x80 | opcode, 126, n >> 8, n & 0xff]) : Buffer.concat([Buffer.from([0x80 | opcode, 127]), u64(n)]);
  return Buffer.concat([head, body]);
}

function u64(n) {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(BigInt(n));
  return b;
}

/**
 * Parses client frames (masked, as RFC 6455 requires) from a byte stream. Calls `onFrame(opcode, payload)` per
 * complete message and `onError(code, reason)` on a protocol violation. Fragmented messages are reassembled;
 * messages above `maxPayload` are refused.
 */
export function frameParser(onFrame, onReject, { maxPayload = 65_536 } = {}) {
  let buf = Buffer.alloc(0);
  let fragments = null;
  let fragmentOp = 0;
  let dead = false;
  // After a violation the stream is unusable: ignore everything that follows.
  const onError = (code, reason) => {
    dead = true;
    buf = Buffer.alloc(0);
    onReject(code, reason);
  };
  return (chunk) => {
    if (dead) return;
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    while (!dead && buf.length >= 2) {
      const fin = (buf[0] & 0x80) !== 0;
      const opcode = buf[0] & 0x0f;
      const masked = (buf[1] & 0x80) !== 0;
      let len = buf[1] & 0x7f;
      let offset = 2;
      if (len === 126) {
        if (buf.length < 4) return;
        len = buf.readUInt16BE(2);
        offset = 4;
      } else if (len === 127) {
        if (buf.length < 10) return;
        const big = buf.readBigUInt64BE(2);
        if (big > BigInt(maxPayload)) return onError(1009, "message too big");
        len = Number(big);
        offset = 10;
      }
      if (!masked) return onError(1002, "client frames must be masked");
      if (len > maxPayload) return onError(1009, "message too big");
      if (buf.length < offset + 4 + len) return;
      const mask = buf.subarray(offset, offset + 4);
      const payload = Buffer.from(buf.subarray(offset + 4, offset + 4 + len));
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
      buf = buf.subarray(offset + 4 + len);
      if (opcode >= 0x8) {
        if (!fin || len > 125) return onError(1002, "bad control frame");
        onFrame(opcode, payload);
        continue;
      }
      if (opcode === 0x0) {
        if (!fragments) return onError(1002, "continuation without a message");
        fragments.push(payload);
        if (fragments.reduce((s, p) => s + p.length, 0) > maxPayload) return onError(1009, "message too big");
        if (fin) {
          const whole = Buffer.concat(fragments);
          fragments = null;
          onFrame(fragmentOp, whole);
        }
        continue;
      }
      if (fragments) return onError(1002, "new message inside a fragmented one");
      if (opcode !== 0x1 && opcode !== 0x2) return onError(1003, "unknown opcode");
      if (fin) onFrame(opcode, payload);
      else {
        fragments = [payload];
        fragmentOp = opcode;
      }
    }
  };
}

// ─────────────────────────────── Clients ───────────────────────────────

const json = (v) => JSON.stringify(v);

/** One SSE stream: writes matching events, refuses to queue more than `maxQueue` bytes. */
export class SseClient {
  constructor(res, filter, { maxQueue, onClose }) {
    this.res = res;
    this.filter = filter;
    this.maxQueue = maxQueue;
    this.onClose = onClose;
    this.closed = false;
    res.on("close", () => this.close());
  }
  write(text) {
    if (this.closed) return false;
    if (this.res.writableLength + Buffer.byteLength(text) > this.maxQueue) {
      this.drop("slow consumer: too far behind the stream; reconnect with Last-Event-ID to resume");
      return false;
    }
    this.res.write(text);
    return true;
  }
  event(ev) {
    if (matches(ev, this.filter)) this.write(`id: ${ev.id}\nevent: ${ev.name}\ndata: ${json(ev)}\n\n`);
  }
  notice(type, data) {
    this.write(`event: ${type}\ndata: ${json({ type, ...data })}\n\n`);
  }
  heartbeat() {
    this.write(`: ${Date.now()}\n\n`);
  }
  drop(reason) {
    if (this.closed) return;
    this.dropped = reason;
    // Past the queue limit on purpose: this is the last thing the client gets.
    this.res.end(`event: error\ndata: ${json({ type: "error", error: reason })}\n\n`);
    this.close();
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    this.onClose(this);
  }
}

/** One WebSocket peer: JSON text messages out, subscribe and ping messages in, pings to detect a dead peer. */
export class WsClient {
  constructor(socket, filter, { maxQueue, onClose, onMessage }) {
    this.socket = socket;
    this.filter = filter;
    this.maxQueue = maxQueue;
    this.onClose = onClose;
    this.closed = false;
    this.alive = true;
    const parse = frameParser(
      (opcode, payload) => {
        if (opcode === 0x8) return this.close(1000, "");
        if (opcode === 0x9) return this.frame(0xa, payload);
        if (opcode === 0xa) return void (this.alive = true);
        if (opcode === 0x2) return this.close(1003, "text frames only");
        let msg;
        try {
          msg = JSON.parse(payload.toString("utf8"));
        } catch {
          return this.send({ type: "error", error: "messages are JSON" });
        }
        onMessage(this, msg);
      },
      (code, reason) => this.close(code, reason),
    );
    socket.on("data", (chunk) => {
      this.alive = true;
      parse(chunk);
    });
    socket.on("close", () => this.gone());
    socket.on("error", () => this.gone());
  }
  frame(opcode, payload) {
    if (this.closed) return false;
    if (this.socket.writableLength + payload.length > this.maxQueue) {
      this.drop("slow consumer: too far behind the stream; reconnect with from= to resume");
      return false;
    }
    this.socket.write(encodeFrame(opcode, payload));
    return true;
  }
  send(obj) {
    return this.frame(0x1, Buffer.from(json(obj)));
  }
  event(ev) {
    if (matches(ev, this.filter)) this.send({ type: "event", ...ev });
  }
  notice(type, data) {
    this.send({ type, ...data });
  }
  heartbeat() {
    if (!this.alive) return this.close(1001, "no pong");
    this.alive = false;
    this.frame(0x9, Buffer.alloc(0));
  }
  drop(reason) {
    if (this.closed) return;
    this.dropped = reason;
    this.socket.write(encodeFrame(0x1, Buffer.from(json({ type: "error", error: reason }))));
    this.close(1013, "slow consumer");
  }
  close(code = 1000, reason = "") {
    if (this.closed) return;
    const r = Buffer.from(String(reason).slice(0, 120));
    const payload = Buffer.concat([Buffer.from([code >> 8, code & 0xff]), r]);
    try {
      this.socket.write(encodeFrame(0x8, payload));
      this.socket.end();
    } catch {
      // Already gone.
    }
    this.gone();
  }
  gone() {
    if (this.closed) return;
    this.closed = true;
    this.socket.destroySoon?.();
    this.onClose(this);
  }
}

// ─────────────────────────────── Server ───────────────────────────────

const DEFAULT_LIMITS = { maxClients: 500, maxClientsPerIp: 20, maxQueueBytes: 1 << 20, maxFilterValues: 50, maxBufferedEvents: 10_000 };

/**
 * The relay: an HTTP server streaming `buffer`'s events as they are published with `publish(events)`. The chain
 * side (createFollower) is wired up by `startRelay`; tests drive `publish` directly.
 */
export function createRelay({ limits: given = {}, heartbeatMs = 15_000, trustProxy = false, status = () => ({}), log = () => {} } = {}) {
  const limits = { ...DEFAULT_LIMITS, ...given };
  const buffer = createBuffer(limits.maxBufferedEvents);
  const clients = new Set();
  const perIp = new Map();
  const counters = { connected: 0, dropped: 0, refused: 0, events: 0 };

  const ipOf = (req) => {
    const fwd = trustProxy ? String(req.headers["x-forwarded-for"] ?? "").split(",")[0].trim() : "";
    return fwd || req.socket.remoteAddress || "?";
  };
  const admit = (ip) => {
    if (clients.size >= limits.maxClients || (perIp.get(ip) ?? 0) >= limits.maxClientsPerIp) {
      counters.refused += 1;
      return false;
    }
    perIp.set(ip, (perIp.get(ip) ?? 0) + 1);
    return true;
  };
  const release = (ip, client) => {
    if (!clients.delete(client)) return;
    const n = (perIp.get(ip) ?? 1) - 1;
    if (n <= 0) perIp.delete(ip);
    else perIp.set(ip, n);
    if (client.dropped) counters.dropped += 1;
  };

  /** The hello, then what a reconnecting client missed (Last-Event-ID or `from`), then live events. */
  function start(client, { after, from }) {
    clients.add(client);
    counters.connected += 1;
    client.notice("hello", { head: status().head ?? null, cursor: status().cursor ?? null, oldest: buffer.floor, filter: describeFilter(client.filter) });
    replay(client, { after, from });
  }
  function replay(client, { after = null, from = null }) {
    if (!after && from === null) return;
    const r = buffer.replay({ after, from });
    if (r.gap) client.notice("gap", { from: after ? after.block : from, oldest: buffer.floor });
    for (const ev of r.events) {
      if (client.closed) return;
      client.event(ev);
    }
  }

  const cors = { "access-control-allow-origin": "*", "access-control-allow-headers": "last-event-id, content-type", "access-control-allow-methods": "GET, OPTIONS" };
  const reply = (res, code, body) => {
    res.writeHead(code, { ...cors, "content-type": "application/json", "cache-control": "no-store" });
    res.end(json(body));
  };
  const query = (url) => {
    const q = {};
    for (const k of ["market", "trader", "event"]) q[k] = url.searchParams.getAll(k);
    return q;
  };
  const fromOf = (url) => {
    const raw = url.searchParams.get("from");
    if (raw === null || raw === "") return null;
    if (!/^\d{1,12}$/.test(raw)) throw new FilterError("from is a block number");
    return Number(raw);
  };

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://relay");
    if (req.method === "OPTIONS") {
      res.writeHead(204, cors);
      return res.end();
    }
    if (req.method !== "GET") return reply(res, 405, { error: "GET only" });
    if (url.pathname === "/health") {
      return reply(res, 200, { ok: true, ...status(), buffered: buffer.size, oldest: buffer.floor, clients: clients.size, ...counters });
    }
    if (url.pathname === "/") {
      return reply(res, 200, { endpoints: ["/events (SSE)", "/ws (WebSocket)", "/recent", "/health"], filters: ["market", "trader", "event", "from"] });
    }
    let filter;
    let from;
    try {
      filter = parseFilter(query(url), { maxValues: limits.maxFilterValues });
      from = fromOf(url);
    } catch (error) {
      if (error instanceof FilterError) return reply(res, 400, { error: error.message });
      throw error;
    }
    if (url.pathname === "/recent") {
      const limit = Math.max(1, Math.min(1_000, Number(url.searchParams.get("limit")) || 100));
      return reply(res, 200, buffer.latest(filter, limit));
    }
    if (url.pathname !== "/events") return reply(res, 404, { error: "not found" });
    const ip = ipOf(req);
    if (!admit(ip)) return reply(res, 503, { error: "too many streams; try again later" });
    res.writeHead(200, { ...cors, "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", connection: "keep-alive", "x-accel-buffering": "no" });
    res.write("retry: 3000\n\n");
    req.socket.setNoDelay?.(true);
    const client = new SseClient(res, filter, { maxQueue: limits.maxQueueBytes, onClose: (c) => release(ip, c) });
    const after = parseEventId(req.headers["last-event-id"] ?? url.searchParams.get("lastEventId"));
    start(client, { after, from: after ? null : from });
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://relay");
    const key = req.headers["sec-websocket-key"];
    const refuse = (code, text) => {
      socket.end(`HTTP/1.1 ${code} ${text}\r\nconnection: close\r\ncontent-type: text/plain\r\n\r\n${text}\n`);
    };
    if (url.pathname !== "/ws" || String(req.headers.upgrade ?? "").toLowerCase() !== "websocket" || typeof key !== "string" || req.headers["sec-websocket-version"] !== "13") {
      return refuse(400, "Bad Request");
    }
    let filter;
    let from;
    try {
      filter = parseFilter(query(url), { maxValues: limits.maxFilterValues });
      from = fromOf(url);
    } catch (error) {
      return refuse(400, error instanceof FilterError ? error.message : "Bad Request");
    }
    const ip = ipOf(req);
    if (!admit(ip)) return refuse(503, "Service Unavailable");
    socket.write(["HTTP/1.1 101 Switching Protocols", "Upgrade: websocket", "Connection: Upgrade", `Sec-WebSocket-Accept: ${acceptKey(key)}`, "", ""].join("\r\n"));
    socket.setNoDelay?.(true);
    // Bytes that arrived with the upgrade request belong to the first frame.
    if (head?.length) socket.unshift(head);
    const client = new WsClient(socket, filter, {
      maxQueue: limits.maxQueueBytes,
      onClose: (c) => release(ip, c),
      onMessage: (c, msg) => {
        if (msg?.type === "ping") return c.send({ type: "pong", time: Date.now() });
        if (msg?.type !== "subscribe") return c.send({ type: "error", error: 'send {"type":"subscribe",…} or {"type":"ping"}' });
        try {
          c.filter = parseFilter(msg, { maxValues: limits.maxFilterValues });
          const f = msg.from === undefined || msg.from === null ? null : Number(msg.from);
          if (f !== null && !(Number.isSafeInteger(f) && f >= 0)) throw new FilterError("from is a block number");
          c.send({ type: "subscribed", filter: describeFilter(c.filter) });
          replay(c, { from: f });
        } catch (error) {
          c.send({ type: "error", error: error instanceof FilterError ? error.message : "bad subscribe message" });
        }
      },
    });
    start(client, { after: null, from });
  });

  const beat = setInterval(() => {
    for (const c of clients) c.heartbeat();
  }, heartbeatMs);
  beat.unref();

  return {
    server,
    buffer,
    clients,
    counters,
    /** Adds events (oldest first) to the buffer and sends them to every client whose filter matches. */
    publish(events) {
      buffer.push(events);
      counters.events += events.length;
      for (const ev of events) for (const c of clients) if (!c.closed) c.event(ev);
    },
    close() {
      clearInterval(beat);
      for (const c of [...clients]) (c instanceof WsClient ? c.close(1001, "relay stopping") : c.res.end());
      return new Promise((r) => server.close(() => r()));
    },
  };
}

/** The relay wired to a chain: follows `source` and publishes what it decodes. */
export async function startRelay({ source, deployment, port = 8091, host = "0.0.0.0", pollMs = 2_000, backfill = 5_000, startBlock = null, logRange = 2_000, confirmations = 0, heartbeatMs = 15_000, limits = {}, trustProxy = false, log = () => {} }) {
  const contracts = contractsOf(deployment);
  const ctx = decodeContext(await marketSymbols(source, deployment.lens).catch((error) => (log(`market symbols unavailable: ${error?.message ?? error}`), new Map())));
  let follower;
  const relay = createRelay({ limits, heartbeatMs, trustProxy, log, status: () => ({ head: follower?.head ?? null, cursor: follower?.cursor ?? null, contracts: contracts.map((c) => c.key) }) });
  follower = createFollower({ source, contracts, ctx, logRange, confirmations, log, onEvents: (events) => relay.publish(events) });
  const head = await source.head();
  const first = startBlock !== null ? startBlock : Math.max(0, head - confirmations - backfill + 1);
  follower.startAfter(first - 1);
  relay.buffer.startAt(first);
  let stopped = false;
  let failures = 0;
  const loop = async () => {
    while (!stopped) {
      try {
        const n = await follower.tick();
        if (n > 0) log(`${n} events up to block ${follower.cursor}`);
        failures = 0;
      } catch (error) {
        failures += 1;
        log(`poll failed (${failures}): ${String(error?.message ?? error).split("\n")[0]}`);
      }
      await new Promise((r) => setTimeout(r, Math.min(pollMs * 2 ** Math.min(failures, 5), 60_000)));
    }
  };
  await new Promise((r) => relay.server.listen(port, host, r));
  log(`streaming ${contracts.map((c) => c.key).join(", ")} from block ${first} on http://${host}:${relay.server.address().port}`);
  const running = loop();
  return {
    ...relay,
    follower,
    async stop() {
      stopped = true;
      await relay.close();
      await running.catch(() => {});
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isMain) {
  const env = process.env;
  const log = (...m) => console.log(new Date().toISOString(), "[relay]", ...m);
  const num = (v, d) => (v === undefined || v === "" ? d : Number(v));
  const { deployment, urls } = chainSettings(env);
  const relay = await startRelay({
    source: rpcSource(makeRpc(urls, { log })),
    deployment,
    port: num(env.PORT, 8091),
    host: env.HOST || "0.0.0.0",
    pollMs: num(env.POLL_MS, 2_000),
    backfill: num(env.BACKFILL_BLOCKS, 5_000),
    startBlock: env.START_BLOCK ? Number(env.START_BLOCK) : null,
    logRange: num(env.LOG_RANGE, 2_000),
    confirmations: num(env.CONFIRMATIONS, 0),
    heartbeatMs: num(env.HEARTBEAT_SECONDS, 15) * 1000,
    trustProxy: env.TRUST_PROXY === "1",
    limits: {
      maxClients: num(env.MAX_CLIENTS, 500),
      maxClientsPerIp: num(env.MAX_CLIENTS_PER_IP, 20),
      maxQueueBytes: num(env.MAX_QUEUE_BYTES, 1 << 20),
      maxFilterValues: num(env.MAX_FILTER_VALUES, 50),
      maxBufferedEvents: num(env.MAX_BUFFERED_EVENTS, 10_000),
    },
    log,
  });
  for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => void relay.stop().then(() => process.exit(0)));
}
