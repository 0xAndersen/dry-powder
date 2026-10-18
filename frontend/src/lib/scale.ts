import { parseEventLogs } from "viem";
import { perpEngineAbi } from "./abi";
import { ensureAllowance, submitBatch, type ActionContext, type BatchCall } from "./actions";
import { fmtPrice } from "./format";
import type { Instrument } from "./instruments";
import { orderTracker } from "./order-tracker";

/** Most orders one ladder places (one multicall with instant trading; one confirmation each from a wallet). */
export const MAX_SCALE_ORDERS = 20;

export type ScaleOrder = { price: bigint; margin: bigint; size: bigint };

/**
 * Splits `margin` and `size` evenly over the ladder's prices; the last order takes the rounding remainder, so the
 * orders add up to exactly what was entered.
 */
export function splitLadder(prices: readonly bigint[], margin: bigint, size: bigint): ScaleOrder[] {
  const n = BigInt(prices.length);
  if (n === 0n) return [];
  const m = margin / n;
  const s = size / n;
  return prices.map((price, i) => {
    const last = i === prices.length - 1;
    return { price, margin: last ? margin - m * (n - 1n) : m, size: last ? size - s * (n - 1n) : s };
  });
}

/**
 * Places a ladder of limit orders. With instant trading the whole ladder is one atomic transaction through the
 * trading account (all or nothing); from a wallet each order is its own confirmation. Brackets go on every order:
 * the first fill opens the position with them, and each later fill moves them and refunds their fee.
 */
export async function scaleFlow(
  ctx: ActionContext,
  req: { instrument: Instrument; isLong: boolean; orders: readonly ScaleOrder[]; takeProfit: bigint; stopLoss: bigint; required: bigint },
): Promise<string> {
  const { instrument, isLong, orders } = req;
  const side = isLong ? "long" : "short";
  await ensureAllowance(ctx, ctx.cfg.perpEngine, req.required);
  const calls: BatchCall[] = orders.map((o, i) => ({
    functionName: "createLimitOrder",
    args: [{ priceId: instrument.id, isLong, margin: o.margin, size: o.size, triggerPrice: o.price, takeProfit: req.takeProfit, stopLoss: req.stopLoss, stopEntry: false }],
    label: `Limit ${side} ${instrument.symbol} at ${fmtPrice(o.price, instrument.priceDecimals)} (${i + 1} of ${orders.length})`,
  }));
  const receipts = await submitBatch(ctx, `Place ${orders.length} limit ${side}s on ${instrument.symbol}`, calls);
  let placed = 0;
  for (const receipt of receipts) {
    for (const log of parseEventLogs({ abi: perpEngineAbi, logs: receipt.logs, eventName: "OrderCreated" })) {
      const orderId = log.args.orderId;
      // Bracket orders are created when a limit fills, not here; every OrderCreated now is one of the ladder's.
      orderTracker.track({ orderId, marketId: instrument.id, symbol: instrument.symbol, action: "limit", isLong });
      placed += 1;
    }
  }
  const first = fmtPrice(orders[0]!.price, instrument.priceDecimals);
  const last = fmtPrice(orders[orders.length - 1]!.price, instrument.priceDecimals);
  return `${placed || orders.length} limit ${side}s resting from ${first} to ${last}. A keeper fills each one when the price is reached; each fill adds to the position.`;
}
