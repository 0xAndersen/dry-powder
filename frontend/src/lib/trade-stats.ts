import type { ClosedTrade } from "./aggregate";

/** Performance of a set of finished round trips (portfolio, trader profiles). Amounts in collateral micro-units. */
export type SideStats = { trades: number; wins: number; net: bigint; volume: bigint };

export type TradeStats = {
  trades: number;
  wins: number;
  losses: number;
  liquidations: number;
  /** Wins over trades; null with no trades. */
  winRate: number | null;
  net: bigint;
  fees: bigint;
  volume: bigint;
  /** Margin put into the trades (known opens only): the ROI denominator. */
  margin: bigint;
  /** Net over margin; null without margin. */
  roi: number | null;
  grossWin: bigint;
  grossLoss: bigint;
  /** Gross wins over gross losses: null without losses (or without trades). */
  profitFactor: number | null;
  avgWin: bigint | null;
  avgLoss: bigint | null;
  /** Average net per trade. */
  expectancy: bigint | null;
  best: ClosedTrade | null;
  worst: ClosedTrade | null;
  /** Largest fall of cumulative net from a previous high, in the order trades closed. */
  maxDrawdown: bigint;
  /** Average time a position was held, in seconds, over trades whose open is known. */
  avgHold: number | null;
  long: SideStats;
  short: SideStats;
  byMarket: Map<string, SideStats>;
  /** Net by UTC day number (unix day). */
  days: Map<number, { net: bigint; trades: number }>;
  /** Cumulative net after each trade, oldest first. */
  curve: { time: number; value: bigint }[];
};

const side = (): SideStats => ({ trades: 0, wins: 0, net: 0n, volume: 0n });

/** `trades` in any order; they are taken oldest first. */
export function tradeStats(trades: readonly ClosedTrade[]): TradeStats {
  const list = [...trades].sort((a, b) => a.closeTime - b.closeTime || a.id.localeCompare(b.id));
  const out: TradeStats = {
    trades: 0,
    wins: 0,
    losses: 0,
    liquidations: 0,
    winRate: null,
    net: 0n,
    fees: 0n,
    volume: 0n,
    margin: 0n,
    roi: null,
    grossWin: 0n,
    grossLoss: 0n,
    profitFactor: null,
    avgWin: null,
    avgLoss: null,
    expectancy: null,
    best: null,
    worst: null,
    maxDrawdown: 0n,
    avgHold: null,
    long: side(),
    short: side(),
    byMarket: new Map(),
    days: new Map(),
    curve: [],
  };
  let cum = 0n;
  let peak = 0n;
  let held = 0;
  let heldCount = 0;
  for (const t of list) {
    out.trades += 1;
    out.net += t.net;
    out.fees += t.fees ?? 0n;
    out.volume += t.volume ?? 0n;
    out.margin += t.margin ?? 0n;
    if (t.liquidated) out.liquidations += 1;
    if (t.net > 0n) {
      out.wins += 1;
      out.grossWin += t.net;
    } else if (t.net < 0n) {
      out.losses += 1;
      out.grossLoss -= t.net;
    }
    if (!out.best || t.net > out.best.net) out.best = t;
    if (!out.worst || t.net < out.worst.net) out.worst = t;
    cum += t.net;
    if (cum > peak) peak = cum;
    if (peak - cum > out.maxDrawdown) out.maxDrawdown = peak - cum;
    out.curve.push({ time: t.closeTime, value: cum });
    if (t.openTime !== null) {
      held += Math.max(0, t.closeTime - t.openTime);
      heldCount += 1;
    }
    const sides = t.isLong === null ? [] : [t.isLong ? out.long : out.short];
    let m = out.byMarket.get(t.marketId);
    if (!m) {
      m = side();
      out.byMarket.set(t.marketId, m);
    }
    sides.push(m);
    for (const s of sides) {
      s.trades += 1;
      if (t.net > 0n) s.wins += 1;
      s.net += t.net;
      s.volume += t.volume ?? 0n;
    }
    const day = Math.floor(t.closeTime / 86_400);
    const d = out.days.get(day) ?? { net: 0n, trades: 0 };
    d.net += t.net;
    d.trades += 1;
    out.days.set(day, d);
  }
  if (out.trades > 0) {
    out.winRate = out.wins / out.trades;
    out.expectancy = out.net / BigInt(out.trades);
    out.profitFactor = out.grossLoss > 0n ? Number((out.grossWin * 1000n) / out.grossLoss) / 1000 : null;
  }
  if (out.wins > 0) out.avgWin = out.grossWin / BigInt(out.wins);
  if (out.losses > 0) out.avgLoss = -(out.grossLoss / BigInt(out.losses));
  if (heldCount > 0) out.avgHold = held / heldCount;
  if (out.margin > 0n) out.roi = Number((out.net * 1_000_000n) / out.margin) / 1e6;
  return out;
}
