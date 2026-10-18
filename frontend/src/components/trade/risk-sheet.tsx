"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/components/providers";
import { Sheet } from "@/components/ui/sheet";
import type { PositionView } from "@/hooks/use-account-data";
import { useMarketData } from "@/hooks/use-market-data";
import { fmtPercent, fmtUsdc } from "@/lib/format";
import { valuePosition } from "@/lib/position";
import { RISK_TEXT, riskTone } from "@/lib/risk-tone";

const LIQUIDATION_SHARE = 0.9;

/** PnL of a position if its market moves by `move` (a fraction) from the current mark, the way the engine settles it. */
function shocked(pos: PositionView["position"], mark: number, move: number, maxProfitMultiple: number) {
  const entry = Number(pos.entryPrice) / 1e18;
  const size = Number(pos.size) / 1e6;
  const margin = Number(pos.margin) / 1e6;
  const price = mark * (1 + move);
  const raw = pos.isLong ? (size * (price - entry)) / entry : (size * (entry - price)) / entry;
  const liquidated = raw <= -margin * LIQUIDATION_SHARE;
  const pnl = liquidated ? -margin : Math.min(raw, margin * maxProfitMultiple);
  return { pnl, liquidated };
}

/**
 * The whole account's risk on one screen: exposure by market, margin at risk, the worst case, and a what-if slider
 * that moves every market by the same percentage and shows which positions survive.
 */
export function RiskSheet({ positions, onClose }: { positions: readonly PositionView[]; onClose: () => void }) {
  const { config: cfg } = useApp();
  const { prices, params, byId } = useMarketData();
  const [movePct, setMovePct] = useState(0);
  const sym = cfg.collateralSymbol;
  const multiple = Number(params?.maxProfitMultiple ?? 10n);

  const rows = useMemo(
    () =>
      positions.map((p) => {
        const id = p.position.priceId.toLowerCase();
        const markBig = prices.get(id)?.mark ?? null;
        const value = valuePosition(p, markBig, params?.maxProfitMultiple ?? 10n);
        const mark = markBig !== null ? Number(markBig) / 1e18 : null;
        const what = mark !== null ? shocked(p.position, mark, movePct / 100, multiple) : null;
        return { p, id, symbol: byId.get(id)?.symbol ?? "Position", value, what };
      }),
    [positions, prices, params?.maxProfitMultiple, byId, movePct, multiple],
  );

  const totals = useMemo(() => {
    let longSize = 0n;
    let shortSize = 0n;
    let margin = 0n;
    let pnlNow = 0n;
    let pnlWhat = 0;
    let liquidated = 0;
    for (const r of rows) {
      if (r.p.position.isLong) longSize += r.p.position.size;
      else shortSize += r.p.position.size;
      margin += r.p.position.margin;
      if (r.value.pnl !== null) pnlNow += r.value.pnl;
      if (r.what) {
        pnlWhat += r.what.pnl;
        if (r.what.liquidated) liquidated += 1;
      }
    }
    return { longSize, shortSize, margin, pnlNow, pnlWhat, liquidated };
  }, [rows]);

  return (
    <Sheet title="Account risk" description="Every open position, the worst case, and what a market move would do." onClose={onClose} wide testId="risk-sheet">
      {positions.length === 0 ? (
        <p className="text-sm text-muted">No open positions.</p>
      ) : (
        <div className="grid gap-4">
          <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <dt className="text-2xs text-muted">Margin at risk</dt>
              <dd className="num text-base">{fmtUsdc(totals.margin)}</dd>
            </div>
            <div>
              <dt className="text-2xs text-muted">Long exposure</dt>
              <dd className="num text-base text-long">{fmtUsdc(totals.longSize, 0)}</dd>
            </div>
            <div>
              <dt className="text-2xs text-muted">Short exposure</dt>
              <dd className="num text-base text-short">{fmtUsdc(totals.shortSize, 0)}</dd>
            </div>
            <div>
              <dt className="text-2xs text-muted">Open PnL</dt>
              <dd className={`num text-base ${totals.pnlNow >= 0n ? "text-long" : "text-short"}`}>{fmtUsdc(totals.pnlNow, 2, { sign: true })}</dd>
            </div>
          </dl>
          <p className="notice text-[0.8125rem]">
            Worst case: every position liquidated. You would lose <span className="num text-text">{fmtUsdc(totals.margin)} {sym}</span> of margin, never more.
          </p>

          <div>
            <div className="flex items-center justify-between">
              <label htmlFor="whatif" className="text-[0.8125rem] text-muted">
                What if every market moves
              </label>
              <span className={`num text-sm ${movePct > 0 ? "text-long" : movePct < 0 ? "text-short" : ""}`}>{movePct > 0 ? "+" : ""}{movePct.toFixed(movePct !== 0 && Math.abs(movePct) < 1 ? 2 : 1)}%</span>
            </div>
            <input
              id="whatif"
              type="range"
              className="slider mt-1"
              min={-100}
              max={100}
              step={1}
              value={Math.sign(movePct) * Math.round(Math.sqrt(Math.abs(movePct) / 20) * 100)}
              onChange={(event) => {
                // Square-root scale: fine steps near zero (1000x positions die at 0.09%), up to ±20% at the ends.
                const t = Number(event.target.value) / 100;
                setMovePct(Math.sign(t) * t * t * 20);
              }}
              aria-valuetext={`${movePct.toFixed(2)} percent`}
              data-testid="whatif-slider"
            />
            <div className="mt-1 flex flex-wrap gap-1.5">
              {[-5, -1, -0.1, 0, 0.1, 1, 5].map((m) => (
                <button key={m} type="button" className="chip" aria-pressed={movePct === m} onClick={() => setMovePct(m)}>
                  {m > 0 ? "+" : ""}
                  {m}%
                </button>
              ))}
            </div>
            <p className="mt-2 text-[0.8125rem]">
              PnL <span className={`num ${totals.pnlWhat >= 0 ? "text-long" : "text-short"}`}>{totals.pnlWhat >= 0 ? "+" : ""}{totals.pnlWhat.toFixed(2)} {sym}</span>
              {totals.liquidated > 0 ? <span className="text-short">, {totals.liquidated} liquidated</span> : <span className="text-muted">, nothing liquidated</span>}
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="data-table">
              <thead>
                <tr>
                  <th>Market</th>
                  <th className="r">Size</th>
                  <th className="r">Liquidation</th>
                  <th className="r">PnL now</th>
                  <th className="r">PnL if moved</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.p.key}>
                    <td>
                      <span className="wide">{r.symbol}</span>{" "}
                      <span className={`text-xs ${r.p.position.isLong ? "text-long" : "text-short"}`}>{r.p.position.isLong ? "Long" : "Short"}</span>{" "}
                      <span className="num text-xs text-faint">{r.value.leverage.toFixed(r.value.leverage < 10 ? 1 : 0)}x</span>
                    </td>
                    <td className="r num">{fmtUsdc(r.p.position.size, 0)}</td>
                    <td className={`r num ${RISK_TEXT[riskTone(r.value.liquidationDistance) ?? "calm"]}`}>
                      {r.value.liquidationDistance === null ? "None" : `${fmtPercent(Math.max(0, r.value.liquidationDistance), 2)} away`}
                    </td>
                    <td className={`r num ${r.value.pnl === null ? "" : r.value.pnl >= 0n ? "text-long" : "text-short"}`}>{r.value.pnl === null ? "—" : fmtUsdc(r.value.pnl, 2, { sign: true })}</td>
                    <td className={`r num ${!r.what ? "" : r.what.liquidated ? "text-short" : r.what.pnl >= 0 ? "text-long" : "text-short"}`}>
                      {!r.what ? "—" : r.what.liquidated ? "Liquidated" : `${r.what.pnl >= 0 ? "+" : ""}${r.what.pnl.toFixed(2)}`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-xs text-faint">Estimates from the mark price, ignoring funding still to accrue and close fees. Profit is capped at {multiple}x margin per position.</p>
        </div>
      )}
    </Sheet>
  );
}
