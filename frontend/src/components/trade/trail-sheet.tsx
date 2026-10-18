"use client";

import { useId, useState } from "react";
import { useApp } from "@/components/providers";
import { Sheet } from "@/components/ui/sheet";
import type { OrderRow, PositionView } from "@/hooks/use-account-data";
import { useMarketData, type MarketPrice } from "@/hooks/use-market-data";
import { PRICE_DECIMALS, fmtPercent, fmtPrice, fmtUsdc, parseAmount } from "@/lib/format";
import type { Instrument } from "@/lib/instruments";
import { MAX_TRAIL_BPS, MIN_TRAIL_BPS, TRAIL_PRESETS_BPS, trailLevel, type Trail } from "@/lib/trailing";

const PARTS = [100, 75, 50, 25] as const;

/**
 * A trailing stop on a position in the trading account: a stop-loss that follows the best price by a distance and
 * never moves back. Set and moved by the trailing-stop contract (the keeper pokes it); the stop itself is an
 * ordinary stop-loss.
 */
export function TrailSheet({
  view,
  instrument,
  price,
  orders,
  trail,
  approved,
  busy,
  onClose,
  onConfirm,
  onRemove,
}: {
  view: PositionView;
  instrument: Instrument;
  price: MarketPrice | undefined;
  orders: OrderRow[];
  trail: Trail | undefined;
  approved: boolean;
  busy: boolean;
  onClose: () => void;
  onConfirm: (args: { distanceBps: number; size: bigint; activation: bigint }) => void;
  onRemove: () => void;
}) {
  const { config: cfg } = useApp();
  const { params } = useMarketData();
  const ids = useId();
  const pos = view.position;
  const dp = instrument.priceDecimals;
  const sym = cfg.collateralSymbol;
  const [pctText, setPctText] = useState(trail ? String(trail.distanceBps / 100) : "1");
  const [part, setPart] = useState<(typeof PARTS)[number]>(() => {
    if (!trail || trail.size === 0n || pos.size === 0n) return 100;
    const share = Number((trail.size * 100n) / pos.size);
    return PARTS.reduce((best, p) => (Math.abs(p - share) < Math.abs(best - share) ? p : best), 100);
  });
  const [activationText, setActivationText] = useState(trail && trail.activation > 0n ? fmtPrice(trail.activation, dp).replace(/,/g, "") : "");

  const pct = Number(pctText);
  const bps = Number.isFinite(pct) ? Math.round(pct * 100) : NaN;
  const activation = activationText.trim() === "" ? 0n : parseAmount(activationText, PRICE_DECIMALS);
  const mark = price?.mark ?? null;
  const currentStop = orders.find((o) => o.id === pos.slOrderId && pos.slOrderId !== 0n)?.order.triggerPrice ?? null;
  const size = part === 100 ? 0n : (pos.size * BigInt(part)) / 100n;

  const error = (() => {
    if (!(bps >= MIN_TRAIL_BPS && bps <= MAX_TRAIL_BPS)) return `Choose a distance between ${MIN_TRAIL_BPS / 100}% and ${MAX_TRAIL_BPS / 100}%`;
    if (activationText.trim() !== "" && (activation === null || activation <= 0n)) return "Enter an activation price greater than zero, or leave it empty";
    return null;
  })();

  // What the first poke would set: from the mark now, or nothing until the activation price is reached.
  const waits = activation !== null && activation > 0n && mark !== null && (pos.isLong ? mark < activation : mark > activation);
  const start = waits ? null : mark;
  const level = !error && start !== null ? trailLevel(start, bps, pos.isLong) : null;
  const keepsCurrent = level !== null && currentStop !== null && (pos.isLong ? level <= currentStop : level >= currentStop);
  const direction = pos.isLong ? "up with each new high, never down" : "down with each new low, never up";

  return (
    <Sheet
      title={`Trailing stop on ${instrument.symbol} ${pos.isLong ? "long" : "short"}`}
      description={`A stop-loss that follows the best price by a fixed distance: it moves ${direction}. The keeper moves it; it fires like any stop-loss.`}
      onClose={onClose}
      testId="trail-sheet"
      footer={
        <div className="flex flex-col gap-2">
          <button type="button" className="btn btn-primary btn-lg w-full" disabled={busy || error !== null} onClick={() => onConfirm({ distanceBps: bps, size, activation: activation ?? 0n })} data-testid="trail-confirm">
            {approved ? (trail ? `Trail at ${fmtPercent(bps / 10_000, 2)}` : `Start trailing at ${fmtPercent(bps / 10_000, 2)}`) : "Allow trailing stops, then start"}
          </button>
          {trail ? (
            <button type="button" className="btn btn-sm btn-ghost w-full" disabled={busy} onClick={onRemove} data-testid="trail-remove">
              Stop trailing (the current stop-loss stays)
            </button>
          ) : null}
        </div>
      }
    >
      <div className="grid gap-3">
        <div>
          <label className="field-label" htmlFor={`${ids}-pct`}>
            Distance behind the best price
          </label>
          <div className="field" data-invalid={error !== null && !(bps >= MIN_TRAIL_BPS && bps <= MAX_TRAIL_BPS)}>
            <input id={`${ids}-pct`} inputMode="decimal" autoComplete="off" value={pctText} onChange={(event) => setPctText(event.target.value)} data-testid="trail-distance" />
            <span className="field-unit">%</span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-1.5">
            {TRAIL_PRESETS_BPS.map((b) => (
              <button key={b} type="button" className="chip" aria-pressed={bps === b} onClick={() => setPctText(String(b / 100))}>
                {b / 100}%
              </button>
            ))}
          </div>
        </div>
        <div>
          <span className="field-label">Closes</span>
          <div className="segmented" role="group" aria-label="How much the stop closes">
            {PARTS.map((p) => (
              <button key={p} type="button" aria-pressed={part === p} onClick={() => setPart(p)}>
                {p === 100 ? "All" : `${p}%`}
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className="field-label" htmlFor={`${ids}-act`}>
            Start once the price reaches (optional)
          </label>
          <div className="field">
            <input id={`${ids}-act`} inputMode="decimal" autoComplete="off" placeholder="Start now" value={activationText} onChange={(event) => setActivationText(event.target.value)} />
            <span className="field-unit">{instrument.quote}</span>
          </div>
        </div>
        {error ? <p className="text-xs text-short">{error}</p> : null}
        <dl className="grid gap-1.5 text-[0.8125rem]">
          <div className="kv">
            <dt>Mark now</dt>
            <dd className="num">{mark !== null ? fmtPrice(mark, dp) : "—"}</dd>
          </div>
          <div className="kv">
            <dt>Stop-loss now</dt>
            <dd className="num">{currentStop !== null ? fmtPrice(currentStop, dp) : "None"}</dd>
          </div>
          <div className="kv">
            <dt>First trailed stop</dt>
            <dd className="num text-right" data-testid="trail-preview">
              {waits ? `once the mark reaches ${fmtPrice(activation!, dp)}` : level !== null ? fmtPrice(level, dp) : "—"}
              {keepsCurrent ? <span className="block text-xs text-faint">Your stop is already tighter: it stays until the trail passes it.</span> : null}
            </dd>
          </div>
          {trail && trail.best > 0n ? (
            <div className="kv">
              <dt>Best price so far</dt>
              <dd className="num">{fmtPrice(trail.best, dp)}</dd>
            </div>
          ) : null}
        </dl>
        <p className="text-xs text-faint">
          {approved
            ? "Setting or changing the trail needs no wallet confirmation."
            : "Your wallet confirms once to let the trailing-stop contract move stops on your trading account (it can do nothing else). After that, no pop-ups."}{" "}
          Creating a stop-loss escrows the {params ? fmtUsdc(params.executionFee) : "keeper"} {sym} fee, as any stop does. The keeper moves the stop when it improves by at least 0.1%.
        </p>
      </div>
    </Sheet>
  );
}
