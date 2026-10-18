"use client";

import { useMemo, useState } from "react";
import { useApp } from "@/components/providers";
import { Sheet } from "@/components/ui/sheet";
import { useLocalStore } from "@/hooks/use-local-store";
import { useMarketData } from "@/hooks/use-market-data";
import type { ClosedTrade } from "@/lib/aggregate";
import { fmtDateTime, fmtDuration, fmtPercent, fmtPrice, fmtUsdc } from "@/lib/format";
import { SUGGESTED_TAGS, downloadText, journal, journalCsv, journalKey, parseTags, saveEntry, type JournalEntry } from "@/lib/journal";

const PAGE = 25;

/** Closed trades with a note and tags each (kept in this browser), a tag filter and a CSV export. */
export function Journal({
  trades,
  readOnly,
  onShare,
  notes = true,
  title = "Trade journal",
}: {
  trades: readonly ClosedTrade[];
  readOnly: boolean;
  onShare?: (trade: ClosedTrade) => void;
  /** False: a plain list of closed trades (another trader's profile), without notes or tags. */
  notes?: boolean;
  title?: string;
}) {
  const { config: cfg } = useApp();
  const { byId } = useMarketData();
  const [entries] = useLocalStore(journal);
  const [tag, setTag] = useState<string | null>(null);
  const [editing, setEditing] = useState<ClosedTrade | null>(null);
  const [limit, setLimit] = useState(PAGE);
  const keyOf = (t: ClosedTrade) => journalKey(cfg.chainId, cfg.perpEngine, t.id);

  const usedTags = useMemo(() => {
    const counts = new Map<string, number>();
    for (const t of trades) for (const g of entries[keyOf(t)]?.tags ?? []) counts.set(g, (counts.get(g) ?? 0) + 1);
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trades, entries]);

  const shown = useMemo(
    () => (tag ? trades.filter((t) => entries[keyOf(t)]?.tags.some((g) => g.toLowerCase() === tag.toLowerCase())) : trades),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [trades, entries, tag],
  );

  const exportCsv = () => {
    const rows = shown.map((trade) => ({ trade, symbol: byId.get(trade.marketId)?.symbol ?? trade.marketId, entry: entries[keyOf(trade)] }));
    downloadText(`dry-powder-journal-${new Date().toISOString().slice(0, 10)}.csv`, journalCsv(rows));
  };

  return (
    <section className="panel min-w-0" aria-label="Trade journal" data-testid="journal">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div>
          <h2 className="panel-title">{title}</h2>
          <p className="text-2xs text-faint">{notes ? "Closed trades, newest first. Notes and tags stay in this browser." : "Closed trades, newest first."}</p>
        </div>
        <button type="button" className="btn btn-sm" onClick={exportCsv} disabled={shown.length === 0} data-testid="journal-export">
          Export CSV
        </button>
      </div>
      {notes && usedTags.length > 0 ? (
        <div className="flex flex-wrap items-center gap-1.5 border-b border-line px-3 py-2" role="group" aria-label="Filter by tag">
          <button type="button" className="chip" aria-pressed={tag === null} onClick={() => setTag(null)}>
            All
          </button>
          {usedTags.map(([g, n]) => (
            <button key={g} type="button" className="chip" aria-pressed={tag === g} onClick={() => setTag(tag === g ? null : g)}>
              {g} <span className="num ml-1 text-faint">{n}</span>
            </button>
          ))}
        </div>
      ) : null}
      {shown.length === 0 ? (
        <p className="px-4 py-10 text-center text-muted">{trades.length === 0 ? "No closed trades in this period." : "No trade has this tag."}</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="data-table card-table">
            <thead>
              <tr>
                <th>Closed</th>
                <th>Market</th>
                <th className="r">Size</th>
                <th className="r">Entry → exit</th>
                <th className="r">Held</th>
                <th className="r">Net PnL</th>
                {notes ? <th>Notes</th> : null}
                <th className="r">
                  <span className="sr-only">Actions</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {shown.slice(0, limit).map((t) => {
                const inst = byId.get(t.marketId);
                const dp = inst?.priceDecimals ?? 2;
                const entry = entries[keyOf(t)];
                return (
                  <tr key={t.id} data-testid="journal-row">
                    <td className="num text-muted" data-label="Closed">
                      {fmtDateTime(t.closeTime)}
                    </td>
                    <td data-cell="market">
                      <span className="wide font-semibold">{inst?.symbol ?? "Unknown"}</span>{" "}
                      {t.isLong !== null ? <span className={t.isLong ? "text-long" : "text-short"}>{t.isLong ? "Long" : "Short"}</span> : null}
                      {t.leverage !== null ? <span className="num ml-1 text-faint">{t.leverage}x</span> : null}
                      {t.liquidated ? <span className="ml-1.5 text-xs font-semibold text-short">Liquidated</span> : null}
                    </td>
                    <td className="r num" data-label="Size">
                      {t.size !== null ? fmtUsdc(t.size, 0) : "—"}
                    </td>
                    <td className="r num" data-label="Entry → exit">
                      {t.entry !== null ? fmtPrice(t.entry, dp) : "?"} → {fmtPrice(t.exit, dp)}
                    </td>
                    <td className="r num" data-label="Held">
                      {t.openTime !== null ? fmtDuration(t.closeTime - t.openTime) : "—"}
                    </td>
                    <td className="r num" data-cell="pnl">
                      <span className={t.net > 0n ? "text-long" : t.net < 0n ? "text-short" : ""}>{fmtUsdc(t.net, 2, { sign: true })}</span>
                      {t.roe !== null ? <span className="block text-xs text-faint">{fmtPercent(t.roe, 1, true)} on margin</span> : null}
                    </td>
                    {notes ? (
                      <td className="max-w-[16rem] whitespace-normal" data-label="Notes">
                        {entry ? <JournalPreview entry={entry} /> : <span className="text-faint">—</span>}
                      </td>
                    ) : null}
                    <td className="r" data-cell="actions">
                      <span className="inline-flex gap-1.5">
                        {notes && !readOnly ? (
                          <button type="button" className="btn btn-sm" onClick={() => setEditing(t)} data-testid="journal-edit">
                            {entry ? "Edit note" : "Add note"}
                          </button>
                        ) : null}
                        {onShare ? (
                          <button type="button" className="btn btn-sm btn-ghost" onClick={() => onShare(t)} data-testid="journal-share">
                            Share
                          </button>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {shown.length > limit ? (
            <div className="border-t border-line px-3 py-2 text-center">
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setLimit((n) => n + PAGE)}>
                Show {Math.min(PAGE, shown.length - limit)} more of {shown.length - limit}
              </button>
            </div>
          ) : null}
        </div>
      )}
      {editing ? <NoteSheet trade={editing} entryKey={keyOf(editing)} entry={entries[keyOf(editing)]} symbol={byId.get(editing.marketId)?.symbol ?? "Trade"} onClose={() => setEditing(null)} /> : null}
    </section>
  );
}

function JournalPreview({ entry }: { entry: JournalEntry }) {
  return (
    <span className="flex flex-wrap items-center gap-1">
      {entry.tags.map((g) => (
        <span key={g} className="tag" data-tone="accent">
          {g}
        </span>
      ))}
      {entry.note ? <span className="line-clamp-2 text-xs text-muted">{entry.note}</span> : null}
    </span>
  );
}

function NoteSheet({ trade, entryKey, entry, symbol, onClose }: { trade: ClosedTrade; entryKey: string; entry: JournalEntry | undefined; symbol: string; onClose: () => void }) {
  const [note, setNote] = useState(entry?.note ?? "");
  const [tags, setTags] = useState<string[]>(entry?.tags ?? []);
  const [draftTag, setDraftTag] = useState("");
  const toggle = (g: string) => setTags((list) => (list.some((x) => x.toLowerCase() === g.toLowerCase()) ? list.filter((x) => x.toLowerCase() !== g.toLowerCase()) : [...list, g]));
  const save = () => {
    saveEntry(entryKey, note, [...tags, ...parseTags(draftTag)]);
    onClose();
  };
  return (
    <Sheet
      title={`${symbol} ${trade.isLong === null ? "" : trade.isLong ? "long" : "short"}: ${fmtUsdc(trade.net, 2, { sign: true })}`}
      description={`Closed ${fmtDateTime(trade.closeTime)}. What was the plan, what happened, what would you repeat?`}
      onClose={onClose}
      testId="journal-sheet"
      footer={
        <div className="flex justify-end gap-2">
          <button type="button" className="btn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="btn btn-primary" onClick={save} data-testid="journal-save">
            Save
          </button>
        </div>
      }
    >
      <div className="grid gap-3">
        <label className="grid gap-1">
          <span className="field-label">Note</span>
          <textarea
            className="min-h-28 w-full rounded-[var(--radius-ui)] border border-line bg-bg px-3 py-2 text-[0.875rem] text-text placeholder:text-faint focus:border-accent focus:outline-none"
            value={note}
            maxLength={2000}
            onChange={(event) => setNote(event.target.value)}
            placeholder="Entry reason, exit reason, mistakes, lessons."
            data-autofocus
            data-testid="journal-note"
          />
        </label>
        <div className="grid gap-1.5">
          <span className="field-label">Tags</span>
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Tags">
            {[...new Set([...SUGGESTED_TAGS, ...tags])].map((g) => (
              <button key={g} type="button" className="chip" aria-pressed={tags.some((x) => x.toLowerCase() === g.toLowerCase())} onClick={() => toggle(g)}>
                {g}
              </button>
            ))}
          </div>
          <div className="field h-9">
            <input value={draftTag} onChange={(event) => setDraftTag(event.target.value)} placeholder="Your own tags, comma separated" aria-label="Add tags" />
          </div>
        </div>
      </div>
    </Sheet>
  );
}
