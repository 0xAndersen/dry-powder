"use client";

import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { AppLink } from "@/components/app-link";
import { useApp } from "@/components/providers";
import { InstantTradingSheet } from "@/components/instant-trading";
import { SettingsSheet } from "@/components/settings-sheet";
import { ModeChooser } from "@/components/simple/mode-chooser";
import { ModeSwitch } from "@/components/simple/mode-switch";
import { PositionCard } from "@/components/simple/position-card";
import { TradeSheet } from "@/components/simple/trade-sheet";
import { ShareSheet } from "@/components/social/share-sheet";
import { TxStatus } from "@/components/tx-status";
import { Sheet } from "@/components/ui/sheet";
import { Sparkline } from "@/components/ui/sparkline";
import { WalletButton } from "@/components/wallet-button";
import { useAccountData } from "@/hooks/use-account-data";
import { useTradeContext } from "@/hooks/use-action-context";
import { useDayStatsMany } from "@/hooks/use-day-stats";
import { useLocalStore } from "@/hooks/use-local-store";
import { useLogFeed } from "@/hooks/use-log-feed";
import { useChainNow, useMarketData } from "@/hooks/use-market-data";
import { useRiskLimits } from "@/hooks/use-risk-limits";
import { useTradingAccount } from "@/hooks/use-trading-account";
import { useTx } from "@/hooks/use-tx";
import { useAccountView } from "@/hooks/use-wallet";
import { TEST_MINT_AMOUNT, submitTestMint } from "@/lib/actions";
import { UserFacingError } from "@/lib/errors";
import { closeFlow } from "@/lib/flows";
import { fmtBps, fmtNum, fmtUsdc, shortAddress } from "@/lib/format";
import { findBySlug, isExpired, isSettled, marketSlug, type Instrument } from "@/lib/instruments";
import { valuePosition } from "@/lib/position";
import type { TradeCard } from "@/lib/share-card";
import { openPositionCard, profileLink, shareText } from "@/lib/share-data";
import { SIMPLE_CATEGORIES, simpleCategory, simpleName, type SimpleCategory } from "@/lib/simple";
import { follows, nicknameOf } from "@/lib/social";
import { tradeSettings } from "@/lib/storage";
import { toast } from "@/lib/toasts";
import { uiMode } from "@/lib/ui-mode";

function Wordmark() {
  return (
    <AppLink route="simple" className="flex shrink-0 items-center gap-2" aria-label="Dry Powder, simple mode home">
      <svg width="24" height="24" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="2.75" y="2.75" width="18.5" height="18.5" rx="5" fill="none" stroke="var(--color-text)" strokeWidth="1.75" />
        <rect x="6.5" y="12.25" width="11" height="5.25" rx="1.5" fill="var(--color-accent)" />
        <path d="M6.5 9.25h11" stroke="var(--color-text)" strokeWidth="1.25" strokeLinecap="round" strokeDasharray="1.5 2.25" opacity="0.55" />
      </svg>
      <span className="s-name hidden text-[1.0625rem] sm:inline">Dry Powder</span>
    </AppLink>
  );
}

/**
 * Simple mode: every market as a tile, your open trades as cards, and one sheet per market to go up or down.
 * Plain words throughout; the terminal (Advanced) is one tap away for everything else.
 */
export function SimpleScreen() {
  const { config: cfg } = useApp();
  const { instruments, prices, params, loading, error } = useMarketData();
  const searchParams = useSearchParams();
  const chainNow = useChainNow(5_000);
  const view = useAccountView();
  const trading = useTradingAccount();
  const account = useAccountData(view.address);
  const feed = useLogFeed({ enabled: view.address !== undefined, trader: view.address, lookbackSeconds: 6 * 3_600 });
  const lossLimit = useRiskLimits(feed, chainNow);
  const actionContext = useTradeContext();
  const tx = useTx({ autoDismissMs: 12_000 });
  const [settings] = useLocalStore(tradeSettings);
  const [followList] = useLocalStore(follows);
  const [mode] = useLocalStore(uiMode);
  const sym = cfg.collateralSymbol;

  const [category, setCategory] = useState<SimpleCategory | "all">("all");
  const [open, setOpen] = useState<Instrument | null>(null);
  const [panel, setPanel] = useState<null | "account" | "instant" | "settings">(null);
  const [share, setShare] = useState<TradeCard | null>(null);

  // ?m=BTC-USD opens that market's sheet (links from elsewhere, the share card).
  const wanted = searchParams.get("m");
  useEffect(() => {
    if (!wanted || open) return;
    const hit = findBySlug(instruments, wanted);
    if (hit) setOpen(hit);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wanted, instruments]);

  const tradable = useMemo(() => instruments.filter((i) => !isSettled(i) && !isExpired(i, chainNow)), [instruments, chainNow]);
  const days = useDayStatsMany(tradable, (id) => prices.get(id)?.display ?? null);
  const shown = category === "all" ? tradable : tradable.filter((i) => simpleCategory(i) === category);
  const categories = SIMPLE_CATEGORIES.filter((c) => c.key === "all" || tradable.some((i) => simpleCategory(i) === c.key));

  const byId = useMemo(() => new Map<string, Instrument>(instruments.map((i) => [i.id, i])), [instruments]);
  const positions = account.data?.positions ?? [];
  const balance = account.data?.balance;

  const cashOut = (positionKey: string, half: boolean) => {
    const p = positions.find((x) => x.key === positionKey);
    if (!p || !params) return;
    const instrument = byId.get(p.position.priceId.toLowerCase());
    if (!instrument) return;
    void tx.run(async (api) => {
      const ctx = actionContext(api);
      if (!ctx) throw new UserFacingError("Sign in first.");
      await closeFlow(ctx, {
        instrument,
        view: p,
        reference: prices.get(instrument.id)?.reference ?? null,
        slippageBps: settings.slippageBps,
        executionFee: params.executionFee,
        balance,
        size: half ? p.position.size / 2n : undefined,
      });
      return half ? `Cashing out half of ${simpleName(instrument)}.` : `Cashing out ${simpleName(instrument)}. A keeper closes it at the next price.`;
    });
  };

  const getPractice = () => {
    void tx.run(async (api) => {
      const ctx = actionContext(api);
      if (!ctx) throw new UserFacingError("Sign in first.");
      await submitTestMint(ctx, `Get ${fmtUsdc(TEST_MINT_AMOUNT, 0)} practice ${sym}`);
      return `${fmtUsdc(TEST_MINT_AMOUNT, 0)} practice ${sym} added.`;
    });
  };

  return (
    <div className="min-h-dvh pb-16" data-testid="simple">
      <header className="sticky top-0 z-30 border-b border-line bg-bg/90 backdrop-blur" style={{ paddingTop: "env(safe-area-inset-top)" }}>
        <div className="mx-auto flex h-14 max-w-[1080px] items-center justify-between gap-3 px-4">
          <Wordmark />
          <div className="flex min-w-0 items-center gap-2">
            {view.canTrade && balance !== undefined ? (
              <button type="button" className="s-num hidden h-9 items-center rounded-full border border-line bg-panel px-3 text-sm sm:inline-flex" onClick={() => setPanel("account")} data-testid="simple-balance">
                {fmtUsdc(balance)} {sym}
              </button>
            ) : null}
            <ModeSwitch current="simple" />
            <WalletButton />
          </div>
        </div>
      </header>

      <div className="mx-auto max-w-[1080px] px-4">
        <section className="pb-4 pt-7 sm:pt-10" aria-labelledby="simple-title">
          <h1 id="simple-title" className="s-display text-[2.5rem] sm:text-[3.5rem]">
            Up or down?
          </h1>
          <p className="mt-2 max-w-[46ch] text-[0.9375rem] text-muted">
            Pick a market, choose how much to put in, and see exactly what you can win or lose before you trade.
          </p>
          {view.canTrade && balance !== undefined ? (
            <div className="mt-4 flex flex-wrap items-center gap-2 sm:hidden">
              <button type="button" className="s-num h-9 rounded-full border border-line bg-panel px-3 text-sm" onClick={() => setPanel("account")}>
                {fmtUsdc(balance)} {sym}
              </button>
            </div>
          ) : null}
          {view.canTrade && balance === 0n && positions.length === 0 && cfg.collateralIsTest ? (
            <button type="button" className="mt-4 h-11 rounded-full bg-text px-5 text-sm font-semibold text-panel" onClick={getPractice} disabled={tx.busy} data-testid="simple-hero-practice">
              Get {fmtUsdc(TEST_MINT_AMOUNT, 0)} practice {sym}
            </button>
          ) : null}
          {tx.state.phase !== "idle" ? <TxStatus state={tx.state} onDismiss={tx.reset} className="mt-4" /> : null}
        </section>

        {positions.length > 0 ? (
          <section className="pb-6" aria-labelledby="simple-positions">
            <h2 id="simple-positions" className="s-name mb-3 text-[1.25rem]">
              Your trades
            </h2>
            <div className="-mx-4 flex snap-x gap-3 overflow-x-auto px-4 pb-1 sm:mx-0 sm:grid sm:grid-cols-2 sm:overflow-visible sm:px-0 lg:grid-cols-3">
              {positions.map((p) => {
                const instrument = byId.get(p.position.priceId.toLowerCase());
                const price = instrument ? prices.get(instrument.id) : undefined;
                const value = valuePosition(p, price?.mark ?? null, params?.maxProfitMultiple ?? 10n);
                return (
                  <div key={p.key} className="snap-start">
                    <PositionCard
                      view={p}
                      value={value}
                      instrument={instrument}
                      price={price}
                      sym={sym}
                      shareBps={params?.profitShareBps ?? null}
                      busy={tx.busy}
                      canTrade={view.canTrade}
                      onCashOut={() => cashOut(p.key, false)}
                      onCashOutHalf={() => cashOut(p.key, true)}
                      onShare={() =>
                        view.address &&
                        setShare(
                          openPositionCard(p, value, price?.mark ?? null, chainNow, {
                            market: (id) => byId.get(id.toLowerCase()),
                            unit: sym,
                            chainId: cfg.chainId,
                            trader: nicknameOf(followList, view.address) ?? shortAddress(view.address),
                            href: window.location.href,
                          }),
                        )
                      }
                    />
                  </div>
                );
              })}
            </div>
          </section>
        ) : null}

        <section aria-labelledby="simple-markets">
          <h2 id="simple-markets" className="sr-only">
            Markets
          </h2>
          <div className="-mx-4 flex gap-2 overflow-x-auto px-4 pb-3 sm:mx-0 sm:flex-wrap sm:px-0" role="group" aria-label="Show">
            {categories.map((c) => (
              <button key={c.key} type="button" className="s-chip" aria-pressed={category === c.key} onClick={() => setCategory(c.key)}>
                {c.label}
              </button>
            ))}
          </div>
          {category === "turbo" && shown.length > 0 ? (
            <p className="mb-3 max-w-[62ch] text-[0.8125rem] text-muted" data-testid="simple-turbo-note">
              <span className="font-semibold text-text">Turbo</span> markets go up to {Math.max(...shown.filter((i) => i.upside).map((i) => i.maxLeverage), 0)}x with no trading fee unless you
              win; then the house keeps {params?.profitShareBps !== null && params?.profitShareBps !== undefined ? fmtBps(params.profitShareBps) : "a share"} of the profit. Keepers fill
              every Turbo order at the mid price for {params ? `${fmtUsdc(params.executionFee)} ${sym}` : "a small fee"}.
            </p>
          ) : null}
          {error && instruments.length === 0 ? (
            <p className="rounded-[14px] border border-line bg-panel px-4 py-10 text-center text-muted">Can&rsquo;t reach the venue right now. Retrying.</p>
          ) : loading && instruments.length === 0 ? (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
              {Array.from({ length: 8 }, (_, n) => (
                <div key={n} className="s-tile h-[9.5rem] animate-pulse" aria-hidden="true" />
              ))}
            </div>
          ) : (
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" data-testid="simple-tiles">
              {shown.map((i) => {
                const price = prices.get(i.id);
                const day = days.get(i.id);
                const change = day?.change ?? null;
                const live = price?.status === "live" || price?.status === "awaiting";
                return (
                  <button key={i.id} type="button" className="s-tile" onClick={() => setOpen(i)} data-testid={`simple-tile-${marketSlug(i)}`}>
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="s-name truncate text-[0.9375rem]">{simpleName(i)}</span>
                      <span className={`s-num shrink-0 text-2xs ${i.upside ? "s-turbo" : "text-muted"}`}>{i.maxLeverage}x</span>
                    </span>
                    {(() => {
                      const text = price?.display !== null && price?.display !== undefined ? fmtNum(price.display, i.priceDecimals) : "—";
                      return <span className={`s-display truncate ${text.length > 9 ? "text-[1.125rem] sm:text-[1.375rem]" : "text-[1.375rem] sm:text-[1.625rem]"}`}>{text}</span>;
                    })()}
                    <span className={`s-num text-xs ${!live ? "text-muted" : change === null ? "text-muted" : change >= 0 ? "text-long" : "text-short"}`}>
                      {!live ? "Closed now" : change === null ? "Today: —" : `${change >= 0 ? "+" : "−"}${Math.abs(change * 100).toFixed(2)}% today`}
                    </span>
                    <Sparkline values={day?.closes ?? null} width={210} height={30} tone={change === null ? "flat" : change >= 0 ? "up" : "down"} className="mt-1 max-w-full" />
                  </button>
                );
              })}
            </div>
          )}
          <p className="mt-6 text-center text-xs text-muted">
            Practice money on Arc Testnet. Want order types, charts and agents?{" "}
            <AppLink route="trade" className="underline underline-offset-2 hover:text-text">
              Open Advanced
            </AppLink>
            .
          </p>
        </section>
      </div>

      {open ? (
        <TradeSheet
          instrument={open}
          lossLimit={lossLimit}
          onClose={() => setOpen(null)}
          onPlaced={(message) => {
            setOpen(null);
            toast("ok", message);
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
          onSetUpInstant={() => setPanel("instant")}
        />
      ) : null}
      {panel === "instant" ? <InstantTradingSheet onClose={() => setPanel(null)} /> : null}
      {panel === "settings" ? <SettingsSheet onClose={() => setPanel(null)} /> : null}
      {panel === "account" ? (
        <Sheet title="Your money" onClose={() => setPanel(null)} testId="simple-account">
          <div className="flex flex-col gap-4">
            <p className="s-display text-[2.25rem]">
              {balance !== undefined ? fmtUsdc(balance) : "—"} <span className="text-base font-medium text-muted">{sym}</span>
            </p>
            <p className="text-sm text-muted">
              {view.instant
                ? "In your trading account. Trades go out without a wallet pop-up."
                : "In your wallet. Each trade asks your wallet to confirm."}
              {cfg.collateralIsTest ? " This is practice money on Arc Testnet." : ""}
            </p>
            <div className="grid gap-2">
              {cfg.collateralIsTest ? (
                <button type="button" className="s-choice" onClick={getPractice} disabled={tx.busy || !view.canTrade}>
                  Get {fmtUsdc(TEST_MINT_AMOUNT, 0)} practice {sym}
                </button>
              ) : null}
              {trading.supported ? (
                <button type="button" className="s-choice" onClick={() => setPanel("instant")}>
                  {view.instant ? "One-tap trading: on (manage)" : "Turn on one-tap trading"}
                </button>
              ) : null}
              <button type="button" className="s-choice" onClick={() => setPanel("settings")}>
                Limits and alerts
              </button>
              <AppLink route="portfolio" className="s-choice flex items-center justify-center">
                History and results
              </AppLink>
            </div>
            {tx.state.phase !== "idle" ? <TxStatus state={tx.state} onDismiss={tx.reset} /> : null}
          </div>
        </Sheet>
      ) : null}
      {share && view.address ? <ShareSheet card={share} title="Share this trade" text={shareText(share)} link={profileLink(view.address)} onClose={() => setShare(null)} /> : null}
      {mode === null ? <ModeChooser /> : null}
    </div>
  );
}
