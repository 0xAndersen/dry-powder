import type { PositionView } from "@/hooks/use-account-data";
import { submitClose, submitOpen, type ActionContext, type OpenRequest } from "./actions";
import type { Instrument } from "./instruments";
import type { Quote } from "./oracle";
import { needsKeeperOrders } from "./math";
import { orderTracker } from "./order-tracker";

/** User-level flows built from the primitive actions: they also register keeper orders for live tracking. */

export async function openFlow(ctx: ActionContext, req: OpenRequest): Promise<string> {
  const { instrument, isLong } = req;
  const side = isLong ? "long" : "short";
  const label = req.type === "limit" ? `Place limit ${side} ${instrument.symbol}` : `${isLong ? "Buy" : "Sell"} ${instrument.symbol}`;
  const result = await submitOpen(ctx, req, label);
  if (result.orderId === null) return `${isLong ? "Long" : "Short"} ${instrument.symbol} opened.`;
  orderTracker.track({
    orderId: result.orderId,
    marketId: instrument.id,
    symbol: instrument.symbol,
    action: req.type === "limit" ? "limit" : "open",
    isLong,
  });
  return req.type === "limit"
    ? `Limit ${side} #${result.orderId} is resting. A keeper fills it when the price is reached.`
    : `Market ${side} sent as order #${result.orderId}. A keeper fills it at the next oracle price.`;
}

export async function closeFlow(
  ctx: ActionContext,
  args: { instrument: Instrument; view: PositionView; reference: Quote | null; slippageBps: number; executionFee: bigint; balance?: bigint },
): Promise<string> {
  const { instrument, view } = args;
  const pos = view.position;
  const settled = instrument.settlementPrice !== 0n;
  const result = await submitClose(
    ctx,
    {
      instrument,
      isLong: pos.isLong,
      reference: args.reference,
      slippageBps: args.slippageBps,
      // Moving an existing close order is free; only a new one escrows the execution fee.
      executionFee: pos.closeOrderId === 0n ? args.executionFee : 0n,
      // A wallet that cannot cover the keeper's fee closes directly against the on-chain price instead.
      direct: pos.closeOrderId === 0n && args.balance !== undefined && args.balance < args.executionFee,
      highLeverage: needsKeeperOrders(pos.size, pos.margin),
    },
    settled ? `Settle and close ${instrument.symbol}` : `Close ${instrument.symbol}`,
  );
  if (result.direct) {
    return settled ? `${instrument.symbol} position closed at the settlement price.` : `${instrument.symbol} position closed.`;
  }
  if (result.orderId !== null) {
    orderTracker.track({ orderId: result.orderId, marketId: instrument.id, symbol: instrument.symbol, action: "close", isLong: pos.isLong });
  }
  return `Close order${result.orderId !== null ? ` #${result.orderId}` : ""} sent. A keeper executes it at the next oracle price.`;
}

/** Resolves once `done()` is true, polling every 400 ms. Rejects after `timeoutMs`. */
export function waitFor(done: () => boolean, timeoutMs: number, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const timer = setInterval(() => {
      if (done()) {
        clearInterval(timer);
        resolve();
      } else if (Date.now() - started > timeoutMs) {
        clearInterval(timer);
        reject(new Error(message));
      }
    }, 400);
  });
}
