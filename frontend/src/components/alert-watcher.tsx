"use client";

import { useEffect } from "react";
import { useMarketData } from "@/hooks/use-market-data";
import { useLocalStore } from "@/hooks/use-local-store";
import { fmtNum } from "@/lib/format";
import { priceAlerts, tradeSettings } from "@/lib/storage";
import { toast } from "@/lib/toasts";

/** Fires price alerts on every page: a toast always, a system notification when the user allowed it. */
export function AlertWatcher() {
  const { prices, byId } = useMarketData();
  const [alerts, setAlerts] = useLocalStore(priceAlerts);
  const [settings] = useLocalStore(tradeSettings);

  useEffect(() => {
    const fired: string[] = [];
    for (const alert of alerts) {
      if (alert.firedAt !== null) continue;
      const price = prices.get(alert.marketId)?.display;
      if (price === null || price === undefined) continue;
      const hit = alert.direction === "above" ? price >= alert.price : price <= alert.price;
      if (!hit) continue;
      fired.push(alert.id);
      const dp = byId.get(alert.marketId)?.priceDecimals ?? 2;
      const title = `${alert.symbol} ${alert.direction === "above" ? "rose to" : "fell to"} ${fmtNum(alert.price, dp)}`;
      const body = `Now ${fmtNum(price, dp)}`;
      toast("warn", title, body, 15_000);
      if (settings.notify && typeof Notification !== "undefined" && Notification.permission === "granted") {
        try {
          new Notification(`House Money: ${title}`, { body, tag: alert.id });
        } catch {
          // Some browsers only allow notifications from a service worker; the toast still shows.
        }
      }
    }
    if (fired.length > 0) {
      const now = Date.now();
      setAlerts((prev) => prev.map((a) => (fired.includes(a.id) ? { ...a, firedAt: now } : a)));
    }
  }, [alerts, prices, byId, settings.notify, setAlerts]);

  return null;
}
