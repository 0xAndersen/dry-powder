// The two off-chain roles a Dry Powder deployment on a publisher oracle needs:
//
//  publisher  reads Kraken, signs PublisherOracle updates and pushes them on-chain only when useful: a feed is
//             older than the heartbeat, moved more than `moveBps`, or a pending order, liquidation or expiry needs
//             a newer price than the one stored.
//  keeper     executes triggered orders (including keeper-filled market orders), liquidates, settles dated
//             markets and their positions, and settles vault epochs. Every call is simulated first, so a lost
//             race costs nothing.
//
// It holds no state that matters: everything is re-read from the chain each tick, so it can be restarted,
// moved between hosts or run on a schedule.
import { formatEther, parseEther } from "viem";
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
  "MarketAlreadySettled", "PriceBeforeExpiry", "MarketNotExpired", "MarketNotSettled",
]);

const revertName = (e) => {
  let x = e;
  while (x) {
    if (x.data?.errorName) return x.data.errorName;
    x = x.cause;
  }
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
  const stats = { ticks: 0, pushes: 0, feedsPushed: 0, executed: 0, liquidated: 0, settledMarkets: 0, settledPositions: 0, epochs: 0, topUps: 0, benign: {}, errors: {}, lastError: null };
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
    const positions = (await Promise.all(posPages)).flat();
    const orders = [];
    for (const [ids, list] of await Promise.all(ordPages)) list.forEach((o, i) => orders.push({ id: ids[i], ...o }));
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

  /** Float price of a market from the Kraken quotes (decision only; the chain decides exactly). */
  function offchainPrice(m) {
    const base = FEED_BY_ID.get(m.market.feedId.toLowerCase());
    const qb = base && kraken.quote(base);
    if (!qb) return null;
    let bid = qb.bid, ask = qb.ask;
    if (m.market.quoteFeedId !== "0x" + "0".repeat(64)) {
      const qf = FEED_BY_ID.get(m.market.quoteFeedId.toLowerCase());
      const qq = qf && kraken.quote(qf);
      if (!qq) return null;
      [bid, ask] = [bid / qq.ask, ask / qq.bid];
    }
    if (m.market.invert) [bid, ask] = [1 / ask, 1 / bid];
    const s = (x) => BigInt(Math.round(x * 1e9)) * 10n ** 9n;
    return { bid: s(bid), ask: s(ask), mid: s((bid + ask) / 2) };
  }

  const feedsOf = (m) => {
    const out = [];
    const a = FEED_BY_ID.get(m.market.feedId.toLowerCase());
    if (a) out.push(a);
    const b = FEED_BY_ID.get(m.market.quoteFeedId.toLowerCase());
    if (b) out.push(b);
    return out;
  };

  async function publish(chainNow, view, oc) {
    const need = new Set();
    const byId = new Map(view.markets.map((m) => [m.id.toLowerCase(), m]));
    const posBy = new Map(view.positions.map((v) => [v.position.trader.toLowerCase() + v.position.priceId.toLowerCase(), v]));
    const minPt = (m) => Math.min(...feedsOf(m).map((f) => oc.get(f.key)?.publishTime ?? 0));
    // Orders that the stored price cannot fill yet but a fresh one would (keeper-filled market orders above all).
    for (const o of view.orders) {
      const m = byId.get(o.priceId.toLowerCase());
      if (!m || m.market.settlementPrice !== 0n) continue;
      const fresh = offchainPrice(m);
      if (!fresh) continue;
      const pos = posBy.get(o.trader.toLowerCase() + o.priceId.toLowerCase());
      if (o.orderType !== 0 && !pos) continue;
      if (o.orderType === 0 && pos) continue;
      const isLong = pos ? pos.position.isLong : o.isLong;
      const stale = minPt(m) < Number(o.createdAt) || (pos && minPt(m) <= Number(pos.position.openedAt));
      const metNow = m.hasPrice && triggered(o.orderType, isLong, o.triggerPrice, m.price);
      if (triggered(o.orderType, isLong, o.triggerPrice, fresh) && (stale || !metNow)) feedsOf(m).forEach((f) => need.add(f.key));
    }
    // Positions a fresh price would liquidate.
    for (const v of view.positions) {
      const m = byId.get(v.position.priceId.toLowerCase());
      if (!m || m.market.settlementPrice !== 0n) continue;
      const fresh = offchainPrice(m);
      if (fresh && isLiquidatable(v.position.isLong, v.liquidationPrice, fresh.mid)) feedsOf(m).forEach((f) => need.add(f.key));
    }
    // Expired dated markets need a price published at or after expiry.
    for (const m of view.markets) {
      const exp = Number(m.market.expiry);
      if (exp && m.market.settlementPrice === 0n && chainNow >= exp && minPt(m) < exp) feedsOf(m).forEach((f) => need.add(f.key));
    }
    const publishTime = Math.max(lastPublish + 1, Math.min(Math.floor(Date.now() / 1000), chainNow + 1));
    const updates = [];
    for (const f of FEEDS) {
      const q = kraken.quote(f);
      if (!q) continue;
      const { price, conf, mid } = quoteToPrice(f, q.bid, q.ask);
      const cur = oc.get(f.key);
      const age = chainNow - cur.publishTime;
      const moved = cur.mid ? Math.abs(mid / cur.mid - 1) * 1e4 : Infinity;
      if (!(need.has(f.key) || age >= opts.heartbeatSeconds || moved >= opts.moveBps)) continue;
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

  async function keep(chainNow, view) {
    const byId = new Map(view.markets.map((m) => [m.id.toLowerCase(), m]));
    // 1. Liquidations first: they protect the vault.
    const liq = [];
    for (const v of view.positions) {
      const m = byId.get(v.position.priceId.toLowerCase());
      if (!m || !m.hasPrice || m.market.settlementPrice !== 0n) continue;
      if (isLiquidatable(v.position.isLong, v.liquidationPrice, m.price.mid) && ready(v.key)) liq.push(v.key);
    }
    for (let i = 0; i < liq.length; i += opts.batchSize) {
      const keys = liq.slice(i, i + opts.batchSize);
      const r = await send(keeper, engine, perpEngineAbi, "liquidateBatch", [keys, []], `liq:${keys[0]}`);
      if (r) stats.liquidated += keys.length;
    }
    // 2. Dated markets: fix the settlement price, then close what is left.
    for (const m of view.markets) {
      const exp = Number(m.market.expiry);
      if (!exp || chainNow < exp) continue;
      if (m.market.settlementPrice === 0n) {
        if (m.hasPrice && Number(m.price.publishTime) >= exp && chainNow >= exp + opts.settleMarketDelaySeconds) {
          const r = await send(keeper, engine, perpEngineAbi, "settleMarket", [m.id, []], `settle:${m.id}`);
          if (r) stats.settledMarkets++;
        }
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
    // 3. Orders whose condition holds at the stored price.
    const liqSet = new Set(liq.map((k) => k.toLowerCase()));
    const posBy = new Map(view.positions.map((v) => [v.position.trader.toLowerCase() + v.position.priceId.toLowerCase(), v]));
    for (const o of view.orders) {
      const id = `o:${o.id}`;
      if (!ready(id)) continue;
      const m = byId.get(o.priceId.toLowerCase());
      if (!m || !m.hasPrice) continue;
      const px = m.price;
      const pos = posBy.get(o.trader.toLowerCase() + o.priceId.toLowerCase());
      if (o.orderType === 0) {
        if (pos) continue;
        if (Number(m.market.expiry) && chainNow >= Number(m.market.expiry)) continue;
      } else {
        if (!pos || liqSet.has(pos.key.toLowerCase())) continue;
        if (m.market.settlementPrice === 0n && Number(px.publishTime) <= Number(pos.position.openedAt)) continue;
      }
      if (m.market.settlementPrice === 0n && Number(px.publishTime) < Number(o.createdAt)) continue;
      if (!triggered(o.orderType, pos ? pos.position.isLong : o.isLong, o.triggerPrice, px)) continue;
      const r = await send(keeper, engine, perpEngineAbi, "executeOrder", [o.id, []], id);
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
    const block = await pub.getBlock();
    const chainNow = Number(block.timestamp);
    let view = await readAll();
    if (krakenOk) {
      const oc = await onchainFeeds();
      if (await publish(chainNow, view, oc)) view = await readAll();
    }
    await keep(chainNow, view);
    return { chainNow, positions: view.positions.length, orders: view.orders.length };
  }

  return { tick, stats, krakenOk: () => krakenOk };
}

export const _test = { E18 };
