// Strategies (v3.2): on-chain trend, mean-reversion and copy agents for an AgentAccount. Pure helpers: a readable
// spec to the contract's Config and back, the contract's validation rules, and the state it reports.
import type { Address, Hex } from "viem";

export type StrategyKind = "trend" | "meanRevert" | "copy";
export type StrategyStatus = "none" | "active" | "paused" | "stopped";
export type StrategySide = "flat" | "long" | "short";
export type StrategyAction = "open" | "increase" | "close" | "reduce" | "cancel";

const KINDS: StrategyKind[] = ["trend", "meanRevert", "copy"];
const STATUSES: StrategyStatus[] = ["none", "active", "paused", "stopped"];
const SIDES: StrategySide[] = ["flat", "long", "short"];
const ACTIONS: StrategyAction[] = ["open", "increase", "close", "reduce", "cancel"];
const ZERO = "0x0000000000000000000000000000000000000000" as Address;

/** Strategies.sol limits. */
export const STRATEGY_LIMITS = {
  minInterval: 60,
  maxInterval: 86_400,
  maxSlippageBps: 500,
  minPeriod: 2,
  maxPeriod: 200,
  maxBandBps: 2_000,
  minBracketBps: 10,
  maxBracketBps: 5_000,
  maxRatioBps: 100_000,
  /** A copy is resized when it is more than 10% off its target. */
  resizeBps: 1_000,
  /** Refusals in a row that pause a strategy. */
  maxRefusals: 3,
} as const;

interface SpecBase {
  /** Symbol ("BTC-USD-TURBO") or market id. */
  market: string;
  /** Margin of each entry (trend, mean reversion) or the most margin per order (copy), USDC 6 decimals. */
  margin: bigint;
  /** Whole multiple: an entry's size is margin x leverage. */
  leverage: number;
  /** Seconds between samples, 60 to 86,400; also how long an order may wait for its fill. */
  interval: number;
  /** Worst fill accepted, from the price when the order is placed (1 to 500 bp). Default 50. */
  maxSlippageBps?: number;
  /** False: long only (a short signal means flat; a copy ignores the leader's shorts). Default true. */
  allowShort?: boolean;
  /** Stop-loss on each new position, this far from the price (10 to 5,000 bp); 0 or omitted for none. */
  stopLossBps?: number;
  /** Take-profit likewise; it must be wider than the slippage bound. */
  takeProfitBps?: number;
}

/** Trend following: long while the fast EMA is above the slow one by more than `bandBps`, short (or flat) below. */
export interface TrendSpec extends SpecBase {
  kind: "trend";
  /** Samples in the fast EMA (2 to 200, below `slowPeriod`). */
  fastPeriod: number;
  /** Samples in the slow EMA (up to 200). The strategy acts once it has seen a full slow period. */
  slowPeriod: number;
  /** Hysteresis around the slow EMA (0 to 2,000 bp). Default 0. */
  bandBps?: number;
}

/** Mean reversion: long when the price is `bandBps` below its EMA, short when as far above, flat once back within `exitBps`. */
export interface MeanRevertSpec extends SpecBase {
  kind: "meanRevert";
  /** Samples in the EMA (2 to 200). */
  period: number;
  /** Entry band (1 to 2,000 bp). */
  bandBps: number;
  /** Exit band, inside the entry band. Default 0 (exit at the EMA). */
  exitBps?: number;
}

/** Copy trading: the leader's position in the market, scaled by `ratioBps` and capped at `maxSize`. */
export interface CopySpec extends SpecBase {
  kind: "copy";
  /** The trader copied (a wallet or another account). */
  leader: Address;
  /** The copy's size as a share of the leader's: 10,000 is the same size; up to 100,000. */
  ratioBps: number;
  /** The largest position the copy takes, USDC notional (6 decimals). */
  maxSize: bigint;
}

export type StrategySpec = TrendSpec | MeanRevertSpec | CopySpec;

/** The contract's Config struct, as viem encodes and decodes it. */
export interface StrategyConfig {
  kind: number;
  interval: number;
  margin: bigint;
  leverage: number;
  maxSlippageBps: number;
  allowShort: boolean;
  stopLossBps: number;
  takeProfitBps: number;
  period: number;
  slowPeriod: number;
  bandBps: number;
  exitBps: number;
  ratioBps: number;
  leader: Address;
  maxSize: bigint;
}

/** The contract's Config for a spec (no validation: see `validateStrategy`). */
export function strategyConfig(s: StrategySpec): StrategyConfig {
  const base = {
    interval: s.interval,
    margin: s.margin,
    leverage: s.leverage,
    maxSlippageBps: s.maxSlippageBps ?? 50,
    allowShort: s.allowShort ?? true,
    stopLossBps: s.stopLossBps ?? 0,
    takeProfitBps: s.takeProfitBps ?? 0,
    period: 0,
    slowPeriod: 0,
    bandBps: 0,
    exitBps: 0,
    ratioBps: 0,
    leader: ZERO,
    maxSize: 0n,
  };
  if (s.kind === "trend") return { ...base, kind: 0, period: s.fastPeriod, slowPeriod: s.slowPeriod, bandBps: s.bandBps ?? 0 };
  if (s.kind === "meanRevert") return { ...base, kind: 1, period: s.period, bandBps: s.bandBps, exitBps: s.exitBps ?? 0 };
  return { ...base, kind: 2, leader: s.leader, ratioBps: s.ratioBps, maxSize: s.maxSize };
}

/** A spec back from the contract's Config (`market` is the market id). */
export function strategySpec(c: StrategyConfig, market: string): StrategySpec {
  const base = { market, margin: c.margin, leverage: Number(c.leverage), interval: Number(c.interval), maxSlippageBps: Number(c.maxSlippageBps), allowShort: c.allowShort, stopLossBps: Number(c.stopLossBps), takeProfitBps: Number(c.takeProfitBps) };
  const kind = KINDS[Number(c.kind)];
  if (kind === "trend") return { ...base, kind, fastPeriod: Number(c.period), slowPeriod: Number(c.slowPeriod), bandBps: Number(c.bandBps) };
  if (kind === "meanRevert") return { ...base, kind, period: Number(c.period), bandBps: Number(c.bandBps), exitBps: Number(c.exitBps) };
  return { ...base, kind: "copy", leader: c.leader, ratioBps: Number(c.ratioBps), maxSize: c.maxSize };
}

/**
 * Every rule Strategies.create checks on a config (Strategies._validate), as messages; empty when valid.
 * `market` is the engine's view of it; `account` the agent account (a copy may not follow itself).
 */
export function validateStrategy(c: StrategyConfig, market: { enabled: boolean; maxLeverage: number; expiry: number; symbol?: string }, minMargin: bigint, account?: Address, nowSeconds = Math.floor(Date.now() / 1000)): string[] {
  const L = STRATEGY_LIMITS;
  const out: string[] = [];
  const int = (x: number) => Number.isInteger(x);
  if (!int(c.interval) || c.interval < L.minInterval || c.interval > L.maxInterval) out.push(`interval must be ${L.minInterval} to ${L.maxInterval} seconds`);
  if (!int(c.maxSlippageBps) || c.maxSlippageBps < 1 || c.maxSlippageBps > L.maxSlippageBps) out.push(`maxSlippageBps must be 1 to ${L.maxSlippageBps}`);
  if (!int(c.leverage) || c.leverage < 1) out.push("leverage must be a whole multiple of at least 1");
  else if (c.leverage > market.maxLeverage) out.push(`leverage is above ${market.symbol ?? "the market"}'s ${market.maxLeverage}x`);
  if (c.margin < minMargin) out.push(`margin must be at least the engine's minimum (${Number(minMargin) / 1e6} USDC)`);
  if (!market.enabled) out.push(`${market.symbol ?? "the market"} is not taking new positions`);
  if (market.expiry !== 0 && nowSeconds >= market.expiry) out.push(`${market.symbol ?? "the market"} has expired`);
  const bracket = (x: number) => x === 0 || (int(x) && x >= L.minBracketBps && x <= L.maxBracketBps);
  if (!bracket(c.stopLossBps)) out.push(`stopLossBps must be 0 or ${L.minBracketBps} to ${L.maxBracketBps}`);
  if (!bracket(c.takeProfitBps)) out.push(`takeProfitBps must be 0 or ${L.minBracketBps} to ${L.maxBracketBps}`);
  else if (c.takeProfitBps !== 0 && c.takeProfitBps <= c.maxSlippageBps) out.push("takeProfitBps must be wider than maxSlippageBps (a take-profit inside the slippage bound sits on the wrong side of the order)");
  const period = (x: number) => int(x) && x >= L.minPeriod && x <= L.maxPeriod;
  const unused = (names: string[]) => {
    const vals: Record<string, unknown> = { period: c.period, slowPeriod: c.slowPeriod, bandBps: c.bandBps, exitBps: c.exitBps, ratioBps: c.ratioBps, maxSize: c.maxSize, leader: c.leader };
    for (const n of names) if (vals[n] !== 0 && vals[n] !== 0n && vals[n] !== ZERO) out.push(`${n} is not used by this kind (leave it 0)`);
  };
  if (c.kind === 0) {
    if (!period(c.period)) out.push(`fastPeriod must be ${L.minPeriod} to ${L.maxPeriod}`);
    if (!int(c.slowPeriod) || c.slowPeriod > L.maxPeriod || c.slowPeriod <= c.period) out.push(`slowPeriod must be above fastPeriod and at most ${L.maxPeriod}`);
    if (!int(c.bandBps) || c.bandBps < 0 || c.bandBps > L.maxBandBps) out.push(`bandBps must be 0 to ${L.maxBandBps}`);
    unused(["exitBps", "ratioBps", "leader", "maxSize"]);
  } else if (c.kind === 1) {
    if (!period(c.period)) out.push(`period must be ${L.minPeriod} to ${L.maxPeriod}`);
    if (!int(c.bandBps) || c.bandBps < 1 || c.bandBps > L.maxBandBps) out.push(`bandBps must be 1 to ${L.maxBandBps}`);
    if (!int(c.exitBps) || c.exitBps < 0 || c.exitBps >= c.bandBps) out.push("exitBps must be below bandBps");
    unused(["slowPeriod", "ratioBps", "leader", "maxSize"]);
  } else if (c.kind === 2) {
    if (!/^0x[0-9a-fA-F]{40}$/.test(c.leader) || c.leader.toLowerCase() === ZERO) out.push("leader must be an address");
    else if (account && c.leader.toLowerCase() === account.toLowerCase()) out.push("a copy cannot follow its own account");
    if (!int(c.ratioBps) || c.ratioBps < 1 || c.ratioBps > L.maxRatioBps) out.push(`ratioBps must be 1 to ${L.maxRatioBps}`);
    if (c.maxSize <= 0n) out.push("maxSize must be positive");
    unused(["period", "slowPeriod", "bandBps", "exitBps"]);
  } else out.push("kind must be trend, meanRevert or copy");
  return out;
}

/** The contract's Strategy struct (getStrategy / getStrategies), as viem decodes it. */
export interface RawStrategy {
  account: Address;
  marketId: Hex;
  config: StrategyConfig;
  state: {
    status: number;
    target: number;
    holding: number;
    todo: boolean;
    refusals: number;
    pendingAction: number;
    pendingSide: number;
    nextAt: bigint;
    actAt: bigint;
    samples: number;
    pendingOrder: bigint;
    pendingSince: bigint;
    targetSize: bigint;
    actions: number;
    emaFast: bigint;
    emaSlow: bigint;
    lastPrice: bigint;
    blockedAt: bigint;
  };
}

export interface StrategyInfo {
  id: bigint;
  account: Address;
  marketId: Hex;
  /** The market's symbol when the client knows it. */
  symbol: string | null;
  kind: StrategyKind;
  status: StrategyStatus;
  spec: StrategySpec;
  /** Where the last sample said to be, and what the strategy holds as far as it knows. */
  target: StrategySide;
  holding: StrategySide;
  /** True while the position does not match the target yet. */
  todo: boolean;
  /** Orders the account refused in a row (three pause the strategy). */
  refusals: number;
  /** Its order on the book (0n: none) and what it does. */
  pendingOrder: bigint;
  pendingAction: StrategyAction | null;
  /** Earliest next sample, unix seconds. */
  nextSampleAt: number;
  samples: number;
  /** Orders placed so far. */
  actions: number;
  /** The mid at the last sample, and the EMAs (trend: fast and slow; mean reversion: the EMA), 18 decimals. */
  lastPrice: bigint;
  emaFast: bigint;
  emaSlow: bigint;
  /** Copy: the size the last sample asked for. */
  targetSize: bigint;
}

export function strategyInfo(id: bigint, s: RawStrategy, symbol: string | null = null): StrategyInfo {
  const st = s.state;
  return {
    id,
    account: s.account,
    marketId: s.marketId,
    symbol,
    kind: KINDS[Number(s.config.kind)] ?? "trend",
    status: STATUSES[Number(st.status)] ?? "none",
    spec: strategySpec(s.config, symbol ?? s.marketId),
    target: SIDES[Number(st.target)] ?? "flat",
    holding: SIDES[Number(st.holding)] ?? "flat",
    todo: st.todo,
    refusals: Number(st.refusals),
    pendingOrder: BigInt(st.pendingOrder),
    pendingAction: BigInt(st.pendingOrder) === 0n ? null : (ACTIONS[Number(st.pendingAction)] ?? null),
    nextSampleAt: Number(st.nextAt),
    samples: Number(st.samples),
    actions: Number(st.actions),
    lastPrice: BigInt(st.lastPrice),
    emaFast: BigInt(st.emaFast),
    emaSlow: BigInt(st.emaSlow),
    targetSize: BigInt(st.targetSize),
  };
}

// ── AgentRegistry listings ──

export interface AgentListingInput {
  /** 1 to 48 bytes. */
  name: string;
  /** Up to 280 bytes. */
  description?: string;
  /** A label such as "trend", "copy" or "llm": 1 to 32 bytes. */
  kind: string;
  /** More about the agent (an ERC-8004 agent card, a page): up to 256 bytes. */
  uri?: string;
}

export interface AgentListing extends Required<AgentListingInput> {
  account: Address;
  owner: Address;
  registeredAt: number;
  updatedAt: number;
}

/** AgentRegistry's field limits, as messages; empty when valid. */
export function validateListing(l: AgentListingInput): string[] {
  const bytes = (s: string | undefined) => new TextEncoder().encode(s ?? "").length;
  const out: string[] = [];
  if (bytes(l.name) === 0 || bytes(l.name) > 48) out.push("name must be 1 to 48 bytes");
  if (bytes(l.description) > 280) out.push("description must be at most 280 bytes");
  if (bytes(l.kind) === 0 || bytes(l.kind) > 32) out.push("kind must be 1 to 32 bytes");
  if (bytes(l.uri) > 256) out.push("uri must be at most 256 bytes");
  return out;
}
