"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useBlockNumber } from "wagmi";
import { getAddress, isAddress } from "viem";
import { AppLink } from "@/components/app-link";
import { useApp } from "@/components/providers";
import { HelpButton } from "@/components/help-sheet";
import { StatusSheet } from "@/components/status-sheet";
import { SettingsButton } from "@/components/settings-sheet";
import { ModeSwitch } from "@/components/simple/mode-switch";
import { WalletButton } from "@/components/wallet-button";
import { useKeeperStatus } from "@/hooks/use-keeper-status";
import { useMarketData } from "@/hooks/use-market-data";
import { useAccountView } from "@/hooks/use-wallet";
import { shortAddress } from "@/lib/format";
import { currentRoute, type Route } from "@/lib/nav";

const NAV: readonly { route: Route; label: string }[] = [
  { route: "trade", label: "Trade" },
  { route: "markets", label: "Markets" },
  { route: "portfolio", label: "Portfolio" },
  { route: "activity", label: "Activity" },
  { route: "leaderboard", label: "Leaderboard" },
  { route: "house", label: "House" },
  { route: "agents", label: "Agents" },
];

function Wordmark() {
  return (
    <AppLink route="trade" className="flex shrink-0 items-center gap-2 whitespace-nowrap" aria-label="Dry Powder, go to trading">
      {/* The reserve: a vessel held part full. Capital kept back is what lets you take the next trade. */}
      <svg width="22" height="22" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="2.75" y="2.75" width="18.5" height="18.5" rx="5" fill="none" stroke="var(--color-text)" strokeWidth="1.75" />
        <rect x="6.5" y="12.25" width="11" height="5.25" rx="1.5" fill="var(--color-accent)" />
        <path d="M6.5 9.25h11" stroke="var(--color-text)" strokeWidth="1.25" strokeLinecap="round" strokeDasharray="1.5 2.25" opacity="0.55" />
      </svg>
      <span className="wide text-[1.0625rem] leading-none lg:hidden xl:inline">Dry Powder</span>
    </AppLink>
  );
}

function StatusDot({ tone }: { tone: "ok" | "warn" | "bad" | "idle" }) {
  const color = tone === "ok" ? "bg-long" : tone === "warn" ? "bg-warn" : tone === "bad" ? "bg-short" : "bg-faint";
  return <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} />;
}

function NetworkStatus() {
  const { chain, config } = useApp();
  const { feedStatus } = useMarketData();
  const block = useBlockNumber({ chainId: chain.id, query: { refetchInterval: 3_000 } });

  const chainTone = block.isError ? "bad" : block.data !== undefined ? "ok" : "idle";
  const chainText = block.isError
    ? "RPC unreachable"
    : block.data !== undefined
      ? `Block ${block.data.toLocaleString("en-US")}`
      : "Connecting";

  const source = config.oracleMode === "publisher" ? "Kraken tape" : "Pyth";
  const feedTone = feedStatus === "live" ? "ok" : feedStatus === "polling" ? "warn" : feedStatus === "offline" ? "bad" : "idle";
  const feedText =
    feedStatus === "live" ? `${source} live` : feedStatus === "polling" ? `${source} delayed` : feedStatus === "offline" ? `${source} offline` : `${source} connecting`;

  const [statusOpen, setStatusOpen] = useState(false);
  return (
    <>
    {statusOpen ? <StatusSheet onClose={() => setStatusOpen(false)} /> : null}
    <button
      type="button"
      className="hidden items-center gap-3 whitespace-nowrap rounded-[var(--radius-sm-ui)] px-1 text-xs text-muted hover:text-text xl:flex 2xl:gap-4"
      onClick={() => setStatusOpen(true)}
      aria-label="Venue status"
      data-testid="network-status"
    >
      <span className="flex items-center gap-1.5" title={`${chain.name}: ${chainText}`}>
        <StatusDot tone={chainTone} />
        <span className="hidden 2xl:inline">{chain.name}</span>
        <span className="num text-faint">{chainText}</span>
      </span>
      <span className="flex items-center gap-1.5" title={feedText}>
        <StatusDot tone={feedTone} />
        <span className="hidden 2xl:inline">{feedText}</span>
        <span className="2xl:hidden">Prices</span>
      </span>
      {config.chainId === 5042002 ? <KeeperStatus /> : null}
    </button>
    </>
  );
}

function KeeperStatus() {
  const keeper = useKeeperStatus();
  const title = keeper.data
    ? `Hosted keeper: ${keeper.ageMin === null ? "no report" : `last report ${keeper.ageMin} min ago`}${keeper.data.stats ? `, ${keeper.data.stats.executed ?? 0} orders filled, ${keeper.data.stats.liquidated ?? 0} liquidations this run` : ""}. Anyone can run a keeper: see keeper/ in the repository.`
    : "Hosted keeper status unavailable";
  return (
    <span className="flex items-center gap-1.5" title={title} data-testid="keeper-status">
      <StatusDot tone={keeper.tone} />
      <span className="hidden 2xl:inline">{keeper.text}</span>
      <span className="2xl:hidden">Keeper</span>
    </span>
  );
}

/** Paste any address to see its positions, orders and history read-only. */
function WatchControl() {
  const view = useAccountView();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const rootRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const valid = isAddress(text.trim(), { strict: false });

  useEffect(() => {
    if (!open) return;
    inputRef.current?.focus();
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (view.watching && view.address) {
    return (
      <div className="watch-badge" role="status">
        <span className="hidden sm:inline">Watching</span>
        <span className="sm:hidden" aria-hidden="true">
          {"◉"}
        </span>
        <span className="num">{shortAddress(view.address)}</span>
        <button type="button" className="ml-0.5 hover:text-text" aria-label="Stop watching this account" onClick={() => view.watch(null)}>
          {"✕"}
        </button>
      </div>
    );
  }

  return (
    <div className="relative" ref={rootRef}>
      <button type="button" className="btn btn-ghost h-8 px-1.5 sm:px-2" aria-label="Watch an account" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((v) => !v)}>
        <svg className="sm:hidden" width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
          <path d="M1.5 9s2.8-5 7.5-5 7.5 5 7.5 5-2.8 5-7.5 5-7.5-5-7.5-5Z" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <circle cx="9" cy="9" r="2.2" fill="currentColor" />
        </svg>
        <span className="hidden sm:inline md:hidden">Watch</span>
        <span className="hidden md:inline">Watch an account</span>
      </button>
      {open ? (
        <form
          className="panel absolute right-0 top-full z-40 mt-2 w-[min(22rem,calc(100vw-1rem))] p-3 shadow-[0_12px_32px_rgba(4,8,14,0.55)]"
          role="dialog"
          aria-label="Watch an account"
          onSubmit={(event) => {
            event.preventDefault();
            if (!valid) return;
            view.watch(getAddress(text.trim()));
            setOpen(false);
            setText("");
          }}
        >
          <label className="field-label" htmlFor="watch-address">
            Account address
          </label>
          <div className="field" data-invalid={text.trim() !== "" && !valid}>
            <input
              id="watch-address"
              ref={inputRef}
              value={text}
              onChange={(event) => setText(event.target.value)}
              placeholder="0x…"
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <p className="mt-2 text-xs text-faint">Shows that account&rsquo;s positions, orders and history. Trading is off while you watch.</p>
          <button type="submit" className="btn btn-primary mt-3 w-full" disabled={!valid}>
            {text.trim() !== "" && !valid ? "Not a valid address" : "Watch account"}
          </button>
        </form>
      ) : null}
    </div>
  );
}

export function Header() {
  const pathname = usePathname();
  const { config } = useApp();
  const route = currentRoute(pathname);
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/95 pt-[env(safe-area-inset-top)] backdrop-blur">
      <div className="mx-auto flex h-12 w-full max-w-[1760px] items-center gap-1 px-2 sm:gap-5 sm:px-3">
        <Wordmark />
        {/* Phones and tablets navigate with the bottom tab bar (MobileNav). */}
        <nav aria-label="Main" className="hidden h-full items-stretch lg:flex">
          {NAV.map((item) => {
            const active = route === item.route;
            return (
              <AppLink
                key={item.route}
                route={item.route}
                aria-current={active ? "page" : undefined}
                className={`relative flex items-center px-2 text-sm font-medium xl:px-3 ${active ? "text-text" : "text-muted hover:text-text"}`}
              >
                {item.label}
                {active ? <span aria-hidden="true" className="absolute inset-x-2 bottom-0 h-0.5 bg-accent xl:inset-x-3" /> : null}
              </AppLink>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-1 sm:gap-3">
          {config.overrides.length > 0 ? (
            <span
              className="hidden rounded-sm border border-warn/50 px-1.5 py-0.5 text-2xs text-warn md:inline"
              title={`Contract addresses or endpoints were set by the page address (${config.overrides.join(", ")}). Only trade if you trust where this link came from.`}
            >
              Custom deployment
            </span>
          ) : null}
          <NetworkStatus />
          <ModeSwitch current="advanced" className="hidden sm:inline-grid" />
          <WatchControl />
          <HelpButton className="hidden sm:inline-flex" />
          <SettingsButton className="hidden sm:inline-flex" />
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
