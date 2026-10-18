"use client";

import { useEffect, useRef } from "react";
import { useAccountData } from "@/hooks/use-account-data";
import { useLocalStore } from "@/hooks/use-local-store";
import { useMarketData } from "@/hooks/use-market-data";
import { useAccountView } from "@/hooks/use-wallet";
import { fmtPercent, fmtPrice } from "@/lib/format";
import { notify } from "@/lib/notify";
import { valuePosition } from "@/lib/position";
import { prefs } from "@/lib/prefs";

/** Buffer left (share of the distance to liquidation the position started with) at which to warn. */
const LEVELS = { half: [0.5, 0.25], quarter: [0.25] } as const;

/**
 * Watches the trader's own positions on every page and warns before liquidation, not after: when half (and then
 * three quarters) of the buffer a position started with is gone. Works the same at 2x and at 1000x because it is
 * relative to the position's own starting distance.
 */
export function RiskWatcher() {
  const view = useAccountView();
  const own = view.watching ? undefined : view.address;
  const account = useAccountData(own);
  const { prices, params, byId } = useMarketData();
  const [p] = useLocalStore(prefs);
  // Last level warned per position key, so each crossing warns once.
  const warned = useRef(new Map<string, number>());

  useEffect(() => {
    if (p.liqWarn === "off" || !account.data || !params) return;
    const levels = LEVELS[p.liqWarn];
    const seen = new Set<string>();
    for (const pos of account.data.positions) {
      const key = pos.key;
      seen.add(key);
      const id = pos.position.priceId.toLowerCase();
      const mark = prices.get(id)?.mark ?? null;
      const value = valuePosition(pos, mark, params.maxProfitMultiple);
      if (value.liquidationDistance === null || value.liquidationPrice === null || mark === null) continue;
      const entry = pos.position.entryPrice;
      const liq = value.liquidationPrice;
      const initial = Number(entry > liq ? entry - liq : liq - entry) / Number(entry);
      if (!(initial > 0)) continue;
      const left = Math.max(0, value.liquidationDistance) / initial;
      const last = warned.current.get(key) ?? Infinity;
      // Re-arm once the buffer has clearly recovered (margin added, price moved back).
      if (left > Math.min(1, last + 0.15)) warned.current.delete(key);
      const crossed = levels.filter((level) => left <= level && level < (warned.current.get(key) ?? Infinity));
      if (crossed.length === 0) continue;
      const level = Math.min(...crossed);
      warned.current.set(key, level);
      const inst = byId.get(id);
      const symbol = inst?.symbol ?? "Position";
      const side = pos.position.isLong ? "long" : "short";
      notify(
        level <= 0.25 ? "error" : "warn",
        `${symbol} ${side}: ${level <= 0.25 ? "three quarters" : "half"} of the buffer is gone`,
        `Liquidation at ${fmtPrice(liq, inst?.priceDecimals ?? 2)}, ${fmtPercent(value.liquidationDistance, 2)} away. Add margin, reduce or close.`,
        { tag: `liq-${key}-${level}`, ttlMs: 20_000 },
      );
    }
    for (const key of [...warned.current.keys()]) if (!seen.has(key)) warned.current.delete(key);
  }, [account.data, prices, params, byId, p.liqWarn]);

  return null;
}
