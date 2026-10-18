// The two off-chain roles a Dry Powder deployment on a publisher oracle needs:
//
//  publisher  reads Kraken, signs PublisherOracle updates and pushes a heartbeat on-chain when a feed is
//             older than the heartbeat or has moved more than `moveBps` (for readers: the app, direct traders).
//             Every keeper transaction carries its own freshly signed prices, so fills never wait for a push.
//  keeper     executes triggered orders (including keeper-filled market orders), liquidates, settles dated
//             markets and their positions, and settles vault epochs. Every call is simulated first, so a lost
//             race costs nothing.
//
// It holds no state that matters: everything is re-read from the chain each tick, so it can be restarted,
// moved between hosts or run on a schedule.
import { formatEther, parseEther, toFunctionSelector } from "viem";
import * as ABIS from "./abi.mjs";
import { engineLensAbi, houseVaultAbi, perpEngineAbi, publisherOracleAbi } from "./abi.mjs";

// Errors raised by any protocol contract, so a revert deep in the vault or the oracle is decoded by name.
const ERRORS = [...new Map(Object.values(ABIS).flat().filter((x) => x.type === "error").map((x) => [x.name + x.inputs.length, x])).values()];
import { FEEDS, FEED_BY_ID, quoteToPrice, signUpdate } from "./feeds.mjs";

const E18 = 10n ** 18n;
const GWEI = 10n ** 9n;
const PAGE = 200n;
// Reverts that mean "lost a race" or "not yet", not a fault.
const BENIGN = new Set([
  "NothingToLiquidate", "OrderNotFound", "TriggerNotMet", "PriceBeforeOrder", "PriceNotAfterOpen", "PositionLiquidatable",
  "PositionExists", "OraclePriceStale", "InvalidTrigger", "EnforcedPause", "MarketDisabled", "LeverageOutOfRange",
  "MarginTooLow", "MarketOiCapExceeded", "VaultOiCapExceeded", "MarketExpired", "PositionNotFound", "EpochNotOver",
  "MarketAlreadySettled", "PriceBeforeExpiry", "MarketNotExpired", "MarketNotSettled", "OracleConfidenceTooWide",
  "OraclePriceUnavailable",
]);

// Selector -> error name, for reverts viem reports only by signature.
const BY_SELECTOR = new Map(ERRORS.map((x) => [toFunctionSelector(`${x.name}(${x.inputs.map((i) => i.type).join(",")})`), x.name]));

const revertName = (e) => {
  let x = e;
  while (x) {
    if (x.data?.errorName) return x.data.errorName;
    if (typeof x.signature === "string" && BY_SELECTOR.has(x.signature)) return BY_SELECTOR.get(x.signature);
    x = x.cause;
  }
  const sel = /signature:\s*(0x[0-9a-fA-F]{8})/.exec(String(e?.message ?? ""));
  if (sel && BY_SELECTOR.has(sel[1].toLowerCase())) return BY_SELECTOR.get(sel[1].toLowerCase());
  const m = /reverted with the following reason:\s*\n?\s*([A-Za-z]+)|Error: ([A-Za-z]+)\(/.exec(String(e?.message ?? ""));
  return m ? m[1] || m[2] : null;
};

/** Mirrors PerpEngine trigger conditions (0 LimitOpen, 1 TakeProfit, 2 StopLoss, 3 Close). */
export function triggered(type, isLong, trigger, px) {
  if (type === 0) return isLong ? px.ask <= trigger : px.bid >= trigger;
  if (type === 1) return isLong ? px.mid >= trigger : px.mid <= trigger;
  if (type === 2) return isLong ? px.mid <= trigger : px.mid >= trigger;
  return trigger === 0n || (isLong ? px.bid >= trigger : px.ask <= trigger);
}
/** Lens liquidation price (PositionMath.liquidationPrice): a long at or below it, a short at or above it.
 *  Zero means a long no price can liquidate, or a short every price does; both fall out of the comparison. */
export const isLiquidatable = (isLong, lp, mid) => (isLong ? mid <= lp : mid >= lp);

export function makeOperator({ pub, publisher, keeper, funder, chainId, addresses, kraken, opts, log }) {
  const { engine, lens, vault, oracle } = addresses;
  const stats = { ticks: 0, pushes: 0, feedsPushed: 0, executed: 0, liquidated: 0, settledMarkets: 0, settledPositions: 0, epochs: 0, topUps: 0, benign: {}, errors: {}, wideFeeds: {}, lastError: null };
  const backoff = new Map(); // id -> [count, until]
  const ready = (id) => !backoff.has(id) || Date.now() >= backoff.get(id)[1];
  const defer = (id) => {
    const n = (backoff.get(id)?.[0] ?? 0) + 1;
    backoff.set(id, [n, Date.now() + Math.min(60_000, 500 * 2 ** n)]);
  };
  const count = (bucket, k) => (bucket[k] = (bucket[k] ?? 0) + 1);
  const settledSeen = new Map();
  let lastPublish = 0;
  let lastTopUp = 0;
  let krakenOk = false;
  let maxConfBps = 50n;

  async function fees() {
    const block = await pub.getBlock();
    const base = block.baseFeePerGas ?? 20n * GWEI;
    const tip = BigInt(opts.priorityFeeGwei) * GWEI;
    let max = base * 2n + tip;
    const floor = BigInt(opts.minFeeGwei) * GWEI;
    if (max < floor) max = floor;
    return { maxFeePerGas: max, maxPriorityFeePerGas: tip };
  }

  /** Simulate, then send and wait. Returns the receipt, or null when the call would revert benignly. */
  async function send(wallet, address, abi, functionName, args, id) {
    if (id && !ready(id)) return null;
    try {
      const { request } = await pub.simulateContract({ account: wallet.account, address, abi: [...abi, ...ERRORS], functionName, args });
      if (opts.dryRun) {
        log("dry-run", functionName, JSON.stringify(args, (_, v) => (typeof v === "bigint" ? String(v) : v)).slice(0, 160));
        return null;
      }
      const hash = await wallet.writeContract({ ...request, ...(await fees()) });
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
      if (receipt.status !== "success") throw new Error(`${functionName} reverted on-chain: ${hash}`);
      if (id) backoff.delete(id);
      return receipt;
    } catch (e) {
      const name = revertName(e);
      if (name && BENIGN.has(name)) count(stats.benign, name);
      else {
        count(stats.errors, name ?? functionName);
        const msg = String(e?.shortMessage ?? e?.message ?? e).split("\n").map((l) => l.trim()).filter(Boolean);
        stats.lastError = `${functionName}: ${msg.slice(0, 2).join(" ").slice(0, 240)}`;
        log("error", stats.lastError);
      }
      if (id) defer(id);
      return null;
    }
  }

  async function readAll() {
    const [markets, pc, oc] = await Promise.all([
      pub.readContract({ address: lens, abi: engineLensAbi, functionName: "getMarkets" }),
      pub.readContract({ address: engine, abi: perpEngineAbi, functionName: "positionCount" }),
      pub.readContract({ address: engine, abi: perpEngineAbi, functionName: "orderCount" }),
    ]);
    const posPages = [];
    for (let o = 0n; o < pc; o += PAGE) posPages.push(pub.readContract({ address: lens, abi: engineLensAbi, functionName: "getPositions", args: [o, PAGE] }));
    const ordPages = [];
    for (let o = 0n; o < oc; o += PAGE) ordPages.push(pub.readContract({ address: lens, abi: engineLensAbi, functionName: "getOrders", args: [o, PAGE] }));
    const [posRes, ordRes] = await Promise.all([Promise.all(posPages), Promise.all(ordPages)]);
    const positions = posRes.flat();
    const orders = [];
    for (const [ids, list] of ordRes) list.forEach((o, i) => orders.push({ id: ids[i], ...o }));
    return { markets, positions, orders };
  }

  async function onchainFeeds() {
    const out = new Map();
    await Promise.all(
      FEEDS.map(async (f) => {
        try {
          const p = await pub.readContract({ address: oracle, abi: publisherOracleAbi, functionName: "getPriceUnsafe", args: [f.id] });
          out.set(f.key, { publishTime: Number(p.publishTime), mid: Number(p.price) * 10 ** p.expo });
        } catch {
          out.set(f.key, { publishTime: 0, mid: 0 });
        }
      }),
    );
    return out;
  }

  const feedsOf = (m) => {
    const out = [];
    const a = FEED_BY_ID.get(m.market.feedId.toLowerCase());
    if (a) out.push(a);
    const b = FEED_BY_ID.get(m.market.quoteFeedId.toLowerCase());
    if (b) out.push(b);
    return out;
  };

  /** Heartbeat for readers (the app, direct traders): pushes feeds that are old or have moved. Keeper
   *  transactions carry their own fresh prices, so nothing here is needed for fills or liquidations. */
  async function publish(chainNow, oc) {
    const publishTime = Math.max(lastPublish + 1, Math.min(Math.floor(Date.now() / 1000), chainNow + 1));
    const updates = [];
    for (const f of FEEDS) {
      const q = kraken.quote(f);
      if (!q) continue;
      const { price, conf, mid } = quoteToPrice(f, q.bid, q.ask);
      // The engine refuses prices with a wider confidence; publishing them only buys reverts.
      if (conf * 10_000n > price * maxConfBps) { count(stats.wideFeeds, f.key); continue; }
      const cur = oc.get(f.key);
      const age = chainNow - cur.publishTime;
      const moved = cur.mid ? Math.abs(mid / cur.mid - 1) * 1e4 : Infinity;
      if (!(age >= opts.heartbeatSeconds || moved >= opts.moveBps)) continue;
      if (publishTime <= cur.publishTime) continue;
      updates.push({ f, data: await signUpdate(publisher.account, chainId, oracle, f, price, conf, publishTime) });
    }
    if (!updates.length) return false;
    const r = await send(publisher, oracle, publisherOracleAbi, "updatePriceFeeds", [updates.map((u) => u.data)]);
    if (!r) return false;
    lastPublish = publishTime;
    stats.pushes++;
    stats.feedsPushed += updates.length;
    return true;
  }

  /** Signed updates for this tick, one per feed, all stamped `pt` (lazily signed). */
  function freshFeeds(pt) {
    const cache = new Map();
    return async (f) => {
      if (cache.has(f.key)) return cache.get(f.key);
      const q = kraken.quote(f);
      let out = null;
      if (q) {
        const { price, conf } = quoteToPrice(f, q.bid, q.ask);
        if (conf * 10_000n > price * maxConfBps) {
          count(stats.wideFeeds, f.key);
          cache.set(f.key, null);
          return null;
        }
        const scale = 10n ** BigInt(18 + f.expo);
        out = { mid: price * scale, bid: (price - conf) * scale, ask: (price + conf) * scale, data: await signUpdate(publisher.account, chainId, oracle, f, price, conf, pt) };
      }
      cache.set(f.key, out);
      return out;
    };
  }

  /** Price the engine will see for `m` with the fresh updates (PythOracle.peek arithmetic), and those updates.
   *  Settled markets use the settlement price; without Kraken, falls back to the stored price and no updates. */
  async function priceFor(m, fresh, pt) {
    if (m.market.settlementPrice !== 0n) return m.hasPrice ? { px: m.price, upd: [], pt: Number(m.price.publishTime) } : null;
    const feeds = feedsOf(m);
    const legs = [];
    for (const f of feeds) legs.push(await fresh(f));
    if (krakenOk && legs.length && legs.every(Boolean)) {
      let [a] = legs;
      let { bid, ask, mid } = a;
      if (legs[1]) {
        const b = legs[1];
        bid = (bid * E18) / b.ask;
        ask = (ask * E18 + b.bid - 1n) / b.bid;
        mid = (mid * E18) / b.mid;
      }
      if (m.market.invert) {
        const one = E18 * E18;
        [bid, ask] = [one / ask, (one + bid - 1n) / bid];
        mid = one / mid;
      }
      return { px: { bid, ask, mid }, upd: legs.map((l) => l.data), pt };
    }
    return m.hasPrice ? { px: m.price, upd: [], pt: Number(m.price.publishTime) } : null;
  }

  async function keep(chainNow, view) {
    const byId = new Map(view.markets.map((m) => [m.id.toLowerCase(), m]));
    // Stamped at the chain's clock (never ahead of the 2 s allowance, never older than the block being built on).
    // A busy tick can outlast a short maxPriceAge, so prices are re-stamped (and re-signed) every second.
    // The chain's clock can run ahead of the wall clock (a local chain gives every block its own second), so
    // re-stamping reads the latest block rather than assuming one second per second.
    let pt, fresh, prices, stampedAt;
    const restamp = (now) => {
      pt = Math.max(now, Math.min(Math.floor(Date.now() / 1000), now + 1));
      fresh = freshFeeds(pt);
      prices = new Map();
      stampedAt = Date.now();
    };
    restamp(chainNow);
    const P = async (m) => {
      if (Date.now() - stampedAt > 1_000) restamp(Number((await pub.getBlock()).timestamp));
      return prices.has(m.id) ? prices.get(m.id) : prices.set(m.id, await priceFor(m, fresh, pt)).get(m.id);
    };
    const merge = (lists) => [...new Set(lists.flat())];

    // 1. Liquidations first: they protect the vault.
    const liq = [];
    for (const v of view.positions) {
      const m = byId.get(v.position.priceId.toLowerCase());
      if (!m || m.market.settlementPrice !== 0n || !ready(v.key)) continue;
      const p = await P(m);
      if (p && isLiquidatable(v.position.isLong, v.liquidationPrice, p.px.mid)) liq.push({ key: v.key, upd: p.upd });
    }
    for (let i = 0; i < liq.length; i += opts.batchSize) {
      const batch = liq.slice(i, i + opts.batchSize);
      const r = await send(keeper, engine, perpEngineAbi, "liquidateBatch", [batch.map((x) => x.key), merge(batch.map((x) => x.upd))], `liq:${batch[0].key}`);
      if (r) stats.liquidated += batch.length;
    }
    // 2. Dated markets: fix the settlement price (a price published at or after expiry), then close what is left.
    for (const m of view.markets) {
      const exp = Number(m.market.expiry);
      if (!exp || chainNow < exp) continue;
      if (m.market.settlementPrice === 0n) {
        if (chainNow < exp + opts.settleMarketDelaySeconds) continue;
        const p = await P(m);
        if (!p || p.pt < exp) continue;
        const r = await send(keeper, engine, perpEngineAbi, "settleMarket", [m.id, p.upd], `settle:${m.id}`);
        if (r) stats.settledMarkets++;
        continue;
      }
      // Leave traders time to close at the settlement price themselves before sweeping what is left.
      const seen = settledSeen.get(m.id) ?? settledSeen.set(m.id, Date.now()).get(m.id);
      if (Date.now() - seen < opts.settlePositionsDelaySeconds * 1000) continue;
      const keys = view.positions.filter((v) => v.position.priceId.toLowerCase() === m.id.toLowerCase() && ready(v.key)).map((v) => v.key);
      for (let i = 0; i < keys.length; i += opts.batchSize) {
        const batch = keys.slice(i, i + opts.batchSize);
        const r = await send(keeper, engine, perpEngineAbi, "settlePositions", [batch], `settleP:${batch[0]}`);
        if (r) stats.settledPositions += batch.length;
      }
    }
    // 3. Orders whose condition holds at the price the fill will use.
    const liqSet = new Set(liq.map((x) => x.key.toLowerCase()));
    const posBy = new Map(view.positions.map((v) => [v.position.trader.toLowerCase() + v.position.priceId.toLowerCase(), v]));
    for (const o of view.orders) {
      const id = `o:${o.id}`;
      if (!ready(id)) continue;
      const m = byId.get(o.priceId.toLowerCase());
      if (!m) continue;
      const pos = posBy.get(o.trader.toLowerCase() + o.priceId.toLowerCase());
      if (o.orderType === 0) {
        if (pos) continue;
        if (Number(m.market.expiry) && chainNow >= Number(m.market.expiry)) continue;
      } else if (!pos || liqSet.has(pos.key.toLowerCase())) continue;
      const p = await P(m);
      if (!p) continue;
      if (m.market.settlementPrice === 0n) {
        if (p.pt < Number(o.createdAt)) continue;
        if (pos && p.pt <= Number(pos.position.openedAt)) continue;
      }
      if (!triggered(o.orderType, pos ? pos.position.isLong : o.isLong, o.triggerPrice, p.px)) continue;
      const r = await send(keeper, engine, perpEngineAbi, "executeOrder", [o.id, p.upd], id);
      if (r) stats.executed++;
    }
    // 4. Vault epoch.
    if (!opts.settleEpochs) return;
    const [last, len] = await Promise.all([
      pub.readContract({ address: vault, abi: houseVaultAbi, functionName: "lastEpochTime" }),
      pub.readContract({ address: vault, abi: houseVaultAbi, functionName: "epochLength" }),
    ]);
    if (chainNow >= Number(last + len)) {
      const r = await send(keeper, vault, houseVaultAbi, "settleEpoch", [], "epoch");
      if (r) stats.epochs++;
    }
  }

  async function topUp() {
    if (!funder || Date.now() - lastTopUp < 300_000) return;
    lastTopUp = Date.now();
    const min = parseEther(String(opts.minGas));
    const amount = parseEther(String(opts.topUp));
    for (const w of [publisher, keeper]) {
      if (w.account.address.toLowerCase() === funder.account.address.toLowerCase()) continue;
      const bal = await pub.getBalance({ address: w.account.address });
      if (bal >= min) continue;
      try {
        const hash = await funder.sendTransaction({ to: w.account.address, value: amount, ...(await fees()) });
        await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
        stats.topUps++;
        log("gas", `topped up ${w.account.address} with ${formatEther(amount)} USDC`);
      } catch (e) {
        count(stats.errors, "topUp");
        stats.lastError = `topUp: ${String(e?.shortMessage ?? e?.message ?? e).split("\n")[0]}`;
      }
    }
  }

  async function tick() {
    stats.ticks++;
    try {
      await kraken.poll();
      krakenOk = true;
    } catch (e) {
      krakenOk = false;
      count(stats.errors, "kraken");
      stats.lastError = `kraken: ${String(e?.message ?? e)}`;
    }
    await topUp();
    if (stats.ticks % 100 === 1) maxConfBps = await pub.readContract({ address: engine, abi: perpEngineAbi, functionName: "maxConfBps" }).catch(() => maxConfBps);
    const block = await pub.getBlock();
    const chainNow = Number(block.timestamp);
    if (krakenOk) await publish(chainNow, await onchainFeeds());
    const view = await readAll();
    await keep(chainNow, view);
    return { chainNow, positions: view.positions.length, orders: view.orders.length };
  }

  return { tick, stats, krakenOk: () => krakenOk };
}

export const _test = { E18 };
