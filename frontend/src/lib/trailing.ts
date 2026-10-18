import { simulateContract, writeContract } from "wagmi/actions";
import { maxUint64, type Address, type Hex } from "viem";
import { agentAccountAbi, trailingStopsAbi } from "./abi";
import type { ActionContext } from "./actions";
import { UserFacingError } from "./errors";
import { sessionWrite } from "./session";

/** Trail distances offered as presets, in basis points. */
export const TRAIL_PRESETS_BPS = [50, 100, 200, 300, 500] as const;
export const MIN_TRAIL_BPS = 10;
export const MAX_TRAIL_BPS = 5_000;

export type Trail = { distanceBps: number; isLong: boolean; size: bigint; activation: bigint; best: bigint };

/** The stop level a trail sets behind `best` (the contract's own rounding: the offset rounds down). */
export function trailLevel(best: bigint, distanceBps: number, isLong: boolean): bigint {
  const offset = (best * BigInt(distanceBps)) / 10_000n;
  return isLong ? best - offset : best + offset;
}

function requireTrading(ctx: ActionContext): { session: NonNullable<ActionContext["session"]>; trailingStops: Address } {
  if (!ctx.session) throw new UserFacingError("Trailing stops work for positions in your trading account: turn on instant trading first.");
  if (!ctx.cfg.trailingStops) throw new UserFacingError("This deployment has no trailing-stop contract.");
  return { session: ctx.session, trailingStops: ctx.cfg.trailingStops };
}

/**
 * Lets the trailing-stop contract move stops on the trading account, with the smallest policy an account allows
 * (margin cap 1 micro-USDC, 1x): it can only ever call setTriggerOrder. One wallet confirmation, once per account.
 */
export async function approveTrailing(ctx: ActionContext, owner: Address): Promise<void> {
  const { session, trailingStops } = requireTrading(ctx);
  const { wagmi, cfg, api } = ctx;
  await api.send("Allow trailing stops on your trading account", async () => {
    const { request } = await simulateContract(wagmi, {
      address: session.account,
      abi: agentAccountAbi,
      functionName: "setAgent",
      args: [trailingStops, maxUint64, 1, 1n],
      account: owner,
      chainId: cfg.chainId,
    });
    return writeContract(wagmi, request);
  });
}

/** Sets (or replaces) the trail on the trading account's position in `marketId`. Signed by the session key. */
export async function setTrail(
  ctx: ActionContext,
  args: { marketId: Hex; distanceBps: number; size: bigint; activation: bigint },
  label: string,
): Promise<void> {
  const { session, trailingStops } = requireTrading(ctx);
  if (!(args.distanceBps >= MIN_TRAIL_BPS && args.distanceBps <= MAX_TRAIL_BPS)) throw new UserFacingError("Choose a distance between 0.1% and 50%.");
  await ctx.api.send(label, () =>
    sessionWrite(session.client, {
      address: trailingStops,
      abi: trailingStopsAbi,
      functionName: "setTrail",
      args: [session.account, args.marketId, args.distanceBps, args.size, args.activation],
    }),
  );
}

/** Removes the trail. The stop it last set stays; remove that separately if unwanted. */
export async function clearTrail(ctx: ActionContext, marketId: Hex, label: string): Promise<void> {
  const { session, trailingStops } = requireTrading(ctx);
  await ctx.api.send(label, () =>
    sessionWrite(session.client, { address: trailingStops, abi: trailingStopsAbi, functionName: "clearTrail", args: [session.account, marketId] }),
  );
}
