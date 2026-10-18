import type { ClosedTrade } from "./aggregate";
import { createLocalStore } from "./storage";
import { tradeStats } from "./trade-stats";

/**
 * Practice challenges: a goal with risk rules, measured from the trades closed after the start (the chain's own
 * history) and the open positions opened after it. The stake is the account value when the challenge starts.
 * Test funds added later (Start over, the faucet) do not count: only trading results do.
 */
export type ChallengeRules = {
  /** Realised result to reach, as a share of the stake (0.05: +5%; 0: finish ahead). Null: no target. */
  target: number | null;
  /** Most the result may fall from its best, open positions included, as a share of the stake. */
  maxDrawdown: number | null;
  /** Most one UTC day may lose, open positions included, as a share of the stake. */
  maxDailyLoss: number | null;
  minTrades: number;
  minWinRate: number | null;
  minProfitFactor: number | null;
  noLiquidations: boolean;
  days: number;
};

export type ChallengeDef = { id: string; name: string; blurb: string; rules: ChallengeRules };

export const CHALLENGES: readonly ChallengeDef[] = [
  {
    id: "steady",
    name: "Steady hand",
    blurb: "Make 5% in a week without ever giving back 3%.",
    rules: { target: 0.05, maxDrawdown: 0.03, maxDailyLoss: null, minTrades: 3, minWinRate: null, minProfitFactor: null, noLiquidations: true, days: 7 },
  },
  {
    id: "evaluation",
    name: "Evaluation",
    blurb: "The prop-firm test: 10% in 30 days, at most 5% drawdown and 2.5% on any one day.",
    rules: { target: 0.1, maxDrawdown: 0.05, maxDailyLoss: 0.025, minTrades: 5, minWinRate: null, minProfitFactor: null, noLiquidations: true, days: 30 },
  },
  {
    id: "sharpshooter",
    name: "Sharpshooter",
    blurb: "Ten trades in a week, six of them winners, with winners worth half again what the losers cost.",
    rules: { target: null, maxDrawdown: null, maxDailyLoss: null, minTrades: 10, minWinRate: 0.6, minProfitFactor: 1.5, noLiquidations: false, days: 7 },
  },
  {
    id: "survivor",
    name: "Survivor",
    blurb: "Twenty trades in two weeks, never liquidated, and finish ahead.",
    rules: { target: 0, maxDrawdown: null, maxDailyLoss: null, minTrades: 20, minWinRate: null, minProfitFactor: null, noLiquidations: true, days: 14 },
  },
];

export const challengeById = (id: string): ChallengeDef | undefined => CHALLENGES.find((c) => c.id === id);

export type Attempt = {
  challenge: string;
  /** Lower-case account, chain and engine: an attempt belongs to one account on one deployment. */
  account: string;
  chainId: number;
  engine: string;
  /** Account value at the start, collateral micro-units. */
  stake: string;
  /** Chain time (unix seconds) at the start. */
  startedAt: number;
  endedAt: number | null;
  result: "passed" | "failed" | "abandoned" | null;
  reason: string | null;
  /** The figures when it ended. */
  final: { net: string; trades: number } | null;
};

const isAttempt = (a: unknown): a is Attempt => {
  const x = a as Attempt;
  return (
    !!x &&
    typeof x.challenge === "string" &&
    typeof x.account === "string" &&
    typeof x.engine === "string" &&
    Number.isFinite(x.chainId) &&
    typeof x.stake === "string" &&
    /^\d+$/.test(x.stake) &&
    Number.isFinite(x.startedAt)
  );
};

export const challengeAttempts = createLocalStore<Attempt[]>("dp:challenges:v1", [], (stored) => {
  if (!Array.isArray(stored)) return null;
  return stored.filter(isAttempt).slice(-50);
});

export type RuleCheck = {
  key: string;
  label: string;
  /** True: met (or not broken), false: broken (or missed at the end), null: not decided yet. */
  ok: boolean | null;
  /** 0..1 progress toward a goal, or how much of a risk budget is used. */
  fill: number;
  detail: string;
  kind: "goal" | "limit";
};

export type ChallengeProgress = {
  status: "active" | "passed" | "failed";
  reason: string | null;
  realised: bigint;
  unrealised: bigint;
  trades: number;
  checks: RuleCheck[];
  /** Seconds left (0 once over). */
  timeLeft: number;
  /** The trades the challenge counts, for its share card. */
  counted: ClosedTrade[];
};

const pct = (fraction: number, dp = 1) => `${(fraction * 100).toFixed(dp)}%`;
const share = (amount: bigint, stake: bigint): number => (stake > 0n ? Number((amount * 1_000_000n) / stake) / 1e6 : 0);

/**
 * Where an attempt stands at `now` (chain seconds). `trades`: the account's closed trades (any period, any order);
 * `unrealised`: PnL of the positions opened after the start, at current prices.
 */
export function evaluateChallenge(def: ChallengeDef, attempt: Pick<Attempt, "stake" | "startedAt">, trades: readonly ClosedTrade[], unrealised: bigint, now: number): ChallengeProgress {
  const r = def.rules;
  const stake = BigInt(attempt.stake);
  const start = attempt.startedAt;
  const end = start + r.days * 86_400;
  // A trade counts when the whole round trip is inside the challenge.
  const counted = trades.filter((t) => t.openTime !== null && t.openTime >= start && t.closeTime >= start && t.closeTime <= end);
  const stats = tradeStats(counted);
  const timeLeft = Math.max(0, end - now);
  const over = now >= end;

  // Drawdown along the realised curve, then to where the open positions stand now.
  let peak = 0n;
  let drawdown = 0n;
  for (const p of stats.curve) {
    if (p.value > peak) peak = p.value;
    if (peak - p.value > drawdown) drawdown = peak - p.value;
  }
  const current = stats.net + unrealised;
  if (current > peak) peak = current;
  if (peak - current > drawdown) drawdown = peak - current;
  // The worst UTC day; today's includes what the open positions stand at.
  const today = Math.floor(now / 86_400);
  let worstDay = 0n;
  const days = new Map(stats.days);
  const t = days.get(today) ?? { net: 0n, trades: 0 };
  days.set(today, { net: t.net + unrealised, trades: t.trades });
  for (const d of days.values()) if (-d.net > worstDay) worstDay = -d.net;

  const checks: RuleCheck[] = [];
  const limit = (key: string, label: string, used: bigint, max: number) => {
    const budget = (stake * BigInt(Math.round(max * 1e6))) / 1_000_000n;
    const ok = used <= budget;
    checks.push({ key, label, ok: ok ? (over ? true : null) : false, fill: budget > 0n ? Math.min(1, Number((used * 1000n) / budget) / 1000) : used > 0n ? 1 : 0, detail: `${pct(share(used, stake), 2)} of ${pct(max)}`, kind: "limit" });
  };
  if (r.target !== null) {
    const need = (stake * BigInt(Math.round(r.target * 1e6))) / 1_000_000n;
    const ok = r.target === 0 ? stats.net > 0n : stats.net >= need;
    checks.push({
      key: "target",
      label: r.target === 0 ? "Finish ahead (closed trades)" : `Make ${pct(r.target, 0)} (closed trades)`,
      ok: ok ? true : over ? false : null,
      fill: r.target === 0 ? (stats.net > 0n ? 1 : 0) : need > 0n ? Math.max(0, Math.min(1, Number((stats.net * 1000n) / need) / 1000)) : 0,
      detail: `${stats.net >= 0n ? "+" : ""}${pct(share(stats.net, stake), 2)}${r.target === 0 ? "" : ` of +${pct(r.target, 0)}`}`,
      kind: "goal",
    });
  }
  checks.push({
    key: "trades",
    label: `At least ${r.minTrades} trades`,
    ok: stats.trades >= r.minTrades ? true : over ? false : null,
    fill: Math.min(1, stats.trades / Math.max(1, r.minTrades)),
    detail: `${stats.trades} of ${r.minTrades}`,
    kind: "goal",
  });
  if (r.minWinRate !== null) {
    const ok = stats.winRate !== null && stats.winRate >= r.minWinRate;
    checks.push({ key: "winRate", label: `Win rate ${pct(r.minWinRate, 0)} or more`, ok: ok && stats.trades >= r.minTrades ? true : over ? ok : null, fill: stats.winRate === null ? 0 : Math.min(1, stats.winRate / r.minWinRate), detail: stats.winRate === null ? "no trades yet" : pct(stats.winRate, 0), kind: "goal" });
  }
  if (r.minProfitFactor !== null) {
    const pf = stats.profitFactor ?? (stats.wins > 0 ? Infinity : null);
    const ok = pf !== null && pf >= r.minProfitFactor;
    checks.push({ key: "profitFactor", label: `Profit factor ${r.minProfitFactor} or more`, ok: ok && stats.trades >= r.minTrades ? true : over ? ok : null, fill: pf === null ? 0 : Math.min(1, pf / r.minProfitFactor), detail: pf === null ? "no trades yet" : pf === Infinity ? "no losses yet" : pf.toFixed(2), kind: "goal" });
  }
  if (r.maxDrawdown !== null) limit("drawdown", `Never down ${pct(r.maxDrawdown, 0)} from the best`, drawdown, r.maxDrawdown);
  if (r.maxDailyLoss !== null) limit("daily", `No day worse than ${pct(r.maxDailyLoss, 1)}`, worstDay, r.maxDailyLoss);
  if (r.noLiquidations) {
    checks.push({ key: "liquidations", label: "Never liquidated", ok: stats.liquidations > 0 ? false : over ? true : null, fill: stats.liquidations > 0 ? 1 : 0, detail: stats.liquidations > 0 ? `${stats.liquidations} liquidated` : "none", kind: "limit" });
  }

  const broken = checks.find((c) => c.kind === "limit" && c.ok === false);
  const goalsMet = checks.filter((c) => c.kind === "goal").every((c) => c.ok === true);
  let status: ChallengeProgress["status"] = "active";
  let reason: string | null = null;
  if (broken) {
    status = "failed";
    reason = `${broken.label}: broken (${broken.detail})`;
  } else if (goalsMet) {
    status = "passed";
    reason = `${def.name} passed with ${stats.trades} trades`;
  } else if (over) {
    status = "failed";
    const missed = checks.find((c) => c.kind === "goal" && c.ok !== true);
    reason = `Time ran out${missed ? `: ${missed.label.toLowerCase()} (${missed.detail})` : ""}`;
  }
  return { status, reason, realised: stats.net, unrealised, trades: stats.trades, checks, timeLeft, counted };
}
