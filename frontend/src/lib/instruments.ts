import type { Hex } from "viem";
import { assetName, feedMeta, type FeedMeta } from "./feeds";
import { autoDecimals, fmtUtc, priceToNum } from "./format";
import type { Quote } from "./oracle";

const ZERO_ID = `0x${"0".repeat(64)}`;

/** A listed market, normalised from `EngineLens.MarketView`. */
export type Instrument = {
  /** Market id (`priceId` in structs and events). */
  id: Hex;
  symbol: string;
  base: string;
  quote: string;
  name: string;
  kind: InstrumentKindKey;
  feedId: Hex;
  quoteFeedId: Hex | null;
  invert: boolean;
  /** Unix seconds; 0 for instruments without an expiry. */
  expiry: number;
  /** 18 decimals; 0n until a dated market has settled. */
  settlementPrice: bigint;
  enabled: boolean;
  maxLeverage: number;
  maxOiPerSide: bigint;
  skewScale: bigint;
  longOi: bigint;
  shortOi: bigint;
  /** Per second, 1e18 scale; positive means longs pay. */
  fundingRate: bigint;
  /** Fresh validated on-chain price, or null when the oracle has none right now. */
  onchain: Quote | null;
  /** Decimals to show prices with. */
  priceDecimals: number;
  /**
   * What `size / price` counts. With a USD quote that is units of the base asset. On a cross it is not: the
   * position is still USDC notional, so one "contract" is simply what gains 1 USDC per 1.0 move in the price.
   */
  unitLabel: string;
  feed: FeedMeta | undefined;
  quoteFeed: FeedMeta | undefined;
};

export type InstrumentKindKey = "perp" | "cross" | "fx" | "dated";

type KindInput = { expiry: number; quoteFeedId: Hex | null; invert: boolean; feed: FeedMeta | undefined };

/**
 * Instrument types. To add one: add a key above, an entry here (`match` is tried in array order, the
 * first hit wins) and, if it needs its own ticket or header treatment, branch on `instrument.kind`.
 */
export const INSTRUMENT_KINDS: readonly {
  key: InstrumentKindKey;
  /** Group heading in the market selector. */
  label: string;
  /** How one instrument of this kind is described. */
  singular: string;
  /** Position of the group in the selector. */
  order: number;
  /** One line shown under the market name. */
  blurb: string;
  match: (m: KindInput) => boolean;
}[] = [
  {
    key: "dated",
    label: "Dated futures",
    singular: "Dated future",
    order: 3,
    blurb: "Cash-settled at the oracle price at expiry. No funding after expiry.",
    match: (m) => m.expiry !== 0,
  },
  {
    key: "cross",
    label: "Crosses",
    singular: "Cross",
    order: 1,
    blurb: "One asset priced in another. Margin and PnL stay in the collateral token.",
    match: (m) => m.quoteFeedId !== null,
  },
  {
    key: "fx",
    label: "FX & Metals",
    singular: "FX / metal",
    order: 2,
    blurb: "Currency and metal prices. These can go stale when the underlying market is closed.",
    match: (m) => m.invert || m.feed?.class === "fx" || m.feed?.class === "metal",
  },
  { key: "perp", label: "Perpetuals", singular: "Perpetual", order: 0, blurb: "No expiry. Funding keeps longs and shorts balanced.", match: () => true },
];

export function kindInfo(key: InstrumentKindKey) {
  return INSTRUMENT_KINDS.find((k) => k.key === key) ?? INSTRUMENT_KINDS[INSTRUMENT_KINDS.length - 1]!;
}

function parseSymbol(symbol: string, feed: FeedMeta | undefined, quoteFeed: FeedMeta | undefined, invert: boolean) {
  const parts = symbol.split(/[-/]/).filter(Boolean);
  if (parts.length >= 2) return { base: parts[0]!.toUpperCase(), quote: parts[1]!.toUpperCase() };
  if (feed) {
    const base = invert ? feed.quote : feed.base;
    const quote = quoteFeed ? quoteFeed.base : invert ? feed.base : feed.quote;
    return { base, quote };
  }
  return { base: symbol || "?", quote: "USD" };
}

/** Decimals stick per market for the session so figures do not change width while prices move. */
const stickyDecimals = new Map<string, number>();

function decimalsFor(id: string, plain: boolean, feed: FeedMeta | undefined, reference: number | null): number {
  if (plain && feed) return feed.decimals;
  const known = stickyDecimals.get(id);
  if (known !== undefined) return known;
  if (reference === null) return 4;
  const dp = autoDecimals(reference);
  stickyDecimals.set(id, dp);
  return dp;
}

export type RawMarketView = {
  id: Hex;
  market: {
    enabled: boolean;
    invert: boolean;
    maxLeverage: number;
    lastFundingTime: bigint;
    expiry: bigint;
    feedId: Hex;
    quoteFeedId: Hex;
    maxOiPerSide: bigint;
    skewScale: bigint;
    longOi: bigint;
    shortOi: bigint;
    longUnits: bigint;
    shortUnits: bigint;
    fundingIndex: bigint;
    settlementPrice: bigint;
    symbol: string;
  };
  fundingRate: bigint;
  hasPrice: boolean;
  price: { mid: bigint; bid: bigint; ask: bigint; publishTime: bigint };
};

export function toInstrument(view: RawMarketView): Instrument {
  const m = view.market;
  const feed = feedMeta(m.feedId);
  const quoteFeedId = m.quoteFeedId.toLowerCase() === ZERO_ID ? null : (m.quoteFeedId.toLowerCase() as Hex);
  const quoteFeed = feedMeta(quoteFeedId);
  const expiry = Number(m.expiry);
  const kindInput: KindInput = { expiry, quoteFeedId, invert: m.invert, feed };
  const kind = (INSTRUMENT_KINDS.find((k) => k.match(kindInput)) ?? INSTRUMENT_KINDS[INSTRUMENT_KINDS.length - 1]!).key;
  const symbol = m.symbol || `${view.id.slice(0, 10)}…`;
  const { base, quote } = parseSymbol(m.symbol, feed, quoteFeed, m.invert);

  const onchain: Quote | null = view.hasPrice
    ? { mid: view.price.mid, bid: view.price.bid, ask: view.price.ask, publishTime: Number(view.price.publishTime) }
    : null;
  const reference = onchain ? priceToNum(onchain.mid) : m.settlementPrice !== 0n ? priceToNum(m.settlementPrice) : null;
  const plain = quoteFeedId === null && !m.invert;

  let name: string;
  if (expiry !== 0) name = `${assetName(base)} future, expires ${fmtUtc(expiry)}`;
  else if (quoteFeedId !== null) name = `${assetName(base)} priced in ${assetName(quote)}`;
  else if (m.invert) name = `${assetName(base)} (inverse of ${feed ? `${feed.base}/${feed.quote}` : "the feed"})`;
  else name = feed?.name ?? assetName(base);

  return {
    id: view.id.toLowerCase() as Hex,
    symbol,
    base,
    quote,
    name,
    kind,
    feedId: m.feedId.toLowerCase() as Hex,
    quoteFeedId,
    invert: m.invert,
    expiry,
    settlementPrice: m.settlementPrice,
    enabled: m.enabled,
    maxLeverage: m.maxLeverage,
    maxOiPerSide: m.maxOiPerSide,
    skewScale: m.skewScale,
    longOi: m.longOi,
    shortOi: m.shortOi,
    fundingRate: view.fundingRate,
    onchain,
    priceDecimals: decimalsFor(view.id.toLowerCase(), plain, feed, reference),
    unitLabel: quote === "USD" ? base : "contracts",
    feed,
    quoteFeed,
  };
}

/** Lets the display layer fix decimals for a market whose first price arrived from the tape. */
export function ensureDecimals(instrument: Instrument, reference: number | null): number {
  const plain = instrument.quoteFeedId === null && !instrument.invert;
  return decimalsFor(instrument.id, plain, instrument.feed, reference);
}

export function isSettled(instrument: Instrument): boolean {
  return instrument.settlementPrice !== 0n;
}

export function isExpired(instrument: Instrument, nowSeconds: number): boolean {
  return instrument.expiry !== 0 && nowSeconds >= instrument.expiry;
}

/** Every feed id needed to price `instrument`. */
export function feedIdsOf(instrument: Instrument): Hex[] {
  return instrument.quoteFeedId ? [instrument.feedId, instrument.quoteFeedId] : [instrument.feedId];
}

/** Where candles and the tape for `instrument` come from on Kraken, or null when a feed is unknown. */
export function krakenSource(instrument: Instrument): { base: string; quote: string | null; invert: boolean } | null {
  if (!instrument.feed) return null;
  if (instrument.quoteFeedId && !instrument.quoteFeed) return null;
  return { base: instrument.feed.kraken, quote: instrument.quoteFeed?.kraken ?? null, invert: instrument.invert };
}

/** URL-safe handle for a market: its symbol. */
export function marketSlug(instrument: Instrument): string {
  return instrument.symbol.replace(/\//g, "-");
}

export function findBySlug(instruments: readonly Instrument[], slug: string | null | undefined): Instrument | undefined {
  if (!slug) return undefined;
  const wanted = slug.toUpperCase().replace(/\//g, "-");
  return (
    instruments.find((i) => marketSlug(i).toUpperCase() === wanted) ??
    instruments.find((i) => i.id === slug.toLowerCase())
  );
}

export function groupInstruments(instruments: readonly Instrument[]) {
  return [...INSTRUMENT_KINDS]
    .sort((a, b) => a.order - b.order)
    .map((kind) => ({ kind, items: instruments.filter((i) => i.kind === kind.key) }))
    .filter((group) => group.items.length > 0);
}
