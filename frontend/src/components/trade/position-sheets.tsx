"use client";

import { useId, useMemo, useState } from "react";
import { useApp } from "@/components/providers";
import { Sheet } from "@/components/ui/sheet";
import type { PositionView } from "@/hooks/use-account-data";
import { useMarketData, type MarketPrice } from "@/hooks/use-market-data";
import { USDC_DECIMALS, fmtPercent, fmtPrice, fmtUsdc, parseAmount, toInputString } from "@/lib/format";
import type { Instrument } from "@/lib/instruments";
import { DIRECT_MAX_LEVERAGE, absDiff, baseFee, ceilDiv, liquidationPrice, needsKeeperOrders, partialRelease, pricePnl, ratio } from "@/lib/math";
import { valuePosition } from "@/lib/position";

const PARTS = [25, 50, 75, 100] as const;

/**
 * Close all or part of a position. A part keeps the rest open with its entry, liquidation price, take-profit and
 * stop-loss; if the rest would hold less than the minimum margin, everything closes.
 */
export function ClosePositionSheet({
  view,
  instrument,
  price,
  busy,
  onClose,
  onConfirm,
}: {
  view: PositionView;
  instrument: Instrument;
  price: MarketPrice | undefined;
  busy: boolean;
  onClose: () => void;
  /** `size` 0n closes everything. */
  onConfirm: (size: bigint) => void;
}) {
  const { config: cfg } = useApp();
  const { params } = useMarketData();
  const ids = useId();
  const pos = view.position;
  const sym = cfg.collateralSymbol;
  const dp = instrument.priceDecimals;
  const [pct, setPct] = useState<number>(100);
  const [custom, setCustom] = useState<string | null>(null);

  const customSize = custom !== null ? parseAmount(custom, USDC_DECIMALS) : null;
  const closeSize = custom !== null ? (customSize ?? 0n) : (pos.size * BigInt(pct)) / 100n;
  const minMargin = params?.minMargin ?? 5_000_000n;
  const released = partialRelease(pos.size, pos.margin, closeSize, minMargin);
  const whole = released === null;
  const partSize = whole ? pos.size : closeSize;
  const partMargin = whole ? pos.margin : released;
  const mark = price?.mark ?? null;
  const value = valuePosition(view, mark, params?.maxProfitMultiple ?? 10n);

  // Estimate at the current mark: price PnL on the part, its share of funding, capped at 10x its margin.
  const estimate = useMemo(() => {
    if (mark === null || !params) return null;
    let pnl = pricePnl(partSize, pos.entryPrice, mark, pos.isLong) - (view.fundingOwed * partSize) / pos.size;
    const cap = partMargin * params.maxProfitMultiple;
    if (pnl > cap) pnl = cap;
    if (pnl < -partMargin) pnl = -partMargin;
    const fee = baseFee(partSize, params.baseFeeBps, partMargin);
    return { pnl, fee, back: partMargin + pnl - fee };
  }, [mark, params, partSize, partMargin, pos.entryPrice, pos.isLong, pos.size, view.fundingOwed]);

  const invalid = custom !== null && (customSize === null || customSize <= 0n);
  const keeper = cfg.oracleMode === "publisher" || needsKeeperOrders(pos.size, pos.margin);
  const restLeverage = !whole && released !== null ? ratio(pos.size - partSize, pos.margin - released) : null;

  return (
    <Sheet
      title={`Close ${instrument.symbol} ${pos.isLong ? "long" : "short"}`}
      description={keeper ? "A keeper closes it at the next oracle price, within your slippage tolerance." : "Closes against the current oracle price."}
      onClose={onClose}
      testId="close-sheet"
      footer={
        <button
          type="button"
          className="btn btn-primary btn-lg w-full"
          disabled={busy || invalid || closeSize === 0n}
          onClick={() => onConfirm(whole ? 0n : partSize)}
          data-testid="close-confirm"
        >
          {whole ? "Close the whole position" : `Close ${fmtUsdc(partSize, 0)} ${sym} (${fmtPercent(ratio(partSize, pos.size), 0)})`}
        </button>
      }
    >
      <div className="grid gap-3">
        <div className="segmented" role="group" aria-label="How much to close">
          {PARTS.map((p) => (
            <button
              key={p}
              type="button"
              aria-pressed={custom === null && pct === p}
              onClick={() => {
                setCustom(null);
                setPct(p);
              }}
              data-testid={`close-part-${p}`}
            >
              {p}%
            </button>
          ))}
        </div>
        <div>
          <label className="field-label" htmlFor={`${ids}-size`}>
            Or a size
          </label>
          <div className="field" data-invalid={invalid}>
            <input
              id={`${ids}-size`}
              inputMode="decimal"
              autoComplete="off"
              placeholder={toInputString(pos.size, USDC_DECIMALS, 2)}
              value={custom ?? ""}
              onChange={(event) => setCustom(event.target.value === "" ? null : event.target.value)}
              data-testid="close-size"
            />
            <span className="field-unit">{sym}</span>
          </div>
        </div>
        <dl className="grid gap-1.5 text-[0.8125rem]">
          <div className="kv">
            <dt>Closing</dt>
            <dd className="num">
              {fmtUsdc(partSize)} of {fmtUsdc(pos.size)} {sym}
            </dd>
          </div>
          <div className="kv">
            <dt>Margin released</dt>
            <dd className="num">{fmtUsdc(partMargin)} {sym}</dd>
          </div>
          {estimate ? (
            <>
              <div className="kv">
                <dt>PnL at the current price</dt>
                <dd className={`num ${estimate.pnl > 0n ? "text-long" : estimate.pnl < 0n ? "text-short" : ""}`}>{fmtUsdc(estimate.pnl, 2, { sign: true })} {sym}</dd>
              </div>
              <div className="kv">
                <dt>Close fee</dt>
                <dd className="num">{fmtUsdc(estimate.fee, 4)} {sym}</dd>
              </div>
              <div className="kv">
                <dt className="text-text">Back to you, about</dt>
                <dd className="num font-semibold">{fmtUsdc(estimate.back > 0n ? estimate.back : 0n)} {sym}</dd>
              </div>
            </>
          ) : null}
          {!whole && released !== null ? (
            <div className="kv">
              <dt>What stays open</dt>
              <dd className="num text-right">
                {fmtUsdc(pos.size - partSize)} {sym} on {fmtUsdc(pos.margin - released)} margin
                {restLeverage !== null ? ` (${restLeverage.toFixed(1)}x)` : ""}
                {value.liquidationPrice !== null ? <span className="block text-xs text-faint">liquidation stays at {fmtPrice(value.liquidationPrice, dp)}</span> : null}
              </dd>
            </div>
          ) : null}
        </dl>
        {whole && closeSize > 0n && closeSize < pos.size ? (
          <p className="notice" data-tone="warn">
            What would remain holds less than the {fmtUsdc(minMargin)} {sym} minimum margin, so the whole position closes.
          </p>
        ) : null}
        {!whole ? <p className="text-xs text-faint">Your take-profit and stop-loss stay on what remains.</p> : null}
      </div>
    </Sheet>
  );
}

/**
 * Most margin that can come out of `view` now (v3.2 PerpEngineExt.removeMargin): what stays must hold the minimum
 * margin, keep the position within the market's leverage and 100x, and cover any loss at the exit price plus the
 * initial margin at that leverage. Unrealised profit never counts. Null without an exit price.
 */
export function removableMargin(view: PositionView, instrument: Instrument, exit: bigint | null, minMargin: bigint): bigint | null {
  const pos = view.position;
  if (exit === null || exit === 0n) return null;
  const maxLev = BigInt(Math.min(instrument.maxLeverage, DIRECT_MAX_LEVERAGE));
  const initial = ceilDiv(pos.size, maxLev);
  const pnl = pricePnl(pos.size, pos.entryPrice, exit, pos.isLong) - view.fundingOwed;
  const loss = pnl < 0n ? -pnl : 0n;
  const keep = [minMargin, initial, loss + initial].reduce((a, b) => (a > b ? a : b));
  return pos.margin > keep ? pos.margin - keep : 0n;
}

/**
 * Margin in or out. Adding lowers leverage and moves liquidation away (refused by the engine while the position
 * is in profit). Taking out (v3.2) raises leverage within the limits of {@link removableMargin}.
 */
export function AddMarginSheet({
  view,
  instrument,
  price,
  balance,
  busy,
  onClose,
  onConfirm,
}: {
  view: PositionView;
  instrument: Instrument;
  price: MarketPrice | undefined;
  balance: bigint | undefined;
  busy: boolean;
  onClose: () => void;
  onConfirm: (amount: bigint, mode: "add" | "remove") => void;
}) {
  const { config: cfg } = useApp();
  const { params } = useMarketData();
  const ids = useId();
  const pos = view.position;
  const sym = cfg.collateralSymbol;
  const dp = instrument.priceDecimals;
  const [text, setText] = useState("");
  // Taking margin out needs a v3.2 engine (it also has the Upside profit share).
  const canRemove = params?.profitShareBps !== null && params?.profitShareBps !== undefined && !params?.paused;
  const [mode, setMode] = useState<"add" | "remove">("add");
  const removing = mode === "remove" && canRemove;
  const amount = parseAmount(text, USDC_DECIMALS);
  const mark = price?.mark ?? null;
  const value = valuePosition(view, mark, params?.maxProfitMultiple ?? 10n);
  const inProfit = value.pnl !== null && value.pnl > 0n;
  const room = pos.size > pos.margin ? pos.size - pos.margin : 0n;
  // The engine checks a removal at the exit price: the bid for a long, the ask for a short.
  const exit = price?.exec ? (pos.isLong ? price.exec.bid : price.exec.ask) : null;
  const removable = params ? removableMargin(view, instrument, exit, params.minMargin) : null;
  const newMargin = amount !== null ? (removing ? (pos.margin > amount ? pos.margin - amount : 0n) : pos.margin + amount) : pos.margin;
  const liqAfter = amount !== null && amount > 0n && newMargin > 0n ? liquidationPrice(pos.entryPrice, newMargin, pos.size, pos.isLong, view.fundingOwed) : null;
  const distance = (liq: bigint | null) => (liq !== null && liq > 0n && mark !== null && mark > 0n ? ratio(absDiff(mark, liq), mark) : null);
  const before = distance(value.liquidationPrice);
  const after = distance(liqAfter);

  const error = (() => {
    if (text.trim() === "") return null;
    if (amount === null || amount <= 0n) return "Enter an amount greater than zero";
    if (removing) {
      if (removable === null) return "Waiting for a usable price to check the removal against";
      if (amount > removable)
        return removable === 0n
          ? "Nothing can come out now: the position is at its leverage limit, or its loss uses the margin"
          : `At most ${fmtUsdc(removable)} ${sym} now: what stays must cover any loss plus the margin for ${Math.min(instrument.maxLeverage, DIRECT_MAX_LEVERAGE)}x`;
      return null;
    }
    if (amount > room) return `At most ${fmtUsdc(room)} ${sym}: leverage cannot go below 1x`;
    if (balance !== undefined && amount > balance) return `Not enough ${sym}: ${fmtUsdc(balance)} available`;
    return null;
  })();

  /** Margin that brings the position to `x` leverage. */
  const toLeverage = (x: number) => {
    const target = (pos.size * 100n) / BigInt(Math.round(x * 100));
    return removing ? (pos.margin > target ? pos.margin - target : 0n) : target > pos.margin ? target - pos.margin : 0n;
  };
  const presets = removing
    ? [10, 25, 50, 100]
        .filter((x) => x <= Math.min(instrument.maxLeverage, DIRECT_MAX_LEVERAGE))
        .map((x) => ({ x, add: toLeverage(x) }))
        .filter((p) => p.add > 0n && removable !== null && p.add <= removable)
    : [50, 20, 10, 5].map((x) => ({ x, add: toLeverage(x) })).filter((p) => p.add > 0n && p.add <= room);
  const blocked = removing ? false : inProfit;

  return (
    <Sheet
      title={`${removing ? "Take margin out of" : "Add margin to"} ${instrument.symbol} ${pos.isLong ? "long" : "short"}`}
      description={
        removing
          ? "Less collateral behind the same position: margin comes back to you, leverage goes up, liquidation comes closer. Size and entry do not change."
          : "More collateral behind the same position: lower leverage, liquidation further away. Size and entry do not change."
      }
      onClose={onClose}
      testId="margin-sheet"
      footer={
        <button
          type="button"
          className="btn btn-primary btn-lg w-full"
          disabled={busy || blocked || amount === null || amount <= 0n || error !== null}
          onClick={() => amount !== null && onConfirm(amount, removing ? "remove" : "add")}
          data-testid="margin-confirm"
        >
          {amount !== null && amount > 0n ? `${removing ? "Take out" : "Add"} ${fmtUsdc(amount)} ${sym}` : removing ? "Take margin out" : "Add margin"}
        </button>
      }
    >
      <div className="grid gap-3">
        {canRemove ? (
          <div className="flex gap-1.5" role="group" aria-label="Add or take out">
            <button type="button" className="chip" aria-pressed={!removing} onClick={() => { setMode("add"); setText(""); }} data-testid="margin-mode-add">
              Add
            </button>
            <button type="button" className="chip" aria-pressed={removing} onClick={() => { setMode("remove"); setText(""); }} data-testid="margin-mode-remove">
              Take out
            </button>
          </div>
        ) : null}
        {blocked ? (
          <p className="notice" data-tone="warn">
            The position is in profit. Margin cannot be added to a winning position: it would raise its profit cap. Take profit on part of it instead, or add margin if it
            turns.
          </p>
        ) : null}
        <div>
          <label className="field-label" htmlFor={`${ids}-amount`}>
            Amount
          </label>
          <div className="field" data-invalid={error !== null}>
            <input id={`${ids}-amount`} inputMode="decimal" autoComplete="off" placeholder="0.00" value={text} onChange={(event) => setText(event.target.value)} data-testid="margin-amount" />
            <span className="field-unit">{sym}</span>
          </div>
          {error ? <p className="mt-1 text-xs text-short">{error}</p> : null}
          {removing && removable !== null && removable > 0n ? (
            <button type="button" className="link mt-1 text-xs" onClick={() => setText(toInputString(removable, USDC_DECIMALS, 2))} data-testid="margin-max">
              Most that can come out: {fmtUsdc(removable)} {sym}
            </button>
          ) : null}
          {presets.length > 0 ? (
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {presets.map((p) => (
                <button key={p.x} type="button" className="chip" onClick={() => setText(toInputString(p.add, USDC_DECIMALS, 2))}>
                  To {p.x}x ({removing ? "−" : "+"}
                  {fmtUsdc(p.add, 2)})
                </button>
              ))}
            </div>
          ) : null}
        </div>
        <dl className="grid gap-1.5 text-[0.8125rem]">
          <div className="kv">
            <dt>Margin</dt>
            <dd className="num">
              {fmtUsdc(pos.margin)} {amount !== null && amount > 0n && !error ? `→ ${fmtUsdc(newMargin)}` : ""} {sym}
            </dd>
          </div>
          <div className="kv">
            <dt>Leverage</dt>
            <dd className="num">
              {ratio(pos.size, pos.margin).toFixed(1)}x{amount !== null && amount > 0n && !error && newMargin > 0n ? ` → ${ratio(pos.size, newMargin).toFixed(1)}x` : ""}
            </dd>
          </div>
          <div className="kv">
            <dt>Liquidation price</dt>
            <dd className="num text-right">
              {value.liquidationPrice === null ? "—" : fmtPrice(value.liquidationPrice, dp)}
              {liqAfter !== null && !error ? ` → ${liqAfter === 0n ? "none" : fmtPrice(liqAfter, dp)}` : ""}
              {before !== null ? (
                <span className="block text-xs text-faint">
                  {fmtPercent(before, 2)} from the mark{after !== null && !error ? ` → ${fmtPercent(after, 2)}` : ""}
                </span>
              ) : null}
            </dd>
          </div>
        </dl>
        <p className="text-xs text-faint">
          {removing
            ? "What comes out is margin, never profit: profit is paid when you close. The profit cap is ten times the margin that stays."
            : "Most you can lose on this position grows by the margin you add: liquidation takes the whole margin."}
        </p>
      </div>
    </Sheet>
  );
}
