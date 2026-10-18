"use client";

import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { Hex } from "viem";
import { AppLink } from "@/components/app-link";
import { useApp } from "@/components/providers";
import { TxStatus } from "@/components/tx-status";
import type { AccountData, OrderRow, PositionView } from "@/hooks/use-account-data";
import { useActionContext } from "@/hooks/use-action-context";
import { useLocalStore } from "@/hooks/use-local-store";
import type { LogFeedHandle } from "@/hooks/use-log-feed";
import { useMarketData, type MarketPrice } from "@/hooks/use-market-data";
import { useTx, type TxHandle } from "@/hooks/use-tx";
import type { AccountView } from "@/hooks/use-wallet";
import { ORDER_TYPE, submitCancel, submitTrigger } from "@/lib/actions";
import { UserFacingError } from "@/lib/errors";
import { orderTypeLabel } from "@/lib/events";
import { closeFlow } from "@/lib/flows";
import { PRICE_DECIMALS, fmtAge, fmtDateTime, fmtNum, fmtPercent, fmtPrice, fmtQty, fmtUsdc, parseAmount, shortAddress, toInputString } from "@/lib/format";
import { buildHistory, historyCsv } from "@/lib/history";
import { isSettled, type Instrument } from "@/lib/instruments";
import { RISK_TEXT, riskTone } from "@/lib/risk-tone";
import { ratio, unitsOf } from "@/lib/math";
import { valuePosition } from "@/lib/position";
import { priceAlerts, tradeSettings, type PriceAlert } from "@/lib/storage";

type Tab = "positions" | "orders" | "history" | "alerts";

export type TablesHandle = {
  /** Opens the take-profit / stop-loss editor of the position in `marketId`, prefilled (chart pick). */
  editTrigger: (marketId: string, type: "tp" | "sl", price: number) => void;
  show: (tab: Tab) => void;
};

function SideTag({ isLong }: { isLong: boolean }) {
  return <span className={isLong ? "text-long" : "text-short"}>{isLong ? "Long" : "Short"}</span>;
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className="px-4 py-10 text-center text-muted">{children}</div>;
}

type EditState = { marketId: string; type: "tp" | "sl"; text: string } | null;

function TriggerCell({
  kind,
  current,
  editing,
  onEdit,
  onText,
  onSave,
  onRemove,
  onCancel,
  error,
  dp,
  disabled,
  canEdit,
  symbol,
}: {
  kind: "tp" | "sl";
  current: bigint | null;
  editing: string | null;
  onEdit: () => void;
  onText: (text: string) => void;
  onSave: () => void;
  onRemove: () => void;
  onCancel: () => void;
  error: string | null;
  dp: number;
  disabled: boolean;
  canEdit: boolean;
  symbol: string;
}) {
  const name = kind === "tp" ? "take-profit" : "stop-loss";
  if (editing === null) {
    if (!canEdit) return <span className="num">{current ? fmtPrice(current, dp) : "—"}</span>;
    return (
      <button type="button" className="num inline-edit" onClick={onEdit} aria-label={`${current ? "Edit" : "Add"} ${name} for ${symbol}`} data-testid={`edit-${kind}`}>
        {current ? fmtPrice(current, dp) : <span className="text-faint">Add</span>}
      </button>
    );
  }
  return (
    <form
      className="flex items-center gap-1"
      onSubmit={(event) => {
        event.preventDefault();
        onSave();
      }}
    >
      <input
        autoFocus
        className="mini-input num w-24"
        inputMode="decimal"
        aria-label={`${name} price for ${symbol}`}
        aria-invalid={error !== null}
        title={error ?? undefined}
        value={editing}
        onChange={(event) => onText(event.target.value)}
        onKeyDown={(event) => event.key === "Escape" && onCancel()}
        data-testid={`input-${kind}`}
      />
      <button type="submit" className="btn btn-sm btn-primary px-2" disabled={disabled || error !== null || editing.trim() === ""} title={error ?? `Set ${name}`} data-testid={`save-${kind}`}>
        Set
      </button>
      {current ? (
        <button type="button" className="btn btn-sm px-2" disabled={disabled} onClick={onRemove} title={`Remove ${name}`}>
          Remove
        </button>
      ) : null}
      <button type="button" className="btn btn-sm btn-ghost px-1.5" onClick={onCancel} aria-label="Cancel editing">
        {"✕"}
      </button>
    </form>
  );
}

function PositionRow({
  view,
  instrument,
  price,
  orders,
  tx,
  canTrade,
  equity,
  balance,
  edit,
  setEdit,
  onSelectMarket,
}: {
  view: PositionView;
  instrument: Instrument | undefined;
  price: MarketPrice | undefined;
  orders: OrderRow[];
  tx: TxHandle;
  canTrade: boolean;
  equity: bigint | null;
  balance: bigint | undefined;
  edit: EditState;
  setEdit: (edit: EditState) => void;
  onSelectMarket: (instrument: Instrument) => void;
}) {
  const { config: cfg } = useApp();
  const { params } = useMarketData();
  const actionContext = useActionContext();
  const [settings] = useLocalStore(tradeSettings);
  const pos = view.position;
  const marketId = pos.priceId.toLowerCase();
  const dp = instrument?.priceDecimals ?? 2;
  const sym = cfg.collateralSymbol;
  const symbol = instrument?.symbol ?? `${pos.priceId.slice(0, 10)}…`;
  const mark = price?.mark ?? null;
  const value = valuePosition(view, mark, params?.maxProfitMultiple ?? 10n);
  const tp = orders.find((o) => o.id === pos.tpOrderId && pos.tpOrderId !== 0n)?.order.triggerPrice ?? null;
  const sl = orders.find((o) => o.id === pos.slOrderId && pos.slOrderId !== 0n)?.order.triggerPrice ?? null;
  const settled = instrument ? isSettled(instrument) : false;
  const closing = pos.closeOrderId !== 0n;

  const editingFor = (type: "tp" | "sl") => (edit && edit.marketId === marketId && edit.type === type ? edit.text : null);
  const parsed = edit && edit.marketId === marketId ? parseAmount(edit.text, PRICE_DECIMALS) : null;
  const editError = (() => {
    if (!edit || edit.marketId !== marketId || edit.text.trim() === "") return null;
    if (!parsed) return "Enter a price greater than zero";
    if (mark === null) return null;
    // The engine does not check the side when a trigger is set on an open position; a trigger on the wrong
    // side of the price would fire on the next keeper pass and close the position.
    const wantsAbove = pos.isLong === (edit.type === "tp");
    if (wantsAbove ? parsed <= mark : parsed >= mark) {
      return `${edit.type === "tp" ? "Take-profit" : "Stop-loss"} must be ${wantsAbove ? "above" : "below"} the current price (${fmtPrice(mark, dp)}), or it would trigger at once`;
    }
    return null;
  })();

  const run = (job: Parameters<TxHandle["run"]>[0]) => void tx.run(job);
  const withCtx = (api: Parameters<Parameters<TxHandle["run"]>[0]>[0]) => {
    const ctx = actionContext(api);
    if (!ctx) throw new UserFacingError("Connect your wallet first.");
    return ctx;
  };

  const saveTrigger = () => {
    if (!edit || !parsed || editError || !params) return;
    const type = edit.type;
    const existing = type === "tp" ? pos.tpOrderId : pos.slOrderId;
    const name = type === "tp" ? "Take-profit" : "Stop-loss";
    run(async (api) => {
      await submitTrigger(withCtx(api), pos.priceId, type === "tp" ? ORDER_TYPE.TakeProfit : ORDER_TYPE.StopLoss, parsed, existing === 0n ? params.executionFee : 0n, `${existing === 0n ? "Set" : "Move"} ${name.toLowerCase()}`);
      setEdit(null);
      return `${name} ${existing === 0n ? "set" : "moved"} to ${fmtPrice(parsed, dp)} on ${symbol}.`;
    });
  };
  const removeTrigger = (type: "tp" | "sl") => {
    const id = type === "tp" ? pos.tpOrderId : pos.slOrderId;
    if (id === 0n) return;
    run(async (api) => {
      await submitCancel(withCtx(api), id, `Remove ${type === "tp" ? "take-profit" : "stop-loss"}`);
      setEdit(null);
      return `${type === "tp" ? "Take-profit" : "Stop-loss"} removed from ${symbol}. Its execution fee was refunded.`;
    });
  };
  const close = () => {
    if (!instrument || !params) return;
    run((api) => closeFlow(withCtx(api), { instrument, view, reference: price?.reference ?? null, slippageBps: settings.slippageBps, executionFee: params.executionFee, balance }));
  };
  const cancelClose = () => {
    run(async (api) => {
      await submitCancel(withCtx(api), pos.closeOrderId, "Cancel close order");
      return `Close order on ${symbol} cancelled.`;
    });
  };

  const liqNear = value.liquidationDistance !== null && value.liquidationDistance < 0.02;

  return (
    <tr data-testid={`position-${symbol}`}>
      <td>
        <button type="button" className="text-left hover:text-accent" disabled={!instrument} onClick={() => instrument && onSelectMarket(instrument)}>
          <span className="wide font-semibold">{symbol}</span>
        </button>
        <span className="block text-xs">
          <SideTag isLong={pos.isLong} /> <span className="num text-faint">{value.leverage.toFixed(1)}x</span>
        </span>
      </td>
      <td className="r">
        <span className="num">{fmtUsdc(pos.size)}</span>
        <span className="num block text-xs text-faint">
          {fmtQty(unitsOf(pos.size, pos.entryPrice))} {instrument?.unitLabel ?? ""}
        </span>
      </td>
      <td className="r num">{fmtPrice(pos.entryPrice, dp)}</td>
      <td className="r num">
        {mark !== null ? fmtPrice(mark, dp) : "—"}
        {price?.status === "awaiting" ? <span className="block text-xs text-warn">indicative</span> : price?.status === "settled" ? <span className="block text-xs text-accent">settled</span> : null}
      </td>
      <td className="r">
        <span className={`num ${liqNear ? "text-short" : RISK_TEXT[riskTone(value.liquidationDistance) ?? "calm"]}`}>
          {value.liquidatableNow ? "Now" : value.liquidationPrice === null ? "None" : fmtPrice(value.liquidationPrice, dp)}
        </span>
        {value.liquidationDistance !== null ? (
          <span className={`num block text-xs ${liqNear ? "text-short" : "text-faint"}`}>{value.liquidationDistance <= 0 ? "past threshold" : `${fmtPercent(value.liquidationDistance, 2)} away`}</span>
        ) : null}
      </td>
      <td className="r">
        <span className={`num font-semibold ${value.pnl === null ? "" : value.pnl >= 0n ? "text-long" : "text-short"}`} data-testid="position-pnl">
          {value.pnl === null ? "—" : fmtUsdc(value.pnl, 2, { sign: true })}
        </span>
        <span className={`num block text-xs ${value.roe === null ? "text-faint" : value.roe >= 0 ? "text-long" : "text-short"}`}>
          {value.roe === null ? "" : `${fmtPercent(value.roe, 1, true)} ROE`}
          {value.capped ? " (capped)" : ""}
        </span>
      </td>
      <td className="r">
        <span className={`num ${view.fundingOwed > 0n ? "text-short" : view.fundingOwed < 0n ? "text-long" : "text-muted"}`} title="Funding accrued since entry. Negative: you have been paid.">
          {fmtUsdc(-view.fundingOwed, 4, { sign: true })}
        </span>
      </td>
      <td className="r">
        <span className="num">{fmtUsdc(pos.margin)}</span>
        {equity !== null && equity > 0n && value.pnl !== null ? (
          <span className="num block text-xs text-faint" title="This position's margin plus open PnL as a share of the account value">
            {fmtPercent(Math.max(0, ratio(pos.margin + value.pnl, equity)), 0)} of account
          </span>
        ) : null}
      </td>
      <td>
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-1.5">
            <span className="w-5 text-xs text-long">TP</span>
            <TriggerCell
              kind="tp" current={tp} editing={editingFor("tp")} dp={dp} symbol={symbol} canEdit={canTrade && !settled} disabled={tx.busy} error={edit?.type === "tp" ? editError : null}
              onEdit={() => setEdit({ marketId, type: "tp", text: tp ? toInputString(tp, PRICE_DECIMALS, dp) : "" })}
              onText={(text) => setEdit({ marketId, type: "tp", text })}
              onSave={saveTrigger} onRemove={() => removeTrigger("tp")} onCancel={() => setEdit(null)}
            />
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-5 text-xs text-short">SL</span>
            <TriggerCell
              kind="sl" current={sl} editing={editingFor("sl")} dp={dp} symbol={symbol} canEdit={canTrade && !settled} disabled={tx.busy} error={edit?.type === "sl" ? editError : null}
              onEdit={() => setEdit({ marketId, type: "sl", text: sl ? toInputString(sl, PRICE_DECIMALS, dp) : "" })}
              onText={(text) => setEdit({ marketId, type: "sl", text })}
              onSave={saveTrigger} onRemove={() => removeTrigger("sl")} onCancel={() => setEdit(null)}
            />
          </span>
          {edit && edit.marketId === marketId && editError ? <span className="max-w-[16rem] whitespace-normal text-xs text-short">{editError}</span> : null}
        </div>
      </td>
      <td className="r">
        {canTrade ? (
          settled ? (
            <button type="button" className="btn btn-sm btn-primary" disabled={tx.busy || !instrument} onClick={close} data-testid="settle-close">
              Settle &amp; close
            </button>
          ) : closing ? (
            <span className="flex items-center justify-end gap-1.5">
              <span className="flex items-center gap-1 text-xs text-accent">
                <span className="spinner" aria-hidden="true" /> Closing
              </span>
              <button type="button" className="btn btn-sm" disabled={tx.busy} onClick={cancelClose} title="Cancel the resting close order">
                Cancel
              </button>
            </span>
          ) : (
            <button type="button" className="btn btn-sm" disabled={tx.busy || !instrument} onClick={close} data-testid="close-position">
              Close
            </button>
          )
        ) : closing ? (
          <span className="text-xs text-accent">Closing</span>
        ) : null}
      </td>
    </tr>
  );
}

function OrdersTable({
  orders,
  positions,
  tx,
  canTrade,
  chainNow,
  onSelectMarket,
}: {
  orders: OrderRow[];
  positions: readonly PositionView[];
  tx: TxHandle;
  canTrade: boolean;
  chainNow: number;
  onSelectMarket: (instrument: Instrument) => void;
}) {
  const { config: cfg } = useApp();
  const { byId, prices } = useMarketData();
  const actionContext = useActionContext();
  const sym = cfg.collateralSymbol;
  const sorted = useMemo(() => [...orders].sort((a, b) => (a.id < b.id ? 1 : -1)), [orders]);

  if (sorted.length === 0) return <Empty>No open orders. Limit orders, take-profits, stop-losses and pending keeper orders appear here.</Empty>;

  const cancel = (row: OrderRow) => {
    void tx.run(async (api) => {
      const ctx = actionContext(api);
      if (!ctx) throw new UserFacingError("Connect your wallet first.");
      await submitCancel(ctx, row.id, `Cancel order #${row.id}`);
      return `Order #${row.id} cancelled. Everything escrowed for it was refunded.`;
    });
  };

  return (
    <div className="relative overflow-x-auto">
      <table className="data-table">
        <thead>
          <tr>
            <th>Order</th>
            <th>Market</th>
            <th>Side</th>
            <th className="r">Size</th>
            <th className="r">Trigger</th>
            <th>Brackets</th>
            <th className="r">Escrow</th>
            <th>State</th>
            <th className="r">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((row) => {
            const o = row.order;
            const instrument = byId.get(o.priceId.toLowerCase());
            const dp = instrument?.priceDecimals ?? 2;
            const p = prices.get(o.priceId.toLowerCase());
            const isOpen = o.orderType === 0;
            const hasPosition = positions.some((v) => v.position.priceId.toLowerCase() === o.priceId.toLowerCase());
            const escrow = isOpen ? o.margin + o.feeBudget + o.executionFee * BigInt(1 + (o.takeProfit !== 0n ? 1 : 0) + (o.stopLoss !== 0n ? 1 : 0)) : o.executionFee;
            const now = p?.exec ? (o.isLong ? p.exec.ask : p.exec.bid) : null;
            const marketable = isOpen && now !== null && (o.isLong ? now <= o.triggerPrice : now >= o.triggerPrice);
            const state = isOpen
              ? hasPosition
                ? { text: "Blocked: a position is open in this market", tone: "text-warn" }
                : marketable
                  ? { text: "Marketable: waiting for a keeper", tone: "text-accent" }
                  : { text: now !== null ? `Resting, ${fmtPercent(Math.abs(ratio(o.triggerPrice - now, now)), 2)} from price` : "Resting", tone: "text-muted" }
              : o.orderType === 3
                ? { text: "Closing: waiting for a keeper", tone: "text-accent" }
                : { text: "Armed", tone: "text-muted" };
            return (
              <tr key={row.id.toString()} data-testid={`order-${row.id}`}>
                <td>
                  <span className="num">#{row.id.toString()}</span> {orderTypeLabel(o.orderType)}
                  <span className="num block text-xs text-faint">{fmtAge(Math.max(0, chainNow - Number(o.createdAt)))} ago</span>
                </td>
                <td>
                  <button type="button" className="wide font-semibold hover:text-accent" disabled={!instrument} onClick={() => instrument && onSelectMarket(instrument)}>
                    {instrument?.symbol ?? "Unknown"}
                  </button>
                </td>
                <td>
                  <SideTag isLong={o.isLong} />
                </td>
                <td className="r num">{isOpen ? fmtUsdc(o.size) : "Whole position"}</td>
                <td className="r num">{o.triggerPrice === 0n ? "Any price" : fmtPrice(o.triggerPrice, dp)}</td>
                <td className="num text-xs">
                  {isOpen ? (
                    <>
                      <span className="text-long">TP</span> {o.takeProfit !== 0n ? fmtPrice(o.takeProfit, dp) : "—"}
                      <br />
                      <span className="text-short">SL</span> {o.stopLoss !== 0n ? fmtPrice(o.stopLoss, dp) : "—"}
                    </>
                  ) : (
                    "—"
                  )}
                </td>
                <td className="r num" title="Returned in full if you cancel">
                  {fmtUsdc(escrow)} {sym}
                </td>
                <td className={`text-xs ${state.tone}`}>{state.text}</td>
                <td className="r">
                  {canTrade ? (
                    <button type="button" className="btn btn-sm" disabled={tx.busy} onClick={() => cancel(row)} aria-label={`Cancel order ${row.id}`} data-testid="cancel-order">
                      Cancel
                    </button>
                  ) : null}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function HistoryTable({ feed, address }: { feed: LogFeedHandle; address: string }) {
  const { config: cfg } = useApp();
  const { byId } = useMarketData();
  const [showOrders, setShowOrders] = useState(false);
  const sym = cfg.collateralSymbol;
  const { rows, summary } = useMemo(() => buildHistory(feed.events), [feed.events]);
  const visible = showOrders ? rows : rows.filter((r) => !r.minor);
  const symbolOf = (id: Hex | null) => (id ? (byId.get(id)?.symbol ?? id) : "");
  const status = feed.status;
  const coverage = status.loadedFromTime > 0 ? Math.max(0, Date.now() / 1000 - status.loadedFromTime) : 0;

  const exportCsv = () => {
    const blob = new Blob([historyCsv(rows, symbolOf, sym)], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `dry-powder-history-${address.slice(0, 8)}.csv`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 border-b border-line px-3 py-2 text-[0.8125rem]">
        <span>
          <span className="text-muted">Realised PnL</span>{" "}
          <span className={`num font-semibold ${summary.realised > 0n ? "text-long" : summary.realised < 0n ? "text-short" : ""}`} data-testid="history-realised">{fmtUsdc(summary.realised, 2, { sign: true })}</span>
        </span>
        <span>
          <span className="text-muted">Fees</span> <span className="num">{fmtUsdc(summary.fees, 2)}</span>
        </span>
        <span>
          <span className="text-muted">Net</span>{" "}
          <span className={`num font-semibold ${summary.net > 0n ? "text-long" : summary.net < 0n ? "text-short" : ""}`}>{fmtUsdc(summary.net, 2, { sign: true })} {sym}</span>
        </span>
        <span className="text-muted">
          {summary.closes} closed{summary.closes > 0 ? `, ${fmtPercent(summary.wins / summary.closes, 0)} won` : ""}
          {summary.liquidations > 0 ? `, ${summary.liquidations} liquidated` : ""}
        </span>
        <span className="ml-auto flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-xs text-muted">
            <input type="checkbox" className="check" checked={showOrders} onChange={(event) => setShowOrders(event.target.checked)} />
            Order events
          </label>
          <button type="button" className="btn btn-sm" disabled={status.pending > 0 || status.loadedFrom <= 0} onClick={() => void feed.extend(Math.max(3_600, coverage))} title="Reads older event logs in bounded block ranges">
            {status.pending > 0 ? `Loading (${status.pending})` : status.loadedFrom <= 0 && status.phase === "live" ? "All history loaded" : "Load earlier"}
          </button>
          <button type="button" className="btn btn-sm" disabled={rows.length === 0} onClick={exportCsv} data-testid="export-csv">
            Export CSV
          </button>
        </span>
      </div>
      {status.phase === "error" ? (
        <p className="notice m-3" data-tone="error" role="alert">
          Event logs could not be read from the RPC ({status.error ?? "unknown error"}). Retrying.
        </p>
      ) : null}
      {visible.length === 0 ? (
        <Empty>
          {status.phase === "starting" || status.pending > 0
            ? "Reading event logs…"
            : `No trades from this account in the last ${fmtAge(coverage)}. Use Load earlier to look further back.`}
        </Empty>
      ) : (
        <div className="relative max-h-[28rem] overflow-auto">
          <table className="data-table">
            <thead className="sticky top-0 bg-panel">
              <tr>
                <th>Time</th>
                <th>Market</th>
                <th>Event</th>
                <th>Side</th>
                <th className="r">Size</th>
                <th className="r">Price</th>
                <th className="r">PnL</th>
                <th className="r">Fee</th>
                <th className="r">Paid out</th>
                <th className="r">Tx</th>
              </tr>
            </thead>
            <tbody>
              {visible.slice(0, 400).map((r) => {
                const instrument = r.marketId ? byId.get(r.marketId) : undefined;
                const dp = instrument?.priceDecimals ?? 2;
                return (
                  <tr key={r.id} className={r.minor ? "text-muted" : ""} data-testid={`history-${r.action.toLowerCase().replace(/ /g, "-")}`}>
                    <td className="num text-muted">{fmtDateTime(r.time)}</td>
                    <td className="wide font-semibold">{symbolOf(r.marketId) ? (instrument?.symbol ?? "Unknown") : "—"}</td>
                    <td>
                      <span className={r.action === "Liquidation" ? "text-short" : ""}>{r.action}</span>
                      <span className="block text-xs text-faint">{r.via}</span>
                    </td>
                    <td>{r.isLong === null ? "—" : <SideTag isLong={r.isLong} />}</td>
                    <td className="r num">{r.size !== null ? fmtUsdc(r.size) : "—"}</td>
                    <td className="r num">{r.price !== null ? fmtPrice(r.price, dp) : "—"}</td>
                    <td className={`r num ${r.pnl === null ? "" : r.pnl > 0n ? "text-long" : r.pnl < 0n ? "text-short" : ""}`}>{r.pnl !== null ? fmtUsdc(r.pnl, 2, { sign: true }) : "—"}</td>
                    <td className="r num">{r.fee !== null ? fmtUsdc(r.fee, 4) : "—"}</td>
                    <td className="r num">{r.payout !== null ? fmtUsdc(r.payout) : "—"}</td>
                    <td className="r">
                      <a className="link num" href={`${cfg.explorerUrl}/tx/${r.tx}`} target="_blank" rel="noreferrer">
                        {r.tx.slice(0, 8)}
                      </a>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="border-t border-line px-3 py-1.5 text-2xs text-faint">
        Built from on-chain event logs{coverage > 0 ? ` covering the last ${fmtAge(coverage)}` : ""}. PnL is after funding and the profit cap, before the close fee. Side and size of a close are shown when its open falls inside the loaded range.
      </p>
    </div>
  );
}

function AlertsPanel({ instrument, price, onPickAlert }: { instrument: Instrument; price: MarketPrice; onPickAlert: () => void }) {
  const [alerts, setAlerts] = useLocalStore(priceAlerts);
  const [settings, setSettings] = useLocalStore(tradeSettings);
  const [text, setText] = useState("");
  const dp = instrument.priceDecimals;
  const level = Number(text);
  const valid = text.trim() !== "" && Number.isFinite(level) && level > 0;
  const notifications = typeof Notification === "undefined" ? "unsupported" : Notification.permission;

  const add = () => {
    if (!valid || price.display === null) return;
    const alert: PriceAlert = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      marketId: instrument.id,
      symbol: instrument.symbol,
      price: level,
      direction: level >= price.display ? "above" : "below",
      createdAt: Date.now(),
      firedAt: null,
    };
    setAlerts((prev) => [...prev, alert].slice(-50));
    setText("");
  };

  const enableNotifications = async () => {
    if (typeof Notification === "undefined") return;
    const permission = Notification.permission === "default" ? await Notification.requestPermission() : Notification.permission;
    setSettings((s) => ({ ...s, notify: permission === "granted" }));
  };

  return (
    <div>
      <form
        className="flex flex-wrap items-end gap-2 border-b border-line px-3 py-3"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <div>
          <label className="field-label" htmlFor="alert-price">
            Alert me when {instrument.symbol} reaches
          </label>
          <div className="field h-9 w-44">
            <input id="alert-price" inputMode="decimal" autoComplete="off" placeholder={price.display !== null ? price.display.toFixed(dp) : "Price"} value={text} onChange={(event) => setText(event.target.value)} data-testid="alert-price" />
          </div>
        </div>
        <button type="submit" className="btn btn-primary" disabled={!valid || price.display === null}>
          {valid && price.display !== null ? `Add alert ${level >= price.display ? "above" : "below"}` : "Add alert"}
        </button>
        <button type="button" className="btn" onClick={onPickAlert}>
          Pick on chart
        </button>
        <span className="ml-auto text-xs text-muted">
          {notifications === "unsupported" ? (
            "Alerts show as a message on this page."
          ) : settings.notify && notifications === "granted" ? (
            <button type="button" className="link" onClick={() => setSettings((s) => ({ ...s, notify: false }))}>
              System notifications on. Turn off
            </button>
          ) : notifications === "denied" ? (
            "System notifications are blocked in your browser settings."
          ) : (
            <button type="button" className="link" onClick={() => void enableNotifications()}>
              Also send a system notification
            </button>
          )}
        </span>
      </form>
      {alerts.length === 0 ? (
        <Empty>No alerts. They are kept in this browser and fire while the app is open.</Empty>
      ) : (
        <ul className="divide-y divide-line/60">
          {[...alerts].reverse().map((a) => (
            <li key={a.id} className="flex items-center gap-3 px-3 py-2 text-[0.8125rem]" data-testid="alert-row">
              <span className="wide w-28 font-semibold">{a.symbol}</span>
              <span className="num flex-1">
                {a.direction === "above" ? "At or above" : "At or below"} {fmtNum(a.price, a.marketId === instrument.id ? dp : Math.max(2, dp))}
              </span>
              <span className={`text-xs ${a.firedAt ? "text-warn" : "text-muted"}`}>{a.firedAt ? `Fired ${fmtDateTime(a.firedAt / 1000)}` : "Waiting"}</span>
              <button type="button" className="btn btn-sm" onClick={() => setAlerts((prev) => prev.filter((x) => x.id !== a.id))} aria-label={`Remove alert at ${a.price}`}>
                Remove
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export const AccountTables = forwardRef<
  TablesHandle,
  {
    view: AccountView;
    account: AccountData | undefined;
    loading: boolean;
    error: boolean;
    feed: LogFeedHandle;
    instrument: Instrument;
    price: MarketPrice;
    chainNow: number;
    onSelectMarket: (instrument: Instrument) => void;
    onPickAlert: () => void;
  }
>(function AccountTables({ view, account, loading, error, feed, instrument, price, chainNow, onSelectMarket, onPickAlert }, ref) {
  const { byId, prices, params } = useMarketData();
  const tx = useTx({ autoDismissMs: 10000 });
  const [tab, setTab] = useState<Tab>("positions");
  const [edit, setEdit] = useState<EditState>(null);
  const rootRef = useRef<HTMLElement>(null);

  useImperativeHandle(ref, () => ({
    editTrigger: (marketId, type, value) => {
      setTab("positions");
      const dp = byId.get(marketId)?.priceDecimals ?? 2;
      setEdit({ marketId, type, text: value.toFixed(dp) });
      rootRef.current?.scrollIntoView({ block: "nearest", behavior: "smooth" });
    },
    show: (next) => setTab(next),
  }));

  const positions = account?.positions ?? [];
  const orders = account?.orders ?? [];
  const equity = useMemo(() => {
    if (!account || !params) return null;
    let total = account.balance;
    for (const p of account.positions) {
      const v = valuePosition(p, prices.get(p.position.priceId.toLowerCase())?.mark ?? null, params.maxProfitMultiple);
      total += p.position.margin + (v.pnl ?? 0n);
    }
    return total;
  }, [account, prices, params]);

  const tabs: { key: Tab; label: string }[] = [
    { key: "positions", label: `Positions${account ? ` (${positions.length})` : ""}` },
    { key: "orders", label: `Orders${account ? ` (${orders.length})` : ""}` },
    { key: "history", label: "History" },
    { key: "alerts", label: "Alerts" },
  ];

  const needsAccount = tab !== "alerts" && !view.address;

  return (
    <section ref={rootRef} className="panel" aria-label="Positions, orders, history and alerts">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line pr-3">
        <div role="tablist" aria-label="Account views" className="tabs border-b-0">
          {tabs.map((t) => (
            <button key={t.key} type="button" role="tab" aria-selected={tab === t.key} className="tab" onClick={() => setTab(t.key)} data-testid={`tab-${t.key}`}>
              {t.label}
            </button>
          ))}
        </div>
        {view.watching && view.address ? (
          <span className="text-xs text-muted">
            Read-only view of <span className="num">{shortAddress(view.address)}</span>.{" "}
            <AppLink route="activity" className="link">
              Venue activity
            </AppLink>
          </span>
        ) : null}
      </div>

      {tx.state.phase !== "idle" ? <TxStatus state={tx.state} onDismiss={tx.reset} className="m-3 mb-0" /> : null}

      {needsAccount ? (
        <Empty>Connect a wallet to see your positions, or watch any account from the header.</Empty>
      ) : tab === "alerts" ? (
        <AlertsPanel instrument={instrument} price={price} onPickAlert={onPickAlert} />
      ) : tab === "history" && view.address ? (
        <HistoryTable feed={feed} address={view.address} />
      ) : error && !account ? (
        <Empty>This account could not be read from the RPC. Retrying.</Empty>
      ) : loading || !account ? (
        <Empty>
          <span className="inline-flex items-center gap-2">
            <span className="spinner" aria-hidden="true" /> Loading account
          </span>
        </Empty>
      ) : tab === "positions" ? (
        positions.length === 0 ? (
          <Empty>{view.watching ? "This account has no open positions." : "No open positions. Pick a market, choose a size and go long or short."}</Empty>
        ) : (
          <div className="relative overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Market</th>
                  <th className="r">Size</th>
                  <th className="r">Entry</th>
                  <th className="r">Mark</th>
                  <th className="r">Liquidation</th>
                  <th className="r">PnL</th>
                  <th className="r">Funding</th>
                  <th className="r">Margin</th>
                  <th>Take-profit / stop-loss</th>
                  <th className="r">
                    <span className="sr-only">Actions</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {positions.map((v) => (
                  <PositionRow
                    key={v.key}
                    view={v}
                    instrument={byId.get(v.position.priceId.toLowerCase())}
                    price={prices.get(v.position.priceId.toLowerCase())}
                    orders={orders}
                    tx={tx}
                    canTrade={view.canTrade}
                    equity={equity}
                    balance={account.balance}
                    edit={edit}
                    setEdit={setEdit}
                    onSelectMarket={onSelectMarket}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <OrdersTable orders={orders} positions={positions} tx={tx} canTrade={view.canTrade} chainNow={chainNow} onSelectMarket={onSelectMarket} />
      )}
    </section>
  );
});
