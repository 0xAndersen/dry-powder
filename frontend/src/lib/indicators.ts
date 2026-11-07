import type { Candle } from "./kraken";

/** Technical indicators over a candle series. Each returns one value per candle; null until it has enough data. */

export type Series = (number | null)[];

export function sma(values: readonly number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period < 1) return out;
  let sum = 0;
  for (let i = 0; i < values.length; i += 1) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values: readonly number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period < 1 || values.length < period) return out;
  const k = 2 / (period + 1);
  let seed = 0;
  for (let i = 0; i < period; i += 1) seed += values[i]!;
  let prev = seed / period;
  out[period - 1] = prev;
  for (let i = period; i < values.length; i += 1) {
    prev = values[i]! * k + prev * (1 - k);
    out[i] = prev;
  }
  return out;
}

export function bollinger(values: readonly number[], period: number, multiplier: number) {
  const middle = sma(values, period);
  const upper: Series = new Array(values.length).fill(null);
  const lower: Series = new Array(values.length).fill(null);
  for (let i = period - 1; i < values.length; i += 1) {
    const mean = middle[i];
    if (mean === null || mean === undefined) continue;
    let variance = 0;
    for (let j = i - period + 1; j <= i; j += 1) variance += (values[j]! - mean) ** 2;
    const deviation = Math.sqrt(variance / period);
    upper[i] = mean + multiplier * deviation;
    lower[i] = mean - multiplier * deviation;
  }
  return { middle, upper, lower };
}

/** Volume-weighted average price, restarted at each UTC midnight. Falls back to the typical price without volume. */
export function vwap(candles: readonly Candle[]): Series {
  const out: Series = new Array(candles.length).fill(null);
  let day = -1;
  let pv = 0;
  let volume = 0;
  let count = 0;
  let sumTypical = 0;
  for (let i = 0; i < candles.length; i += 1) {
    const c = candles[i]!;
    const d = Math.floor(c.time / 86_400);
    if (d !== day) {
      day = d;
      pv = 0;
      volume = 0;
      count = 0;
      sumTypical = 0;
    }
    const typical = (c.high + c.low + c.close) / 3;
    pv += typical * c.volume;
    volume += c.volume;
    count += 1;
    sumTypical += typical;
    out[i] = volume > 0 ? pv / volume : sumTypical / count;
  }
  return out;
}

/** Wilder's relative strength index. */
export function rsi(values: readonly number[], period: number): Series {
  const out: Series = new Array(values.length).fill(null);
  if (period < 1 || values.length <= period) return out;
  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = values[i]! - values[i - 1]!;
    if (change >= 0) gain += change;
    else loss -= change;
  }
  gain /= period;
  loss /= period;
  out[period] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i]! - values[i - 1]!;
    gain = (gain * (period - 1) + Math.max(change, 0)) / period;
    loss = (loss * (period - 1) + Math.max(-change, 0)) / period;
    out[i] = loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
  }
  return out;
}

export function macd(values: readonly number[], fast: number, slow: number, signalPeriod: number) {
  const fastLine = ema(values, fast);
  const slowLine = ema(values, slow);
  const line: Series = values.map((_, i) => {
    const f = fastLine[i];
    const s = slowLine[i];
    return f === null || f === undefined || s === null || s === undefined ? null : f - s;
  });
  const start = line.findIndex((v) => v !== null);
  const signal: Series = new Array(values.length).fill(null);
  if (start >= 0) {
    const compact = line.slice(start) as number[];
    const smoothed = ema(compact, signalPeriod);
    for (let i = 0; i < smoothed.length; i += 1) signal[start + i] = smoothed[i] ?? null;
  }
  const histogram: Series = line.map((v, i) => {
    const s = signal[i];
    return v === null || s === null || s === undefined ? null : v - s;
  });
  return { line, signal, histogram };
}

export type IndicatorSettings = {
  ema1: { on: boolean; period: number };
  ema2: { on: boolean; period: number };
  sma: { on: boolean; period: number };
  bb: { on: boolean; period: number; mult: number };
  vwap: { on: boolean };
  rsi: { on: boolean; period: number };
  macd: { on: boolean; fast: number; slow: number; signal: number };
  volume: { on: boolean };
};

export const DEFAULT_INDICATORS: IndicatorSettings = {
  ema1: { on: true, period: 20 },
  ema2: { on: false, period: 50 },
  sma: { on: false, period: 100 },
  bb: { on: false, period: 20, mult: 2 },
  vwap: { on: false },
  rsi: { on: false, period: 14 },
  macd: { on: false, fast: 12, slow: 26, signal: 9 },
  volume: { on: true },
};
