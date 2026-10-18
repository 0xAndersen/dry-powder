import { formatUnits } from "viem";
import type { ClosedTrade } from "./aggregate";
import { createLocalStore } from "./storage";

/**
 * The trade journal: a note and tags per closed trade, kept in this browser only. Keyed by chain, engine and the
 * exit event, so notes never attach to a different deployment's trade with the same id.
 */
export type JournalEntry = { note: string; tags: string[]; updatedAt: number };

const MAX_ENTRIES = 5_000;
const MAX_NOTE = 2_000;
const MAX_TAGS = 8;
const MAX_TAG = 24;

export const SUGGESTED_TAGS = ["Plan", "Breakout", "Reversal", "Trend", "News", "Scalp", "Swing", "Impulse", "FOMO", "Revenge", "Mistake"];

export function cleanTags(tags: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of tags) {
    const tag = raw.replace(/\s+/g, " ").trim().slice(0, MAX_TAG);
    if (!tag || seen.has(tag.toLowerCase())) continue;
    seen.add(tag.toLowerCase());
    out.push(tag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

export const journal = createLocalStore<Record<string, JournalEntry>>("dp:journal:v1", {}, (stored) => {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  const out: Record<string, JournalEntry> = {};
  let n = 0;
  for (const [key, value] of Object.entries(stored as Record<string, Partial<JournalEntry>>)) {
    if (!value || typeof value !== "object" || key.length > 200) continue;
    const note = typeof value.note === "string" ? value.note.slice(0, MAX_NOTE) : "";
    const tags = Array.isArray(value.tags) ? cleanTags(value.tags.filter((t): t is string => typeof t === "string")) : [];
    if (!note && tags.length === 0) continue;
    out[key] = { note, tags, updatedAt: Number(value.updatedAt) || 0 };
    if (++n >= MAX_ENTRIES) break;
  }
  return out;
});

export function journalKey(chainId: number, engine: string, tradeId: string): string {
  return `${chainId}:${engine.toLowerCase()}:${tradeId}`;
}

/** Saves (or, when empty, removes) the entry for `key`. */
export function saveEntry(key: string, note: string, tags: readonly string[]): void {
  const clean = { note: note.slice(0, MAX_NOTE).trim(), tags: cleanTags(tags) };
  journal.set((all) => {
    const next = { ...all };
    if (!clean.note && clean.tags.length === 0) delete next[key];
    else next[key] = { ...clean, updatedAt: Date.now() };
    return next;
  });
}

/** Splits "a, b; c" into tags. */
export function parseTags(text: string): string[] {
  return cleanTags(text.split(/[,;\n]/));
}

const csvCell = (value: string | number | boolean | null | undefined): string => {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
};

const usdc = (v: bigint | null) => (v === null ? null : formatUnits(v, 6));
const price = (v: bigint | null) => (v === null ? null : formatUnits(v, 18));

/** The journal as CSV: one row per closed trade with its note and tags. */
export function journalCsv(rows: readonly { trade: ClosedTrade; symbol: string; entry: JournalEntry | undefined }[]): string {
  const header = [
    "closed_at_utc",
    "opened_at_utc",
    "market",
    "side",
    "leverage",
    "size_usdc",
    "entry_price",
    "exit_price",
    "margin_usdc",
    "realised_usdc",
    "fees_usdc",
    "net_usdc",
    "roe_pct",
    "held_seconds",
    "liquidated",
    "partial_closes",
    "tags",
    "note",
    "tx",
  ];
  const lines = [header.join(",")];
  for (const { trade: t, symbol, entry } of rows) {
    lines.push(
      [
        new Date(t.closeTime * 1000).toISOString(),
        t.openTime !== null ? new Date(t.openTime * 1000).toISOString() : null,
        symbol,
        t.isLong === null ? null : t.isLong ? "long" : "short",
        t.leverage,
        usdc(t.size),
        price(t.entry),
        price(t.exit),
        usdc(t.margin),
        usdc(t.realised),
        usdc(t.fees),
        usdc(t.net),
        t.roe === null ? null : (t.roe * 100).toFixed(2),
        t.openTime !== null ? t.closeTime - t.openTime : null,
        t.liquidated,
        t.partials,
        entry?.tags.join("; ") ?? "",
        entry?.note ?? "",
        t.tx,
      ]
        .map(csvCell)
        .join(","),
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Saves `text` as a file in the browser. */
export function downloadText(filename: string, text: string, type = "text/csv;charset=utf-8"): void {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1_000);
}
