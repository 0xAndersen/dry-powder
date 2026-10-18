import { readContract, simulateContract, writeContract } from "wagmi/actions";
import type { Address, Hex } from "viem";
import { agentAccountAbi, twapOrdersAbi } from "./abi";
import type { ActionContext } from "./actions";
import { UserFacingError } from "./errors";
import { fmtUsdc } from "./format";
import type { Instrument } from "./instruments";
import { sessionWrite } from "./session";

/** The TwapOrders contract's bounds. */
export const TWAP_MIN_SLICES = 2;
export const TWAP_MAX_SLICES = 100;
export const TWAP_MIN_INTERVAL = 30;
export const TWAP_MAX_INTERVAL = 86_400;
export const TWAP_MAX_SLIPPAGE_BPS = 500;
/** Gaps offered between slices, in seconds. */
export const TWAP_INTERVALS = [30, 60, 300, 900, 3_600] as const;

export type Twap = {
  isLong: boolean;
  slices: number;
  done: number;
  interval: number;
  maxSlippageBps: number;
  /** Unix seconds: the earliest time for the next slice. */
  nextAt: number;
  sliceMargin: bigint;
  /** Slices the account refused in a row; three end the TWAP. */
  refusals: number;
  sliceSize: bigint;
};

export type TwapPlan = { slices: number; interval: number; sliceMargin: bigint; sliceSize: bigint; slippageBps: number };

/**
 * Equal slices of `margin` and `size`. Each is rounded down (the contract places equal slices), so the total can be
 * a few millionths short of what was entered. Slippage is kept inside the contract's 0.01% to 5%.
 */
export function planTwap(margin: bigint, size: bigint, slices: number, interval: number, slippageBps: number): TwapPlan {
  const n = BigInt(slices);
  return {
    slices,
    interval,
    sliceMargin: margin / n,
    sliceSize: size / n,
    slippageBps: Math.max(1, Math.min(TWAP_MAX_SLIPPAGE_BPS, Math.round(slippageBps))),
  };
}

/** The whole-multiple leverage a slice needs from a policy (`size <= margin x leverage`). */
export function sliceLeverage(plan: { sliceMargin: bigint; sliceSize: bigint }): number {
  if (plan.sliceMargin === 0n) return 0;
  return Number((plan.sliceSize + plan.sliceMargin - 1n) / plan.sliceMargin);
}

/** "30 s", "5 min", "1 h", "2.5 h". */
export function fmtInterval(seconds: number): string {
  if (seconds < 60) return `${seconds} s`;
  if (seconds < 3_600) return `${Math.round((seconds / 60) * 10) / 10} min`;
  return `${Math.round((seconds / 3_600) * 10) / 10} h`;
}

/** Roughly how long a TWAP runs: the first slice goes at once, the last after `slices - 1` gaps. */
export const twapDuration = (plan: { slices: number; interval: number }): number => (plan.slices - 1) * plan.interval;

function requireTrading(ctx: ActionContext): { session: NonNullable<ActionContext["session"]>; twapOrders: Address } {
  if (!ctx.session) throw new UserFacingError("TWAP orders run from your trading account: turn on instant trading first.");
  if (!ctx.cfg.twapOrders) throw new UserFacingError("This deployment has no TWAP contract.");
  return { session: ctx.session, twapOrders: ctx.cfg.twapOrders };
}

/**
 * Makes sure the trading account lets the TWAP contract place this plan's slices until it has finished. The
 * approval matches the session key's own limits (the contract refuses a TWAP from the key beyond them), so
 * later TWAPs inside those limits need no wallet confirmation until it lapses. Returns whether the wallet signed.
 */
export async function ensureTwapApproval(
  ctx: ActionContext,
  owner: Address | undefined,
  plan: TwapPlan,
  session: { expiry: number; maxLeverage: number; maxMargin: bigint } | null,
): Promise<boolean> {
  const { session: s, twapOrders } = requireTrading(ctx);
  const { wagmi, cfg, api } = ctx;
  api.preparing("Checking the TWAP approval on your trading account");
  const [expiry, maxLeverage, maxMargin] = await readContract(wagmi, {
    address: s.account,
    abi: agentAccountAbi,
    functionName: "agents",
    args: [twapOrders],
    chainId: cfg.chainId,
  });
  const now = BigInt(Math.floor(Date.now() / 1000));
  // The whole TWAP, plus an hour for slow pokes and refusals.
  const until = now + BigInt(twapDuration(plan) + 3_600);
  const needLeverage = sliceLeverage(plan);
  const active = expiry > now;
  if (active && expiry >= until && maxLeverage >= needLeverage && maxMargin >= plan.sliceMargin) return false;
  if (!owner) throw new UserFacingError("Connect the wallet that owns your trading account: it allows TWAP orders with one confirmation.");
  const nextExpiry = [until, active ? expiry : 0n, session ? BigInt(session.expiry) : 0n].reduce((a, b) => (b > a ? b : a));
  const nextLeverage = Math.max(needLeverage, active ? maxLeverage : 0, session?.maxLeverage ?? 0);
  const nextMargin = [plan.sliceMargin, active ? maxMargin : 0n, session?.maxMargin ?? 0n].reduce((a, b) => (b > a ? b : a));
  await api.send("Allow TWAP orders on your trading account", async () => {
    const { request } = await simulateContract(wagmi, {
      address: s.account,
      abi: agentAccountAbi,
      functionName: "setAgent",
      args: [twapOrders, nextExpiry, nextLeverage, nextMargin],
      account: owner,
      chainId: cfg.chainId,
    });
    return writeContract(wagmi, request);
  });
  return true;
}

/**
 * Starts a TWAP (or replaces the one in this market): the approval if needed (one wallet confirmation), then the
 * TWAP itself, signed by the session key. The keeper places each slice when it is due and fills it at the next
 * price; slices on the side held add to the position.
 */
export async function twapFlow(
  ctx: ActionContext,
  req: {
    instrument: Instrument;
    isLong: boolean;
    plan: TwapPlan;
    owner: Address | undefined;
    session: { expiry: number; maxLeverage: number; maxMargin: bigint } | null;
  },
): Promise<string> {
  const { session, twapOrders } = requireTrading(ctx);
  const { instrument, isLong, plan } = req;
  const side = isLong ? "long" : "short";
  await ensureTwapApproval(ctx, req.owner, plan, req.session);
  await ctx.api.send(`TWAP ${side} ${instrument.symbol}: ${plan.slices} slices, one every ${fmtInterval(plan.interval)}`, () =>
    sessionWrite(session.client, {
      address: twapOrders,
      abi: twapOrdersAbi,
      functionName: "setTwap",
      args: [session.account, instrument.id, isLong, plan.sliceMargin, plan.sliceSize, plan.slices, plan.interval, plan.slippageBps],
    }),
  );
  return `TWAP started: ${plan.slices} ${side} slices of ${fmtUsdc(plan.sliceSize)} ${ctx.cfg.collateralSymbol}, one every ${fmtInterval(plan.interval)}. The keeper places each one and fills it at the next price; each fill adds to the position.`;
}

/** Stops the TWAP in `marketId`. Slices already placed stay (a resting one can be cancelled like any order). */
export async function cancelTwap(ctx: ActionContext, marketId: Hex, label: string): Promise<void> {
  const { session, twapOrders } = requireTrading(ctx);
  await ctx.api.send(label, () =>
    sessionWrite(session.client, { address: twapOrders, abi: twapOrdersAbi, functionName: "cancelTwap", args: [session.account, marketId] }),
  );
}
