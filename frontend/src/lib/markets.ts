import type { Hex } from "viem";

export type MarketInfo = {
  /** Pyth feed id; also the on-chain market id. */
  id: Hex;
  symbol: string;
  base: string;
  name: string;
  /** Symbol on Pyth Benchmarks (TradingView shim). */
  benchSymbol: string;
  /** The engine uses 1/price of the Pyth feed (Pyth only publishes USD/JPY). */
  invert: boolean;
  /** Decimals shown for prices. */
  priceDecimals: number;
  kind: "crypto" | "fx";
};

export const MARKETS: readonly MarketInfo[] = [
  {
    id: "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
    symbol: "BTC/USD",
    base: "BTC",
    name: "Bitcoin",
    benchSymbol: "Crypto.BTC/USD",
    invert: false,
    priceDecimals: 2,
    kind: "crypto",
  },
  {
    id: "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace",
    symbol: "ETH/USD",
    base: "ETH",
    name: "Ether",
    benchSymbol: "Crypto.ETH/USD",
    invert: false,
    priceDecimals: 2,
    kind: "crypto",
  },
  {
    id: "0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b",
    symbol: "EUR/USD",
    base: "EUR",
    name: "Euro",
    benchSymbol: "FX.EUR/USD",
    invert: false,
    priceDecimals: 5,
    kind: "fx",
  },
  {
    id: "0xef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52",
    symbol: "JPY/USD",
    base: "JPY",
    name: "Japanese yen",
    benchSymbol: "FX.USD/JPY",
    invert: true,
    priceDecimals: 8,
    kind: "fx",
  },
] as const;

export const DEFAULT_MARKET: MarketInfo = MARKETS[0]!;

export function marketById(id: string | undefined): MarketInfo | undefined {
  if (!id) return undefined;
  const lower = id.toLowerCase();
  return MARKETS.find((m) => m.id === lower);
}

export function marketBySymbol(symbol: string | null | undefined): MarketInfo | undefined {
  if (!symbol) return undefined;
  const wanted = symbol.toUpperCase().replace("-", "/");
  return MARKETS.find((m) => m.symbol === wanted);
}
