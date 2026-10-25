"use client";

import { Fuse } from "@/components/simple/fuse";
import type { PositionView } from "@/hooks/use-account-data";
import type { MarketPrice } from "@/hooks/use-market-data";
import { fmtUsdc } from "@/lib/format";
import type { Instrument } from "@/lib/instruments";
import { absDiff, ratio } from "@/lib/math";
import type { PositionValue } from "@/lib/position";
import { movePct, simpleName, simpleSubject } from "@/lib/simple";

/** One open trade, in Simple mode's words: which way, what it is worth now, how much fuse is left, cash out. */
export function PositionCard({
  view,
  value,
  instrument,
  price,
  sym,
  busy,
  canTrade,
  onCashOut,
  onCashOutHalf,
  onShare,
}: {
  view: PositionView;
  value: PositionValue;
  instrument: Instrument | undefined;
  price: MarketPrice | undefined;
  sym: string;
  busy: boolean;
  canTrade: boolean;
  onCashOut: () => void;
  onCashOutHalf: () => void;
  onShare: () => void;
}) {
  const pos = view.position;
  const up = pos.isLong;
  const name = instrument ? simpleName(instrument) : "Market";
  const subject = instrument ? simpleSubject(instrument) : "The price";
  const pnl = value.pnl;
  const worth = pnl !== null ? pos.margin + pnl : null;
  const closing = pos.closeOrderId !== 0n;
  // How far the price could move against the trade at entry, and how far it can now.
  const full = value.liquidationPrice !== null && pos.entryPrice > 0n ? ratio(absDiff(pos.entryPrice, value.liquidationPrice), pos.entryPrice) : null;
  const left = value.liquidationDistance;
  const fuseText =
    value.liquidatableNow
      ? "This trade is closing on its own"
      : left === null
        ? "This trade cannot close on its own"
        : `${subject} can ${up ? "fall" : "rise"} ${movePct(Math.max(0, left))} more before this closes on its own`;
  const tone = pnl === null || pnl === 0n ? "text-text" : pnl > 0n ? "text-long" : "text-short";
  return (
    <article className="flex min-w-[17.5rem] flex-col gap-3 rounded-[18px] border border-line bg-panel p-4" data-testid={`simple-position-${instrument?.symbol ?? "unknown"}`}>
      <header className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="s-name truncate text-[1.0625rem]">{name}</p>
          <p className="text-xs text-muted">
            <span className={up ? "text-long" : "text-short"}>{up ? "Up" : "Down"}</span> at {value.leverage >= 10 ? value.leverage.toFixed(0) : value.leverage.toFixed(1)}x with {fmtUsdc(pos.margin)} {sym}
          </p>
        </div>
        <button type="button" className="text-xs text-muted underline-offset-2 hover:text-text hover:underline" onClick={onShare} disabled={pnl === null}>
          Share
        </button>
      </header>
      <div>
        <p className={`s-display text-[2rem] ${tone}`} data-testid="simple-pnl">
          {pnl === null ? "—" : `${pnl >= 0n ? "+" : "−"}${fmtUsdc(pnl < 0n ? -pnl : pnl)}`}
        </p>
        <p className="s-num text-sm text-muted">
          {value.roe !== null ? `${value.roe >= 0 ? "+" : "−"}${Math.abs(value.roe * 100).toFixed(1)}%` : ""}
          {worth !== null ? `, worth ${fmtUsdc(worth > 0n ? worth : 0n)} ${sym} now` : ""}
          {value.capped ? ", at the 10x win limit" : ""}
        </p>
      </div>
      <div>
        <Fuse distance={left === null ? null : Math.max(0, left)} entryDistance={full} label={fuseText} compact />
        <p className="mt-1 text-xs text-muted">{fuseText}.</p>
      </div>
      {canTrade ? (
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <button
            type="button"
            className="h-11 rounded-[12px] bg-text text-[0.9375rem] font-semibold text-panel disabled:opacity-50"
            disabled={busy || closing || price?.reference === null}
            onClick={onCashOut}
            data-testid="simple-cash-out"
          >
            {closing ? "Cashing out…" : worth !== null ? `Cash out ${fmtUsdc(worth > 0n ? worth : 0n)}` : "Cash out"}
          </button>
          <button type="button" className="s-choice h-11 px-3 text-sm" disabled={busy || closing} onClick={onCashOutHalf} data-testid="simple-cash-out-half">
            Half
          </button>
        </div>
      ) : null}
    </article>
  );
}
