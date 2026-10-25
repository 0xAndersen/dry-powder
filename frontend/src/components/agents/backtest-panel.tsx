"use client";

import { useState } from "react";
import type { BtFees, BtResult, BtTrade } from "@/lib/backtest";
import { fmtNum, fmtPercent } from "@/lib/format";
import { bpsText } from "@/lib/strategies";
import { BacktestChart, fmtWhen } from "./backtest-chart";

const EXIT_WORDS: Record<BtTrade["exit"], string> = {
  signal: "Signal",
  stop: "Stop-loss",
  target: "Take-profit",
  liquidation: "Liquidated",
  open: "Still open",
};

const money = (v: number) => `${v > 0.004 ? "+" : v < -0.004 ? "−" : ""}${fmtNum(Math.abs(v), 2)}`;
const toneOf = (v: number) => (v > 0.004 ? "text-long" : v < -0.004 ? "text-short" : "");
/** "45 minutes", "12 hours", "7.5 days". */
const windowText = (s: number) => (s < 7_200 ? `${Math.round(s / 60)} minutes` : s < 172_800 ? `${Math.round(s / 3_600)} hours` : `${Math.round((s / 86_400) * 10) / 10} days`);

function Figure({ label, children, sub, testId }: { label: string; children: React.ReactNode; sub?: React.ReactNode; testId?: string }) {
  return (
    <div className="min-w-0 bg-panel px-3 py-2" data-testid={testId}>
      <dt className="text-2xs text-faint">{label}</dt>
      <dd className="num mt-0.5 truncate text-[0.9375rem] font-semibold leading-tight">{children}</dd>
      {sub ? <dd className="num truncate text-2xs text-faint">{sub}</dd> : null}
    </div>
  );
}

/** The replay of a trend or mean-reversion draft: chart, figures, trades, and what the figures leave out. */
export function BacktestPanel({
  result,
  fees,
  kind,
  bandBps,
  margin,
  priceDecimals,
  candleLabel,
  sym,
  loading,
  error,
}: {
  result: BtResult | null;
  fees: BtFees;
  kind: "trend" | "meanRevert";
  bandBps: number;
  margin: number;
  priceDecimals: number;
  candleLabel: string;
  sym: string;
  loading: boolean;
  error: string | null;
}) {
  const [allTrades, setAllTrades] = useState(false);
  if (error) return <p className="px-4 py-10 text-center text-[0.8125rem] text-muted">{error}</p>;
  if (loading || !result) return <p className="px-4 py-10 text-center text-[0.8125rem] text-muted">Loading recent candles…</p>;

  const closed = result.trades.filter((t) => t.exit !== "open");
  const open = result.trades.find((t) => t.exit === "open");
  const shown = [...result.trades].reverse().slice(0, allTrades ? undefined : 6);
  const span = Math.max(0, result.to - result.from);

  return (
    <div className="flex flex-col" data-testid="backtest">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 px-4 pt-3">
        <h3 className="panel-title">How it would have done</h3>
        <p className="text-2xs text-faint">
          Hypothetical: the last {windowText(span)} of {candleLabel} candles, {result.readings} readings
        </p>
      </div>
      {result.tooShort ? (
        <div className="notice mx-4 mt-2 text-xs" data-tone="warn" role="status">
          Not enough history for a signal: the strategy waits for {result.warmup} readings and these candles give {result.readings}. Read the price more
          often or use shorter averages.
        </div>
      ) : null}
      <div className="px-4 pt-2">
        <BacktestChart result={result} kind={kind} bandBps={bandBps} priceDecimals={priceDecimals} sym={sym} />
        <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-2xs text-faint" aria-hidden="true">
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-3 bg-muted" />
            Price
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-0.5 w-3 bg-accent" />
            {kind === "trend" ? "Fast average" : "Average"}
          </span>
          {kind === "trend" ? (
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block h-0.5 w-3 bg-warn" />
              Slow average
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5">
              <span className="inline-block w-3 border-t border-dashed border-faint" />
              Entry bands
            </span>
          )}
          <span className="inline-flex items-center gap-1.5">
            <span className="inline-block h-1.5 w-3 rounded-[1px] bg-long/75" />
            <span className="inline-block h-1.5 w-3 rounded-[1px] bg-short/75" />
            Held long, short
          </span>
          <span>Lower line: running result</span>
        </div>
      </div>

      <dl className="mx-4 mt-3 grid grid-cols-2 gap-px overflow-hidden rounded-[6px] border border-line bg-line sm:grid-cols-3 2xl:grid-cols-6">
        <Figure label="Result" sub={margin > 0 ? `${fmtPercent(result.net / margin, 0, true)} of one margin` : undefined} testId="bt-net">
          <span className={toneOf(result.net)}>
            {money(result.net)} <span className="text-2xs font-normal text-muted">{sym}</span>
          </span>
        </Figure>
        <Figure label="Largest drawdown" sub={margin > 0 ? `${fmtNum(result.maxDrawdown / margin, 2)}× one margin` : undefined}>
          {result.maxDrawdown > 0.004 ? `−${fmtNum(result.maxDrawdown, 2)}` : "0.00"}
        </Figure>
        <Figure label="Trades" sub={`${result.wins} won, ${result.losses} lost${open ? ", 1 open" : ""}`} testId="bt-trades">
          {closed.length}
        </Figure>
        <Figure label="Liquidations">
          <span className={result.liquidations > 0 ? "text-short" : ""}>{result.liquidations}</span>
        </Figure>
        <Figure label="Fees" sub={fees.mode === "upside" ? "keeper + profit share" : "fees + keeper"}>
          {fmtNum(result.fees, 2)}
        </Figure>
        <Figure label="In the market">{fmtPercent(result.exposure, 0)}</Figure>
      </dl>

      {result.trades.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
          <table className="data-table text-xs">
            <thead>
              <tr>
                <th>Side</th>
                <th>Opened</th>
                <th className="r">Entry</th>
                <th className="r">Exit</th>
                <th>How it ended</th>
                <th className="r">Result ({sym})</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((t, i) => (
                <tr key={`${t.entryTime}-${i}`}>
                  <td className={t.side === "long" ? "text-long" : "text-short"}>{t.side === "long" ? "Long" : "Short"}</td>
                  <td className="num text-muted">{fmtWhen(t.entryTime)}</td>
                  <td className="r num">{fmtNum(t.entryPrice, priceDecimals)}</td>
                  <td className="r num">{fmtNum(t.exitPrice, priceDecimals)}</td>
                  <td className={t.exit === "liquidation" ? "text-short" : t.exit === "open" ? "text-faint" : "text-muted"}>{EXIT_WORDS[t.exit]}</td>
                  <td className={`r num ${toneOf(t.net)}`}>{money(t.net)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {result.trades.length > 6 ? (
            <button type="button" className="link mx-4 mt-1 text-xs" onClick={() => setAllTrades((v) => !v)}>
              {allTrades ? "Show the last 6" : `Show all ${result.trades.length} trades`}
            </button>
          ) : null}
        </div>
      ) : !result.tooShort ? (
        <p className="mx-4 mt-3 text-xs text-muted">No trades: the signal never crossed its band in this window.</p>
      ) : null}

      <p className="mx-4 mb-3 mt-3 text-2xs leading-relaxed text-faint">
        {fees.mode === "upside"
          ? `Upside market: no fee to open or close and fills at the mid; the house keeps ${bpsText(fees.profitShareBps)} of a winning trade's profit.`
          : `Fees as on this market: ${bpsText(fees.baseFeeBps)} of size on each side (at most ${bpsText(fees.feeCapBps)} of margin), plus the spread (${bpsText(Math.round(fees.spreadBps))} now).`}{" "}
        Each order the keeper fills costs {fmtNum(fees.executionFee, 2)} {sym}. Fills at candle closes; liquidation at a 90% loss of margin, profit capped at {fees.maxProfitMultiple}×
        margin; funding and price jumps between readings are left out. A preview of how the rules behave, not a forecast.
      </p>
    </div>
  );
}
