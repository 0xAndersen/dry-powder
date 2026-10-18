"use client";

import { useEffect, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { useBlockNumber } from "wagmi";
import { getAddress, isAddress } from "viem";
import { AppLink } from "@/components/app-link";
import { useApp } from "@/components/providers";
import { WalletButton } from "@/components/wallet-button";
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
      <span className="wide hidden text-[1.0625rem] leading-none lg:inline">Dry Powder</span>
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

  return (
    <div className="hidden items-center gap-4 text-xs text-muted xl:flex" role="status" aria-live="polite">
      <span className="flex items-center gap-1.5" title={`${chain.name}: ${chainText}`}>
        <StatusDot tone={chainTone} />
        <span>{chain.name}</span>
        <span className="num text-faint">{chainText}</span>
      </span>
      <span className="flex items-center gap-1.5">
        <StatusDot tone={feedTone} />
        <span>{feedText}</span>
      </span>
      {config.chainId === 5042002 ? <KeeperStatus /> : null}
    </div>
  );
}

/** The hosted keeper's health snapshot (pushed to the repository's status branch every 5 minutes). */
const KEEPER_STATUS_URL = "https://raw.githubusercontent.com/0xAndersen/dry-powder/status/status/keeper.json";

function KeeperStatus() {
  const health = useQuery({
    queryKey: ["keeper-status"],
    refetchInterval: 60_000,
    retry: 1,
    queryFn: async () => {
      const r = await fetch(`${KEEPER_STATUS_URL}?t=${Math.floor(Date.now() / 60_000)}`, { cache: "no-store" });
      if (!r.ok) throw new Error(String(r.status));
      return (await r.json()) as { ok?: boolean; last?: { at?: number }; stats?: { executed?: number; liquidated?: number } };
    },
  });
  const at = health.data?.last?.at ?? 0;
  const ageMin = at ? Math.max(0, Math.round((Date.now() - at) / 60_000)) : null;
  // Snapshots arrive every 5 minutes; older than 12 means the keeper (or its status push) has stopped.
  const fresh = ageMin !== null && ageMin <= 12;
  const tone = health.isError ? "idle" : !health.data ? "idle" : health.data.ok && fresh ? "ok" : fresh ? "warn" : "bad";
  const text = !health.data ? "Keeper" : health.data.ok && fresh ? "Keeper running" : fresh ? "Keeper degraded" : "Keeper not reporting";
  const title = health.data
    ? `Hosted keeper: ${ageMin === null ? "no report" : `last report ${ageMin} min ago`}${health.data.stats ? `, ${health.data.stats.executed ?? 0} orders filled, ${health.data.stats.liquidated ?? 0} liquidations this run` : ""}. Anyone can run a keeper: see keeper/ in the repository.`
    : "Hosted keeper status unavailable";
  return (
    <span className="flex items-center gap-1.5" title={title} data-testid="keeper-status">
      <StatusDot tone={tone} />
      <span>{text}</span>
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
    <header className="sticky top-0 z-30 border-b border-line bg-bg/95 backdrop-blur">
      <div className="mx-auto flex h-12 w-full max-w-[1760px] items-center gap-1 px-2 sm:gap-5 sm:px-3">
        <Wordmark />
        <nav aria-label="Main" className="flex h-full items-stretch">
          {NAV.map((item) => {
            const active = route === item.route;
            return (
              <AppLink
                key={item.route}
                route={item.route}
                aria-current={active ? "page" : undefined}
                className={`relative flex items-center px-[3px] text-xs font-medium tracking-[-0.01em] sm:px-3 sm:text-sm sm:tracking-normal ${active ? "text-text" : "text-muted hover:text-text"}`}
              >
                {item.label}
                {active ? <span aria-hidden="true" className="absolute inset-x-1 bottom-0 h-0.5 bg-accent sm:inset-x-3" /> : null}
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
          <WatchControl />
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
