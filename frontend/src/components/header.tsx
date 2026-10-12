"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useBlockNumber } from "wagmi";
import { useApp } from "@/components/providers";
import { useFeedStatus } from "@/hooks/use-prices";
import { WalletButton } from "@/components/wallet-button";

const NAV = [
  { href: "/trade", label: "Trade" },
  { href: "/house", label: "House" },
] as const;

function Wordmark() {
  return (
    <Link href="/trade" className="flex shrink-0 items-center gap-2 whitespace-nowrap" aria-label="Arc House, go to trading">
      <svg width="26" height="18" viewBox="0 0 26 18" aria-hidden="true">
        <path d="M2 16a11 11 0 0 1 22 0" fill="none" stroke="var(--color-brass)" strokeWidth="3" strokeLinecap="round" />
        <path d="M9.5 16a3.5 3.5 0 0 1 7 0" fill="none" stroke="var(--color-text)" strokeWidth="2.5" strokeLinecap="round" />
      </svg>
      <span className="wide hidden text-[1.0625rem] font-bold leading-none min-[430px]:inline">Arc House</span>
    </Link>
  );
}

function StatusDot({ tone }: { tone: "ok" | "warn" | "bad" | "idle" }) {
  const color =
    tone === "ok" ? "bg-long" : tone === "warn" ? "bg-warn" : tone === "bad" ? "bg-short" : "bg-faint";
  return <span aria-hidden="true" className={`inline-block h-1.5 w-1.5 rounded-full ${color}`} />;
}

function NetworkStatus() {
  const { chain } = useApp();
  const feed = useFeedStatus();
  const block = useBlockNumber({ chainId: chain.id, watch: true });

  const chainTone = block.isError ? "bad" : block.data !== undefined ? "ok" : "idle";
  const chainText = block.isError
    ? "RPC unreachable"
    : block.data !== undefined
      ? `Block ${block.data.toLocaleString("en-US")}`
      : "Connecting";

  const feedTone = feed === "live" ? "ok" : feed === "polling" ? "warn" : feed === "offline" ? "bad" : "idle";
  const feedText =
    feed === "live"
      ? "Prices live"
      : feed === "polling"
        ? "Prices delayed"
        : feed === "offline"
          ? "Prices offline"
          : "Prices connecting";

  return (
    <div className="flex items-center gap-2 text-xs text-muted md:gap-4" role="status" aria-live="polite">
      <span className="flex items-center gap-1.5" title={`${chain.name}: ${chainText}`}>
        <StatusDot tone={chainTone} />
        <span className="sr-only md:not-sr-only">{chain.name}</span>
        <span className="num sr-only text-faint md:not-sr-only">{chainText}</span>
      </span>
      <span className="flex items-center gap-1.5" title={`Pyth price stream: ${feedText}`}>
        <StatusDot tone={feedTone} />
        <span className="sr-only md:not-sr-only">{feedText}</span>
      </span>
    </div>
  );
}

export function Header() {
  const pathname = usePathname();
  return (
    <header className="sticky top-0 z-30 border-b border-line bg-bg/95 backdrop-blur">
      <div className="mx-auto flex h-14 w-full max-w-[1680px] items-center gap-2 px-3 sm:gap-7 sm:px-4">
        <Wordmark />
        <nav aria-label="Main" className="flex h-full items-stretch gap-1">
          {NAV.map((item) => {
            const active = pathname === item.href || pathname.startsWith(`${item.href}/`);
            return (
              <Link
                key={item.href}
                href={item.href}
                aria-current={active ? "page" : undefined}
                className={`relative flex items-center px-2.5 text-sm font-medium sm:px-3 ${
                  active ? "text-text" : "text-muted hover:text-text"
                }`}
              >
                {item.label}
                {active ? <span aria-hidden="true" className="absolute inset-x-2.5 bottom-0 h-0.5 bg-brass sm:inset-x-3" /> : null}
              </Link>
            );
          })}
        </nav>
        <div className="ml-auto flex items-center gap-2.5 sm:gap-4">
          <NetworkStatus />
          <WalletButton />
        </div>
      </div>
    </header>
  );
}
