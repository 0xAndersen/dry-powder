"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, type Query } from "@tanstack/react-query";
import { WagmiProvider, createConfig, http, injected } from "wagmi";
import type { Chain } from "viem";
import type { RuntimeConfig } from "@/lib/config";
import { buildChain } from "@/lib/chain";
import { KrakenStore } from "@/lib/kraken";
import { HermesStore } from "@/lib/pyth";
import { MarketDataProvider } from "@/hooks/use-market-data";

type AppContextValue = {
  config: RuntimeConfig;
  chain: Chain;
  /** Tape prices (publisher mode). */
  kraken: KrakenStore | null;
  /** Pyth prices and signed updates (pyth mode). */
  hermes: HermesStore | null;
};

const AppContext = createContext<AppContextValue | null>(null);

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error("useApp must be used inside <Providers>");
  return value;
}

export function useAppConfig(): RuntimeConfig {
  return useApp().config;
}

/** Query keys wagmi uses for on-chain reads. */
const CHAIN_READ_KEYS = new Set(["readContract", "readContracts", "balance"]);

export function isChainRead(query: Query): boolean {
  const head = query.queryKey[0];
  return typeof head === "string" && CHAIN_READ_KEYS.has(head);
}

export function Providers({ config, children }: { config: RuntimeConfig; children: ReactNode }) {
  const chain = useMemo(() => buildChain(config), [config]);

  const [wagmiConfig] = useState(() =>
    createConfig({
      chains: [chain],
      connectors: [injected({ shimDisconnect: true })],
      // Reads issued in the same tick travel in one JSON-RPC batch; no Multicall deployment is assumed.
      transports: { [chain.id]: http(config.rpcUrl, { batch: { wait: 12 }, retryCount: 2 }) },
      batch: { multicall: false },
      pollingInterval: 1_000,
      ssr: true,
    }),
  );

  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 800, refetchOnWindowFocus: false, retry: 1 },
        },
      }),
  );

  const [kraken] = useState(() => (config.oracleMode === "publisher" ? new KrakenStore(config.krakenUrl) : null));
  const [hermes] = useState(() => (config.oracleMode === "pyth" ? new HermesStore(config.hermesUrl, config.pythApiKey) : null));
  useEffect(() => {
    kraken?.start();
    hermes?.start();
    return () => {
      kraken?.stop();
      hermes?.stop();
    };
  }, [kraken, hermes]);

  const value = useMemo<AppContextValue>(() => ({ config, chain, kraken, hermes }), [config, chain, kraken, hermes]);

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <AppContext.Provider value={value}>
          <MarketDataProvider>{children}</MarketDataProvider>
        </AppContext.Provider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
