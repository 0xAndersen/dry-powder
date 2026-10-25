"use client";

import { forwardRef, useImperativeHandle, useMemo, useRef, useState } from "react";
import type { Hex } from "viem";
import { AppLink } from "@/components/app-link";
import { useApp } from "@/components/providers";
import { ShareSheet } from "@/components/social/share-sheet";
import { ConfirmDialog } from "@/components/trade/confirm-dialog";
import { AddMarginSheet, ClosePositionSheet } from "@/components/trade/position-sheets";
import { TrailSheet } from "@/components/trade/trail-sheet";
import { TxStatus } from "@/components/tx-status";
import type { AccountData, OrderRow, PositionView } from "@/hooks/use-account-data";
import { useTradeContext } from "@/hooks/use-action-context";
import { useLocalStore } from "@/hooks/use-local-store";
import type { LogFeedHandle } from "@/hooks/use-log-feed";
import { useChainNow, useMarketData, type MarketPrice } from "@/hooks/use-market-data";
import { useTrailing, type TrailingState } from "@/hooks/use-trailing";
import { useTwaps } from "@/hooks/use-twap";
import { useTx, type TxHandle } from "@/hooks/use-tx";
import { useWallet, type AccountView } from "@/hooks/use-wallet";
import { ORDER_TYPE, TEST_MINT_AMOUNT, submitAddMargin, submitBatch, submitCancel, submitRemoveMargin, submitTestMint, submitTrigger, type BatchCall } from "@/lib/actions";
import { UserFacingError } from "@/lib/errors";
import { isOpenOrder, orderTypeLabel } from "@/lib/events";
import { closeFlow } from "@/lib/flows";
import { PRICE_DECIMALS, fmtAge, fmtDateTime, fmtNum, fmtPercent, fmtPrice, fmtQty, fmtUsdc, parseAmount, shortAddress, toInputString } from "@/lib/format";
import { buildHistory, historyCsv } from "@/lib/history";
import { isSettled, type Instrument } from "@/lib/instruments";
import { RISK_TEXT, riskTone } from "@/lib/risk-tone";
import { ratio, unitsOf, withSlippageDown, withSlippageUp } from "@/lib/math";
import { valuePosition } from "@/lib/position";
import type { TradeCard } from "@/lib/share-card";
import { openPositionCard, profileLink, shareText } from "@/lib/share-data";
import { follows, nicknameOf } from "@/lib/social";
import { approveTrailing, clearTrail, setTrail } from "@/lib/trailing";
import { cancelTwap, fmtInterval, type Twap } from "@/lib/twap";
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

/** `part`: the share of the position the order closes when it fires (100: all of it, the engine's size 0). */
type EditState = { marketId: string; type: "tp" | "sl"; text: string; part?: number } | null;
const PARTS = [100, 75, 50, 25] as const;

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
  part,
  onPart,
  currentPart,
}: {
  kind: "tp" | "sl";
  current: bigint | null;
  /** Share of the position the existing order closes (100 when all). */
  currentPart: number;
  part: number;
  onPart: (part: number) => void;
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
        {current && currentPart < 100 ? <span className="ml-1 text-2xs text-faint" data-testid={`part-${kind}`}>{currentPart}%</span> : null}
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
      <select
        className="unit-select h-7"
        aria-label={`How much the ${name} closes`}
        title="How much of the position it closes when it fires"
        value={part}
        onChange={(event) => onPart(Number(event.target.value))}
        data-testid={`size-${kind}`}
      >
        {PARTS.map((p) => (
          <option key={p} value={p}>
            {p === 100 ? "All" : `${p}%`}
          </option>
        ))}
      </select>
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
  trailing,
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
  /** Trailing stops for the trading account (instant trading only); null when not offered. */
  trailing: TrailingState | null;
}) {
  const { config: cfg } = useApp();
  const { params } = useMarketData();
  const actionContext = useTradeContext();
  const [settings] = useLocalStore(tradeSettings);
  const pos = view.position;
  const marketId = pos.priceId.toLowerCase();
  const dp = instrument?.priceDecimals ?? 2;
  const sym = cfg.collateralSymbol;
  const symbol = instrument?.symbol ?? `${pos.priceId.slice(0, 10)}…`;
  const mark = price?.mark ?? null;
  const value = valuePosition(view, mark, params?.maxProfitMultiple ?? 10n);
  const tpOrder = orders.find((o) => o.id === pos.tpOrderId && pos.tpOrderId !== 0n)?.order ?? null;
  const slOrder = orders.find((o) => o.id === pos.slOrderId && pos.slOrderId !== 0n)?.order ?? null;
  const tp = tpOrder?.triggerPrice ?? null;
  const sl = slOrder?.triggerPrice ?? null;
  // Share of the position a sized order closes (an order sized above the position closes all of it).
  const partOf = (size: bigint | undefined) => (!size || size === 0n || size >= pos.size ? 100 : Math.max(1, Math.round(Number((size * 100n) / pos.size))));
  const tpPart = partOf(tpOrder?.size);
  const slPart = partOf(slOrder?.size);
  const settled = instrument ? isSettled(instrument) : false;
  const closing = pos.closeOrderId !== 0n;
  const [sheet, setSheet] = useState<"close" | "margin" | "trail" | null>(null);
  const wallet = useWallet();
  const trail = trailing?.trails.get(marketId);
  // Frozen when the sheet opens, so the image does not redraw on every price tick.
  const [shareCard, setShareCard] = useState<TradeCard | null>(null);
  const [followList] = useLocalStore(follows);
  const chainNow = useChainNow(10_000);
  const { byId } = useMarketData();
  const openShare = () =>
    setShareCard(
      openPositionCard(view, value, mark, chainNow, {
        market: (id) => byId.get(id.toLowerCase()),
        unit: sym,
        chainId: cfg.chainId,
        trader: nicknameOf(followList, pos.trader) ?? shortAddress(pos.trader),
        href: typeof window === "undefined" ? "" : window.location.href,
      }),
    );

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
    const part = edit.part ?? 100;
    const size = part >= 100 ? 0n : (pos.size * BigInt(part)) / 100n;
    run(async (api) => {
      await submitTrigger(withCtx(api), pos.priceId, type === "tp" ? ORDER_TYPE.TakeProfit : ORDER_TYPE.StopLoss, parsed, existing === 0n ? params.executionFee : 0n, `${existing === 0n ? "Set" : "Move"} ${name.toLowerCase()}`, size);
      setEdit(null);
      return `${name} ${existing === 0n ? "set" : "moved"} to ${fmtPrice(parsed, dp)} on ${symbol}${part < 100 ? `, closing ${part}% of the position` : ""}.`;
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
  const close = (size = 0n) => {
    if (!instrument || !params) return;
    setSheet(null);
    run((api) => closeFlow(withCtx(api), { instrument, view, reference: price?.reference ?? null, slippageBps: settings.slippageBps, executionFee: params.executionFee, balance, size }));
  };
  const addMargin = (amount: bigint, mode: "add" | "remove" = "add") => {
    setSheet(null);
    run(async (api) => {
      if (mode === "remove") {
        if (!instrument) throw new UserFacingError("This market is not loaded yet.");
        await submitRemoveMargin(withCtx(api), instrument, amount, `Take margin out of ${symbol}`);
        return `${fmtUsdc(amount)} ${cfg.collateralSymbol} taken out of the ${symbol} margin.`;
      }
      await submitAddMargin(withCtx(api), pos.priceId, amount, `Add margin to ${symbol}`);
      return `${fmtUsdc(amount)} ${cfg.collateralSymbol} added to the ${symbol} margin.`;
    });
  };
  const startTrail = (args: { distanceBps: number; size: bigint; activation: bigint }) => {
    setSheet(null);
    const pct = fmtPercent(args.distanceBps / 10_000, 2);
    run(async (api) => {
      const ctx = withCtx(api);
      if (!trailing?.approved) {
        if (!wallet.address) throw new UserFacingError("Connect the wallet that owns your trading account: it allows trailing stops once.");
        await approveTrailing(ctx, wallet.address);
      }
      await setTrail(ctx, { marketId: pos.priceId, ...args }, `Trail the ${symbol} stop ${pct} behind`);
      trailing?.refetch();
      return `Trailing stop on ${symbol}: ${pct} behind the best price. The keeper moves the stop-loss as the market moves your way; it never moves back.`;
    });
  };
  const removeTrail = () => {
    setSheet(null);
    run(async (api) => {
      await clearTrail(withCtx(api), pos.priceId, `Stop trailing ${symbol}`);
      trailing?.refetch();
      return `${symbol} no longer trails. Its stop-loss stays where it is.`;
    });
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
      <td data-cell="market">
        <button type="button" className="text-left hover:text-accent" disabled={!instrument} onClick={() => instrument && onSelectMarket(instrument)}>
          <span className="wide font-semibold">{symbol}</span>
        </button>
        <span className="block text-xs">
          <SideTag isLong={pos.isLong} /> <span className="num text-faint">{value.leverage.toFixed(1)}x</span>
        </span>
      </td>
      <td className="r" data-label="Size" data-cell="size">
        <span className="num">{fmtUsdc(pos.size)}</span>
        <span className="num block text-xs text-faint">
          {fmtQty(unitsOf(pos.size, pos.entryPrice))} {instrument?.unitLabel ?? ""}
        </span>
      </td>
      <td className="r num" data-label="Entry" data-cell="entry">{fmtPrice(pos.entryPrice, dp)}</td>
      <td className="r num" data-label="Mark" data-cell="mark">
        {mark !== null ? fmtPrice(mark, dp) : "—"}
        {price?.status === "awaiting" ? <span className="block text-xs text-warn">indicative</span> : price?.status === "settled" ? <span className="block text-xs text-accent">settled</span> : null}
      </td>
      <td className="r" data-label="Liquidation" data-cell="liq">
        <span className={`num ${liqNear ? "text-short" : RISK_TEXT[riskTone(value.liquidationDistance) ?? "calm"]}`}>
          {value.liquidatableNow ? "Now" : value.liquidationPrice === null ? "None" : fmtPrice(value.liquidationPrice, dp)}
        </span>
        {value.liquidationDistance !== null ? (
          <span className={`num block text-xs ${liqNear ? "text-short" : "text-faint"}`}>{value.liquidationDistance <= 0 ? "past threshold" : `${fmtPercent(value.liquidationDistance, 2)} away`}</span>
        ) : null}
      </td>
      <td className="r" data-cell="pnl">
        <span className={`num font-semibold ${value.pnl === null ? "" : value.pnl >= 0n ? "text-long" : "text-short"}`} data-testid="position-pnl">
          {value.pnl === null ? "—" : fmtUsdc(value.pnl, 2, { sign: true })}
        </span>
        <span className={`num block text-xs ${value.roe === null ? "text-faint" : value.roe >= 0 ? "text-long" : "text-short"}`}>
          {value.roe === null ? "" : `${fmtPercent(value.roe, 1, true)} ROE`}
          {value.capped ? " (capped)" : ""}
        </span>
      </td>
      <td className="r" data-label="Funding" data-cell="funding">
        <span className={`num ${view.fundingOwed > 0n ? "text-short" : view.fundingOwed < 0n ? "text-long" : "text-muted"}`} title="Funding accrued since entry. Negative: you have been paid.">
          {fmtUsdc(-view.fundingOwed, 4, { sign: true })}
        </span>
      </td>
      <td className="r" data-label="Margin" data-cell="margin">
        <span className="num">{fmtUsdc(pos.margin)}</span>
        {equity !== null && equity > 0n && value.pnl !== null ? (
          <span className="num block text-xs text-faint" title="This position's margin plus open PnL as a share of the account value">
            {fmtPercent(Math.max(0, ratio(pos.margin + value.pnl, equity)), 0)} of account
          </span>
        ) : null}
      </td>
      <td data-cell="brackets">
        <div className="flex flex-col gap-1">
          <span className="flex items-center gap-1.5">
            <span className="w-5 text-xs text-long">TP</span>
            <TriggerCell
              kind="tp" current={tp} editing={editingFor("tp")} dp={dp} symbol={symbol} canEdit={canTrade && !settled} disabled={tx.busy} error={edit?.type === "tp" ? editError : null}
              currentPart={tpPart} part={edit?.type === "tp" && edit.marketId === marketId ? (edit.part ?? tpPart) : tpPart}
              onPart={(part) => edit && setEdit({ ...edit, part })}
              onEdit={() => setEdit({ marketId, type: "tp", text: tp ? toInputString(tp, PRICE_DECIMALS, dp) : "", part: tpPart })}
              onText={(text) => setEdit({ marketId, type: "tp", text, part: edit?.part ?? tpPart })}
              onSave={saveTrigger} onRemove={() => removeTrigger("tp")} onCancel={() => setEdit(null)}
            />
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-5 text-xs text-short">SL</span>
            <TriggerCell
              kind="sl" current={sl} editing={editingFor("sl")} dp={dp} symbol={symbol} canEdit={canTrade && !settled} disabled={tx.busy} error={edit?.type === "sl" ? editError : null}
              currentPart={slPart} part={edit?.type === "sl" && edit.marketId === marketId ? (edit.part ?? slPart) : slPart}
              onPart={(part) => edit && setEdit({ ...edit, part })}
              onEdit={() => setEdit({ marketId, type: "sl", text: sl ? toInputString(sl, PRICE_DECIMALS, dp) : "", part: slPart })}
              onText={(text) => setEdit({ marketId, type: "sl", text, part: edit?.part ?? slPart })}
              onSave={saveTrigger} onRemove={() => removeTrigger("sl")} onCancel={() => setEdit(null)}
            />
            {trail ? (
              <span className="tag" data-tone="accent" title={`Trails ${fmtPercent(trail.distanceBps / 10_000, 2)} behind the best price${trail.best > 0n ? ` (${fmtPrice(trail.best, dp)} so far)` : ""}`} data-testid="trail-tag">
                Trail {fmtPercent(trail.distanceBps / 10_000, trail.distanceBps % 100 === 0 ? 0 : 1)}
              </span>
            ) : null}
          </span>
          {edit && edit.marketId === marketId && editError ? <span className="max-w-[16rem] whitespace-normal text-xs text-short">{editError}</span> : null}
        </div>
      </td>
      <td className="r" data-cell="actions">
        {canTrade ? (
          settled ? (
            <button type="button" className="btn btn-sm btn-primary" disabled={tx.busy || !instrument} onClick={() => close()} data-testid="settle-close">
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
            <span className="flex flex-wrap items-center justify-end gap-1.5">
              <button type="button" className="btn btn-sm" disabled={tx.busy || !instrument} onClick={() => setSheet("margin")} data-testid="add-margin" title="Add margin (lower leverage) or take some out (higher leverage)">
                Margin
              </button>
              <button type="button" className="btn btn-sm" disabled={tx.busy || !instrument} onClick={() => setSheet("close")} data-testid="close-position">
                Close
              </button>
              {trailing?.available ? (
                <button type="button" className="btn btn-sm" disabled={tx.busy || !instrument} onClick={() => setSheet("trail")} title="A stop-loss that follows the best price" data-testid="trail-position">
                  {trail ? "Trailing" : "Trail"}
                </button>
              ) : null}
              <button type="button" className="btn btn-sm btn-ghost" disabled={value.pnl === null} onClick={openShare} title="Share this position as an image" data-testid="position-share">
                Share
              </button>
            </span>
          )
        ) : closing ? (
          <span className="text-xs text-accent">Closing</span>
        ) : null}
        {shareCard ? <ShareSheet card={shareCard} title="Share this position" text={shareText(shareCard)} link={profileLink(pos.trader)} onClose={() => setShareCard(null)} /> : null}
        {sheet === "close" && instrument ? (
          <ClosePositionSheet view={view} instrument={instrument} price={price} busy={tx.busy} onClose={() => setSheet(null)} onConfirm={(size) => close(size)} />
        ) : null}
        {sheet === "margin" && instrument ? (
          <AddMarginSheet view={view} instrument={instrument} price={price} balance={balance} busy={tx.busy} onClose={() => setSheet(null)} onConfirm={addMargin} />
        ) : null}
        {sheet === "trail" && instrument && trailing ? (
          <TrailSheet
            view={view}
            instrument={instrument}
            price={price}
            orders={orders}
            trail={trail}
            approved={trailing.approved}
            busy={tx.busy}
            onClose={() => setSheet(null)}
            onConfirm={startTrail}
            onRemove={removeTrail}
          />
        ) : null}
      </td>
    </tr>
  );
}

/** Running TWAPs on the trading account: progress, the next slice, and a way to stop each. */
function TwapList({
  twaps,
  canTrade,
  busy,
  chainNow,
  onStop,
  onSelectMarket,
}: {
  twaps: readonly (readonly [string, Twap])[];
  canTrade: boolean;
  busy: boolean;
  chainNow: number;
  onStop: (marketId: Hex, symbol: string) => void;
  onSelectMarket: (instrument: Instrument) => void;
}) {
  const { config: cfg } = useApp();
  const { byId } = useMarketData();
  if (twaps.length === 0) return null;
  return (
    <ul className="divide-y divide-line border-b border-line" data-testid="twap-list">
      {twaps.map(([m, t]) => {
        const instrument = byId.get(m);
        const symbol = instrument?.symbol ?? "Unknown";
        const wait = t.nextAt - chainNow;
        const pct = Math.round((t.done / t.slices) * 100);
        return (
          <li key={m} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1.5 px-3 py-2.5 text-[0.8125rem]" data-testid={`twap-${symbol}`}>
            <div className="min-w-0">
              <span className="chip mr-1.5 align-middle">TWAP</span>
              <SideTag isLong={t.isLong} />{" "}
              <button type="button" className="font-semibold hover:text-accent" disabled={!instrument} onClick={() => instrument && onSelectMarket(instrument)}>
                {symbol}
              </button>{" "}
              <span className="num text-muted" data-testid="twap-progress">
                {t.done} of {t.slices} slices
              </span>
              <span className="num block text-xs text-faint">
                {fmtUsdc(t.sliceSize)} {cfg.collateralSymbol} each ({fmtUsdc(t.sliceMargin)} margin), every {fmtInterval(t.interval)} · next {wait > 0 ? `in ${fmtAge(wait)}` : "due now"}
                {t.refusals > 0 ? <span className="text-warn"> · last {t.refusals === 1 ? "slice was" : `${t.refusals} slices were`} refused (3 in a row stop it)</span> : null}
              </span>
            </div>
            <div className="flex items-center gap-3">
              <span className="h-1.5 w-20 overflow-hidden rounded-full bg-line" role="progressbar" aria-valuemin={0} aria-valuemax={t.slices} aria-valuenow={t.done} aria-label={`${symbol} TWAP progress`}>
                <span className={`block h-full ${t.isLong ? "bg-long" : "bg-short"}`} style={{ width: `${pct}%` }} />
              </span>
              {canTrade ? (
                <button type="button" className="btn btn-sm" disabled={busy} onClick={() => onStop(m as Hex, symbol)} data-testid="stop-twap">
                  Stop
                </button>
              ) : null}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

function OrdersTable({
  orders,
  positions,
  twaps,
  tx,
  canTrade,
  chainNow,
  onSelectMarket,
  onStopTwap,
}: {
  orders: OrderRow[];
  positions: readonly PositionView[];
  twaps: readonly (readonly [string, Twap])[];
  tx: TxHandle;
  canTrade: boolean;
  chainNow: number;
  onSelectMarket: (instrument: Instrument) => void;
  onStopTwap: (marketId: Hex, symbol: string) => void;
}) {
  const { config: cfg } = useApp();
  const { byId, prices } = useMarketData();
  const actionContext = useTradeContext();
  const sym = cfg.collateralSymbol;
  const sorted = useMemo(() => [...orders].sort((a, b) => (a.id < b.id ? 1 : -1)), [orders]);

  const twapList = <TwapList twaps={twaps} canTrade={canTrade} busy={tx.busy} chainNow={chainNow} onStop={onStopTwap} onSelectMarket={onSelectMarket} />;
  if (sorted.length === 0) {
    return twaps.length > 0 ? (
      twapList
    ) : (
      <Empty>No open orders. Limit orders, take-profits, stop-losses, TWAPs and pending keeper orders appear here.</Empty>
    );
  }

  const cancel = (row: OrderRow) => {
    void tx.run(async (api) => {
      const ctx = actionContext(api);
      if (!ctx) throw new UserFacingError("Connect your wallet first.");
      await submitCancel(ctx, row.id, `Cancel order #${row.id}`);
      return `Order #${row.id} cancelled. Everything escrowed for it was refunded.`;
    });
  };

  return (
    <>
    {twapList}
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
            const isOpen = o.orderType === 0 || o.orderType === 4;
            const hasPosition = positions.some((v) => v.position.priceId.toLowerCase() === o.priceId.toLowerCase());
            const escrow = isOpen ? o.margin + o.feeBudget + o.executionFee * BigInt(1 + (o.takeProfit !== 0n ? 1 : 0) + (o.stopLoss !== 0n ? 1 : 0)) : o.executionFee;
            const now = p?.exec ? (o.isLong ? p.exec.ask : p.exec.bid) : null;
            const stop = o.orderType === 4;
            const marketable =
              isOpen && now !== null && (stop ? (o.isLong ? now >= o.triggerPrice : now <= o.triggerPrice) : o.isLong ? now <= o.triggerPrice : now >= o.triggerPrice);
            const held = positions.find((v) => v.position.priceId.toLowerCase() === o.priceId.toLowerCase());
            const state = isOpen
              ? hasPosition && held && held.position.isLong !== o.isLong
                ? { text: "Blocked: the other side is open in this market", tone: "text-warn" }
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
                  {Number((o as { expiresAt?: bigint }).expiresAt ?? 0n) !== 0 ? (
                    <span className="num block text-xs text-faint" data-testid="order-expiry">
                      {chainNow > Number((o as { expiresAt?: bigint }).expiresAt)
                        ? "Expired: a keeper removes it"
                        : `Expires in ${fmtAge(Number((o as { expiresAt?: bigint }).expiresAt) - chainNow)}`}
                    </span>
                  ) : null}
                </td>
                <td>
                  <button type="button" className="wide font-semibold hover:text-accent" disabled={!instrument} onClick={() => instrument && onSelectMarket(instrument)}>
                    {instrument?.symbol ?? "Unknown"}
                  </button>
                </td>
                <td>
                  <SideTag isLong={o.isLong} />
                </td>
                <td className="r num">{isOpen ? fmtUsdc(o.size) : o.size > 0n ? fmtUsdc(o.size) : "Whole position"}</td>
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
    </>
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
  const { config: cfg } = useApp();
  const { byId, prices, params } = useMarketData();
  const tx = useTx({ autoDismissMs: 10000 });
  const [tab, setTab] = useState<Tab>("positions");
  const [bulk, setBulk] = useState<null | "close" | "cancel" | "reset">(null);
  const bulkContext = useTradeContext();
  const [bulkSettings] = useLocalStore(tradeSettings);
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
  // Trailing stops work for positions in the trading account (instant trading), where a contract can be an agent.
  const trailing = useTrailing(view.instant ? view.address : undefined, positions.map((p) => p.position.priceId));
  // TWAPs run from the trading account too; one per market, so every listed market is read.
  const marketIds = useMemo(() => [...byId.keys()] as Hex[], [byId]);
  const twapState = useTwaps(view.instant ? view.address : undefined, cfg.twapOrders ? marketIds : []);
  const twaps = useMemo(() => [...twapState.twaps.entries()], [twapState.twaps]);
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
    { key: "orders", label: `Orders${account ? ` (${orders.length + twaps.length})` : ""}` },
    { key: "history", label: "History" },
    { key: "alerts", label: "Alerts" },
  ];

  const needsAccount = tab !== "alerts" && !view.address;

  /** One close per open position: a keeper Close order (worst price at the slippage setting), or a direct close at
   *  the settlement price for a settled dated market. Positions already closing are skipped. */
  const closeCalls = (): BatchCall[] => {
    const bps = BigInt(bulkSettings.slippageBps);
    const calls: BatchCall[] = [];
    for (const p of positions) {
      if (p.position.closeOrderId !== 0n) continue;
      const inst = byId.get(p.position.priceId.toLowerCase());
      if (!inst) continue;
      const ref = prices.get(inst.id)?.reference ?? null;
      const worst = ref ? (p.position.isLong ? withSlippageDown(ref.bid, bps) : withSlippageUp(ref.ask, bps)) : 0n;
      calls.push(
        inst.settlementPrice !== 0n
          ? { functionName: "closePosition", args: [inst.id, 0n, 0n, []], label: `Close ${inst.symbol}` }
          : { functionName: "setTriggerOrder", args: [inst.id, ORDER_TYPE.Close, worst, 0n], label: `Close ${inst.symbol}` },
      );
    }
    return calls;
  };

  const stopTwap = (marketId: Hex, symbol: string) => {
    void tx.run(async (api) => {
      const ctx = bulkContext(api);
      if (!ctx) throw new UserFacingError("Connect your wallet first.");
      await cancelTwap(ctx, marketId, `Stop the ${symbol} TWAP`);
      twapState.refetch();
      return `${symbol} TWAP stopped. Slices already placed stay; a resting one can be cancelled below.`;
    });
  };

  /** Stops every running TWAP first, so none places a slice while the rest is being cancelled or closed. */
  const stopAllTwaps = async (ctx: NonNullable<ReturnType<typeof bulkContext>>): Promise<number> => {
    if (!ctx.session) return 0;
    for (const [m] of twaps) await cancelTwap(ctx, m as Hex, `Stop the ${byId.get(m)?.symbol ?? "market"} TWAP`);
    if (twaps.length > 0) twapState.refetch();
    return twaps.length;
  };

  /**
   * Practice: start over. Cancels resting entry orders, closes every position, and adds test funds; history and the
   * journal stay. With instant trading the cancels and closes are one transaction.
   */
  const startOver = () => {
    setBulk(null);
    if (!params) return;
    void tx.run(async (api) => {
      const ctx = bulkContext(api);
      if (!ctx) throw new UserFacingError("Connect your wallet first.");
      const stopped = await stopAllTwaps(ctx);
      const entries = orders.filter((o) => isOpenOrder(o.order.orderType));
      let closes = 0;
      if (ctx.session && cfg.oracleMode === "publisher") {
        const calls: BatchCall[] = [...entries.map((o) => ({ functionName: "cancelOrder" as const, args: [o.id], label: `Cancel order #${o.id}` })), ...closeCalls()];
        closes = calls.length - entries.length;
        if (calls.length > 0) await submitBatch(ctx, "Start over: cancel orders and close positions", calls);
      } else {
        for (const o of entries) await submitCancel(ctx, o.id, `Cancel order #${o.id}`);
        for (const p of positions) {
          if (p.position.closeOrderId !== 0n) continue;
          const inst = byId.get(p.position.priceId.toLowerCase());
          if (!inst) continue;
          await closeFlow(ctx, { instrument: inst, view: p, reference: prices.get(inst.id)?.reference ?? null, slippageBps: bulkSettings.slippageBps, executionFee: params.executionFee, balance: account?.balance });
          closes += 1;
        }
      }
      await submitTestMint(ctx, `Add test ${cfg.collateralSymbol}`);
      return `Started over: ${stopped > 0 ? `${stopped} TWAP${stopped === 1 ? "" : "s"} stopped, ` : ""}${entries.length} order${entries.length === 1 ? "" : "s"} cancelled, ${closes} close${closes === 1 ? "" : "s"} sent (the keeper fills them at the next price), ${fmtUsdc(TEST_MINT_AMOUNT, 0)} ${cfg.collateralSymbol} added. Your history and journal stay.`;
    });
  };

  /** Close every open position (keeper orders where needed), one after another. */
  const closeAll = () => {
    setBulk(null);
    if (!params) return;
    void tx.run(async (api) => {
      const ctx = bulkContext(api);
      if (!ctx) throw new UserFacingError("Connect your wallet first.");
      // Instant trading: every close in one transaction from the trading account (all or nothing, no pop-up).
      if (ctx.session && cfg.oracleMode === "publisher") {
        const calls = closeCalls();
        await submitBatch(ctx, `Close ${calls.length} position${calls.length === 1 ? "" : "s"}`, calls);
        return `Sent ${calls.length} close${calls.length === 1 ? "" : "s"} in one transaction. Keeper orders fill at the next price.`;
      }
      let done = 0;
      for (const p of positions) {
        if (p.position.closeOrderId !== 0n) continue;
        const inst = byId.get(p.position.priceId.toLowerCase());
        if (!inst) continue;
        await closeFlow(ctx, {
          instrument: inst,
          view: p,
          reference: prices.get(inst.id)?.reference ?? null,
          slippageBps: bulkSettings.slippageBps,
          executionFee: params.executionFee,
          balance: account?.balance,
        });
        done += 1;
      }
      return `Sent ${done} close${done === 1 ? "" : "s"}. Keeper orders fill at the next price.`;
    });
  };

  /** Cancel every resting order, take-profits and stop-losses included. */
  const cancelAll = () => {
    setBulk(null);
    void tx.run(async (api) => {
      const ctx = bulkContext(api);
      if (!ctx) throw new UserFacingError("Connect your wallet first.");
      if (ctx.session) {
        const stopped = await stopAllTwaps(ctx);
        if (orders.length > 0) await submitBatch(ctx, `Cancel ${orders.length} orders`, orders.map((o) => ({ functionName: "cancelOrder", args: [o.id], label: `Cancel order #${o.id}` })));
        return `${stopped > 0 ? `Stopped ${stopped} TWAP${stopped === 1 ? "" : "s"}; c` : "C"}ancelled ${orders.length} order${orders.length === 1 ? "" : "s"}${orders.length > 1 ? " in one transaction" : ""}. Escrow refunded.`;
      }
      for (const o of orders) await submitCancel(ctx, o.id, `Cancel order #${o.id}`);
      return `Cancelled ${orders.length} order${orders.length === 1 ? "" : "s"}. Escrow refunded.`;
    });
  };

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
        {view.canTrade && tab === "positions" && positions.length > 1 ? (
          <button type="button" className="btn btn-sm" disabled={tx.busy} onClick={() => setBulk("close")} data-testid="close-all">
            Close all
          </button>
        ) : null}
        {view.canTrade && tab === "orders" && orders.length + twaps.length > 1 ? (
          <button type="button" className="btn btn-sm" disabled={tx.busy} onClick={() => setBulk("cancel")} data-testid="cancel-all">
            Cancel all
          </button>
        ) : null}
        {view.canTrade && cfg.collateralIsTest && (positions.length > 0 || orders.length > 0 || twaps.length > 0) && (tab === "positions" || tab === "orders") ? (
          <button type="button" className="btn btn-sm btn-ghost" disabled={tx.busy} onClick={() => setBulk("reset")} title="Practice: close everything, cancel orders, add test funds" data-testid="start-over">
            Start over
          </button>
        ) : null}
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
      {bulk ? (
        <ConfirmDialog
          title={bulk === "reset" ? "Start over?" : bulk === "close" ? `Close all ${positions.length} positions?` : `Cancel all ${orders.length + twaps.length} orders?`}
          lines={
            bulk === "reset"
              ? [
                  ...(twaps.length > 0 ? [{ label: "TWAPs stopped", value: String(twaps.length) }] : []),
                  { label: "Positions closed", value: String(positions.filter((p) => p.position.closeOrderId === 0n).length) },
                  { label: "Entry orders cancelled", value: String(orders.filter((o) => isOpenOrder(o.order.orderType)).length) },
                  { label: "Test funds added", value: `${fmtUsdc(TEST_MINT_AMOUNT, 0)} ${cfg.collateralSymbol}` },
                ]
              : bulk === "close"
                ? positions.map((p) => ({ label: byId.get(p.position.priceId.toLowerCase())?.symbol ?? "Position", value: `${p.position.isLong ? "Long" : "Short"} ${fmtUsdc(p.position.size)}` }))
                : [{ label: "Orders", value: String(orders.length) }, ...(twaps.length > 0 ? [{ label: "TWAPs stopped", value: String(twaps.length) }] : [])]
          }
          note={
            bulk === "reset"
              ? "Practice money only. Your trade history, journal and stats stay; closes fill at the next price."
              : bulk === "close"
                ? view.instant
                  ? "Sent from your trading account, no wallet pop-ups."
                  : "Your wallet asks once per position."
                : `Take-profits and stop-losses are cancelled too, so open positions lose their protection.${twaps.length > 0 ? " Running TWAPs stop." : ""}`
          }
          confirmLabel={bulk === "reset" ? "Start over" : bulk === "close" ? "Close all" : "Cancel all"}
          tone="short"
          onConfirm={bulk === "reset" ? startOver : bulk === "close" ? closeAll : cancelAll}
          onCancel={() => setBulk(null)}
        />
      ) : null}

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
            <table className="data-table card-table" data-testid="positions-table">
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
                    trailing={trailing.available ? trailing : null}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <OrdersTable
          orders={orders}
          positions={positions}
          twaps={twaps}
          tx={tx}
          canTrade={view.canTrade}
          chainNow={chainNow}
          onSelectMarket={onSelectMarket}
          onStopTwap={stopTwap}
        />
      )}
    </section>
  );
});
