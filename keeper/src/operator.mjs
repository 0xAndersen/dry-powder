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
//
// Without a publisher (KEEPER_MODE=executor) it is a keeper anyone can run: it signs no prices and acts only on
// what is already on-chain, earning the execution fees and liquidation rewards it collects. Running a second one
// beside the venue's means fills never depend on one operator (roadmap 10).
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
  "OraclePriceUnavailable", "OrderHasExpired", "NothingToCancel", "OrdersOnly",
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

/** Mirrors PerpEngine trigger conditions (0 LimitOpen, 1 TakeProfit, 2 StopLoss, 3 Close, 4 StopOpen). Opens and
 *  closes compare the price they fill at: the ask for a buy and the bid for a sell, or the mid in an Upside (Turbo)
 *  market (`atMid`); take-profits and stops always compare the mid. */
export function triggered(type, isLong, trigger, px, atMid = false) {
  const buy = atMid ? px.mid : px.ask;
  const sell = atMid ? px.mid : px.bid;
  if (type === 0) return isLong ? buy <= trigger : sell >= trigger;
  if (type === 4) return isLong ? buy >= trigger : sell <= trigger;
  if (type === 1) return isLong ? px.mid >= trigger : px.mid <= trigger;
  if (type === 2) return isLong ? px.mid <= trigger : px.mid >= trigger;
  return trigger === 0n || (isLong ? sell >= trigger : buy <= trigger);
}

/** True for a market in the Upside fee mode (Market.feeMode 1): fills at the mid. */
export const fillsAtMid = (m) => Number(m?.market?.feeMode ?? 0) === 1;

/** True when order `o` can no longer execute at chain time `now` (Order.expiresAt, 0 = never). */
export const isExpired = (o, now) => Number(o.expiresAt ?? 0n) !== 0 && now > Number(o.expiresAt);
/** Lens liquidation price (PositionMath.liquidationPrice): a long at or below it, a short at or above it.
 *  Zero means a long no price can liquidate, or a short every price does; both fall out of the comparison. */
export const isLiquidatable = (isLong, lp, mid) => (isLong ? mid <= lp : mid >= lp);

/**
 * Gas limit for a transaction estimated at `gas`. eth_estimateGas finds the least gas that works on the state it
 * ran on; the transaction runs in a later block on a state other transactions may have changed (an addition to
 * a position becomes a new position when the trader closed in between, funding accrues, the vault marks more
 * positions), and a tight limit then runs out. A quarter more, plus room for a few fresh storage slots.
 */
export const withHeadroom = (gas) => (gas * 5n) / 4n + 50_000n;

/** True when moving a stop from `current` to `next` is too small a step to be worth a transaction. */
export const trailStepTooSmall = (current, next, stepBps = 10) => {
  const diff = next > current ? next - current : current - next;
  return diff * 10_000n < current * BigInt(stepBps);
};

/** True when an open order would fill at or through its take-profit or stop-loss (PerpEngine._validateBrackets). */
export function gapsBracket(o, px, atMid = false) {
  const fill = atMid ? px.mid : o.isLong ? px.ask : px.bid;
  if (o.takeProfit !== 0n && (o.isLong ? o.takeProfit <= fill : o.takeProfit >= fill)) return true;
  if (o.stopLoss !== 0n && (o.isLong ? o.stopLoss >= fill : o.stopLoss <= fill)) return true;
  return false;
}

// Strategies add-on enums (contracts/src/Strategies.sol).
const STRATEGY_ACTIVE = 1;
const STRATEGY_COPY = 2;
const FLAT = 0;
const LONG = 1;
const SHORT = 2;
const sideOf = (p) => (p ? (p.isLong ? LONG : SHORT) : FLAT);

/**
 * Mirrors Strategies' copy target: true when the copy's position is off what its leader's says (another side, or
 * more than 10% off the scaled size), so a sample would trade. `posBy` maps trader + market id (lower case) to a
 * position. A copy sitting out the leader's trade it was closed out of is not, until the leader moves on.
 */
export function copyOff(s, posBy) {
  const c = s.config;
  const market = s.marketId.toLowerCase();
  const lead = posBy.get(c.leader.toLowerCase() + market);
  let side = sideOf(lead);
  if (side === SHORT && !c.allowShort) side = FLAT;
  if (BigInt(s.state.blockedAt) !== 0n) return !(side !== FLAT && BigInt(lead.openedAt) === BigInt(s.state.blockedAt));
  let size = 0n;
  if (side !== FLAT) {
    size = (BigInt(lead.size) * BigInt(c.ratioBps)) / 10_000n;
    if (size > BigInt(c.maxSize)) size = BigInt(c.maxSize);
    if (size === 0n) side = FLAT;
  }
  const mine = posBy.get(s.account.toLowerCase() + market);
  const have = sideOf(mine);
  if (side === FLAT) return have !== FLAT;
  if (have !== side) return true;
  const held = BigInt(mine.size);
  const off = held > size ? held - size : size - held;
  return off * 10_000n > size * 1_000n;
}

/**
 * Whether a live strategy may have something to do at chain time `now` (seconds, bigint); the contract's `due()`
 * has the last word. An order of its own on the book (settled or gone stale), a step left to take, or a sample due:
 * trend and mean reversion sample every interval, a copy only when its position and its leader's differ (an idle
 * copy costs nothing).
 */
export function strategyCandidate(s, now, posBy) {
  const st = s.state;
  if (Number(st.status) !== STRATEGY_ACTIVE) return false;
  if (BigInt(st.pendingOrder) !== 0n) return true;
  if (st.todo && BigInt(st.actAt) <= now) return true;
  if (BigInt(st.nextAt) > now) return false;
  return Number(s.config.kind) !== STRATEGY_COPY || copyOff(s, posBy);
}

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
  // The engine's price age limit for reads without an update (add-on pokes read the stored price).
  let maxPriceAge = 10;

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
      // By address, not the local account: viem would otherwise estimate twice and cap the second estimate at the
      // first, which fails whenever the state moved in between (funding accrues each second).
      const gas = await pub.estimateContractGas({ account: wallet.account.address, address, abi: [...abi, ...ERRORS], functionName, args, value: request.value });
      const hash = await wallet.writeContract({ ...request, gas: withHeadroom(gas), ...(await fees()) });
      const receipt = await pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
      if (receipt.status !== "success") {
        const limit = (await pub.getTransaction({ hash }).catch(() => null))?.gas ?? 0n;
        if (limit > 0n && receipt.gasUsed * 100n >= limit * 99n) {
          const oog = new Error(`${functionName} ran out of gas (${receipt.gasUsed} of ${limit}): ${hash}`);
          oog.data = { errorName: "OutOfGas" };
          throw oog;
        }
        // Usually a lost race: a trader's transaction (a cancel, a close, a moved trigger) landed between the
        // simulation and this one. The receipt carries no reason, so replay the call on the new state to name it;
        // a benign reason is then counted as such instead of as a fault.
        const failed = new Error(`${functionName} reverted on-chain: ${hash}`);
        try {
          await pub.simulateContract({ account: wallet.account, address, abi: [...abi, ...ERRORS], functionName, args });
        } catch (replay) {
          const reason = revertName(replay);
          if (reason) failed.data = { errorName: reason };
        }
        throw failed;
      }
      if (id) backoff.delete(id);
      return receipt;
    } catch (e) {
      const name = revertName(e);
      if (name && BENIGN.has(name)) count(stats.benign, name);
      else {
        count(stats.errors, name ?? functionName);
        const msg = String(e?.shortMessage ?? e?.message ?? e).split("\n").map((l) => l.trim()).filter(Boolean);
        // The node's own words ("nonce too low", "insufficient funds") sit at the bottom of viem's cause chain.
        let detail = null;
        for (let x = e; x; x = x.cause) if (typeof x.details === "string" && x.details) detail = x.details;
        stats.lastError = `${functionName}: ${msg.slice(0, 2).join(" ")}${detail && !msg.join(" ").includes(detail) ? ` (${detail})` : ""}`.slice(0, 300);
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

  /** Heartbeat for readers (the app, direct traders): pushes feeds that are old or have moved, and the feeds in
   *  `force`. Keeper transactions carry their own fresh prices, so nothing here is needed for fills or
   *  liquidations; add-on pokes (TWAP slices, strategies) read the stored price and force their feeds when it is
   *  old. */
  async function publish(chainNow, oc, force = null) {
    if (!publisher) return false;
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
      if (!(force?.has(f.key) || age >= opts.heartbeatSeconds || moved >= opts.moveBps)) continue;
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
      // An executor signs nothing: it acts on the prices already on-chain.
      if (!publisher) return null;
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
    // 3. Orders whose condition holds at the price the fill will use. Expired ones are swept instead (3e).
    const liqSet = new Set(liq.map((x) => x.key.toLowerCase()));
    const posBy = new Map(view.positions.map((v) => [v.position.trader.toLowerCase() + v.position.priceId.toLowerCase(), v]));
    const expired = [];
    for (const o of view.orders) {
      const id = `o:${o.id}`;
      if (isExpired(o, chainNow)) {
        expired.push(o.id);
        continue;
      }
      if (!ready(id)) continue;
      const m = byId.get(o.priceId.toLowerCase());
      if (!m) continue;
      const atMid = fillsAtMid(m);
      const pos = posBy.get(o.trader.toLowerCase() + o.priceId.toLowerCase());
      // Open orders (limit, stop-entry) add to a position on the same side; the engine refuses the other side.
      const opens = o.orderType === 0 || o.orderType === 4;
      if (opens) {
        if (pos && pos.position.isLong !== o.isLong) continue;
        if (Number(m.market.expiry) && chainNow >= Number(m.market.expiry)) continue;
      } else if (!pos || liqSet.has(pos.key.toLowerCase())) continue;
      const p = await P(m);
      if (!p) continue;
      if (m.market.settlementPrice === 0n) {
        if (p.pt < Number(o.createdAt)) continue;
        if (pos && p.pt <= Number(pos.position.openedAt)) continue;
      }
      if (!triggered(o.orderType, pos && !opens ? pos.position.isLong : o.isLong, o.triggerPrice, p.px, atMid)) continue;
      // A fill through one of its own brackets would close at once: the engine leaves such an order resting.
      if (opens && gapsBracket(o, p.px, atMid)) continue;
      const r = await send(keeper, engine, perpEngineAbi, "executeOrder", [o.id, p.upd], id);
      if (r) stats.executed++;
    }
    // 3b. Trailing stops (the TrailingStops add-on): move the stops whose trail has moved far enough.
    if (addresses.trailingStops) {
      try {
        await trail(view);
      } catch (e) {
        count(stats.errors, "trail");
        stats.lastError = `trail: ${String(e?.shortMessage ?? e?.message ?? e).split("\n")[0].slice(0, 240)}`;
      }
    }
    // 3c. TWAP orders (the TwapOrders add-on): place the slices that are due.
    if (addresses.twapOrders) {
      try {
        await twap(view);
      } catch (e) {
        count(stats.errors, "twap");
        stats.lastError = `twap: ${String(e?.shortMessage ?? e?.message ?? e).split("\n")[0].slice(0, 240)}`;
      }
    }
    // 3d. Strategies (the Strategies add-on): samples, and the orders that move positions to their signals.
    if (addresses.strategies) {
      try {
        await strategies(view);
      } catch (e) {
        count(stats.errors, "strategies");
        stats.lastError = `strategies: ${String(e?.shortMessage ?? e?.message ?? e).split("\n")[0].slice(0, 240)}`;
      }
    }
    // 3e. Expired orders: anyone may remove them and earns each one's execution fee (the rest of its escrow goes
    // back to its trader).
    for (let i = 0; i < expired.length; i += opts.batchSize) {
      const batch = expired.slice(i, i + opts.batchSize);
      const r = await send(keeper, engine, perpEngineAbi, "cancelExpired", [batch], `exp:${batch[0]}`);
      if (r) stats.expired = (stats.expired ?? 0) + batch.length;
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

  /**
   * Pokes the trails whose stop would move by at least `trailStepBps` of its level (or that have no stop yet, or
   * whose position is gone, which clears them), in batches. `pending()` is the contract's own answer, so the
   * keeper never sends a poke that does nothing.
   */
  async function trail(view) {
    const ts = addresses.trailingStops;
    const abi = ABIS.trailingStopsAbi;
    if (!abi) return;
    const n = await pub.readContract({ address: ts, abi, functionName: "trailCount" });
    if (n === 0n) return;
    const posBy = new Map(view.positions.map((v) => [v.position.trader.toLowerCase() + v.position.priceId.toLowerCase(), v.position]));
    const stopOf = new Map(view.orders.filter((o) => o.orderType === 2).map((o) => [o.id, o.triggerPrice]));
    const due = [];
    for (let at = 0n; at < n; at += PAGE) {
      const [accounts, markets, trails] = await pub.readContract({ address: ts, abi, functionName: "getTrails", args: [at, PAGE] });
      for (let i = 0; i < accounts.length; i += 1) {
        const id = `trail:${accounts[i]}:${markets[i]}`;
        if (!ready(id)) continue;
        const pos = posBy.get(accounts[i].toLowerCase() + markets[i].toLowerCase());
        if (!pos || pos.isLong !== trails[i].isLong) {
          due.push({ account: accounts[i], market: markets[i], id });
          continue;
        }
        const level = await pub.readContract({ address: ts, abi, functionName: "pending", args: [accounts[i], markets[i]] });
        if (level === 0n) continue;
        // An account that no longer lets the contract act would refuse every move: do not spend gas on it.
        const [expiry] = await pub.readContract({ address: accounts[i], abi: ABIS.agentAccountAbi, functionName: "agents", args: [ts] });
        if (BigInt(expiry) <= BigInt(Math.floor(Date.now() / 1000))) {
          defer(id);
          continue;
        }
        const current = pos.slOrderId !== 0n ? stopOf.get(pos.slOrderId) : undefined;
        if (current && trailStepTooSmall(current, level, opts.trailStepBps)) continue;
        due.push({ account: accounts[i], market: markets[i], id });
      }
    }
    for (let i = 0; i < due.length; i += opts.batchSize) {
      const batch = due.slice(i, i + opts.batchSize);
      const r = await send(keeper, ts, abi, "poke", [batch.map((x) => x.account), batch.map((x) => x.market)], batch[0].id);
      if (r) stats.trailed = (stats.trailed ?? 0) + batch.length;
    }
  }

  /**
   * Pokes the TWAPs with a slice due, in batches. `due()` is the contract's own answer (interval passed, a usable
   * price, not holding the other side), so a poke always places or is refused; accounts that withdrew the
   * contract's approval, or that hold the other side, are skipped. Each slice is an ordinary keeper order, filled
   * by step 3. A TWAP still not due after its market's price was refreshed backs off (no publish every tick).
   */
  async function twap(view) {
    const tw = addresses.twapOrders;
    const abi = ABIS.twapOrdersAbi;
    if (!abi) return;
    const n = await pub.readContract({ address: tw, abi, functionName: "twapCount" });
    if (n === 0n) return;
    const now = BigInt(Math.floor(Date.now() / 1000));
    const sideOf = new Map(view.positions.map((v) => [v.position.trader.toLowerCase() + v.position.priceId.toLowerCase(), v.position.isLong]));
    const candidates = [];
    for (let at = 0n; at < n; at += PAGE) {
      const [accounts, markets, twaps] = await pub.readContract({ address: tw, abi, functionName: "getTwaps", args: [at, PAGE] });
      for (let i = 0; i < accounts.length; i += 1) {
        const id = `twap:${accounts[i]}:${markets[i]}`;
        if (!ready(id) || BigInt(twaps[i].nextAt) > now) continue;
        // Slices wait while the account holds the other side (they could not fill).
        const held = sideOf.get(accounts[i].toLowerCase() + markets[i].toLowerCase());
        if (held !== undefined && held !== twaps[i].isLong) continue;
        const [expiry] = await pub.readContract({ address: accounts[i], abi: ABIS.agentAccountAbi, functionName: "agents", args: [tw] });
        if (BigInt(expiry) <= now) {
          defer(id);
          continue;
        }
        candidates.push({ account: accounts[i], market: markets[i], id });
      }
    }
    if (candidates.length === 0) return;
    // A poke reads the engine's stored price (no update rides along), which on a quiet venue is older than the
    // engine accepts between heartbeats: refresh the feeds of markets whose price has under 3 s of life left.
    const block = await pub.getBlock();
    const chainNow = Number(block.timestamp);
    const byId = new Map(view.markets.map((m) => [m.id.toLowerCase(), m]));
    const force = new Set();
    for (const c of candidates) {
      const m = byId.get(c.market.toLowerCase());
      if (!m || m.market.settlementPrice !== 0n) continue;
      const age = m.hasPrice ? chainNow - Number(m.price.publishTime) : Infinity;
      if (age >= maxPriceAge - 3) for (const f of feedsOf(m)) force.add(f.key);
    }
    if (force.size > 0 && krakenOk) await publish(chainNow, await onchainFeeds(), force);
    const due = [];
    for (const c of candidates) {
      if (await pub.readContract({ address: tw, abi, functionName: "due", args: [c.account, c.market] })) due.push(c);
      else defer(c.id);
    }
    for (let i = 0; i < due.length; i += opts.batchSize) {
      const batch = due.slice(i, i + opts.batchSize);
      const r = await send(keeper, tw, abi, "poke", [batch.map((x) => x.account), batch.map((x) => x.market)], batch[0].id);
      if (r) stats.slices = (stats.slices ?? 0) + batch.length;
    }
  }

  /**
   * Pokes the strategies with something to do (`strategyCandidate`, then the contract's own `due()`), in batches.
   * A poke samples, settles the strategy's last order, or places its next one, which step 3 fills like any other
   * keeper order. Accounts that withdrew the contract's approval are skipped; markets whose stored price has under
   * 3 s of life left are refreshed first, as for TWAPs; a strategy still not due afterwards backs off.
   */
  async function strategies(view) {
    const sx = addresses.strategies;
    const abi = ABIS.strategiesAbi;
    if (!abi) return;
    const n = await pub.readContract({ address: sx, abi, functionName: "strategyCount" });
    if (n === 0n) return;
    const block = await pub.getBlock();
    const chainNow = Number(block.timestamp);
    const now = BigInt(chainNow);
    const posBy = new Map(view.positions.map((v) => [v.position.trader.toLowerCase() + v.position.priceId.toLowerCase(), v.position]));
    const approved = new Map();
    const candidates = [];
    for (let at = 0n; at < n; at += PAGE) {
      const [ids, list] = await pub.readContract({ address: sx, abi, functionName: "getStrategies", args: [at, PAGE] });
      for (let i = 0; i < ids.length; i += 1) {
        const id = `strategy:${ids[i]}`;
        if (!ready(id) || !strategyCandidate(list[i], now, posBy)) continue;
        const account = list[i].account;
        if (!approved.has(account)) {
          const [expiry] = await pub.readContract({ address: account, abi: ABIS.agentAccountAbi, functionName: "agents", args: [sx] });
          approved.set(account, BigInt(expiry) > now);
        }
        if (!approved.get(account)) {
          defer(id);
          continue;
        }
        candidates.push({ sid: ids[i], market: list[i].marketId, id });
      }
    }
    if (candidates.length === 0) return;
    const byId = new Map(view.markets.map((m) => [m.id.toLowerCase(), m]));
    const force = new Set();
    for (const c of candidates) {
      const m = byId.get(c.market.toLowerCase());
      if (!m || m.market.settlementPrice !== 0n) continue;
      const age = m.hasPrice ? chainNow - Number(m.price.publishTime) : Infinity;
      if (age >= maxPriceAge - 3) for (const f of feedsOf(m)) force.add(f.key);
    }
    if (force.size > 0 && krakenOk) await publish(chainNow, await onchainFeeds(), force);
    const due = [];
    for (const c of candidates) {
      if (await pub.readContract({ address: sx, abi, functionName: "due", args: [c.sid] })) due.push(c);
      else defer(c.id);
    }
    // An order costs a poke about 470k gas: smaller batches than the engine's.
    const size = Math.max(1, Math.min(opts.batchSize, opts.strategyBatchSize ?? 8));
    for (let i = 0; i < due.length; i += size) {
      const batch = due.slice(i, i + size);
      const r = await send(keeper, sx, abi, "poke", [batch.map((x) => x.sid)], batch[0].id);
      if (r) stats.strategyPokes = (stats.strategyPokes ?? 0) + batch.length;
    }
  }

  async function topUp() {
    if (!funder || Date.now() - lastTopUp < 300_000) return;
    lastTopUp = Date.now();
    const min = parseEther(String(opts.minGas));
    const amount = parseEther(String(opts.topUp));
    for (const w of [publisher, keeper].filter(Boolean)) {
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
    // An executor signs no prices, so it needs no exchange feed.
    if (publisher) {
      try {
        await kraken.poll();
        krakenOk = true;
      } catch (e) {
        krakenOk = false;
        count(stats.errors, "kraken");
        stats.lastError = `kraken: ${String(e?.message ?? e)}`;
      }
    }
    await topUp();
    if (stats.ticks % 100 === 1) {
      maxConfBps = await pub.readContract({ address: engine, abi: perpEngineAbi, functionName: "maxConfBps" }).catch(() => maxConfBps);
      maxPriceAge = Number(await pub.readContract({ address: engine, abi: perpEngineAbi, functionName: "maxPriceAge" }).catch(() => BigInt(maxPriceAge)));
    }
    const block = await pub.getBlock();
    const chainNow = Number(block.timestamp);
    if (krakenOk && publisher) await publish(chainNow, await onchainFeeds());
    const view = await readAll();
    await keep(chainNow, view);
    return { chainNow, positions: view.positions.length, orders: view.orders.length };
  }

  return { tick, stats, krakenOk: () => krakenOk };
}

export const _test = { E18 };
