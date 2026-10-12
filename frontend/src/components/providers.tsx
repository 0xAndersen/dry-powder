"use client";

import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";
import { QueryClient, QueryClientProvider, useQueryClient, type Query } from "@tanstack/react-query";
import { WagmiProvider, createConfig, http, injected, useBlockNumber } from "wagmi";
import type { Chain } from "viem";
import type { RuntimeConfig } from "@/lib/config";
import { buildChain } from "@/lib/chain";
import { PriceStore } from "@/lib/pyth";

type AppContextValue = {
  config: RuntimeConfig;
  chain: Chain;
  prices: PriceStore;
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

/** Refetches every on-chain read whenever a new block is observed. */
function ChainSync({ chainId }: { chainId: number }) {
  const queryClient = useQueryClient();
  const { data: blockNumber } = useBlockNumber({ chainId, watch: true });
  useEffect(() => {
    if (blockNumber === undefined) return;
    void queryClient.invalidateQueries({ predicate: isChainRead });
  }, [blockNumber, queryClient]);
  return null;
}

export function Providers({ config, children }: { config: RuntimeConfig; children: ReactNode }) {
  const chain = useMemo(() => buildChain(config), [config]);

  const [wagmiConfig] = useState(() =>
    createConfig({
      chains: [chain],
      connectors: [injected({ shimDisconnect: true })],
      transports: { [chain.id]: http(config.rpcUrl, { batch: { wait: 16 }, retryCount: 2 }) },
      // No Multicall3 deployment is assumed on Arc; reads are batched at the JSON-RPC level instead.
      batch: { multicall: false },
      pollingInterval: 4_000,
      ssr: true,
    }),
  );

  const [queryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 2_000, refetchOnWindowFocus: false, retry: 1 },
        },
      }),
  );

  const [prices] = useState(() => new PriceStore(config.hermesUrl));
  useEffect(() => {
    prices.start();
    return () => prices.stop();
  }, [prices]);

  const value = useMemo<AppContextValue>(() => ({ config, chain, prices }), [config, chain, prices]);

  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>
        <AppContext.Provider value={value}>
          <ChainSync chainId={chain.id} />
          {children}
        </AppContext.Provider>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
