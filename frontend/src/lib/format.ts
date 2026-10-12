import { formatUnits, parseUnits } from "viem";

export const USDC_DECIMALS = 6;
export const PRICE_DECIMALS = 18;
export const TOKEN_DECIMALS = 18;
export const MAX_UINT256 = (1n << 256n) - 1n;

function group(intPart: string): string {
  return intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/**
 * Formats a fixed-point bigint with thousands separators, truncated (never rounded up) to `dp` decimals.
 * Pure string/bigint arithmetic, so large values keep full precision.
 */
export function fmtUnits(
  value: bigint,
  unitDecimals: number,
  dp: number,
  opts: { sign?: boolean; trimZeros?: boolean } = {},
): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const [intPart = "0", fracRaw = ""] = formatUnits(abs, unitDecimals).split(".");
  let frac = fracRaw.padEnd(dp, "0").slice(0, dp);
  if (opts.trimZeros) frac = frac.replace(/0+$/, "");
  const body = frac.length > 0 ? `${group(intPart)}.${frac}` : group(intPart);
  const isZero = /^[0.,]*$/.test(body);
  if (negative && !isZero) return `−${body}`;
  if (opts.sign && !isZero) return `+${body}`;
  return body;
}

export function fmtUsdc(value: bigint, dp = 2, opts: { sign?: boolean } = {}): string {
  return fmtUnits(value, USDC_DECIMALS, dp, opts);
}

export function fmtPrice(value: bigint, dp: number): string {
  return fmtUnits(value, PRICE_DECIMALS, dp);
}

export function fmtToken(value: bigint, dp = 2): string {
  return fmtUnits(value, TOKEN_DECIMALS, dp);
}

/** Display-only compact notation (1.2K, 3.4M). */
export function fmtCompact(value: bigint, unitDecimals: number): string {
  const n = Number(formatUnits(value, unitDecimals));
  if (!Number.isFinite(n)) return "—";
  if (Math.abs(n) < 10_000) return n.toLocaleString("en-US", { maximumFractionDigits: 2 });
  return new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 2 }).format(n);
}

export function fmtPercent(fraction: number, dp = 2, sign = false): string {
  if (!Number.isFinite(fraction)) return "—";
  const pct = fraction * 100;
  const body = Math.abs(pct).toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp });
  const isZero = Number(Math.abs(pct).toFixed(dp)) === 0;
  if (pct < 0 && !isZero) return `−${body}%`;
  if (sign && !isZero) return `+${body}%`;
  return `${body}%`;
}

/**
 * Parses user input into a fixed-point bigint. Returns null for anything that is not a plain
 * non-negative decimal number. Digits beyond `decimals` are dropped.
 */
export function parseAmount(input: string, decimals: number): bigint | null {
  const text = input.trim().replace(/,/g, "");
  if (text === "" || text === ".") return null;
  if (!/^\d*\.?\d*$/.test(text)) return null;
  const [intPart = "", fracPart = ""] = text.split(".");
  const normalised = `${intPart || "0"}${decimals > 0 && fracPart ? `.${fracPart.slice(0, decimals)}` : ""}`;
  try {
    return parseUnits(normalised, decimals);
  } catch {
    return null;
  }
}

/** Plain decimal string for putting an on-chain amount back into an input (no separators). */
export function toInputString(value: bigint, unitDecimals: number, dp: number): string {
  const [intPart = "0", fracRaw = ""] = formatUnits(value, unitDecimals).split(".");
  const frac = fracRaw.slice(0, dp).replace(/0+$/, "");
  return frac ? `${intPart}.${frac}` : intPart;
}

export function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function fmtDuration(totalSeconds: number): string {
  const s = Math.max(0, Math.floor(totalSeconds));
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h ${m}m`;
  if (h > 0) return `${h}h ${m}m ${sec}s`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function fmtAge(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  if (s < 90) return `${s}s`;
  if (s < 5400) return `${Math.round(s / 60)} min`;
  if (s < 172800) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} days`;
}
