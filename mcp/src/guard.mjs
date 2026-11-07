// Guardrails and two-step confirmation, ported from Project Nexus's MCP server (mcp/src/guardrails.ts and
// confirm.ts) to Dry Powder's USDC-notional, keeper-filled orders.
import { randomBytes } from "node:crypto";

export class ToolError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const BPS = 10_000n;

export class Guardrails {
  /** @param {{allowedMarkets?: string[], maxNotional: bigint, maxLeverage: number, maxSlippageBps: number}} c */
  constructor(c) {
    this.c = c;
  }
  isAllowed(symbol) {
    return !this.c.allowedMarkets || this.c.allowedMarkets.includes(symbol.toUpperCase());
  }
  checkMarket(m) {
    if (!this.isAllowed(m.symbol)) throw new ToolError("MARKET_NOT_ALLOWED", `${m.symbol} is not in DP_ALLOWED_MARKETS (${this.c.allowedMarkets.join(", ")})`);
    if (!m.enabled) throw new ToolError("MARKET_DISABLED", `${m.symbol} is not accepting new positions`);
    if (m.settled) throw new ToolError("MARKET_SETTLED", `${m.symbol} has settled; positions can only be closed`);
    if (m.expiry && Date.now() / 1000 >= m.expiry) throw new ToolError("MARKET_EXPIRED", `${m.symbol} has expired`);
  }
  /** `size` in 6-decimal USDC notional. */
  checkNotional(size) {
    if (size > this.c.maxNotional) {
      throw new ToolError("MAX_NOTIONAL_EXCEEDED", `size $${Number(size) / 1e6} exceeds the per-order cap $${Number(this.c.maxNotional) / 1e6} (DP_MAX_NOTIONAL_USD)`);
    }
  }
  checkLeverage(m, leverage) {
    const max = Math.min(m.maxLeverage, this.c.maxLeverage);
    if (!(leverage >= 1 && leverage <= max)) throw new ToolError("LEVERAGE_OUT_OF_RANGE", `leverage must be between 1 and ${max} for ${m.symbol} (market max ${m.maxLeverage}, DP_MAX_LEVERAGE ${this.c.maxLeverage})`);
  }
  checkSlippage(bps) {
    if (!(Number.isInteger(bps) && bps >= 0 && bps <= this.c.maxSlippageBps)) throw new ToolError("SLIPPAGE_TOO_HIGH", `slippageBps must be an integer between 0 and ${this.c.maxSlippageBps}`);
  }
  /**
   * Price band: no order may be worse than `maxSlippageBps` from the reference price (a long's limit at most
   * ref × (1 + bps), a short's at least ref × (1 − bps)), so "buy at any price" cannot slip past the cap.
   */
  checkBand(m, isLong, limit, ref) {
    const bps = BigInt(this.c.maxSlippageBps);
    if (isLong ? limit * BPS > ref * (BPS + bps) : limit * BPS < ref * (BPS - bps)) {
      throw new ToolError("PRICE_OUTSIDE_BAND", `${isLong ? "long" : "short"} limit is more than ${bps} bps ${isLong ? "above" : "below"} the ${m.symbol} reference price (DP_MAX_SLIPPAGE_BPS)`);
    }
  }
}

/** Single-use, short-lived tokens bound to the exact arguments of a previewed request. */
export class ConfirmationStore {
  constructor(ttlMs, now = Date.now) {
    this.ttlMs = ttlMs;
    this.now = now;
    this.pending = new Map();
  }
  issue(tool, fp, payload) {
    for (const [k, v] of this.pending) if (this.now() > v.expiresAt) this.pending.delete(k);
    const token = `cfm_${randomBytes(9).toString("base64url")}`;
    const expiresAt = this.now() + this.ttlMs;
    this.pending.set(token, { tool, fp, payload, expiresAt });
    return { token, expiresAt };
  }
  consume(token, tool, fp) {
    const e = this.pending.get(token);
    if (!e || e.tool !== tool) throw new ToolError("UNKNOWN_TOKEN", "unknown or already used confirmToken; request a new preview");
    this.pending.delete(token);
    if (this.now() > e.expiresAt) throw new ToolError("TOKEN_EXPIRED", "confirmToken expired; request a new preview");
    if (e.fp !== fp) throw new ToolError("TOKEN_MISMATCH", "confirmToken was issued for different arguments; call again with exactly the previewed arguments");
    return e.payload;
  }
}

/** Stable JSON of a request (sorted keys, bigints as strings, confirmToken excluded). */
export function fingerprint(args) {
  const { confirmToken: _, ...rest } = args;
  return JSON.stringify(rest, (_k, v) => {
    if (typeof v === "bigint") return v.toString();
    if (v && typeof v === "object" && !Array.isArray(v)) return Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)));
    return v;
  });
}
