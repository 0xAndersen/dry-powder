import type { AccountData } from "@/hooks/use-account-data";
import type { EngineParams, MarketPrice } from "@/hooks/use-market-data";
import type { Instrument } from "./instruments";
import { valuePosition } from "./position";

/** Order types that escrow margin and open (or add to) a position: LimitOpen and, from v3.1, StopOpen. */
export const isOpenOrderType = (orderType: number) => orderType === 0 || orderType === 4;

export type AccountTotals = {
  /** Margin locked in open positions. */
  margin: bigint;
  /** Unrealised PnL at the current marks, after funding, before close fees. */
  pnl: bigint;
  /** False when some position has no mark yet (its PnL is left out). */
  priced: boolean;
  /** Margin, fee budgets and keeper fees escrowed by resting orders. */
  escrow: bigint;
  nearest: { symbol: string; distance: number } | null;
  /** Balance + margin + escrow + unrealised PnL. */
  equity: bigint;
  /** Notional of open positions, long and short. */
  longExposure: bigint;
  shortExposure: bigint;
};

/** One account's totals across positions and orders, as the account bar and the portfolio show them. */
export function accountTotals(account: AccountData, prices: Map<string, MarketPrice>, params: EngineParams, byId: Map<string, Instrument>): AccountTotals {
  let margin = 0n;
  let pnl = 0n;
  let priced = true;
  let longExposure = 0n;
  let shortExposure = 0n;
  let nearest: AccountTotals["nearest"] = null;
  for (const p of account.positions) {
    margin += p.position.margin;
    if (p.position.isLong) longExposure += p.position.size;
    else shortExposure += p.position.size;
    const id = p.position.priceId.toLowerCase();
    const value = valuePosition(p, prices.get(id)?.mark ?? null, params.maxProfitMultiple);
    if (value.pnl === null) priced = false;
    else pnl += value.pnl;
    const d = value.liquidatableNow ? 0 : value.liquidationDistance;
    if (d !== null && (nearest === null || d < nearest.distance)) nearest = { symbol: byId.get(id)?.symbol ?? "Position", distance: Math.max(0, d) };
  }
  let escrow = 0n;
  for (const { order } of account.orders) {
    escrow += order.executionFee;
    if (!isOpenOrderType(order.orderType)) continue;
    const brackets = (order.takeProfit !== 0n ? 1n : 0n) + (order.stopLoss !== 0n ? 1n : 0n);
    escrow += order.margin + order.feeBudget + brackets * order.executionFee;
  }
  return { margin, pnl, priced, escrow, nearest, equity: account.balance + margin + escrow + pnl, longExposure, shortExposure };
}
