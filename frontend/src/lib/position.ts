import type { PositionView } from "@/hooks/use-account-data";
import { MAX_UINT256 } from "./format";
import { pricePnl, ratio, unitsOf } from "./math";

export type PositionValue = {
  /** Price PnL minus funding owed, capped at the profit cap. Before the close fee. */
  pnl: bigint | null;
  /** PnL as a fraction of margin. */
  roe: number | null;
  /** True when the profit cap is binding at the mark price. */
  capped: boolean;
  /** Null when the position can never be liquidated by price (a long whose margin covers its size). */
  liquidationPrice: bigint | null;
  /** True when the position is past the threshold at any price (funding has eaten the margin). */
  liquidatableNow: boolean;
  /** Distance from mark to liquidation as a fraction of mark. */
  liquidationDistance: number | null;
  /** Units of the underlying, 18 decimals. */
  units: bigint;
  leverage: number;
};

export function valuePosition(view: PositionView, mark: bigint | null, maxProfitMultiple: bigint): PositionValue {
  const pos = view.position;
  const never = pos.isLong ? view.liquidationPrice === 0n : false;
  const always = pos.isLong ? view.liquidationPrice === MAX_UINT256 : view.liquidationPrice === 0n;
  const liquidationPrice = never || always ? null : view.liquidationPrice;

  let pnl: bigint | null = null;
  let capped = false;
  if (mark !== null) {
    pnl = pricePnl(pos.size, pos.entryPrice, mark, pos.isLong) - view.fundingOwed;
    const cap = pos.margin * maxProfitMultiple;
    if (pnl > cap) {
      pnl = cap;
      capped = true;
    }
    // A loss is bounded by the margin; beyond that the position is liquidated.
    if (pnl < -pos.margin) pnl = -pos.margin;
  }

  let liquidationDistance: number | null = null;
  if (mark !== null && mark > 0n && liquidationPrice !== null) {
    const gap = pos.isLong ? mark - liquidationPrice : liquidationPrice - mark;
    liquidationDistance = ratio(gap, mark);
  }

  return {
    pnl,
    roe: pnl !== null && pos.margin > 0n ? ratio(pnl, pos.margin) : null,
    capped,
    liquidationPrice,
    liquidatableNow: always,
    liquidationDistance,
    units: unitsOf(pos.size, pos.entryPrice),
    leverage: pos.margin > 0n ? ratio(pos.size, pos.margin) : 0,
  };
}
