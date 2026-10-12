"use client";

import { Fragment, useId, useMemo, useState } from "react";
import { useConfig } from "wagmi";
import { simulateContract, writeContract } from "wagmi/actions";
import { useApp } from "@/components/providers";
import { TxStatus } from "@/components/tx-status";
import type { EngineParams, OrderRow, PositionView } from "@/hooks/use-engine";
import { usePriceState } from "@/hooks/use-prices";
import { useSlippage } from "@/hooks/use-slippage";
import { useTx } from "@/hooks/use-tx";
import { useWallet } from "@/hooks/use-wallet";
import { perpEngineAbi } from "@/lib/abi";
import { ensureAllowance, freshOracleUpdate } from "@/lib/actions";
import { UserFacingError } from "@/lib/errors";
import { MAX_UINT256, PRICE_DECIMALS, fmtPercent, fmtPrice, fmtUsdc, parseAmount, toInputString } from "@/lib/format";
import { marketById, type MarketInfo } from "@/lib/markets";
import { BPS, LIQUIDATION_THRESHOLD_BPS, pricePnl, ratio, withSlippageDown, withSlippageUp } from "@/lib/math";

const ORDER_TYPE_LIMIT = 0;
const ORDER_TYPE_TAKE_PROFIT = 1;
const ORDER_TYPE_STOP_LOSS = 2;

type TxHandle = ReturnType<typeof useTx>;
type OrdersById = Map<bigint, OrderRow>;

type Loadable<T> = { data: T | undefined; isLoading: boolean; isError: boolean; refetch: () => unknown };

function SideTag({ isLong }: { isLong: boolean }) {
  return <span className={isLong ? "text-long" : "text-short"}>{isLong ? "Long" : "Short"}</span>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-10 text-center text-muted">{children}</div>;
}

function leverageOf(size: bigint, margin: bigint): string {
  if (margin === 0n) return "—";
  return `${(Number((size * 100n) / margin) / 100).toFixed(1)}×`;
}

// ───────────────────────────── Take-profit / stop-loss editor ─────────────────────────────

function TriggerField({
  kind,
  market,
  view,
  current,
  mark,
  params,
  tx,
}: {
  kind: "tp" | "sl";
  market: MarketInfo;
  view: PositionView;
  current: OrderRow | undefined;
  mark: bigint | undefined;
  params: EngineParams | undefined;
  tx: TxHandle;
}) {
  const { config: cfg } = useApp();
  const wagmiConfig = useConfig();
  const wallet = useWallet();
  const id = useId();
  const pos = view.position;
  const isTp = kind === "tp";
  const name = isTp ? "Take-profit" : "Stop-loss";
  const orderId = isTp ? pos.tpOrderId : pos.slOrderId;
  const exists = orderId !== 0n;
  const [text, setText] = useState(current ? toInputString(current.triggerPrice, PRICE_DECIMALS, market.priceDecimals) : "");

  const price = text.trim() === "" ? null : parseAmount(text, PRICE_DECIMALS);
  // A take-profit sits on the winning side of the mark, a stop-loss on the losing side; otherwise it fires at once.
  const mustBeAbove = isTp ? pos.isLong : !pos.isLong;
  const error =
    text.trim() === ""
      ? null
      : price === null || price === 0n
        ? "Enter a price greater than zero"
        : mark !== undefined && (mustBeAbove ? price <= mark : price >= mark)
          ? `${name} on a ${pos.isLong ? "long" : "short"} must be ${mustBeAbove ? "above" : "below"} the mark price, or it would trigger immediately`
          : null;
  const unchanged = current !== undefined && price === current.triggerPrice;
  const canSave = wallet.ready && !tx.busy && price !== null && price > 0n && error === null && !unchanged && (exists || params !== undefined);

  const save = () => {
    const account = wallet.address;
    if (!canSave || !account || price === null) return;
    void tx.run(async (api) => {
      if (!exists) {
        if (!params) throw new UserFacingError("Engine parameters are still loading.");
        await ensureAllowance(wagmiConfig, cfg, api, {
          token: cfg.usdc,
          owner: account,
          spender: cfg.perpEngine,
          amount: params.executionFee,
          symbol: "USDC",
        });
      }
      await api.send(`${exists ? "Move" : "Set"} ${name.toLowerCase()} on ${market.symbol}`, async () => {
        const { request } = await simulateContract(wagmiConfig, {
          abi: perpEngineAbi,
          address: cfg.perpEngine,
          functionName: "setTriggerOrder",
          args: [market.id, isTp ? ORDER_TYPE_TAKE_PROFIT : ORDER_TYPE_STOP_LOSS, price],
          account,
          chainId: cfg.chainId,
        });
        return writeContract(wagmiConfig, request);
      });
      return `${name} ${exists ? "moved" : "set"} at ${fmtPrice(price, market.priceDecimals)}.`;
    });
  };

  const remove = () => {
    const account = wallet.address;
    if (!exists || !account || tx.busy) return;
    void tx
      .run(async (api) => {
        await api.send(`Remove ${name.toLowerCase()} on ${market.symbol}`, async () => {
          const { request } = await simulateContract(wagmiConfig, {
            abi: perpEngineAbi,
            address: cfg.perpEngine,
            functionName: "cancelOrder",
            args: [orderId],
            account,
            chainId: cfg.chainId,
          });
          return writeContract(wagmiConfig, request);
        });
        return `${name} removed. Its keeper fee was refunded.`;
      })
      .then((ok) => {
        if (ok) setText("");
      });
  };

  return (
    <div className="min-w-0 flex-1">
      <label className="field-label" htmlFor={id}>
        {name} price
      </label>
      <div className="flex gap-2">
        <div className="field h-9 min-w-0 flex-1" data-invalid={error !== null}>
          <input
            id={id}
            inputMode="decimal"
            autoComplete="off"
            placeholder="None"
            value={text}
            onChange={(event) => setText(event.target.value)}
            aria-invalid={error !== null}
            aria-describedby={`${id}-help`}
          />
        </div>
        <button type="button" className="btn h-9" disabled={!canSave} onClick={save}>
          {exists ? "Move" : "Set"}
        </button>
        {exists ? (
          <button type="button" className="btn btn-ghost h-9" disabled={!wallet.ready || tx.busy} onClick={remove}>
            Remove
          </button>
        ) : null}
      </div>
      <p id={`${id}-help`} className={`mt-1 whitespace-normal text-xs ${error ? "text-short" : "text-faint"}`}>
        {error ??
          (exists
            ? "Moving an existing trigger is free."
            : `Setting one escrows a ${params ? fmtUsdc(params.executionFee) : "…"} USDC keeper fee, refunded if you remove it.`)}
      </p>
    </div>
  );
}

// ───────────────────────────── Positions ─────────────────────────────

function PositionRow({
  view,
  market,
  orders,
  params,
  tx,
  onSelectMarket,
}: {
  view: PositionView;
  market: MarketInfo;
  orders: OrdersById;
  params: EngineParams | undefined;
  tx: TxHandle;
  onSelectMarket: (market: MarketInfo) => void;
}) {
  const { config: cfg, prices } = useApp();
  const wagmiConfig = useConfig();
  const wallet = useWallet();
  const [slippageBps] = useSlippage();
  const [editing, setEditing] = useState(false);
  const { tick, stale } = usePriceState(market.id);
  const pos = view.position;
  const pd = market.priceDecimals;

  const mark = tick?.mid;
  const gross = mark !== undefined ? pricePnl(pos.size, pos.entryPrice, mark, pos.isLong) : undefined;
  const net = gross !== undefined ? gross - view.fundingOwed : undefined;
  const roe = net !== undefined && pos.margin > 0n ? ratio(net, pos.margin) : undefined;
  const threshold = (pos.margin * LIQUIDATION_THRESHOLD_BPS) / BPS;
  const liquidatableAlways = pos.isLong ? view.liquidationPrice === MAX_UINT256 : view.liquidationPrice === 0n;
  const liquidatable = liquidatableAlways || (net !== undefined && net <= -threshold);
  const noLiquidation = pos.isLong && view.liquidationPrice === 0n;

  const tp = pos.tpOrderId !== 0n ? orders.get(pos.tpOrderId) : undefined;
  const sl = pos.slOrderId !== 0n ? orders.get(pos.slOrderId) : undefined;

  const close = () => {
    const account = wallet.address;
    const seen = tick;
    if (!account || !seen || !params || tx.busy) return;
    void tx.run(async (api) => {
      // Closing a long sells at the bid, closing a short buys at the ask.
      const acceptablePrice = pos.isLong
        ? withSlippageDown(seen.bid, BigInt(slippageBps))
        : withSlippageUp(seen.ask, BigInt(slippageBps));
      api.preparing(`Fetching the latest ${market.symbol} price`);
      const oracle = await freshOracleUpdate(wagmiConfig, cfg, prices, market, Number(params.maxPriceAge));
      await api.send(`Close ${pos.isLong ? "long" : "short"} ${market.symbol}`, async () => {
        const { request } = await simulateContract(wagmiConfig, {
          abi: perpEngineAbi,
          address: cfg.perpEngine,
          functionName: "closePosition",
          args: [market.id, acceptablePrice, oracle.updateData],
          value: oracle.fee,
          account,
          chainId: cfg.chainId,
        });
        return writeContract(wagmiConfig, request);
      });
      return `${market.symbol} position closed.`;
    });
  };

  const closeBlocked = !wallet.ready
    ? "Connect to Arc to close"
    : liquidatable
      ? "Past the liquidation threshold: only a liquidation can settle this position"
      : stale
        ? "Market closed: the price is stale"
        : !tick || !params
          ? "Waiting for a price"
          : null;

  return (
    <Fragment>
      <tr>
        <td>
          <button type="button" className="wide font-semibold hover:text-brass" onClick={() => onSelectMarket(market)}>
            {market.symbol}
          </button>
        </td>
        <td>
          <SideTag isLong={pos.isLong} />
        </td>
        <td className="r num">{fmtUsdc(pos.size)}</td>
        <td className="r num">{fmtUsdc(pos.margin)}</td>
        <td className="r num">{leverageOf(pos.size, pos.margin)}</td>
        <td className="r num">{fmtPrice(pos.entryPrice, pd)}</td>
        <td className={`r num ${stale ? "text-muted" : ""}`} title={stale ? "Market closed: last published price" : undefined}>
          {mark !== undefined ? fmtPrice(mark, pd) : "…"}
        </td>
        <td className="r num">
          {liquidatable ? (
            <span className="text-short">Liquidatable</span>
          ) : noLiquidation ? (
            <span className="text-muted" title="Fully collateralised: no price liquidates this position">
              None
            </span>
          ) : (
            <span className="text-brass">{fmtPrice(view.liquidationPrice, pd)}</span>
          )}
        </td>
        <td
          className={`r num ${view.fundingOwed > 0n ? "text-short" : view.fundingOwed < 0n ? "text-long" : "text-muted"}`}
          title={view.fundingOwed > 0n ? "Funding this position owes" : view.fundingOwed < 0n ? "Funding this position is owed" : undefined}
        >
          {fmtUsdc(-view.fundingOwed, 4, { sign: true })}
        </td>
        <td className="r num">
          {net !== undefined && roe !== undefined ? (
            <span className={net >= 0n ? "text-long" : "text-short"}>
              {fmtUsdc(net, 2, { sign: true })}
              <span className="ml-1.5 text-xs">{fmtPercent(roe, 2, true)}</span>
            </span>
          ) : (
            "…"
          )}
        </td>
        <td className="r num">
          <span className={tp ? "text-long" : "text-faint"}>{tp ? fmtPrice(tp.triggerPrice, pd) : "—"}</span>
          <span className="mx-1 text-faint">/</span>
          <span className={sl ? "text-short" : "text-faint"}>{sl ? fmtPrice(sl.triggerPrice, pd) : "—"}</span>
          <button
            type="button"
            className="chip ml-2"
            aria-expanded={editing}
            aria-label={`Edit take-profit and stop-loss for ${market.symbol}`}
            onClick={() => setEditing((v) => !v)}
          >
            {editing ? "Done" : "Edit"}
          </button>
        </td>
        <td className="r">
          <button type="button" className="btn btn-sm" disabled={closeBlocked !== null || tx.busy} title={closeBlocked ?? undefined} onClick={close}>
            Close
          </button>
        </td>
      </tr>
      {editing ? (
        <tr>
          <td colSpan={12} className="bg-bg/60">
            <div className="flex max-w-3xl flex-col gap-4 py-1 sm:flex-row">
              <TriggerField key={`tp-${pos.tpOrderId}-${tp?.triggerPrice ?? 0n}`} kind="tp" market={market} view={view} current={tp} mark={mark} params={params} tx={tx} />
              <TriggerField key={`sl-${pos.slOrderId}-${sl?.triggerPrice ?? 0n}`} kind="sl" market={market} view={view} current={sl} mark={mark} params={params} tx={tx} />
            </div>
          </td>
        </tr>
      ) : null}
    </Fragment>
  );
}

/** A position in a market this UI has no price feed metadata for: shown read-only. */
function UnknownPositionRow({ view }: { view: PositionView }) {
  const pos = view.position;
  return (
    <tr>
      <td className="num text-muted" title={pos.priceId}>
        {pos.priceId.slice(0, 10)}
        {"…"}
      </td>
      <td>
        <SideTag isLong={pos.isLong} />
      </td>
      <td className="r num">{fmtUsdc(pos.size)}</td>
      <td className="r num">{fmtUsdc(pos.margin)}</td>
      <td className="r num">{leverageOf(pos.size, pos.margin)}</td>
      <td className="r num">{fmtPrice(pos.entryPrice, 6)}</td>
      <td colSpan={6} className="text-muted">
        This market is not supported by this interface.
      </td>
    </tr>
  );
}

function PositionsTable({
  positions,
  orders,
  params,
  tx,
  onSelectMarket,
}: {
  positions: readonly PositionView[];
  orders: OrdersById;
  params: EngineParams | undefined;
  tx: TxHandle;
  onSelectMarket: (market: MarketInfo) => void;
}) {
  if (positions.length === 0) {
    return <Empty>No open positions. Pick a market and place an order to open one.</Empty>;
  }
  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Market</th>
            <th scope="col">Side</th>
            <th scope="col" className="r">Size (USDC)</th>
            <th scope="col" className="r">Margin</th>
            <th scope="col" className="r">Leverage</th>
            <th scope="col" className="r">Entry</th>
            <th scope="col" className="r">Mark</th>
            <th scope="col" className="r">Liq. price</th>
            <th scope="col" className="r">Funding</th>
            <th scope="col" className="r">PnL / ROE</th>
            <th scope="col" className="r">TP / SL</th>
            <th scope="col" className="r">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {positions.map((view) => {
            const market = marketById(view.position.priceId);
            return market ? (
              <PositionRow key={view.key} view={view} market={market} orders={orders} params={params} tx={tx} onSelectMarket={onSelectMarket} />
            ) : (
              <UnknownPositionRow key={view.key} view={view} />
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ───────────────────────────── Orders ─────────────────────────────

function orderTypeLabel(order: OrderRow): string {
  if (order.orderType === ORDER_TYPE_LIMIT) return "Limit";
  return order.orderType === ORDER_TYPE_TAKE_PROFIT ? "Take-profit" : "Stop-loss";
}

function OrdersTable({ ids, orders, tx }: { ids: readonly bigint[]; orders: readonly OrderRow[]; tx: TxHandle }) {
  const { config: cfg } = useApp();
  const wagmiConfig = useConfig();
  const wallet = useWallet();

  if (ids.length === 0) {
    return <Empty>No open orders. Limit orders, take-profits and stop-losses appear here until they fill.</Empty>;
  }

  const cancel = (orderId: bigint, description: string) => {
    const account = wallet.address;
    if (!account || tx.busy) return;
    void tx.run(async (api) => {
      await api.send(`Cancel ${description}`, async () => {
        const { request } = await simulateContract(wagmiConfig, {
          abi: perpEngineAbi,
          address: cfg.perpEngine,
          functionName: "cancelOrder",
          args: [orderId],
          account,
          chainId: cfg.chainId,
        });
        return writeContract(wagmiConfig, request);
      });
      return "Order cancelled. Everything escrowed for it was refunded.";
    });
  };

  return (
    <div className="overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th scope="col">Type</th>
            <th scope="col">Market</th>
            <th scope="col">Side</th>
            <th scope="col" className="r">Trigger price</th>
            <th scope="col" className="r">Size (USDC)</th>
            <th scope="col" className="r">Margin</th>
            <th scope="col">Attached</th>
            <th scope="col" className="r">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {ids.map((orderId, i) => {
            const order = orders[i];
            if (!order) return null;
            const market = marketById(order.priceId);
            const pd = market?.priceDecimals ?? 6;
            const isLimit = order.orderType === ORDER_TYPE_LIMIT;
            const symbol = market?.symbol ?? `${order.priceId.slice(0, 10)}…`;
            const type = orderTypeLabel(order);
            const condition = isLimit
              ? order.isLong
                ? "ask ≤"
                : "bid ≥"
              : (order.orderType === ORDER_TYPE_TAKE_PROFIT) === order.isLong
                ? "mark ≥"
                : "mark ≤";
            return (
              <tr key={orderId.toString()}>
                <td>{type}</td>
                <td className="wide font-semibold">{symbol}</td>
                <td>
                  {isLimit ? (
                    <SideTag isLong={order.isLong} />
                  ) : (
                    <span className="text-muted">
                      Close <SideTag isLong={order.isLong} />
                    </span>
                  )}
                </td>
                <td className="r num">
                  <span className="mr-1.5 text-xs text-faint">{condition}</span>
                  {fmtPrice(order.triggerPrice, pd)}
                </td>
                <td className="r num">{isLimit ? fmtUsdc(order.size) : <span className="text-muted">Whole position</span>}</td>
                <td className="r num">{isLimit ? fmtUsdc(order.margin) : "—"}</td>
                <td className="num text-muted">
                  {isLimit && (order.takeProfit !== 0n || order.stopLoss !== 0n)
                    ? [
                        order.takeProfit !== 0n ? `TP ${fmtPrice(order.takeProfit, pd)}` : null,
                        order.stopLoss !== 0n ? `SL ${fmtPrice(order.stopLoss, pd)}` : null,
                      ]
                        .filter(Boolean)
                        .join(", ")
                    : "—"}
                </td>
                <td className="r">
                  <button
                    type="button"
                    className="btn btn-sm"
                    disabled={!wallet.ready || tx.busy}
                    onClick={() => cancel(orderId, `${type.toLowerCase()} on ${symbol}`)}
                    aria-label={`Cancel ${type.toLowerCase()} order on ${symbol}`}
                  >
                    Cancel
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ───────────────────────────── Panel ─────────────────────────────

export function AccountTables({
  positions,
  orders,
  params,
  onSelectMarket,
}: {
  positions: Loadable<readonly PositionView[]>;
  orders: Loadable<readonly [readonly bigint[], readonly OrderRow[]]>;
  params: EngineParams | undefined;
  onSelectMarket: (market: MarketInfo) => void;
}) {
  const wallet = useWallet();
  const tx = useTx();
  const [tab, setTab] = useState<"positions" | "orders">("positions");

  const ordersById = useMemo<OrdersById>(() => {
    const map: OrdersById = new Map();
    const data = orders.data;
    if (data) data[0].forEach((id, i) => {
      const order = data[1][i];
      if (order) map.set(id, order);
    });
    return map;
  }, [orders.data]);

  const positionCount = positions.data?.length;
  const orderCount = orders.data?.[0].length;
  const active = tab === "positions" ? positions : orders;

  let body: React.ReactNode;
  if (!wallet.connected) {
    body = <Empty>Connect your wallet to see your positions and orders.</Empty>;
  } else if (active.isError) {
    body = (
      <Empty>
        <p>Your {tab === "positions" ? "positions" : "orders"} could not be read from the engine.</p>
        <button type="button" className="btn btn-sm mt-3" onClick={() => void active.refetch()}>
          Retry
        </button>
      </Empty>
    );
  } else if (active.data === undefined) {
    body = (
      <Empty>
        <span className="inline-flex items-center gap-2" role="status">
          <span className="spinner" aria-hidden="true" /> Loading
        </span>
      </Empty>
    );
  } else if (tab === "positions") {
    body = <PositionsTable positions={positions.data ?? []} orders={ordersById} params={params} tx={tx} onSelectMarket={onSelectMarket} />;
  } else {
    body = <OrdersTable ids={orders.data?.[0] ?? []} orders={orders.data?.[1] ?? []} tx={tx} />;
  }

  return (
    <section className="panel" aria-label="Your positions and orders">
      <div role="tablist" aria-label="Account" className="tabs">
        <button type="button" role="tab" aria-selected={tab === "positions"} className="tab" onClick={() => setTab("positions")}>
          Positions{positionCount !== undefined && wallet.connected ? <span className="num ml-1.5 text-muted">{positionCount}</span> : null}
        </button>
        <button type="button" role="tab" aria-selected={tab === "orders"} className="tab" onClick={() => setTab("orders")}>
          Open orders{orderCount !== undefined && wallet.connected ? <span className="num ml-1.5 text-muted">{orderCount}</span> : null}
        </button>
      </div>
      {wallet.wrongNetwork ? (
        <p className="notice m-3" data-tone="warn">
          Your wallet is on another network. Switch to Arc to manage positions.
        </p>
      ) : null}
      {tx.state.phase !== "idle" ? <TxStatus state={tx.state} onDismiss={tx.reset} className="m-3" /> : null}
      {body}
    </section>
  );
}
