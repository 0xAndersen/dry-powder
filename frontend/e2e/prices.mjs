// One price model shared by the on-chain publisher and the mock Kraken API, so the tape the UI shows and the
// oracle prices orders execute at stay consistent, like they do when both follow the real market.
import { FEEDS } from "./lib.mjs";

/** Half the bid/ask spread as a fraction of mid. Also the oracle confidence (>= 1 bp, as on testnet). */
const HALF_SPREAD = 0.00012;

export class PriceModel {
  constructor({ volatility = 1 } = {}) {
    this.volatility = volatility;
    this.prices = Object.fromEntries(Object.entries(FEEDS).map(([key, f]) => [key, f.price]));
    this.drift = Object.fromEntries(Object.keys(FEEDS).map((key) => [key, 0]));
    this.frozen = new Set();
    this.candles = new Map();
    this.timer = null;
  }

  start() {
    this.timer = setInterval(() => this.step(), 250);
  }

  stop() {
    clearInterval(this.timer);
  }

  /** Stops a feed from being published on-chain (the tape keeps moving): simulates a stale oracle. */
  freeze(key, on) {
    if (on) this.frozen.add(key);
    else this.frozen.delete(key);
  }

  /** Moves a feed by `percent` at once (tests use it to push a price through a stop or an alert). */
  move(key, percent) {
    this.prices[key] *= 1 + percent / 100;
    this.drift[key] = 0;
  }

  step() {
    for (const [key, feed] of Object.entries(FEEDS)) {
      // Mean-reverting drift plus noise: trends that last a while, so charts and PnL are worth looking at.
      this.drift[key] = this.drift[key] * 0.97 + (Math.random() - 0.5) * 0.00006;
      const shock = (Math.random() - 0.5) * 0.0007 + (Math.random() < 0.004 ? (Math.random() - 0.5) * 0.006 : 0);
      this.prices[key] *= 1 + (this.drift[key] + shock) * feed.vol * this.volatility;
    }
  }

  mid(key) {
    return this.prices[key];
  }

  ticker(key) {
    const mid = this.prices[key];
    const dp = mid > 1_000 ? 1 : mid > 10 ? 2 : 5;
    return { bid: (mid * (1 - HALF_SPREAD)).toFixed(dp), ask: (mid * (1 + HALF_SPREAD)).toFixed(dp), last: mid.toFixed(dp) };
  }

  /** Raw oracle values for a feed: integer price and confidence at the feed's exponent. */
  oracle(key) {
    const feed = FEEDS[key];
    const scale = 10 ** -feed.expo;
    const price = BigInt(Math.round(this.prices[key] * scale));
    const conf = BigInt(Math.max(1, Math.round(this.prices[key] * HALF_SPREAD * scale)));
    return { id: feed.id, expo: feed.expo, price, conf };
  }

  /** OHLC history: generated backwards from the current price once, then kept and extended with live prices. */
  ohlc(key, minutes) {
    const seconds = minutes * 60;
    const now = Math.floor(Date.now() / 1000);
    const bucket = Math.floor(now / seconds) * seconds;
    const cacheKey = `${key}:${minutes}`;
    let series = this.candles.get(cacheKey);
    const price = this.prices[key];
    if (!series) {
      series = [];
      let close = price;
      const sigma = 0.0009 * Math.sqrt(minutes) * FEEDS[key].vol;
      for (let i = 0; i < 720; i += 1) {
        const time = bucket - i * seconds;
        const open = close / (1 + Math.sin((time / seconds) * 0.11) * sigma * 0.35 + (Math.random() - 0.5) * sigma * 2);
        const high = Math.max(open, close) * (1 + Math.random() * sigma * 0.6);
        const low = Math.min(open, close) * (1 - Math.random() * sigma * 0.6);
        const volume = (20 + Math.random() * 180) * (1 + (Math.abs(close - open) / open) * 400);
        series.unshift({ time, open, high, low, close, volume });
        close = open;
      }
      this.candles.set(cacheKey, series);
    }
    let last = series[series.length - 1];
    while (last.time < bucket) {
      last = { time: last.time + seconds, open: last.close, high: last.close, low: last.close, close: last.close, volume: 5 + Math.random() * 40 };
      series.push(last);
      if (series.length > 720) series.shift();
    }
    last.close = price;
    last.high = Math.max(last.high, price);
    last.low = Math.min(last.low, price);
    last.volume += Math.random() * 0.8;
    return series;
  }
}
