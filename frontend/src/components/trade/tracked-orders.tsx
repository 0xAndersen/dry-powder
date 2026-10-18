"use client";

import { useSyncExternalStore } from "react";
import { useNow } from "@/hooks/use-market-data";
import { fmtPrice } from "@/lib/format";
import { orderTracker } from "@/lib/order-tracker";

/** Live state of keeper orders placed from this browser session: resting, then filled or cancelled. */
export function TrackedOrders({ marketId, dp }: { marketId: string; dp: number }) {
  const all = useSyncExternalStore(orderTracker.subscribe, orderTracker.get, orderTracker.getServer);
  const now = useNow(500);
  const orders = all.filter((o) => o.marketId === marketId && (o.status === "resting" || now - (o.settledAt ?? 0) < 20_000)).slice(-3);
  if (orders.length === 0) return null;
  return (
    <ul className="grid gap-1.5" aria-live="polite" data-testid="tracked-orders">
      {orders.map((o) => {
        const what = o.action === "close" ? "Close" : `${o.action === "limit" ? "Limit" : "Market"} ${o.isLong ? "long" : "short"}`;
        const waited = (((o.settledAt ?? now) - o.placedAt) / 1000).toFixed(1);
        return (
          <li key={o.orderId.toString()} className="notice flex items-center gap-2 py-1.5 text-xs" data-tone={o.status === "filled" ? "ok" : o.status === "cancelled" ? "warn" : undefined} data-status={o.status}>
            {o.status === "resting" ? <span className="spinner text-accent" aria-hidden="true" /> : null}
            <span className="min-w-0 flex-1">
              <span className="num">#{o.orderId.toString()}</span> {what}:{" "}
              {o.status === "resting"
                ? o.action === "limit"
                  ? "resting until the price is reached"
                  : `resting, waiting for a keeper (${waited}s)`
                : o.status === "filled"
                  ? `filled${o.fillPrice ? ` at ${fmtPrice(o.fillPrice, dp)}` : ""} after ${waited}s`
                  : o.status === "cancelled"
                    ? "cancelled, escrow refunded"
                    : "no longer on the book"}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
