"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { usePathname } from "next/navigation";
import { InstantTradingSheet } from "@/components/instant-trading";
import { SettingsSheet } from "@/components/settings-sheet";
import { useMarketData } from "@/hooks/use-market-data";
import { useLocalStore } from "@/hooks/use-local-store";
import { fmtNum } from "@/lib/format";
import { currentRoute, hrefFor, stickyQuery, type Route } from "@/lib/nav";
import { toggleWatch, watchlist } from "@/lib/social";

/** Commands the trade screen listens for (it owns the ticket). */
export type TradeCommand = { type: "side"; long: boolean } | { type: "close" } | { type: "market"; symbol: string };

export function sendTradeCommand(command: TradeCommand): void {
  window.dispatchEvent(new CustomEvent<TradeCommand>("dp:command", { detail: command }));
}

type Item = { id: string; label: string; hint?: string; group: string; keywords?: string; run: () => void };

function go(route: Route, params: Record<string, string | null> = {}): void {
  window.location.assign(hrefFor(route, stickyQuery(new URLSearchParams(window.location.search), params)));
}

/** Ctrl/⌘ K: jump to any market or page, place a side, close, open settings. */
export function CommandPalette() {
  const pathname = usePathname();
  const route = currentRoute(pathname);
  const { instruments, prices } = useMarketData();
  const [favourites] = useLocalStore(watchlist);
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [index, setIndex] = useState(0);
  const [sheet, setSheet] = useState<null | "settings" | "instant">(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setOpen((v) => !v);
        setQuery("");
        setIndex(0);
      }
    };
    const onOpen = () => {
      setOpen(true);
      setQuery("");
      setIndex(0);
    };
    document.addEventListener("keydown", onKey);
    window.addEventListener("dp:palette", onOpen);
    return () => {
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("dp:palette", onOpen);
    };
  }, []);

  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open]);

  const currentSymbol = useMemo(() => {
    if (route !== "trade" || typeof window === "undefined") return null;
    return new URLSearchParams(window.location.search).get("market");
  }, [route, open]); // eslint-disable-line react-hooks/exhaustive-deps

  const items = useMemo<Item[]>(() => {
    const out: Item[] = [];
    const onTrade = route === "trade";
    if (onTrade) {
      out.push(
        { id: "long", label: "Long", hint: currentSymbol ?? undefined, group: "Trade", keywords: "buy b", run: () => sendTradeCommand({ type: "side", long: true }) },
        { id: "short", label: "Short", hint: currentSymbol ?? undefined, group: "Trade", keywords: "sell s", run: () => sendTradeCommand({ type: "side", long: false }) },
        { id: "close", label: "Close position", hint: currentSymbol ?? undefined, group: "Trade", keywords: "flatten exit x", run: () => sendTradeCommand({ type: "close" }) },
      );
      if (currentSymbol) {
        const starred = favourites.includes(currentSymbol);
        out.push({ id: "fav", label: starred ? `Remove ${currentSymbol} from favourites` : `Add ${currentSymbol} to favourites`, group: "Trade", keywords: "star watchlist", run: () => toggleWatch(currentSymbol) });
      }
    }
    const sorted = [...instruments].sort((a, b) => Number(favourites.includes(b.symbol)) - Number(favourites.includes(a.symbol)));
    for (const i of sorted) {
      const p = prices.get(i.id);
      out.push({
        id: `m-${i.id}`,
        label: i.symbol,
        hint: `${p?.display !== null && p?.display !== undefined ? fmtNum(p.display, i.priceDecimals) : ""}${favourites.includes(i.symbol) ? "  ★" : ""}`,
        group: "Markets",
        keywords: `${i.name} ${i.base} ${i.quote}`,
        run: () => (onTrade ? sendTradeCommand({ type: "market", symbol: i.symbol }) : go("trade", { market: i.symbol })),
      });
    }
    const pages: [Route, string, string][] = [
      ["trade", "Trade", "chart ticket"],
      ["markets", "Markets", "prices funding open interest"],
      ["charts", "Chart wall", "multi chart grid layout"],
      ["portfolio", "Portfolio", "pnl journal stats"],
      ["activity", "Activity", "feed trades liquidations"],
      ["leaderboard", "Leaderboard", "season top traders"],
      ["house", "House", "vault stake DRY yield"],
      ["agents", "Agents", "bots api accounts strategies studio"],
      ["simple", "Simple mode", "easy up down beginner"],
    ];
    for (const [r, label, keywords] of pages) out.push({ id: `p-${r}`, label, group: "Go to", keywords, run: () => go(r) });
    out.push(
      { id: "settings", label: "Settings", hint: "slippage, risk limits, notifications", group: "App", keywords: "preferences", run: () => setSheet("settings") },
      { id: "instant", label: "Instant trading", hint: "no wallet pop-up per order", group: "App", keywords: "session key one click", run: () => setSheet("instant") },
    );
    return out;
  }, [route, currentSymbol, instruments, prices, favourites]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    const words = q.split(/\s+/);
    return items.filter((item) => {
      const text = `${item.label} ${item.hint ?? ""} ${item.group} ${item.keywords ?? ""}`.toLowerCase();
      return words.every((w) => text.includes(w));
    });
  }, [items, query]);

  const run = (item: Item | undefined) => {
    if (!item) return;
    setOpen(false);
    item.run();
  };

  useEffect(() => {
    listRef.current?.querySelector(`[data-index="${index}"]`)?.scrollIntoView({ block: "nearest" });
  }, [index]);

  return (
    <>
      {open ? (
        <div className="sheet-backdrop items-start pt-[12vh]" onPointerDown={(event) => event.target === event.currentTarget && setOpen(false)}>
          <div role="dialog" aria-modal="true" aria-label="Command palette" className="panel w-[min(34rem,calc(100vw-1.5rem))] overflow-hidden bg-raised shadow-[0_24px_60px_rgba(2,4,8,0.7)]" data-testid="command-palette">
            <div className="border-b border-line p-2">
              <input
                ref={inputRef}
                className="h-10 w-full bg-transparent px-2 text-[0.9375rem] text-text outline-none placeholder:text-faint"
                placeholder="Search markets, pages and actions"
                value={query}
                aria-label="Search commands"
                aria-controls="palette-list"
                aria-activedescendant={filtered[index] ? `palette-${filtered[index].id}` : undefined}
                onChange={(event) => {
                  setQuery(event.target.value);
                  setIndex(0);
                }}
                onKeyDown={(event) => {
                  if (event.key === "ArrowDown") {
                    event.preventDefault();
                    setIndex((i) => Math.min(filtered.length - 1, i + 1));
                  } else if (event.key === "ArrowUp") {
                    event.preventDefault();
                    setIndex((i) => Math.max(0, i - 1));
                  } else if (event.key === "Enter") {
                    event.preventDefault();
                    run(filtered[index]);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    setOpen(false);
                  }
                }}
              />
            </div>
            <ul id="palette-list" ref={listRef} role="listbox" className="max-h-[min(26rem,60vh)] overflow-y-auto py-1">
              {filtered.length === 0 ? <li className="px-4 py-6 text-center text-sm text-muted">Nothing matches &ldquo;{query}&rdquo;.</li> : null}
              {filtered.map((item, i) => (
                <li
                  key={item.id}
                  id={`palette-${item.id}`}
                  role="option"
                  aria-selected={i === index}
                  data-index={i}
                  className={`flex cursor-pointer items-center justify-between gap-3 px-4 py-2 text-[0.8125rem] ${i === index ? "bg-panel text-text" : "text-muted"}`}
                  onPointerMove={() => setIndex(i)}
                  onClick={() => run(item)}
                >
                  <span className="min-w-0 truncate">
                    <span className={i === index ? "text-text" : "text-text/90"}>{item.label}</span>
                    {item.hint ? <span className="num ml-2 text-faint">{item.hint}</span> : null}
                  </span>
                  <span className="shrink-0 text-2xs text-faint">{item.group}</span>
                </li>
              ))}
            </ul>
            <div className="flex items-center justify-between border-t border-line px-3 py-1.5 text-2xs text-faint">
              <span>
                <span className="kbd">↑</span> <span className="kbd">↓</span> to move, <span className="kbd">Enter</span> to run
              </span>
              <span>
                <span className="kbd">Esc</span> to close
              </span>
            </div>
          </div>
        </div>
      ) : null}
      {sheet === "settings" ? <SettingsSheet onClose={() => setSheet(null)} /> : null}
      {sheet === "instant" ? <InstantTradingSheet onClose={() => setSheet(null)} /> : null}
    </>
  );
}
