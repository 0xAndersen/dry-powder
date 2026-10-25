/**
 * Strategy agents (the Strategies add-on): the contract's limits, the Agent Studio's templates and their defaults
 * per market, checks that mirror `Strategies._validate` (so a launch fails here, in words, rather than on-chain),
 * the conversions between the form and the contract's `Config`, and the approval a launch needs.
 *
 * Pure: no wallet, no network, no app modules (only types), so `node --test` can import it directly.
 */
import type { Address, Hex } from "viem";

/** The contract's bounds (Strategies.sol constants). */
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
  /** A copy is resized when it is off its target by more than this share of the target. */
  resizeBps: 1_000,
  /** Refusals in a row that pause a strategy. */
  maxRefusals: 3,
} as const;

/** AgentRegistry limits, in UTF-8 bytes. */
export const LISTING_LIMITS = { name: 48, description: 280, kind: 32, uri: 256 } as const;

export const ZERO_ADDRESS: Address = "0x0000000000000000000000000000000000000000";

export type StrategyKind = "trend" | "meanRevert" | "copy";
export type Side = "flat" | "long" | "short";
export type StrategyStatus = "none" | "active" | "paused" | "stopped";
export type StrategyAction = "open" | "increase" | "close" | "reduce" | "cancel";

/** Solidity enum values, in declaration order. */
export const KIND_CODE: Record<StrategyKind, number> = { trend: 0, meanRevert: 1, copy: 2 };
export const KINDS: readonly StrategyKind[] = ["trend", "meanRevert", "copy"];
export const SIDES: readonly Side[] = ["flat", "long", "short"];
export const STATUSES: readonly StrategyStatus[] = ["none", "active", "paused", "stopped"];
export const ACTIONS: readonly StrategyAction[] = ["open", "increase", "close", "reduce", "cancel"];

export const kindOf = (code: number): StrategyKind => KINDS[code] ?? "trend";
export const sideOf = (code: number): Side => SIDES[code] ?? "flat";
export const statusOf = (code: number): StrategyStatus => STATUSES[code] ?? "none";
export const actionOf = (code: number): StrategyAction => ACTIONS[code] ?? "open";

/** What the studio's form edits. Amounts have 6 decimals; everything else is a whole number. */
export type StrategyDraft = {
  kind: StrategyKind;
  /** Seconds between price readings (and how long an order may wait for its fill). */
  interval: number;
  /** Margin of an entry (trend, mean reversion) or the most margin per order (copy). */
  margin: bigint;
  leverage: number;
  slippageBps: number;
  allowShort: boolean;
  /** 0: none. */
  stopLossBps: number;
  /** 0: none. */
  takeProfitBps: number;
  /** Trend: the fast average; mean reversion: the average. In readings. */
  period: number;
  /** Trend: the slow average. */
  slowPeriod: number;
  /** Trend: the hysteresis band; mean reversion: the entry band. */
  bandBps: number;
  /** Mean reversion: the exit band. */
  exitBps: number;
  /** Copy: the copy's size as a share of the leader's (10,000 = the same size). */
  ratioBps: number;
  /** Copy: whom to follow. */
  leader: Address | null;
  /** Copy: the largest position the copy takes. */
  maxSize: bigint;
};

/** `Strategies.Config` as viem encodes it. */
export type StrategyConfig = {
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
};

/** `Strategies.State` as viem decodes it. */
export type StrategyState = {
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

/** The parts of a market the studio needs (an `Instrument` fits). */
export type StrategyMarket = {
  id: Hex;
  symbol: string;
  base: string;
  kind: string;
  maxLeverage: number;
  /** Upside fee mode (the Turbo markets): no fee at open or close, mid fills, a share of winning profit. */
  upside: boolean;
  enabled: boolean;
  /** Unix seconds; 0 for none. */
  expiry: number;
};

// ─────────────────────────────── Templates ───────────────────────────────

export const TEMPLATES: readonly { key: StrategyKind; title: string; line: string }[] = [
  { key: "trend", title: "Trend follower", line: "Rides a move once it is under way" },
  { key: "meanRevert", title: "Mean reversion", line: "Bets that a stretched price snaps back" },
  { key: "copy", title: "Copy a trader", line: "Holds a share of another trader's position" },
];

export const templateOf = (kind: StrategyKind) => TEMPLATES.find((t) => t.key === kind)!;

/** How often a strategy may read the price. */
export const INTERVAL_PRESETS: readonly { seconds: number; label: string }[] = [
  { seconds: 60, label: "1 min" },
  { seconds: 300, label: "5 min" },
  { seconds: 900, label: "15 min" },
  { seconds: 1_800, label: "30 min" },
  { seconds: 3_600, label: "1 hour" },
  { seconds: 14_400, label: "4 hours" },
  { seconds: 86_400, label: "1 day" },
];

/** How long a launch lets the Strategies contract trade the account before the approval needs renewing. */
export const KEEP_FOR_PRESETS: readonly { seconds: number; label: string }[] = [
  { seconds: 7 * 86_400, label: "7 days" },
  { seconds: 30 * 86_400, label: "30 days" },
  { seconds: 90 * 86_400, label: "90 days" },
  { seconds: 365 * 86_400, label: "1 year" },
];

export type AssetClass = "crypto" | "metal" | "fx";
const FX = new Set(["EUR", "JPY", "GBP", "CHF", "AUD", "CAD", "NZD", "CNH", "CNY", "MXN", "SEK", "NOK", "SGD", "HKD", "KRW", "INR", "BRL", "ZAR", "TRY"]);
const METALS = new Set(["XAU", "XAG", "XPT", "XPD", "PAXG", "GOLD"]);

export function assetClassOf(m: Pick<StrategyMarket, "base" | "kind">): AssetClass {
  const base = m.base.toUpperCase();
  if (METALS.has(base)) return "metal";
  if (m.kind === "fx" || FX.has(base)) return "fx";
  return "crypto";
}

/** Rough size of a day's move against crypto's: bands and stops scale with it, leverage against it. */
const CLASS_SCALE: Record<AssetClass, number> = { crypto: 1, metal: 0.4, fx: 0.2 };

const BASE_DEFAULTS: Record<StrategyKind, { interval: number; leverage: number; slippageBps: number; stopLossBps: number; period: number; slowPeriod: number; bandBps: number; exitBps: number }> = {
  trend: { interval: 900, leverage: 3, slippageBps: 50, stopLossBps: 300, period: 9, slowPeriod: 21, bandBps: 15, exitBps: 0 },
  meanRevert: { interval: 300, leverage: 3, slippageBps: 30, stopLossBps: 250, period: 20, slowPeriod: 0, bandBps: 80, exitBps: 15 },
  copy: { interval: 60, leverage: 5, slippageBps: 50, stopLossBps: 0, period: 0, slowPeriod: 0, bandBps: 0, exitBps: 0 },
};

const DEFAULT_MARGIN = 100_000_000n; // 100 units of collateral

/**
 * Starting values for `kind` on `market`: bands and stops sized to the market's usual moves, a modest leverage (five
 * times more on an Upside market, which has no fees and is made for notional far above margin), a stop at most half
 * way to the liquidation price, within the market's maximum and the trader's own cap.
 */
export function defaultsFor(kind: StrategyKind, market: StrategyMarket, opts: { minMargin?: bigint; maxLeverage?: number | null } = {}): StrategyDraft {
  const base = BASE_DEFAULTS[kind];
  const scale = CLASS_SCALE[assetClassOf(market)];
  const cap = Math.max(1, Math.min(market.maxLeverage, opts.maxLeverage ?? market.maxLeverage));
  const leverage = clampInt(Math.round((base.leverage / scale) * (market.upside ? 5 : 1)), 1, cap);
  // At most half the distance to liquidation (a 90% loss of margin), and none when that is under the 0.1% minimum.
  let stopLossBps = 0;
  if (base.stopLossBps > 0) {
    const stop = Math.min(Math.round(base.stopLossBps * scale), Math.floor(4_500 / leverage));
    stopLossBps = stop < STRATEGY_LIMITS.minBracketBps ? 0 : Math.min(stop, STRATEGY_LIMITS.maxBracketBps);
  }
  const margin = opts.minMargin !== undefined && opts.minMargin > DEFAULT_MARGIN ? opts.minMargin : DEFAULT_MARGIN;
  const bandBps = kind === "copy" ? 0 : clampInt(Math.round(base.bandBps * scale), kind === "meanRevert" ? 2 : 1, STRATEGY_LIMITS.maxBandBps);
  const exitBps = kind === "meanRevert" ? Math.min(bandBps - 1, Math.max(0, Math.round(base.exitBps * scale))) : 0;
  return {
    kind,
    interval: base.interval,
    margin,
    leverage,
    slippageBps: Math.max(1, Math.round(base.slippageBps * Math.max(scale, 0.4))),
    allowShort: true,
    stopLossBps,
    takeProfitBps: 0,
    period: base.period,
    slowPeriod: base.slowPeriod,
    bandBps,
    exitBps,
    ratioBps: kind === "copy" ? 5_000 : 0,
    leader: null,
    maxSize: kind === "copy" ? margin * BigInt(leverage) : 0n,
  };
}

// ─────────────────────────────── Checks ───────────────────────────────

export type DraftField = keyof StrategyDraft | "market";
export type DraftIssue = { field: DraftField; message: string };

export type DraftContext = {
  market: StrategyMarket | null;
  /** The engine's minimum margin (6 decimals). */
  minMargin: bigint;
  /** Unix seconds (chain time). */
  now: number;
  /** The agent account the strategy will run on, when known (a copy cannot follow it). */
  account?: Address | null;
  /** The trader's own leverage cap (Settings), if any. */
  personalMaxLeverage?: number | null;
  collateralSymbol?: string;
};

/**
 * Everything `Strategies.create` would refuse with `InvalidStrategy`, in words, plus the trader's own leverage cap.
 * Empty when the draft can be launched.
 */
export function validateDraft(d: StrategyDraft, ctx: DraftContext): DraftIssue[] {
  const out: DraftIssue[] = [];
  const add = (field: DraftField, message: string) => out.push({ field, message });
  const L = STRATEGY_LIMITS;
  const sym = ctx.collateralSymbol ?? "USDC";
  const m = ctx.market;

  if (!m) add("market", "Pick a market");
  else if (!m.enabled) add("market", `${m.symbol} is closed to new positions`);
  else if (m.expiry !== 0 && ctx.now >= m.expiry) add("market", `${m.symbol} has expired`);

  if (!Number.isInteger(d.interval) || d.interval < L.minInterval || d.interval > L.maxInterval) add("interval", "Read the price every 1 minute to 1 day");
  if (!Number.isInteger(d.slippageBps) || d.slippageBps < 1 || d.slippageBps > L.maxSlippageBps) add("slippageBps", "Slippage bound: 0.01% to 5%");
  if (!Number.isInteger(d.leverage) || d.leverage < 1) add("leverage", "Leverage: a whole number, at least 1x");
  else if (m && d.leverage > m.maxLeverage) add("leverage", `${m.symbol} allows up to ${m.maxLeverage}x`);
  else if (ctx.personalMaxLeverage && d.leverage > ctx.personalMaxLeverage) add("leverage", `Your own cap is ${ctx.personalMaxLeverage}x (Settings)`);
  else if (d.leverage > 65_535) add("leverage", "Leverage is too high");
  if (d.margin < ctx.minMargin || d.margin <= 0n) add("margin", `Margin: at least ${units(ctx.minMargin > 0n ? ctx.minMargin : 1n)} ${sym}`);
  else if (d.margin >= 1n << 64n) add("margin", "Margin is too large");

  if (d.stopLossBps !== 0 && !(Number.isInteger(d.stopLossBps) && d.stopLossBps >= L.minBracketBps && d.stopLossBps <= L.maxBracketBps)) {
    add("stopLossBps", "Stop-loss: 0.1% to 50% from the entry, or off");
  }
  if (d.takeProfitBps !== 0) {
    if (!(Number.isInteger(d.takeProfitBps) && d.takeProfitBps >= L.minBracketBps && d.takeProfitBps <= L.maxBracketBps)) add("takeProfitBps", "Take-profit: 0.1% to 50% from the entry, or off");
    else if (d.takeProfitBps <= d.slippageBps) add("takeProfitBps", `Take-profit must be wider than the slippage bound (${bpsText(d.slippageBps)})`);
  }

  if (d.kind === "trend") {
    if (!Number.isInteger(d.period) || d.period < L.minPeriod) add("period", "Fast average: at least 2 readings");
    if (!Number.isInteger(d.slowPeriod) || d.slowPeriod > L.maxPeriod) add("slowPeriod", "Slow average: at most 200 readings");
    else if (Number.isInteger(d.period) && d.slowPeriod <= d.period) add("slowPeriod", "Slow average: more readings than the fast one");
    if (!Number.isInteger(d.bandBps) || d.bandBps < 0 || d.bandBps > L.maxBandBps) add("bandBps", "Band: 0% to 20%");
  } else if (d.kind === "meanRevert") {
    if (!Number.isInteger(d.period) || d.period < L.minPeriod || d.period > L.maxPeriod) add("period", "Average: 2 to 200 readings");
    if (!Number.isInteger(d.bandBps) || d.bandBps < 1 || d.bandBps > L.maxBandBps) add("bandBps", "Entry band: 0.01% to 20%");
    if (!Number.isInteger(d.exitBps) || d.exitBps < 0) add("exitBps", "Exit band: 0% or more");
    else if (Number.isInteger(d.bandBps) && d.exitBps >= d.bandBps) add("exitBps", "Exit band: inside the entry band");
  } else {
    if (!d.leader || d.leader.toLowerCase() === ZERO_ADDRESS) add("leader", "Enter the address to copy");
    else if (ctx.account && d.leader.toLowerCase() === ctx.account.toLowerCase()) add("leader", "An account cannot copy itself");
    if (!Number.isInteger(d.ratioBps) || d.ratioBps < 1 || d.ratioBps > L.maxRatioBps) add("ratioBps", "Share of their size: 0.01% to 1,000%");
    if (d.maxSize <= 0n) add("maxSize", "Set the largest position the copy may hold");
    else if (d.maxSize >= 1n << 80n) add("maxSize", "Largest position is too large");
  }
  return out;
}

/** The draft as the contract's `Config`, with the fields its kind does not use set to zero (as `_validate` wants). */
export function toConfig(d: StrategyDraft): StrategyConfig {
  const copy = d.kind === "copy";
  return {
    kind: KIND_CODE[d.kind],
    interval: d.interval,
    margin: d.margin,
    leverage: d.leverage,
    maxSlippageBps: d.slippageBps,
    allowShort: d.allowShort,
    stopLossBps: d.stopLossBps,
    takeProfitBps: d.takeProfitBps,
    period: copy ? 0 : d.period,
    slowPeriod: d.kind === "trend" ? d.slowPeriod : 0,
    bandBps: copy ? 0 : d.bandBps,
    exitBps: d.kind === "meanRevert" ? d.exitBps : 0,
    ratioBps: copy ? d.ratioBps : 0,
    leader: copy && d.leader ? d.leader : ZERO_ADDRESS,
    maxSize: copy ? d.maxSize : 0n,
  };
}

/** A running strategy's `Config` back as a draft (to launch the same thing elsewhere). */
export function fromConfig(c: StrategyConfig): StrategyDraft {
  const kind = kindOf(Number(c.kind));
  return {
    kind,
    interval: Number(c.interval),
    margin: BigInt(c.margin),
    leverage: Number(c.leverage),
    slippageBps: Number(c.maxSlippageBps),
    allowShort: c.allowShort,
    stopLossBps: Number(c.stopLossBps),
    takeProfitBps: Number(c.takeProfitBps),
    period: Number(c.period),
    slowPeriod: Number(c.slowPeriod),
    bandBps: Number(c.bandBps),
    exitBps: Number(c.exitBps),
    ratioBps: Number(c.ratioBps),
    leader: c.leader.toLowerCase() === ZERO_ADDRESS ? null : c.leader,
    maxSize: BigInt(c.maxSize),
  };
}

/** Readings a strategy needs before it acts: trend waits for the slow average, mean reversion for its average. */
export function warmupReadings(d: Pick<StrategyDraft, "kind" | "period" | "slowPeriod">): number {
  if (d.kind === "trend") return d.slowPeriod;
  if (d.kind === "meanRevert") return d.period;
  return 1;
}

/** The size of one entry (`margin x leverage`), 6 decimals. */
export const entrySize = (d: Pick<StrategyDraft, "margin" | "leverage">): bigint => d.margin * BigInt(Math.max(0, Math.floor(d.leverage)));

/** Price move against a position that liquidates it (losses reach 90% of the margin). */
export const liquidationMove = (leverage: number): number => (leverage > 0 ? 0.9 / leverage : 1);

// ─────────────────────────────── Approval ───────────────────────────────

/** An agent policy on an AgentAccount (`agents(agent)`). */
export type AgentPolicy = { expiry: bigint; maxLeverage: number; maxMargin: bigint };

export type PolicyPlan = {
  /** Whether the account needs a new `setAgent(strategies, …)`. */
  change: boolean;
  next: AgentPolicy;
  /** Why it changes, in words (null when it does not). */
  reason: string | null;
};

/**
 * The approval the Strategies contract needs on the account so this strategy (and every other live one, which all
 * share the one approval) can place its orders for `keepFor` seconds. Never lowers what is approved: the new policy
 * is the larger of each limit. No change when the current approval covers them and lapses no more than a day (or a
 * seventh of `keepFor`) before the wanted time.
 */
export function planPolicy(args: {
  current: AgentPolicy | null;
  need: { leverage: number; margin: bigint };
  live?: readonly { leverage: number; margin: bigint }[];
  now: number;
  keepFor: number;
}): PolicyPlan {
  const { current, now, keepFor } = args;
  const live = args.live ?? [];
  const active = current !== null && current.expiry > BigInt(now);
  const needLeverage = Math.max(args.need.leverage, ...live.map((x) => x.leverage));
  const needMargin = [args.need.margin, ...live.map((x) => x.margin)].reduce((a, b) => (b > a ? b : a), 0n);
  const want = BigInt(Math.floor(now + keepFor));
  const slack = BigInt(Math.floor(Math.min(86_400, keepFor / 7)));
  const next: AgentPolicy = {
    expiry: active && current!.expiry > want ? current!.expiry : want,
    maxLeverage: Math.max(needLeverage, active ? current!.maxLeverage : 0),
    maxMargin: active && current!.maxMargin > needMargin ? current!.maxMargin : needMargin,
  };
  if (!active) {
    return { change: true, next, reason: current && current.expiry > 0n ? "the approval has lapsed" : "the account has not approved strategies yet" };
  }
  const reasons: string[] = [];
  if (current!.maxLeverage < needLeverage) reasons.push(`leverage up to ${needLeverage}x`);
  if (current!.maxMargin < needMargin) reasons.push(`more margin per order`);
  if (current!.expiry + slack < want) reasons.push("a later expiry");
  if (reasons.length === 0) return { change: false, next: current!, reason: null };
  return { change: true, next, reason: reasons.join(", ") };
}

// ─────────────────────────────── Listing ───────────────────────────────

export const byteLength = (text: string): number => new TextEncoder().encode(text).length;

export type Listing = { name: string; description: string; kind: string; uri: string };
export type ListingIssue = { field: keyof Listing; message: string };

/** What `AgentRegistry.register` / `update` would refuse with `InvalidAgent`. */
export function validateListing(l: Listing): ListingIssue[] {
  const out: ListingIssue[] = [];
  const name = byteLength(l.name.trim());
  const kind = byteLength(l.kind.trim());
  if (name === 0) out.push({ field: "name", message: "Give the agent a name" });
  else if (name > LISTING_LIMITS.name) out.push({ field: "name", message: `Name: at most ${LISTING_LIMITS.name} bytes (${name} now)` });
  const description = byteLength(l.description.trim());
  if (description > LISTING_LIMITS.description) out.push({ field: "description", message: `Description: at most ${LISTING_LIMITS.description} bytes (${description} now)` });
  if (kind === 0) out.push({ field: "kind", message: "Say what kind of agent it is" });
  else if (kind > LISTING_LIMITS.kind) out.push({ field: "kind", message: `Kind: at most ${LISTING_LIMITS.kind} bytes` });
  const uri = byteLength(l.uri.trim());
  if (uri > LISTING_LIMITS.uri) out.push({ field: "uri", message: `Link: at most ${LISTING_LIMITS.uri} bytes` });
  return out;
}

/** Kind labels the directory knows; any other short label works too. */
export const LISTING_KINDS: readonly { value: string; label: string }[] = [
  { value: "trend", label: "Trend follower" },
  { value: "mean-reversion", label: "Mean reversion" },
  { value: "copy", label: "Copy trader" },
  { value: "llm", label: "AI (LLM) agent" },
  { value: "market-maker", label: "Market maker" },
  { value: "manual", label: "Manual, with bots" },
];

export const listingKindFor = (kind: StrategyKind): string => (kind === "meanRevert" ? "mean-reversion" : kind);

// ─────────────────────────────── Words ───────────────────────────────

/** "0.15%", "1%", "0.05%". */
export function bpsText(bps: number): string {
  return `${Number((bps / 100).toFixed(2)).toLocaleString("en-US", { maximumFractionDigits: 2 })}%`;
}

/** "1 min", "15 min", "1 hour", "4 hours", "1 day", "90 s". */
export function everyText(seconds: number): string {
  const preset = INTERVAL_PRESETS.find((p) => p.seconds === seconds);
  if (preset) return preset.label;
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3_600) return `${Math.round((seconds / 60) * 10) / 10} min`;
  if (seconds < 86_400) return `${Math.round((seconds / 3_600) * 10) / 10} hours`;
  return `${Math.round((seconds / 86_400) * 10) / 10} days`;
}

/** A compact one-line description of a strategy's settings. */
export function configLine(c: StrategyDraft): string {
  const risk = `${c.leverage}x${c.stopLossBps ? `, stop ${bpsText(c.stopLossBps)}` : ""}${c.takeProfitBps ? `, target ${bpsText(c.takeProfitBps)}` : ""}${c.allowShort ? "" : ", long only"}`;
  if (c.kind === "trend") return `Averages ${c.period}/${c.slowPeriod}, band ${bpsText(c.bandBps)}, every ${everyText(c.interval)}, ${risk}`;
  if (c.kind === "meanRevert") return `Average ${c.period}, in at ${bpsText(c.bandBps)}, out at ${bpsText(c.exitBps)}, every ${everyText(c.interval)}, ${risk}`;
  return `${bpsText(c.ratioBps)} of their size, checked every ${everyText(c.interval)}, ${risk}`;
}

function units(amount: bigint): string {
  const whole = amount / 1_000_000n;
  const frac = (amount % 1_000_000n).toString().padStart(6, "0").replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole.toString();
}

function clampInt(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, Math.round(n)));
}
