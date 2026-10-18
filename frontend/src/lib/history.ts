import type { Hex } from "viem";
import type { EngineEvent } from "./events";
import { isOpenOrder, orderTypeLabel } from "./events";
import { formatUnits } from "viem";
import { fmtUsdc } from "./format";

/** One line of an account's history, derived from engine events. */
export type HistoryRow = {
  id: string;
  time: number;
  tx: Hex;
  marketId: Hex | null;
  /** "Increase", "Decrease" (a partial close with realised PnL) and "Margin added" come from v3.1 engines. */
  action: "Open" | "Close" | "Liquidation" | "Order placed" | "Order cancelled" | "Increase" | "Decrease" | "Margin added";
  /** How it happened: "Market", "Take-profit", "Stop-loss", "Limit open", "Keeper close", "Direct", ... */
  via: string;
  isLong: boolean | null;
  size: bigint | null;
  price: bigint | null;
  /** Realised PnL before the close fee (price move minus funding, capped). Liquidations: minus the margin. */
  pnl: bigint | null;
  fee: bigint | null;
  payout: bigint | null;
  /** True for order bookkeeping rows, which the table can hide. */
  minor: boolean;
};

/** `closes` and `wins` count full closes; partial closes (`partials`) add to `realised` and `fees` only. */
export type HistorySummary = { realised: bigint; fees: bigint; net: bigint; closes: number; wins: number; liquidations: number; partials: number };

export function buildHistory(events: readonly EngineEvent[]): { rows: HistoryRow[]; summary: HistorySummary } {
  const orderTypes = new Map<string, number>();
  const openByKey = new Map<string, { isLong: boolean; size: bigint; marketId: Hex }>();
  const rows: HistoryRow[] = [];
  const summary: HistorySummary = { realised: 0n, fees: 0n, net: 0n, closes: 0, wins: 0, liquidations: 0, partials: 0 };
  const via = (orderId: bigint | undefined) => {
    if (orderId === undefined) return "Direct";
    const type = orderTypes.get(orderId.toString());
    return `${type === undefined ? "Keeper" : orderTypeLabel(type)} #${orderId}`;
  };

  for (const e of events) {
    switch (e.type) {
      case "orderCreated":
        orderTypes.set(e.orderId.toString(), e.orderType);
        rows.push({
          id: e.id, time: e.time, tx: e.tx, marketId: e.marketId, action: "Order placed",
          via: `${orderTypeLabel(e.orderType)} #${e.orderId}`,
          isLong: e.isLong, size: isOpenOrder(e.orderType) || e.size > 0n ? e.size : null, price: e.triggerPrice === 0n ? null : e.triggerPrice,
          pnl: null, fee: null, payout: null, minor: true,
        });
        break;
      case "orderCancelled": {
        const type = orderTypes.get(e.orderId.toString());
        rows.push({
          id: e.id, time: e.time, tx: e.tx, marketId: null, action: "Order cancelled",
          via: `${type === undefined ? "Order" : orderTypeLabel(type)} #${e.orderId}`,
          isLong: null, size: null, price: null, pnl: null, fee: null, payout: null, minor: true,
        });
        break;
      }
      case "open":
        openByKey.set(e.key, { isLong: e.isLong, size: e.size, marketId: e.marketId });
        summary.fees += e.fee;
        rows.push({
          id: e.id, time: e.time, tx: e.tx, marketId: e.marketId, action: "Open",
          via: e.orderId !== undefined ? `Keeper fill #${e.orderId}` : "Direct",
          isLong: e.isLong, size: e.size, price: e.price, pnl: null, fee: e.fee, payout: null, minor: false,
        });
        break;
      case "close": {
        const opened = openByKey.get(e.key);
        openByKey.delete(e.key);
        const type = e.orderId !== undefined ? orderTypes.get(e.orderId.toString()) : undefined;
        summary.realised += e.pnl;
        summary.fees += e.fee;
        summary.closes += 1;
        if (e.pnl > 0n) summary.wins += 1;
        rows.push({
          id: e.id, time: e.time, tx: e.tx, marketId: e.marketId, action: "Close",
          via: e.orderId !== undefined ? `${type === undefined ? "Keeper" : type === 3 ? "Keeper close" : orderTypeLabel(type)} #${e.orderId}` : "Direct or settlement",
          isLong: opened?.isLong ?? null, size: opened?.size ?? null, price: e.price, pnl: e.pnl, fee: e.fee, payout: e.payout, minor: false,
        });
        break;
      }
      case "liquidation": {
        const opened = openByKey.get(e.key);
        openByKey.delete(e.key);
        summary.realised -= e.margin;
        summary.liquidations += 1;
        rows.push({
          id: e.id, time: e.time, tx: e.tx, marketId: e.marketId, action: "Liquidation",
          via: "Liquidator",
          isLong: opened?.isLong ?? null, size: opened?.size ?? null, price: e.price, pnl: -e.margin, fee: null, payout: 0n, minor: false,
        });
        break;
      }
      case "increase":
        openByKey.set(e.key, { isLong: e.isLong, size: e.newSize, marketId: e.marketId });
        summary.fees += e.fee;
        rows.push({
          id: e.id, time: e.time, tx: e.tx, marketId: e.marketId, action: "Increase", via: via(e.orderId),
          isLong: e.isLong, size: e.addedSize, price: e.price, pnl: null, fee: e.fee, payout: null, minor: false,
        });
        break;
      case "decrease": {
        const opened = openByKey.get(e.key);
        if (opened) opened.size = opened.size > e.closedSize ? opened.size - e.closedSize : 0n;
        summary.realised += e.pnl;
        summary.fees += e.fee;
        summary.partials += 1;
        rows.push({
          id: e.id, time: e.time, tx: e.tx, marketId: e.marketId, action: "Decrease", via: via(e.orderId),
          isLong: opened?.isLong ?? null, size: e.closedSize, price: e.price, pnl: e.pnl, fee: e.fee, payout: e.payout, minor: false,
        });
        break;
      }
      case "marginAdded": {
        const opened = openByKey.get(e.key);
        rows.push({
          id: e.id, time: e.time, tx: e.tx, marketId: opened?.marketId ?? null, action: "Margin added", via: `${fmtUsdc(e.amount)} added`,
          isLong: opened?.isLong ?? null, size: null, price: null, pnl: null, fee: null, payout: null, minor: false,
        });
        break;
      }
      default:
        break;
    }
  }
  summary.net = summary.realised - summary.fees;
  rows.reverse();
  return { rows, summary };
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

export function historyCsv(rows: readonly HistoryRow[], symbolOf: (id: Hex | null) => string, collateral: string): string {
  const header = ["time_utc", "market", "action", "via", "side", `size_${collateral}`, "price", `pnl_${collateral}`, `fee_${collateral}`, `payout_${collateral}`, "tx"];
  const lines = [header.join(",")];
  const usdc = (v: bigint | null) => (v === null ? "" : formatUnits(v, 6));
  for (const r of [...rows].reverse()) {
    lines.push(
      [
        new Date(r.time * 1000).toISOString(),
        symbolOf(r.marketId),
        r.action,
        r.via,
        r.isLong === null ? "" : r.isLong ? "long" : "short",
        usdc(r.size),
        r.price === null ? "" : formatUnits(r.price, 18),
        usdc(r.pnl),
        usdc(r.fee),
        usdc(r.payout),
        r.tx,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return lines.join("\n");
}
