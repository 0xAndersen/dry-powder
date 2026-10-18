/**
 * PnL share cards: a 1200 x 675 PNG (the 16:9 size X, Telegram and Discord preview without cropping) drawn on a
 * canvas in the brand's colours and type. Everything on the card comes from the chain: the figures are the same
 * ones the app shows, so a card can be checked against the trader's profile.
 */

export const CARD_WIDTH = 1200;
export const CARD_HEIGHT = 675;

const C = {
  ink: "#0d0f12",
  panel: "#14171c",
  line: "#262b33",
  paper: "#e8ecf1",
  muted: "#a0a9b6",
  faint: "#6b7480",
  signal: "#7ea6ff",
  long: "#3ecf8e",
  short: "#f0646f",
};
const SANS = '"Inter Variable", Inter, ui-sans-serif, system-ui, sans-serif';
const MONO = '"IBM Plex Mono", ui-monospace, monospace';

export type CardFigure = { label: string; value: string };

export type TradeCard = {
  kind: "trade";
  /** "BTC-USD". */
  symbol: string;
  side: "Long" | "Short" | null;
  leverage: number | null;
  /** Big number: return on margin, e.g. "+42.3%". Null when unknown (falls back to the PnL). */
  headline: string | null;
  /** Net PnL with its unit, e.g. "+123.45 tUSDC". */
  pnl: string;
  positive: boolean;
  /** "Closed", "Open", "Liquidated", "Partly closed". */
  status: string;
  figures: CardFigure[];
  trader: string;
  /** "18 Oct 2026, 04:31 UTC". */
  when: string;
  url: string;
  network: string;
};

export type ProfileCard = {
  kind: "profile";
  trader: string;
  /** "All time", "This season (week 42)", "30 days". */
  period: string;
  headline: string;
  pnl: string;
  positive: boolean;
  figures: CardFigure[];
  url: string;
  network: string;
};

export type ShareCard = TradeCard | ProfileCard;

/** Signed percentage for a card headline: "+42.3%", "−7.10%". */
export function cardPercent(fraction: number): string {
  const pct = fraction * 100;
  const abs = Math.abs(pct);
  const dp = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return `${pct > 0 ? "+" : pct < 0 ? "−" : ""}${abs.toFixed(dp)}%`;
}

/** Draws the brand mark (vessel with its reserve) with its top-left corner at x, y and side `s`. */
function mark(ctx: CanvasRenderingContext2D, x: number, y: number, s: number): void {
  const k = s / 32;
  ctx.save();
  ctx.translate(x, y);
  ctx.scale(k, k);
  ctx.strokeStyle = C.paper;
  ctx.lineWidth = 2.25;
  roundRect(ctx, 5, 5, 22, 22, 6);
  ctx.stroke();
  ctx.fillStyle = C.signal;
  roundRect(ctx, 9.5, 16.5, 13, 6.5, 1.75);
  ctx.fill();
  ctx.globalAlpha = 0.55;
  ctx.setLineDash([2, 2.8]);
  ctx.lineWidth = 1.6;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.moveTo(9.5, 12.5);
  ctx.lineTo(22.5, 12.5);
  ctx.stroke();
  ctx.restore();
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

/** Shrinks the font until `text` fits in `max` pixels; returns the size used. */
function fit(ctx: CanvasRenderingContext2D, text: string, weight: string, family: string, size: number, max: number): number {
  let s = size;
  ctx.font = `${weight} ${s}px ${family}`;
  while (s > 12 && ctx.measureText(text).width > max) {
    s -= 2;
    ctx.font = `${weight} ${s}px ${family}`;
  }
  return s;
}

async function loadFonts(): Promise<void> {
  if (typeof document === "undefined" || !document.fonts) return;
  try {
    await Promise.all([
      document.fonts.load(`650 64px ${SANS}`),
      document.fonts.load(`400 24px ${SANS}`),
      document.fonts.load(`500 40px ${MONO}`),
      document.fonts.load(`600 120px ${MONO}`),
    ]);
  } catch {
    // Falls back to system fonts; the card still renders.
  }
}

/** Draws `card` into a fresh canvas at `scale` (2 = sharp on high-density screens and when posted). */
export async function drawCard(card: ShareCard, scale = 1): Promise<HTMLCanvasElement> {
  await loadFonts();
  const canvas = document.createElement("canvas");
  canvas.width = CARD_WIDTH * scale;
  canvas.height = CARD_HEIGHT * scale;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This browser cannot draw images");
  ctx.scale(scale, scale);
  ctx.textBaseline = "alphabetic";

  // Ground: ink, a panel inset, and a thin band of the outcome's colour along the left edge.
  ctx.fillStyle = C.ink;
  ctx.fillRect(0, 0, CARD_WIDTH, CARD_HEIGHT);
  ctx.fillStyle = C.panel;
  roundRect(ctx, 32, 32, CARD_WIDTH - 64, CARD_HEIGHT - 64, 14);
  ctx.fill();
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2;
  ctx.stroke();
  const tone = card.positive ? C.long : C.short;
  ctx.fillStyle = tone;
  roundRect(ctx, 32, 120, 6, CARD_HEIGHT - 240, 3);
  ctx.fill();

  const left = 88;
  const right = CARD_WIDTH - 88;

  // Header: mark and wordmark, network on the right.
  mark(ctx, left - 6, 62, 44);
  ctx.fillStyle = C.paper;
  ctx.font = `650 28px ${SANS}`;
  ctx.fillText("Dry Powder", left + 48, 94);
  ctx.fillStyle = C.faint;
  ctx.font = `400 20px ${SANS}`;
  ctx.textAlign = "right";
  ctx.fillText(card.network, right, 92);
  ctx.textAlign = "left";

  // Subject line.
  let y = 176;
  ctx.fillStyle = C.paper;
  if (card.kind === "trade") {
    const lev = card.leverage !== null ? ` ${card.leverage >= 10 ? Math.round(card.leverage) : Math.round(card.leverage * 10) / 10}x` : "";
    const subject = `${card.symbol}${card.side ? `  ·  ${card.side}${lev}` : ""}`;
    fit(ctx, subject, "650", SANS, 44, right - left - 220);
    ctx.fillText(subject, left, y);
    // Status chip on the right.
    ctx.font = `500 20px ${SANS}`;
    const w = ctx.measureText(card.status).width + 32;
    ctx.fillStyle = C.ink;
    roundRect(ctx, right - w, y - 32, w, 42, 6);
    ctx.fill();
    ctx.strokeStyle = C.line;
    ctx.stroke();
    ctx.fillStyle = card.status === "Liquidated" ? C.short : C.muted;
    ctx.textAlign = "right";
    ctx.fillText(card.status, right - 16, y - 4);
    ctx.textAlign = "left";
  } else {
    fit(ctx, card.trader, "650", SANS, 44, right - left - 260);
    ctx.fillText(card.trader, left, y);
    ctx.fillStyle = C.muted;
    ctx.font = `400 22px ${SANS}`;
    ctx.textAlign = "right";
    ctx.fillText(card.period, right, y - 4);
    ctx.textAlign = "left";
  }

  // Headline number and the PnL beside it.
  y = 336;
  const headline = card.headline ?? card.pnl;
  ctx.fillStyle = tone;
  const size = fit(ctx, headline, "600", MONO, 132, 640);
  ctx.fillText(headline, left - 4, y);
  ctx.font = `600 ${size}px ${MONO}`;
  const used = ctx.measureText(headline).width;
  if (card.headline !== null) {
    ctx.fillStyle = C.paper;
    const label = card.kind === "trade" ? "on margin" : "return";
    ctx.font = `500 36px ${MONO}`;
    const pnlX = left + used + 36;
    const pnlMax = right - pnlX;
    if (pnlMax > 160) {
      fit(ctx, card.pnl, "500", MONO, 36, pnlMax);
      ctx.fillText(card.pnl, pnlX, y - 52);
      ctx.fillStyle = C.faint;
      ctx.font = `400 22px ${SANS}`;
      ctx.fillText(label, pnlX, y - 16);
    }
  }

  // Figures: up to four columns.
  y = 448;
  const figures = card.figures.slice(0, 4);
  const col = (right - left) / Math.max(1, figures.length);
  ctx.strokeStyle = C.line;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(left, y - 40);
  ctx.lineTo(right, y - 40);
  ctx.stroke();
  figures.forEach((f, i) => {
    const x = left + i * col;
    ctx.fillStyle = C.faint;
    ctx.font = `400 20px ${SANS}`;
    ctx.fillText(f.label, x, y);
    ctx.fillStyle = C.paper;
    fit(ctx, f.value, "500", MONO, 32, col - 40);
    ctx.fillText(f.value, x, y + 44);
  });

  // Footer: who and when on the left, where on the right.
  y = CARD_HEIGHT - 72;
  ctx.fillStyle = C.muted;
  ctx.font = `400 22px ${SANS}`;
  const who = card.kind === "trade" ? `${card.trader}  ·  ${card.when}` : "On-chain results, checkable on the trader's profile";
  fit(ctx, who, "400", SANS, 22, (right - left) * 0.58);
  ctx.fillText(who, left, y);
  ctx.fillStyle = C.signal;
  ctx.textAlign = "right";
  fit(ctx, card.url, "500", SANS, 22, (right - left) * 0.4);
  ctx.fillText(card.url, right, y);
  ctx.textAlign = "left";

  return canvas;
}

/** The card as a PNG blob. */
export async function renderCard(card: ShareCard, scale = 2): Promise<Blob> {
  const canvas = await drawCard(card, scale);
  return new Promise((resolve, reject) => canvas.toBlob((b) => (b ? resolve(b) : reject(new Error("Could not encode the image"))), "image/png"));
}

/** A short, safe file name: "dry-powder-btc-usd-long-2026-10-18.png". */
export function cardFileName(card: ShareCard, date = new Date()): string {
  const day = date.toISOString().slice(0, 10);
  const base = card.kind === "trade" ? `${card.symbol}-${card.side ?? "trade"}` : `profile-${card.trader}`;
  return `dry-powder-${base}-${day}`.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/-+/g, "-") + ".png";
}

/** The site address without the scheme, for the card's footer: "0xandersen.github.io/dry-powder". */
export function displayUrl(href: string): string {
  try {
    const u = new URL(href);
    const path = u.pathname.replace(/\/(trade|markets|portfolio|activity|leaderboard|trader|house|agents)\/?$/, "").replace(/\/$/, "");
    return `${u.host}${path}`;
  } catch {
    return href;
  }
}
