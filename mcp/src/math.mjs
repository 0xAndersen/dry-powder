// Pure maths and rules for v3.2, the same as the engine's and the Strategies contract's (and the SDK's): margin,
// liquidation, settlement in both fee models, margin removal, strategy configs and their validation, and what
// each contract error means. No network.

export const BPS = 10_000n;
export const DIRECT_MAX_LEVERAGE = 100;
const ZERO = "0x0000000000000000000000000000000000000000";
const ceilDiv = (a, b) => (a + b - 1n) / b;
const min = (a, b) => (a < b ? a : b);
const max = (a, b) => (a > b ? a : b);

/** Margin for a size at a leverage, rounded up so the leverage is never exceeded. */
export const marginFor = (size, leverage) => ceilDiv(size * 100n, BigInt(Math.round(leverage * 100)));

/** Mid price at which losses plus funding reach 90% of margin; 0n never (a long), null already. */
export function liquidationPrice(entry, margin, size, isLong, fundingOwed = 0n) {
  if (size === 0n || entry === 0n) return null;
  const room = (margin * 9_000n) / BPS - fundingOwed;
  if (room <= 0n) return null;
  if (isLong) return room >= size ? 0n : ceilDiv(entry * (size - room), size);
  return (entry * (size + room)) / size;
}

/** PnL from the price move alone, rounded against the trader (PositionMath.pricePnl). */
export function pricePnl(size, entry, price, isLong) {
  const gain = isLong ? price >= entry : price <= entry;
  const diff = price > entry ? price - entry : entry - price;
  return gain ? (size * diff) / entry : -ceilDiv(size * diff, entry);
}

/** The Upside share a trader pays, in bps, after the referral discount when they have a referrer. */
export const effectiveShareBps = (shareBps, referred, discountBps) => (referred ? shareBps - (shareBps * discountBps) / BPS : shareBps);

/**
 * PerpEngineBase._settle: profit capped at `multiple` x margin; Standard takes `closeFee` (before any discount)
 * from what is left of the margin; Upside charges nothing on a loss and `profitShareBps` of a profit (rounded up).
 * A referred trader's fee is `discountBps` lower and `referralShareBps` of it goes to the referrer.
 */
export function settle({ pnl, margin, upside = false, closeFee, profitShareBps = 2_000n, multiple = 10n, referred = false, discountBps = 500n, referralShareBps = 1_000n }) {
  const capped = pnl > margin * multiple ? margin * multiple : pnl;
  const disc = (fee) => (referred && fee !== 0n ? fee - (fee * discountBps) / BPS : fee);
  const toReferrer = (fee) => (referred && fee !== 0n ? (fee * referralShareBps) / BPS : 0n);
  if (upside) {
    if (capped < 0n) return { pnl: capped, fee: 0n, payout: margin - min(-capped, margin), toReferrer: 0n };
    const fee = disc(ceilDiv(capped * profitShareBps, BPS));
    return { pnl: capped, fee, payout: margin + capped - fee, toReferrer: toReferrer(fee) };
  }
  const base = disc(closeFee ?? margin / 10n);
  if (capped >= 0n) {
    const fee = min(base, margin);
    return { pnl: capped, fee, payout: margin - fee + capped, toReferrer: toReferrer(fee) };
  }
  const remaining = margin - min(-capped, margin);
  const fee = min(base, remaining);
  return { pnl: capped, fee, payout: remaining - fee, toReferrer: toReferrer(fee) };
}

/**
 * PerpEngineExt.removeMargin (and AgentAccount's leverage check for an agent): the most margin that can come out
 * now. What stays holds `minMargin`, the loss at the exit price (funding included) plus the initial margin at
 * min(market max, 100x), and for an agent size / its leverage cap. 0n when nothing can come out.
 */
export function removableMargin({ size, margin, entry, isLong, exitPrice, fundingOwed = 0n, marketMaxLeverage, minMargin = 5_000_000n, agentMaxLeverage }) {
  const lev = BigInt(Math.min(marketMaxLeverage, DIRECT_MAX_LEVERAGE));
  if (lev <= 0n || agentMaxLeverage === 0) return 0n;
  const pnl = pricePnl(size, entry, exitPrice, isLong) - fundingOwed;
  let keep = max(minMargin, (pnl < 0n ? -pnl : 0n) + ceilDiv(size, lev));
  if (agentMaxLeverage !== undefined) keep = max(keep, ceilDiv(size, BigInt(agentMaxLeverage)));
  return keep >= margin ? 0n : margin - keep;
}

// ── Strategies ──

export const STRATEGY_KINDS = ["trend", "meanRevert", "copy"];
const STATUSES = ["none", "active", "paused", "stopped"];
const SIDES = ["flat", "long", "short"];
const ACTIONS = ["open", "increase", "close", "reduce", "cancel"];

/** The contract's Config from a readable spec (amounts are 6-decimal bigints). */
export function strategyConfig(s) {
  const kind = STRATEGY_KINDS.indexOf(s.kind);
  return {
    kind: kind < 0 ? 255 : kind,
    interval: s.interval,
    margin: s.margin,
    leverage: s.leverage,
    maxSlippageBps: s.maxSlippageBps ?? 50,
    allowShort: s.allowShort ?? true,
    stopLossBps: s.stopLossBps ?? 0,
    takeProfitBps: s.takeProfitBps ?? 0,
    period: s.kind === "trend" ? (s.fastPeriod ?? 0) : s.kind === "meanRevert" ? (s.period ?? 0) : 0,
    slowPeriod: s.kind === "trend" ? (s.slowPeriod ?? 0) : 0,
    bandBps: s.kind === "copy" ? 0 : (s.bandBps ?? 0),
    exitBps: s.kind === "meanRevert" ? (s.exitBps ?? 0) : 0,
    ratioBps: s.kind === "copy" ? (s.ratioBps ?? 0) : 0,
    leader: s.kind === "copy" ? (s.leader ?? ZERO) : ZERO,
    maxSize: s.kind === "copy" ? (s.maxSize ?? 0n) : 0n,
  };
}

/** Strategies._validate as messages (empty when valid). */
export function validateStrategy(c, market, minMargin, account, now = Math.floor(Date.now() / 1000)) {
  const out = [];
  const int = Number.isInteger;
  const name = market.symbol ?? "the market";
  if (!int(c.interval) || c.interval < 60 || c.interval > 86_400) out.push("intervalSeconds must be 60 to 86400");
  if (!int(c.maxSlippageBps) || c.maxSlippageBps < 1 || c.maxSlippageBps > 500) out.push("maxSlippageBps must be 1 to 500");
  if (!int(c.leverage) || c.leverage < 1) out.push("leverage must be a whole multiple of at least 1");
  else if (c.leverage > market.maxLeverage) out.push(`leverage is above ${name}'s ${market.maxLeverage}x`);
  if (c.margin < minMargin) out.push(`marginUsd must be at least the engine's minimum (${Number(minMargin) / 1e6})`);
  if (!market.enabled) out.push(`${name} is not taking new positions`);
  if (market.expiry && now >= market.expiry) out.push(`${name} has expired`);
  const bracket = (x) => x === 0 || (int(x) && x >= 10 && x <= 5_000);
  if (!bracket(c.stopLossBps)) out.push("stopLossBps must be 0 or 10 to 5000");
  if (!bracket(c.takeProfitBps)) out.push("takeProfitBps must be 0 or 10 to 5000");
  else if (c.takeProfitBps !== 0 && c.takeProfitBps <= c.maxSlippageBps) out.push("takeProfitBps must be wider than maxSlippageBps");
  const period = (x) => int(x) && x >= 2 && x <= 200;
  if (c.kind === 0) {
    if (!period(c.period)) out.push("fastPeriod must be 2 to 200");
    if (!int(c.slowPeriod) || c.slowPeriod > 200 || c.slowPeriod <= c.period) out.push("slowPeriod must be above fastPeriod and at most 200");
    if (!int(c.bandBps) || c.bandBps < 0 || c.bandBps > 2_000) out.push("bandBps must be 0 to 2000");
  } else if (c.kind === 1) {
    if (!period(c.period)) out.push("period must be 2 to 200");
    if (!int(c.bandBps) || c.bandBps < 1 || c.bandBps > 2_000) out.push("bandBps must be 1 to 2000");
    if (!int(c.exitBps) || c.exitBps < 0 || c.exitBps >= c.bandBps) out.push("exitBps must be below bandBps");
  } else if (c.kind === 2) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(c.leader ?? "") || c.leader.toLowerCase() === ZERO) out.push("leader must be an address");
    else if (account && c.leader.toLowerCase() === account.toLowerCase()) out.push("a copy cannot follow its own account");
    if (!int(c.ratioBps) || c.ratioBps < 1 || c.ratioBps > 100_000) out.push("ratioBps must be 1 to 100000");
    if (!(c.maxSize > 0n)) out.push("maxSizeUsd must be positive");
  } else out.push("kind must be trend, meanRevert or copy");
  return out;
}

const toUsd = (x) => Number(x) / 1e6;
const toPx = (x) => Number((BigInt(x) * 10n ** 9n) / 10n ** 18n) / 1e9;

/** A strategy as the MCP shows it. */
export function describeStrategy(id, s, symbol) {
  const c = s.config;
  const st = s.state;
  const kind = STRATEGY_KINDS[Number(c.kind)] ?? "unknown";
  const params =
    kind === "trend"
      ? { fastPeriod: Number(c.period), slowPeriod: Number(c.slowPeriod), bandBps: Number(c.bandBps) }
      : kind === "meanRevert"
        ? { period: Number(c.period), bandBps: Number(c.bandBps), exitBps: Number(c.exitBps) }
        : { leader: c.leader, ratioBps: Number(c.ratioBps), maxSizeUsd: toUsd(c.maxSize) };
  const pending = BigInt(st.pendingOrder);
  return {
    id: String(id), kind, market: symbol ?? s.marketId, status: STATUSES[Number(st.status)] ?? "none",
    marginUsd: toUsd(c.margin), leverage: Number(c.leverage), intervalSeconds: Number(c.interval), maxSlippageBps: Number(c.maxSlippageBps),
    allowShort: c.allowShort, stopLossBps: Number(c.stopLossBps), takeProfitBps: Number(c.takeProfitBps), ...params,
    target: SIDES[Number(st.target)], holding: SIDES[Number(st.holding)], todo: st.todo, refusals: Number(st.refusals),
    pendingOrder: pending ? { id: String(pending), action: ACTIONS[Number(st.pendingAction)] } : null,
    samples: Number(st.samples), ordersPlaced: Number(st.actions), lastPrice: BigInt(st.lastPrice) ? toPx(st.lastPrice) : null,
    nextSampleAt: new Date(Number(st.nextAt) * 1000).toISOString(),
  };
}

// ── Contract errors ──

/** What a revert means, for the agent reading the tool's error (the engine, AgentAccount, Strategies, AgentRegistry). */
export const ERROR_HINTS = {
  OrdersOnly: "Turbo markets trade through keeper orders only (dp_open, dp_limit, dp_close place them)",
  HighLeverageNeedsOrder: "above 100x positions open and close only through keeper orders",
  OrderHasExpired: "the order is past its expiry and cannot fill; cancel it (dp_cancel) to get its escrow back",
  NothingToCancel: "none of these orders has expired",
  InsufficientMargin: "what stays could not cover the loss at the exit price plus the initial margin: take out less",
  PriceNotAfterOpen: "needs a price newer than the position's last open or top-up: try again in a few seconds",
  OraclePriceStale: "the on-chain price is too old right now: try again shortly",
  LeverageOutOfRange: "leverage outside 1x to the market's limit (margin removal stops at 100x)",
  MarginTooLow: "margin below the engine's minimum",
  PositionInProfit: "margin cannot be added while the position is in profit",
  PositionExists: "the trader holds the other side of this market: close it first",
  InvalidTrigger: "a take-profit must be on the profit side and a stop-loss on the loss side of the current price",
  VaultOiCapExceeded: "the house vault's exposure cap is reached: try a smaller size",
  MarketOiCapExceeded: "the market's open-interest cap for this side is reached",
  ReferrerAlreadySet: "a referrer is already set: it can be set once",
  NothingToClaim: "nothing to claim",
  InvalidParam: "a parameter is out of range (an expiry in the past, an amount of 0 or at least the margin, a self-referral)",
  NotOwner: "only the account's owner can do that: use dp_prepare_owner_tx and have the owner sign it",
  NotAuthorized: "this key is no longer an active agent of the account",
  LeverageCapExceeded: "beyond this agent's on-chain leverage cap",
  MarginCapExceeded: "beyond this agent's on-chain margin cap per call",
  DailyBudgetExceeded: "this agent's daily margin budget is used up for today (it resets at 00:00 UTC)",
  MarketNotAllowed: "the account does not let agents trade this market",
  NotAllowed: "only the account's owner or an active agent can manage its strategies",
  AgentPolicyExceeded: "the strategy's margin or leverage is above this agent's own caps",
  InvalidStrategy: "the strategy's configuration is invalid",
  NotApproved: "the account has not approved the Strategies contract for orders this size: dp_prepare_owner_tx approve_strategies",
  MarketTaken: "the account already runs a strategy in this market: stop it first",
  NoStrategy: "no strategy with that id in a state that allows this",
  InvalidAgent: "listing fields: name 1-48 bytes, description up to 280, kind 1-32, uri up to 256",
  AlreadyRegistered: "the account is already listed (update_agent)",
  NotRegistered: "the account is not listed",
};
