"use client";

import { useState, type ReactNode } from "react";
import { usePathname } from "next/navigation";
import { AppLink } from "@/components/app-link";
import { InstantTradingSheet } from "@/components/instant-trading";
import { HelpSheet } from "@/components/help-sheet";
import { SettingsSheet } from "@/components/settings-sheet";
import { StatusSheet } from "@/components/status-sheet";
import { Sheet } from "@/components/ui/sheet";
import { currentRoute, type Route } from "@/lib/nav";
import { useInstallPrompt } from "@/hooks/use-install-prompt";

const icon = (path: ReactNode) => (
  <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {path}
  </svg>
);

const ICONS: Record<string, ReactNode> = {
  trade: icon(
    <>
      <path d="M4 19V9M10 19V5M16 19v-8M22 19H2" />
    </>,
  ),
  markets: icon(
    <>
      <circle cx="11" cy="11" r="6.5" />
      <path d="m20.5 20.5-4.8-4.8" />
    </>,
  ),
  portfolio: icon(
    <>
      <rect x="3" y="7" width="18" height="13" rx="2.5" />
      <path d="M8.5 7V5.5A1.5 1.5 0 0 1 10 4h4a1.5 1.5 0 0 1 1.5 1.5V7M3 12.5h18" />
    </>,
  ),
  activity: icon(<path d="M3 12h4l3-7 4 14 3-7h4" />),
  more: icon(
    <>
      <circle cx="5" cy="12" r="1.3" />
      <circle cx="12" cy="12" r="1.3" />
      <circle cx="19" cy="12" r="1.3" />
    </>,
  ),
};

const TABS: readonly { route: Route; label: string }[] = [
  { route: "trade", label: "Trade" },
  { route: "markets", label: "Markets" },
  { route: "portfolio", label: "Portfolio" },
  { route: "activity", label: "Activity" },
];

const MORE: readonly { route: Route; label: string; hint: string }[] = [
  { route: "charts", label: "Chart wall", hint: "Up to six charts side by side" },
  { route: "leaderboard", label: "Leaderboard", hint: "Top traders this season" },
  { route: "house", label: "House", hint: "Be the counterparty: the vault and DRY staking" },
  { route: "agents", label: "Agents", hint: "Accounts that bots and AI agents trade from" },
];

/** Bottom tab bar on phones and tablets (the header carries navigation from `lg` up). */
export function MobileNav() {
  const pathname = usePathname();
  const route = currentRoute(pathname);
  const [moreOpen, setMoreOpen] = useState(false);
  const [instantOpen, setInstantOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [statusOpen, setStatusOpen] = useState(false);
  const install = useInstallPrompt();
  const inMore = MORE.some((m) => m.route === route);

  return (
    <>
      <nav aria-label="Main" className="mobile-nav lg:hidden" data-testid="mobile-nav">
        {TABS.map((tab) => {
          const active = route === tab.route;
          return (
            <AppLink key={tab.route} route={tab.route} aria-current={active ? "page" : undefined} className="mobile-nav-item" data-active={active}>
              {ICONS[tab.route]}
              <span>{tab.label}</span>
            </AppLink>
          );
        })}
        <button type="button" className="mobile-nav-item" data-active={inMore} aria-haspopup="dialog" onClick={() => setMoreOpen(true)}>
          {ICONS.more}
          <span>More</span>
        </button>
      </nav>
      {moreOpen ? (
        <Sheet title="More" onClose={() => setMoreOpen(false)}>
          <ul className="grid gap-1">
            {MORE.map((item) => (
              <li key={item.route}>
                <AppLink route={item.route} className="flex items-center justify-between gap-3 rounded-[var(--radius-ui)] px-3 py-3 hover:bg-panel" aria-current={route === item.route ? "page" : undefined}>
                  <span>
                    <span className="block text-sm text-text">{item.label}</span>
                    <span className="block text-xs text-muted">{item.hint}</span>
                  </span>
                  <span aria-hidden="true" className="text-faint">
                    {"›"}
                  </span>
                </AppLink>
              </li>
            ))}
            <li>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 rounded-[var(--radius-ui)] px-3 py-3 text-left hover:bg-panel"
                onClick={() => {
                  setMoreOpen(false);
                  setInstantOpen(true);
                }}
              >
                <span>
                  <span className="block text-sm text-text">Instant trading</span>
                  <span className="block text-xs text-muted">Trade without a wallet pop-up for every order</span>
                </span>
                <span aria-hidden="true" className="text-faint">
                  {"›"}
                </span>
              </button>
            </li>
            <li>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 rounded-[var(--radius-ui)] px-3 py-3 text-left hover:bg-panel"
                onClick={() => {
                  setMoreOpen(false);
                  setSettingsOpen(true);
                }}
              >
                <span>
                  <span className="block text-sm text-text">Settings</span>
                  <span className="block text-xs text-muted">Slippage, risk limits, notifications</span>
                </span>
                <span aria-hidden="true" className="text-faint">
                  {"›"}
                </span>
              </button>
            </li>
            <li>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 rounded-[var(--radius-ui)] px-3 py-3 text-left hover:bg-panel"
                onClick={() => {
                  setMoreOpen(false);
                  setHelpOpen(true);
                }}
              >
                <span>
                  <span className="block text-sm text-text">Help</span>
                  <span className="block text-xs text-muted">How it works, staying safe, support</span>
                </span>
                <span aria-hidden="true" className="text-faint">
                  {"›"}
                </span>
              </button>
            </li>
            <li>
              <button
                type="button"
                className="flex w-full items-center justify-between gap-3 rounded-[var(--radius-ui)] px-3 py-3 text-left hover:bg-panel"
                onClick={() => {
                  setMoreOpen(false);
                  setStatusOpen(true);
                }}
              >
                <span>
                  <span className="block text-sm text-text">Venue status</span>
                  <span className="block text-xs text-muted">Chain, keeper and price feeds</span>
                </span>
                <span aria-hidden="true" className="text-faint">
                  {"›"}
                </span>
              </button>
            </li>
            {install.canInstall || install.iosHint ? (
              <li>
                <button
                  type="button"
                  className="flex w-full items-center justify-between gap-3 rounded-[var(--radius-ui)] px-3 py-3 text-left hover:bg-panel"
                  onClick={() => void install.prompt()}
                >
                  <span>
                    <span className="block text-sm text-text">Install the app</span>
                    <span className="block text-xs text-muted">
                      {install.iosHint ? "In Safari: Share, then Add to Home Screen" : "Full screen, from your home screen"}
                    </span>
                  </span>
                  <span aria-hidden="true" className="text-faint">
                    {"›"}
                  </span>
                </button>
              </li>
            ) : null}
          </ul>
        </Sheet>
      ) : null}
      {instantOpen ? <InstantTradingSheet onClose={() => setInstantOpen(false)} /> : null}
      {settingsOpen ? <SettingsSheet onClose={() => setSettingsOpen(false)} /> : null}
      {helpOpen ? <HelpSheet onClose={() => setHelpOpen(false)} /> : null}
      {statusOpen ? <StatusSheet onClose={() => setStatusOpen(false)} /> : null}
    </>
  );
}
