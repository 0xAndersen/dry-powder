"use client";

import { useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { formatUnits } from "viem";
import { AccountTables } from "@/components/trade/account-tables";
import { MarketBar } from "@/components/trade/market-bar";
import { OrderPanel } from "@/components/trade/order-panel";
import { PriceChart, type ChartLine } from "@/components/trade/price-chart";
import { useEngineParams, useMarketStates, useTraderOrders, useTraderPositions } from "@/hooks/use-engine";
import { usePriceState } from "@/hooks/use-prices";
import { useWallet } from "@/hooks/use-wallet";
import { MAX_UINT256, PRICE_DECIMALS } from "@/lib/format";
import { DEFAULT_MARKET, marketBySymbol, type MarketInfo } from "@/lib/markets";

function priceNumber(value: bigint): number {
  return Number(formatUnits(value, PRICE_DECIMALS));
}

export function TradeScreen() {
  const searchParams = useSearchParams();
  const market = marketBySymbol(searchParams.get("market")) ?? DEFAULT_MARKET;

  // The market lives in the URL so links are shareable. The History API keeps the switch client-side
  // (Next.js syncs useSearchParams with it), avoiding a server round trip per click.
  const selectMarket = useCallback(
    (next: MarketInfo) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("market", next.symbol.replace("/", "-"));
      window.history.replaceState(null, "", `?${params.toString()}`);
    },
    [searchParams],
  );

  const wallet = useWallet();
  const params = useEngineParams();
  const marketStates = useMarketStates();
  const positions = useTraderPositions(wallet.address);
  const orders = useTraderOrders(wallet.address);
  const { stale } = usePriceState(market.id);

  const marketState = marketStates.data?.[market.id];

  // Entry, liquidation and trigger levels of the trader's position in the selected market.
  const lines = useMemo<ChartLine[]>(() => {
    const view = positions.data?.find((p) => p.position.priceId.toLowerCase() === market.id);
    if (!view) return [];
    const pos = view.position;
    const out: ChartLine[] = [
      { key: "entry", price: priceNumber(pos.entryPrice), title: `${pos.isLong ? "Long" : "Short"} entry`, tone: "entry" },
    ];
    if (view.liquidationPrice !== 0n && view.liquidationPrice !== MAX_UINT256) {
      out.push({ key: "liq", price: priceNumber(view.liquidationPrice), title: "Liquidation", tone: "liq" });
    }
    const ids = orders.data?.[0] ?? [];
    const rows = orders.data?.[1] ?? [];
    ids.forEach((id, i) => {
      const row = rows[i];
      if (!row) return;
      if (id === pos.tpOrderId && id !== 0n) out.push({ key: "tp", price: priceNumber(row.triggerPrice), title: "Take-profit", tone: "tp" });
      if (id === pos.slOrderId && id !== 0n) out.push({ key: "sl", price: priceNumber(row.triggerPrice), title: "Stop-loss", tone: "sl" });
    });
    return out;
  }, [positions.data, orders.data, market.id]);

  const engineUnreachable = params.isError || marketStates.isError;

  return (
    <div className="flex flex-col gap-3">
      <h1 className="sr-only">Trade {market.symbol}</h1>
      {engineUnreachable ? (
        <div className="notice flex flex-wrap items-center gap-3" data-tone="error" role="alert">
          <span className="flex-1">
            The trading engine could not be read. The RPC may be down, or the configured contract addresses may not match
            this network.
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => {
              void params.refetch();
              void marketStates.refetch();
            }}
          >
            Retry
          </button>
        </div>
      ) : null}
      {params.data?.paused ? (
        <p className="notice" data-tone="warn" role="status">
          Trading is paused: new positions and limit orders are blocked. Open positions can still be closed.
        </p>
      ) : null}

      <div className="grid grid-cols-1 items-start gap-3 lg:grid-cols-[minmax(0,1fr)_22.5rem]">
        <div className="flex min-w-0 flex-col gap-3">
          <MarketBar market={market} state={marketState} loading={marketStates.isLoading} onSelect={selectMarket} />
          <PriceChart market={market} lines={lines} stale={stale} />
        </div>
        <div className="lg:sticky lg:top-[4.25rem]">
          <OrderPanel
            key={market.id}
            market={market}
            marketState={marketState}
            params={params.data}
            paramsError={engineUnreachable}
            positions={positions.data}
          />
        </div>
      </div>

      <AccountTables positions={positions} orders={orders} params={params.data} onSelectMarket={selectMarket} />
    </div>
  );
}
