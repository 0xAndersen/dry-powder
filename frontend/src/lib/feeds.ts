import type { Hex } from "viem";

export type FeedClass = "crypto" | "fx" | "metal";

/** Display metadata for a Pyth feed id. Markets are discovered on-chain; this table only adds names,
 *  decimals and the Kraken pair used for the tape and candles. A feed missing here still trades. */
export type FeedMeta = {
  id: Hex;
  base: string;
  quote: string;
  name: string;
  /** Decimals shown for a price quoted directly from this feed. */
  decimals: number;
  /** Kraken REST pair name (`Ticker` / `OHLC`). */
  kraken: string;
  class: FeedClass;
  /** Shown where the Kraken instrument is a proxy rather than the asset itself. */
  note?: string;
};

export const FEEDS: readonly FeedMeta[] = [
  {
    id: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    base: "BTC",
    quote: "USD",
    name: "Bitcoin",
    decimals: 2,
    kraken: "XBTUSD",
    class: "crypto",
  },
  {
    id: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    base: "ETH",
    quote: "USD",
    name: "Ether",
    decimals: 2,
    kraken: "ETHUSD",
    class: "crypto",
  },
  {
    id: "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d",
    base: "SOL",
    quote: "USD",
    name: "Solana",
    decimals: 3,
    kraken: "SOLUSD",
    class: "crypto",
  },
  {
    id: "0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b",
    base: "EUR",
    quote: "USD",
    name: "Euro",
    decimals: 5,
    kraken: "EURUSD",
    class: "fx",
  },
  {
    id: "0xef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52",
    base: "USD",
    quote: "JPY",
    name: "US dollar in yen",
    decimals: 3,
    kraken: "USDJPY",
    class: "fx",
  },
  {
    id: "0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2",
    base: "XAU",
    quote: "USD",
    name: "Gold",
    decimals: 2,
    kraken: "PAXGUSD",
    class: "metal",
    note: "Tape and candles use PAXG, a tokenised-gold proxy",
  },
];

const BY_ID = new Map<string, FeedMeta>(FEEDS.map((f) => [f.id.toLowerCase(), f]));

export function feedMeta(id: string | null | undefined): FeedMeta | undefined {
  return id ? BY_ID.get(id.toLowerCase()) : undefined;
}

const CURRENCY_NAMES: Record<string, string> = {
  USD: "US dollar",
  JPY: "Japanese yen",
  EUR: "Euro",
  BTC: "Bitcoin",
  ETH: "Ether",
  SOL: "Solana",
  XAU: "Gold",
};

export function assetName(code: string): string {
  return CURRENCY_NAMES[code.toUpperCase()] ?? code;
}
