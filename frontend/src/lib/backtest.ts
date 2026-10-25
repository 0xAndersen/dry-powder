/**
 * A hypothetical replay of a trend or mean-reversion strategy over recent candles. The signal follows the contract
 * line by line (`Strategies._sample`: the same EMAs, warm-up, hysteresis and bands), positions follow the engine
 * (fees by the market's fee mode, liquidation at a 90% loss of margin, profit capped at a multiple of margin), and
 * fills are at candle closes. Floats throughout: a preview of how the rules behave, not a promise.
 *
 * Pure: no app modules, so `node --test` can import it directly.
 */

export type BtCandle = { time: number; open: number; high: number; low: number; close: number };
export type BtSide = "flat" | "long" | "short";

export type BtConfig = {
  kind: "trend" | "meanRevert";
  /** Seconds between readings. */
  interval: number;
  /** Margin of each entry, in collateral units. */
  margin: number;
  leverage: number;
  allowShort: boolean;
  /** 0: none. */
  stopLossBps: number;
  /** 0: none. */
  takeProfitBps: number;
  period: number;
  slowPeriod: number;
  bandBps: number;
  exitBps: number;
};

export type BtFees = {
  /** Standard: a fee on each side and the spread. Upside: no fee, fills at the mid, a share of a winning close. */
  mode: "standard" | "upside";
  baseFeeBps: number;
  /** A side's fee is capped at this share of the margin (the engine's 10%). */
  feeCapBps: number;
  /** The full bid-ask spread in basis points: an entry pays half of it, an exit the other half (Standard only). */
  spreadBps: number;
  /** Paid to the keeper for each order it fills: entries, closes, stops and targets. */
  executionFee: number;
  profitShareBps: number;
  maxProfitMultiple: number;
};

export type BtExit = "signal" | "stop" | "target" | "liquidation" | "open";

export type BtTrade = {
  side: "long" | "short";
  entryTime: number;
  entryPrice: number;
  exitTime: number;
  exitPrice: number;
  size: number;
  margin: number;
  /** Price PnL, after the profit cap and before fees (a liquidation: minus the margin). */
  gross: number;
  fees: number;
  net: number;
  /** How it ended; "open" for a position still held at the end (valued as if closed then). */
  exit: BtExit;
};

/** One candle of the replay. `a`/`b`: trend, the fast and slow averages; mean reversion, the average (in `a`). */
export type BtPoint = { time: number; close: number; a: number | null; b: number | null; held: BtSide; equity: number };

export type BtResult = {
  points: BtPoint[];
  trades: BtTrade[];
  /** Result over the window, fees included, the open position valued at the last close. */
  net: number;
  fees: number;
  wins: number;
  losses: number;
  liquidations: number;
  /** Largest fall of the result from a high, in collateral units (≥ 0). */
  maxDrawdown: number;
  /** Share of the window spent holding a position. */
  exposure: number;
  /** Readings taken, and how many the strategy needs before it acts. */
  readings: number;
  warmup: number;
  /** True when the window ends before the warm-up does: the strategy would not have traded yet. */
  tooShort: boolean;
  from: number;
  to: number;
};

const BPS = 10_000;
const LIQUIDATION = 0.9;

/** Seconds of the largest candle that divides `interval` evenly (so readings land on candle closes). */
export function pickResolution(interval: number, candleMinutes: readonly number[]): number {
  let best = Math.min(...candleMinutes);
  for (const m of candleMinutes) {
    const s = m * 60;
    if (s <= interval && interval % s === 0 && m > best) best = m;
  }
  return best * 60;
}

const ema = (prev: number, price: number, period: number): number => {
  const alpha = 2 / (period + 1);
  return price * alpha + prev * (1 - alpha);
};

type Open = {
  side: "long" | "short";
  entryIndex: number;
  entryTime: number;
  entryPrice: number;
  size: number;
  margin: number;
  stop: number;
  target: number;
  liquidation: number;
  /** Fees paid so far (the entry). */
  fees: number;
};

/**
 * Replays `cfg` over `candles` (oldest first, each `candleSeconds` long). A reading is taken at the first candle
 * close and then at each close at least `interval` after the last, as keeper pokes do.
 */
export function runBacktest(candles: readonly BtCandle[], candleSeconds: number, cfg: BtConfig, fees: BtFees): BtResult {
  const half = fees.mode === "upside" ? 0 : Math.max(0, fees.spreadBps) / 2 / BPS;
  const size = cfg.margin * cfg.leverage;
  const sideFee = (notional: number, margin: number) => (fees.mode === "upside" ? 0 : Math.min((notional * fees.baseFeeBps) / BPS, (margin * fees.feeCapBps) / BPS));
  const warmup = cfg.kind === "trend" ? cfg.slowPeriod : cfg.period;

  const points: BtPoint[] = [];
  const trades: BtTrade[] = [];
  let realized = 0;
  let feesTotal = 0;
  let peak = 0;
  let maxDrawdown = 0;
  let heldCandles = 0;

  // Contract state.
  let target: BtSide = "flat";
  let readings = 0;
  let emaFast = 0;
  let emaSlow = 0;
  let nextAt = -Infinity;
  let a: number | null = null;
  let b: number | null = null;
  let pos: Open | null = null;

  const pnlAt = (p: Open, price: number) => (p.side === "long" ? (p.size * (price - p.entryPrice)) / p.entryPrice : (p.size * (p.entryPrice - price)) / p.entryPrice);

  const close = (p: Open, price: number, time: number, exit: BtExit): BtTrade => {
    let gross: number;
    let fee = p.fees;
    if (exit === "liquidation") {
      gross = -p.margin;
    } else {
      gross = Math.max(-p.margin, Math.min(pnlAt(p, price), fees.maxProfitMultiple * p.margin));
      fee += fees.executionFee;
      if (fees.mode === "upside") {
        if (gross > 0) fee += (gross * fees.profitShareBps) / BPS;
      } else {
        // The close fee comes out of what is left of the margin.
        fee += Math.max(0, Math.min(sideFee(p.size, p.margin), p.margin + gross));
      }
    }
    return { side: p.side, entryTime: p.entryTime, entryPrice: p.entryPrice, exitTime: time, exitPrice: price, size: p.size, margin: p.margin, gross, fees: fee, net: gross - fee, exit };
  };

  const settle = (t: BtTrade) => {
    trades.push(t);
    realized += t.net;
    feesTotal += t.fees;
  };

  const open = (side: "long" | "short", mid: number, index: number, time: number): Open => {
    // Marketable entry: a long pays the ask, a short gets the bid; brackets are set from that price.
    const ref = side === "long" ? mid * (1 + half) : mid * (1 - half);
    const sl = cfg.stopLossBps / BPS;
    const tp = cfg.takeProfitBps / BPS;
    const room = LIQUIDATION / Math.max(1, cfg.leverage);
    const entryFee = sideFee(size, cfg.margin) + fees.executionFee;
    return {
      side,
      entryIndex: index,
      entryTime: time,
      entryPrice: ref,
      size,
      margin: cfg.margin,
      stop: cfg.stopLossBps ? (side === "long" ? ref * (1 - sl) : ref * (1 + sl)) : 0,
      target: cfg.takeProfitBps ? (side === "long" ? ref * (1 + tp) : ref * (1 - tp)) : 0,
      liquidation: side === "long" ? ref * (1 - room) : ref * (1 + room),
      fees: entryFee,
    };
  };

  /** A stop, a target or a liquidation inside candle `c`; the adverse side is assumed to come first. */
  const intrabar = (p: Open, c: BtCandle): { price: number; exit: BtExit } | null => {
    if (p.side === "long") {
      if (p.stop > p.liquidation && c.low <= p.stop) {
        const px = Math.min(p.stop, c.open);
        return px <= p.liquidation ? { price: p.liquidation, exit: "liquidation" } : { price: px * (1 - half), exit: "stop" };
      }
      if (c.low <= p.liquidation) return { price: p.liquidation, exit: "liquidation" };
      if (p.target > 0 && c.high >= p.target) return { price: p.target * (1 - half), exit: "target" };
      return null;
    }
    if (p.stop > 0 && p.stop < p.liquidation && c.high >= p.stop) {
      const px = Math.max(p.stop, c.open);
      return px >= p.liquidation ? { price: p.liquidation, exit: "liquidation" } : { price: px * (1 + half), exit: "stop" };
    }
    if (c.high >= p.liquidation) return { price: p.liquidation, exit: "liquidation" };
    if (p.target > 0 && c.low <= p.target) return { price: p.target * (1 + half), exit: "target" };
    return null;
  };

  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i]!;
    const time = c.time + candleSeconds;

    // 1. A stop, a target or a liquidation during the candle (not the one the position opened at the close of).
    if (pos !== null && i > pos.entryIndex) {
      const hit = intrabar(pos, c);
      if (hit) {
        settle(close(pos, hit.price, time, hit.exit));
        pos = null;
      }
    }

    // 2. A reading, when one is due: the contract's signal, then one step towards it.
    if (time >= nextAt) {
      nextAt = time + cfg.interval;
      const mid = c.close;
      let want: BtSide = target;
      if (cfg.kind === "trend") {
        emaFast = readings === 0 ? mid : ema(emaFast, mid, cfg.period);
        emaSlow = readings === 0 ? mid : ema(emaSlow, mid, cfg.slowPeriod);
        readings += 1;
        a = emaFast;
        b = emaSlow;
        if (readings >= cfg.slowPeriod) {
          if (emaFast * BPS > emaSlow * (BPS + cfg.bandBps)) want = "long";
          else if (emaFast * BPS < emaSlow * (BPS - cfg.bandBps)) want = cfg.allowShort ? "short" : "flat";
        }
      } else {
        // The price is compared with the average of the readings before it, then folded in.
        const avg = emaFast;
        if (readings >= cfg.period) {
          const p = mid * BPS;
          if (p < avg * (BPS - cfg.bandBps)) want = "long";
          else if (p > avg * (BPS + cfg.bandBps)) want = cfg.allowShort ? "short" : "flat";
          else if (want === "long" && p >= avg * (BPS - cfg.exitBps)) want = "flat";
          else if (want === "short" && p <= avg * (BPS + cfg.exitBps)) want = "flat";
        }
        a = readings === 0 ? mid : avg;
        emaFast = readings === 0 ? mid : ema(avg, mid, cfg.period);
        readings += 1;
        b = null;
      }
      if (want !== target) {
        target = want;
        // A position on the wrong side is closed; the new one opens straight after (a flip is two orders).
        if (pos !== null && pos.side !== want) {
          settle(close(pos, pos.side === "long" ? mid * (1 - half) : mid * (1 + half), time, "signal"));
          pos = null;
        }
        if (pos === null && want !== "flat") pos = open(want, mid, i, time);
      }
    }

    // 3. The result so far, with the position valued at the close.
    let equity = realized;
    if (pos !== null) {
      equity += Math.max(-pos.margin, Math.min(pnlAt(pos, c.close), fees.maxProfitMultiple * pos.margin)) - pos.fees;
      heldCandles += 1;
    }
    if (equity > peak) peak = equity;
    if (peak - equity > maxDrawdown) maxDrawdown = peak - equity;
    points.push({ time, close: c.close, a, b, held: pos === null ? "flat" : pos.side, equity });
  }

  // A position still held at the end, valued as if closed at the last close.
  let net = realized;
  let feeSum = feesTotal;
  const last = candles[candles.length - 1];
  if (pos !== null && last) {
    const t = close(pos, pos.side === "long" ? last.close * (1 - half) : last.close * (1 + half), last.time + candleSeconds, "open");
    trades.push(t);
    net += t.net;
    feeSum += t.fees;
  }

  const closed = trades.filter((t) => t.exit !== "open");
  return {
    points,
    trades,
    net,
    fees: feeSum,
    wins: closed.filter((t) => t.net > 0).length,
    losses: closed.filter((t) => t.net <= 0).length,
    liquidations: closed.filter((t) => t.exit === "liquidation").length,
    maxDrawdown,
    exposure: candles.length > 0 ? heldCandles / candles.length : 0,
    readings,
    warmup,
    tooShort: readings < warmup,
    from: candles.length > 0 ? candles[0]!.time : 0,
    to: candles.length > 0 ? candles[candles.length - 1]!.time + candleSeconds : 0,
  };
}
