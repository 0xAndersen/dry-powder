"use client";

import { ArcGauge } from "@/components/arc-gauge";
import { useDayReference, type MarketState } from "@/hooks/use-engine";
import { usePriceState } from "@/hooks/use-prices";
import { fmtAge, fmtCompact, fmtPercent, fmtPrice, USDC_DECIMALS } from "@/lib/format";
import { MARKETS, type MarketInfo } from "@/lib/markets";
import { ratio } from "@/lib/math";

function useDayChange(market: MarketInfo, mid: number | undefined): number | null {
  const reference = useDayReference(market);
  if (mid === undefined || !reference.data) return null;
  return mid / reference.data - 1;
}

function MarketTab({ market, selected, onSelect }: { market: MarketInfo; selected: boolean; onSelect: () => void }) {
  const { tick, stale } = usePriceState(market.id);
  const change = useDayChange(market, tick?.midNum);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={`flex min-w-[8.5rem] flex-1 flex-col items-start gap-0.5 border-b-2 px-3 py-2.5 text-left transition-colors sm:px-4 ${
        selected ? "border-brass bg-raised/60" : "border-transparent hover:bg-raised/30"
      }`}
    >
      <span className="flex w-full items-center justify-between gap-2">
        <span className={`wide text-[0.8125rem] font-semibold ${selected ? "text-text" : "text-muted"}`}>{market.symbol}</span>
        {stale ? (
          <span className="text-2xs text-warn">Closed</span>
        ) : change !== null ? (
          <span className={`num text-2xs ${change >= 0 ? "text-long" : "text-short"}`}>{fmtPercent(change, 2, true)}</span>
        ) : null}
      </span>
      <span className={`num text-sm ${stale ? "text-muted" : "text-text"}`}>
        {tick ? fmtPrice(tick.mid, market.priceDecimals) : <span className="skeleton" />}
      </span>
    </button>
  );
}

function Stat({ label, children, hint }: { label: string; children: React.ReactNode; hint?: string }) {
  return (
    <div className="min-w-0" title={hint}>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="num mt-0.5 text-sm">{children}</dd>
    </div>
  );
}

export function MarketBar({
  market,
  state,
  loading,
  onSelect,
}: {
  market: MarketInfo;
  state: MarketState | undefined;
  loading: boolean;
  onSelect: (market: MarketInfo) => void;
}) {
  const { tick, age, stale } = usePriceState(market.id);
  const change = useDayChange(market, tick?.midNum);

  const fundingPerHour = state ? (Number(state.fundingRate) * 3600) / 1e18 : null;
  const totalOi = state ? state.longOi + state.shortOi : 0n;
  const longShare = state && totalOi > 0n ? ratio(state.longOi, totalOi) : null;
  const pending = loading && !state;

  return (
    <section className="panel" aria-label="Markets">
      <div role="tablist" aria-label="Market" className="flex overflow-x-auto border-b border-line">
        {MARKETS.map((m) => (
          <MarketTab key={m.id} market={m} selected={m.id === market.id} onSelect={() => onSelect(m)} />
        ))}
      </div>

      <div className="flex flex-wrap items-center gap-x-8 gap-y-3 px-3 py-3 sm:px-4">
        <div className="w-full min-w-[11rem] sm:w-auto">
          <p className="text-xs text-muted">
            {market.name} {market.invert ? "(inverse of Pyth USD/JPY)" : ""}
          </p>
          <p className={`num text-[1.75rem] font-semibold leading-tight ${stale ? "text-muted" : "text-text"}`} aria-live="off">
            {tick ? fmtPrice(tick.mid, market.priceDecimals) : <span className="skeleton w-32" />}
          </p>
          {stale && age !== undefined ? (
            <p className="text-xs text-warn">Market closed: last price is {fmtAge(age)} old</p>
          ) : tick ? (
            <p className="num text-xs text-faint">
              Bid {fmtPrice(tick.bid, market.priceDecimals)} / Ask {fmtPrice(tick.ask, market.priceDecimals)}
            </p>
          ) : (
            <p className="text-xs text-faint">Waiting for Pyth</p>
          )}
        </div>

        <dl className="grid w-full grid-cols-[auto_1fr_auto] gap-x-5 gap-y-3 sm:flex sm:w-auto sm:gap-x-8">
          <Stat label="24h change">
            {change !== null ? (
              <span className={change >= 0 ? "text-long" : "text-short"}>{fmtPercent(change, 2, true)}</span>
            ) : (
              "—"
            )}
          </Stat>
          <Stat
            label="Funding / hour"
            hint="Share of position size paid each hour. Positive: longs pay shorts. Negative: shorts pay longs."
          >
            {pending ? (
              <span className="skeleton" />
            ) : fundingPerHour === null || !state?.listed ? (
              "—"
            ) : (
              <>
                <span className={fundingPerHour > 0 ? "text-short" : fundingPerHour < 0 ? "text-long" : ""}>
                  {fmtPercent(fundingPerHour, 4, true)}
                </span>
                <span className="block text-xs text-faint sm:ml-1.5 sm:inline">
                  {fundingPerHour > 0 ? "longs pay" : fundingPerHour < 0 ? "shorts pay" : "balanced"}
                </span>
              </>
            )}
          </Stat>
          <Stat label="Max leverage">{pending ? <span className="skeleton" /> : state?.listed ? `${state.maxLeverage}×` : "—"}</Stat>
        </dl>

        <div className="flex items-center gap-4 sm:ml-auto">
          <ArcGauge
            fraction={longShare}
            leftColor="var(--color-long)"
            rightColor="var(--color-short)"
            width={92}
            stroke={7}
            label={
              longShare === null
                ? "No open interest"
                : `Open interest is ${fmtPercent(longShare, 0)} long and ${fmtPercent(1 - longShare, 0)} short`
            }
          >
            <span className="num text-xs text-muted">{longShare === null ? "No OI" : `${fmtPercent(longShare, 0)} long`}</span>
          </ArcGauge>
          <dl className="grid gap-1.5">
            <div className="flex items-baseline gap-2">
              <dt className="w-[4.5rem] text-xs text-muted">Long OI</dt>
              <dd className="num text-sm text-long">
                {pending ? <span className="skeleton" /> : state ? fmtCompact(state.longOi, USDC_DECIMALS) : "—"}
              </dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="w-[4.5rem] text-xs text-muted">Short OI</dt>
              <dd className="num text-sm text-short">
                {pending ? <span className="skeleton" /> : state ? fmtCompact(state.shortOi, USDC_DECIMALS) : "—"}
              </dd>
            </div>
            <div className="flex items-baseline gap-2">
              <dt className="w-[4.5rem] text-xs text-muted">Cap / side</dt>
              <dd className="num text-xs text-faint">
                {state?.listed ? `${fmtCompact(state.maxOiPerSide, USDC_DECIMALS)} USDC` : "—"}
              </dd>
            </div>
          </dl>
        </div>
      </div>
    </section>
  );
}
