import { DEFAULT_INDICATORS, type IndicatorSettings } from "./indicators";

/** Small localStorage-backed stores with a subscribe/getSnapshot surface for useSyncExternalStore. */

export type LocalStore<T> = {
  get: () => T;
  set: (next: T | ((prev: T) => T)) => void;
  subscribe: (listener: () => void) => () => void;
  /** Value used while rendering on the server and during hydration. */
  initial: T;
};

export function createLocalStore<T>(key: string, initial: T, revive: (stored: unknown) => T | null): LocalStore<T> {
  let current = initial;
  let loaded = false;
  const listeners = new Set<() => void>();

  const load = () => {
    if (loaded || typeof window === "undefined") return;
    loaded = true;
    try {
      const raw = window.localStorage.getItem(key);
      if (raw !== null) {
        const revived = revive(JSON.parse(raw));
        if (revived !== null) current = revived;
      }
    } catch {
      // Storage can be unavailable (private mode) or hold garbage; the default applies.
    }
  };

  return {
    initial,
    get: () => {
      load();
      return current;
    },
    set: (next) => {
      load();
      current = typeof next === "function" ? (next as (prev: T) => T)(current) : next;
      try {
        window.localStorage.setItem(key, JSON.stringify(current));
      } catch {
        // Ignored: the value still applies for this session.
      }
      for (const listener of listeners) listener();
    },
    subscribe: (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

export const DEFAULT_SLIPPAGE_BPS = 30;
export const MAX_SLIPPAGE_BPS = 5_000;

export type TradeSettings = {
  slippageBps: number;
  /** Skip the confirmation step. */
  oneClick: boolean;
  /** Approve the collateral token once instead of the exact amount before every order. */
  approveUnlimited: boolean;
  /** Ask the browser to show price alerts as system notifications. */
  notify: boolean;
  /** Keep the ticket's fee, funding and profit-cap breakdown open. */
  ticketDetails: boolean;
};

export const tradeSettings = createLocalStore<TradeSettings>(
  "arc-house:settings:v2",
  { slippageBps: DEFAULT_SLIPPAGE_BPS, oneClick: false, approveUnlimited: true, notify: false, ticketDetails: false },
  (stored) => {
    if (!stored || typeof stored !== "object") return null;
    const s = stored as Partial<TradeSettings>;
    const slippage = Number(s.slippageBps);
    return {
      slippageBps: Number.isInteger(slippage) && slippage >= 0 && slippage <= MAX_SLIPPAGE_BPS ? slippage : DEFAULT_SLIPPAGE_BPS,
      oneClick: s.oneClick === true,
      approveUnlimited: s.approveUnlimited !== false,
      notify: s.notify === true,
      ticketDetails: s.ticketDetails === true,
    };
  },
);

function num(value: unknown, fallback: number, min: number, max: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n >= min && n <= max ? n : fallback;
}

export const indicatorSettings = createLocalStore<IndicatorSettings>("arc-house:indicators:v1", DEFAULT_INDICATORS, (stored) => {
  if (!stored || typeof stored !== "object") return null;
  const s = stored as Partial<Record<keyof IndicatorSettings, Record<string, unknown>>>;
  const d = DEFAULT_INDICATORS;
  return {
    ema1: { on: s.ema1?.on === true, period: num(s.ema1?.period, d.ema1.period, 2, 500) },
    ema2: { on: s.ema2?.on === true, period: num(s.ema2?.period, d.ema2.period, 2, 500) },
    sma: { on: s.sma?.on === true, period: num(s.sma?.period, d.sma.period, 2, 500) },
    bb: { on: s.bb?.on === true, period: num(s.bb?.period, d.bb.period, 2, 500), mult: num(s.bb?.mult, d.bb.mult, 0.5, 5) },
    vwap: { on: s.vwap?.on === true },
    rsi: { on: s.rsi?.on === true, period: num(s.rsi?.period, d.rsi.period, 2, 100) },
    macd: {
      on: s.macd?.on === true,
      fast: num(s.macd?.fast, d.macd.fast, 2, 200),
      slow: num(s.macd?.slow, d.macd.slow, 3, 400),
      signal: num(s.macd?.signal, d.macd.signal, 2, 100),
    },
    volume: { on: s.volume?.on !== false },
  };
});

export type PriceAlert = {
  id: string;
  marketId: string;
  symbol: string;
  price: number;
  /** Fires when the price is at or above (`above`) / at or below (`below`) the level. */
  direction: "above" | "below";
  createdAt: number;
  /** Unix ms when it fired; fired alerts stay listed until removed. */
  firedAt: number | null;
};

export const priceAlerts = createLocalStore<PriceAlert[]>("arc-house:alerts:v1", [], (stored) => {
  if (!Array.isArray(stored)) return null;
  const out: PriceAlert[] = [];
  for (const item of stored as Partial<PriceAlert>[]) {
    if (!item || typeof item.id !== "string" || typeof item.marketId !== "string") continue;
    const price = Number(item.price);
    if (!(price > 0)) continue;
    out.push({
      id: item.id,
      marketId: item.marketId,
      symbol: typeof item.symbol === "string" ? item.symbol : "",
      price,
      direction: item.direction === "below" ? "below" : "above",
      createdAt: Number(item.createdAt) || 0,
      firedAt: typeof item.firedAt === "number" ? item.firedAt : null,
    });
  }
  return out;
});


/** Horizontal lines the trader drew on a market's chart (support, resistance, levels to watch), by market id. */
export type DrawnLine = { id: string; price: number };
export const chartLines = createLocalStore<Record<string, DrawnLine[]>>("dp:chart-lines:v1", {}, (stored) => {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  const out: Record<string, DrawnLine[]> = {};
  for (const [market, list] of Object.entries(stored as Record<string, unknown>)) {
    if (!Array.isArray(list)) continue;
    const lines = list
      .filter((l): l is DrawnLine => !!l && typeof (l as DrawnLine).id === "string" && Number((l as DrawnLine).price) > 0)
      .map((l) => ({ id: l.id, price: Number(l.price) }))
      .slice(-20);
    if (lines.length > 0) out[market.toLowerCase()] = lines;
  }
  return out;
});
