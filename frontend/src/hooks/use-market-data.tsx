"use client";

import { createContext, useContext, useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePublicClient, useReadContract, useReadContracts } from "wagmi";
import type { Address, Hex } from "viem";
import { useApp } from "@/components/providers";
import { engineLensAbi, houseVaultAbi, perpEngineAbi } from "@/lib/abi";
import { pythAbi } from "@/lib/abis-extra";
import { numToPrice, priceToNum } from "@/lib/format";
import { ensureDecimals, krakenSource, toInstrument, type Instrument, type RawMarketView } from "@/lib/instruments";
import { composeTicker, type TapeStatus, type Ticker } from "@/lib/kraken";
import { composeQuote, pythToQuote, type Quote } from "@/lib/oracle";
import type { FeedStatus } from "@/lib/pyth";

export type EngineParams = {
  baseFeeBps: bigint;
  maxSkewFeeBps: bigint;
  executionFee: bigint;
  minMargin: bigint;
  maxPriceAge: bigint;
  maxOiToNavBps: bigint;
  totalOpenInterest: bigint;
  paused: boolean;
  maxProfitMultiple: bigint;
  /** The oracle contract the engine forwards updates to (Pyth or the testnet PublisherOracle). */
  pyth: Address;
  vaultNav: bigint;
};

/**
 * One market's price as the UI needs it, whichever oracle mode is configured.
 * - `exec`: a quote the engine would accept right now (or the settlement price). Null while awaiting a price.
 * - `reference`: best estimate of where the next execution happens; anchors keeper orders while `exec` is null.
 * - `display`: tape price for headers and charts (Kraken in publisher mode, Pyth mid in pyth mode).
 */
export type MarketPrice = {
  status: "live" | "awaiting" | "settled" | "unavailable";
  exec: Quote | null;
  reference: Quote | null;
  /** 18-decimal price used to value open positions. */
  mark: bigint | null;
  display: number | null;
  displaySource: "tape" | "oracle" | "settlement" | null;
  /** Seconds since the on-chain / oracle price was published. */
  age: number | null;
  /** Unix seconds (chain clock) of the last on-chain or oracle publish; drives live candles. */
  publishTime: number | null;
};

const NO_PRICE: MarketPrice = {
  status: "unavailable",
  exec: null,
  reference: null,
  mark: null,
  display: null,
  displaySource: null,
  age: null,
  publishTime: null,
};

/** In pyth mode a price older than this is treated as a closed market. The engine itself allows `maxPriceAge`. */
const PYTH_STALE_SECONDS = 8;

type MarketData = {
  instruments: Instrument[];
  byId: Map<string, Instrument>;
  prices: Map<string, MarketPrice>;
  params: EngineParams | undefined;
  loading: boolean;
  error: boolean;
  refetch: () => void;
  /** Seconds to add to the local clock to get chain time. */
  clockSkew: number;
  feedStatus: TapeStatus | FeedStatus;
};

const MarketDataContext = createContext<MarketData | null>(null);

export function useMarketData(): MarketData {
  const value = useContext(MarketDataContext);
  if (!value) throw new Error("useMarketData must be used inside <Providers>");
  return value;
}

const EMPTY_TICKERS = new Map<string, Ticker>();
const EMPTY_QUOTES = new Map<Hex, Quote>();
const noopSubscribe = () => () => {};

/** The quote the keeper's next signed price will produce: mid ± max(half spread, 1 bp), like the publisher. */
function tickerQuote(t: Ticker, publishTime: number): Quote {
  const mid = (t.bid + t.ask) / 2;
  const half = Math.max((t.ask - t.bid) / 2, mid * 1e-4);
  return { bid: numToPrice(mid - half), ask: numToPrice(mid + half), mid: numToPrice(mid), publishTime };
}

export function MarketDataProvider({ children }: { children: ReactNode }) {
  const { config: cfg, kraken, hermes } = useApp();
  const client = usePublicClient({ chainId: cfg.chainId });
  const engine = { abi: perpEngineAbi, address: cfg.perpEngine, chainId: cfg.chainId } as const;

  // ── Chain clock: block timestamps are the reference for price ages, expiries and epochs. ──
  const lags = useRef<number[]>([]);
  const [clockSkew, setClockSkew] = useState(0);
  const head = useQuery({
    queryKey: ["chain-head", cfg.chainId, cfg.rpcUrl],
    enabled: client !== undefined,
    refetchInterval: 5_000,
    queryFn: async () => {
      const block = await client!.getBlock({ blockTag: "latest" });
      return { timestamp: Number(block.timestamp), local: Date.now() / 1000 };
    },
  });
  useEffect(() => {
    if (!head.data) return;
    // A block is never newer than "now", so the smallest observed lag is the best estimate of clock error.
    const list = lags.current;
    list.push(head.data.local - head.data.timestamp);
    if (list.length > 12) list.shift();
    const lag = Math.min(...list);
    setClockSkew((prev) => (Math.abs(prev + lag) > 1.5 ? -lag : prev));
  }, [head.data]);

  // ── Markets: one eth_call per second returns configuration, open interest, funding and price. ──
  const markets = useReadContract({
    abi: engineLensAbi,
    address: cfg.engineLens,
    chainId: cfg.chainId,
    functionName: "getMarkets",
    query: { refetchInterval: 1_000 },
  });

  const paramsQuery = useReadContracts({
    allowFailure: false,
    contracts: [
      { ...engine, functionName: "baseFeeBps" },
      { ...engine, functionName: "maxSkewFeeBps" },
      { ...engine, functionName: "executionFee" },
      { ...engine, functionName: "minMargin" },
      { ...engine, functionName: "maxPriceAge" },
      { ...engine, functionName: "maxOiToNavBps" },
      { ...engine, functionName: "totalOpenInterest" },
      { ...engine, functionName: "paused" },
      { ...engine, functionName: "maxProfitMultiple" },
      { ...engine, functionName: "pyth" },
      { abi: houseVaultAbi, address: cfg.houseVault, chainId: cfg.chainId, functionName: "totalAssets" },
    ],
    query: { refetchInterval: 5_000 },
  });
  const params = useMemo<EngineParams | undefined>(() => {
    const d = paramsQuery.data;
    if (!d) return undefined;
    return {
      baseFeeBps: d[0],
      maxSkewFeeBps: d[1],
      executionFee: d[2],
      minMargin: d[3],
      maxPriceAge: d[4],
      maxOiToNavBps: d[5],
      totalOpenInterest: d[6],
      paused: d[7],
      maxProfitMultiple: d[8],
      pyth: d[9],
      vaultNav: d[10],
    };
  }, [paramsQuery.data]);

  const instruments = useMemo<Instrument[]>(
    () => (markets.data ? (markets.data as readonly RawMarketView[]).map(toInstrument) : []),
    [markets.data],
  );
  const byId = useMemo(() => new Map(instruments.map((i) => [i.id as string, i])), [instruments]);

  // ── Last known on-chain price for markets the lens reports no fresh price for (publisher mode). ──
  const staleFeedIds = useMemo(() => {
    if (cfg.oracleMode !== "publisher") return [] as Hex[];
    const ids = new Set<Hex>();
    for (const i of instruments) {
      if (i.onchain || i.settlementPrice !== 0n) continue;
      ids.add(i.feedId);
      if (i.quoteFeedId) ids.add(i.quoteFeedId);
    }
    return [...ids].sort();
  }, [instruments, cfg.oracleMode]);
  const lastPrices = useReadContracts({
    allowFailure: true,
    contracts: params
      ? staleFeedIds.map((id) => ({ abi: pythAbi, address: params.pyth, chainId: cfg.chainId, functionName: "getPriceUnsafe" as const, args: [id] as const }))
      : [],
    query: { enabled: params !== undefined && staleFeedIds.length > 0, refetchInterval: 4_000 },
  });
  const lastQuotes = useMemo(() => {
    const out = new Map<string, Quote>();
    staleFeedIds.forEach((id, i) => {
      const row = lastPrices.data?.[i];
      if (!row || row.status !== "success") return;
      const p = row.result;
      const quote = pythToQuote(p.price, p.conf, p.expo, Number(p.publishTime));
      if (quote) out.set(id, quote);
    });
    return out;
  }, [lastPrices.data, staleFeedIds]);

  // ── Tape (publisher mode) and Hermes (pyth mode) ──
  useEffect(() => {
    if (kraken) {
      const pairs: string[] = [];
      for (const i of instruments) {
        const source = krakenSource(i);
        if (!source) continue;
        pairs.push(source.base);
        if (source.quote) pairs.push(source.quote);
      }
      kraken.setPairs(pairs);
    }
    if (hermes) {
      const ids: Hex[] = [];
      for (const i of instruments) {
        ids.push(i.feedId);
        if (i.quoteFeedId) ids.push(i.quoteFeedId);
      }
      hermes.setFeeds(ids);
    }
  }, [instruments, kraken, hermes]);

  const tickers = useSyncExternalStore(kraken?.subscribe ?? noopSubscribe, kraken?.getTickers ?? (() => EMPTY_TICKERS), () => EMPTY_TICKERS);
  const tapeStatus = useSyncExternalStore(kraken?.subscribe ?? noopSubscribe, kraken?.getStatus ?? (() => "connecting" as const), () => "connecting" as const);
  const hermesQuotes = useSyncExternalStore(hermes?.subscribe ?? noopSubscribe, hermes?.getQuotes ?? (() => EMPTY_QUOTES), () => EMPTY_QUOTES);
  const hermesStatus = useSyncExternalStore(hermes?.subscribe ?? noopSubscribe, hermes?.getStatus ?? (() => "connecting" as const), () => "connecting" as const);

  const prices = useMemo(() => {
    const out = new Map<string, MarketPrice>();
    const now = Date.now() / 1000 + clockSkew;
    for (const i of instruments) {
      if (i.settlementPrice !== 0n) {
        const q: Quote = { mid: i.settlementPrice, bid: i.settlementPrice, ask: i.settlementPrice, publishTime: Math.floor(now) };
        out.set(i.id, { status: "settled", exec: q, reference: q, mark: q.mid, display: priceToNum(q.mid), displaySource: "settlement", age: null, publishTime: null });
        continue;
      }

      if (hermes) {
        const base = hermesQuotes.get(i.feedId);
        const quote = i.quoteFeedId ? hermesQuotes.get(i.quoteFeedId) : null;
        const composed = base && quote !== undefined ? composeQuote(base, quote, i.invert) : null;
        if (!composed) {
          out.set(i.id, NO_PRICE);
          continue;
        }
        const age = hermes.ageOf(composed.publishTime);
        const fresh = age <= PYTH_STALE_SECONDS;
        const display = priceToNum(composed.mid);
        ensureDecimals(i, display);
        out.set(i.id, {
          status: fresh ? "live" : "awaiting",
          exec: fresh ? composed : null,
          reference: composed,
          mark: composed.mid,
          display,
          displaySource: "oracle",
          age,
          publishTime: composed.publishTime,
        });
        continue;
      }

      const source = krakenSource(i);
      const tape = source ? composeTicker(tickers.get(source.base), source.quote ? tickers.get(source.quote) : null, source.invert) : null;
      let last: Quote | null = i.onchain;
      if (!last) {
        const base = lastQuotes.get(i.feedId);
        const quote = i.quoteFeedId ? lastQuotes.get(i.quoteFeedId) : null;
        last = base && quote !== undefined ? composeQuote(base, quote, i.invert) : null;
      }
      const tapeMid = tape ? (tape.bid + tape.ask) / 2 : null;
      const display = tapeMid ?? (last ? priceToNum(last.mid) : null);
      if (display === null) {
        out.set(i.id, NO_PRICE);
        continue;
      }
      ensureDecimals(i, display);
      out.set(i.id, {
        status: i.onchain ? "live" : "awaiting",
        exec: i.onchain,
        // Keeper orders fill at the price the keeper signs next (from this tape), not at the stored one, which can
        // be a heartbeat old: bound market orders and closes on the tape when it is live.
        reference: tape ? tickerQuote(tape, Math.floor(now)) : (i.onchain ?? last),
        mark: i.onchain?.mid ?? (tapeMid !== null ? numToPrice(tapeMid) : (last?.mid ?? null)),
        display,
        displaySource: tape ? "tape" : "oracle",
        age: last ? Math.max(0, now - last.publishTime) : null,
        publishTime: last?.publishTime ?? null,
      });
    }
    return out;
  }, [instruments, tickers, hermesQuotes, lastQuotes, hermes, clockSkew]);

  const value = useMemo<MarketData>(
    () => ({
      instruments,
      byId,
      prices,
      params,
      loading: markets.isPending || paramsQuery.isPending,
      error: markets.isError || paramsQuery.isError,
      refetch: () => {
        void markets.refetch();
        void paramsQuery.refetch();
      },
      clockSkew,
      feedStatus: hermes ? hermesStatus : tapeStatus,
    }),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [instruments, byId, prices, params, markets.isPending, markets.isError, paramsQuery.isPending, paramsQuery.isError, clockSkew, hermesStatus, tapeStatus, hermes],
  );

  return <MarketDataContext.Provider value={value}>{children}</MarketDataContext.Provider>;
}

export function useMarketPrice(id: string | undefined): MarketPrice {
  const { prices } = useMarketData();
  return (id ? prices.get(id) : undefined) ?? NO_PRICE;
}

/** Wall-clock milliseconds that re-render the caller every `intervalMs`. */
export function useNow(intervalMs = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}

/** Chain time in seconds, ticking once a second. */
export function useChainNow(intervalMs = 1_000): number {
  const { clockSkew } = useMarketData();
  const now = useNow(intervalMs);
  return now / 1000 + clockSkew;
}
