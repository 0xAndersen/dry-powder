"use client";

import { useCallback, useMemo } from "react";
import { useConfig } from "wagmi";
import { useApp } from "@/components/providers";
import { useLocalStore } from "@/hooks/use-local-store";
import { useMarketData } from "@/hooks/use-market-data";
import { useTradingAccount } from "@/hooks/use-trading-account";
import type { TxApi } from "@/hooks/use-tx";
import { useWallet } from "@/hooks/use-wallet";
import type { ActionContext } from "@/lib/actions";
import { sessionClient } from "@/lib/session";
import { tradeSettings } from "@/lib/storage";

/**
 * Builds the context every on-chain action takes, signed by the connected wallet. Returns null when no wallet can
 * sign right now. Use it for wallet-only actions (the vault, staking, deposits); trading uses {useTradeContext}.
 */
export function useActionContext(): (api: TxApi) => ActionContext | null {
  const { config: cfg, hermes } = useApp();
  const wagmi = useConfig();
  const wallet = useWallet();
  const { params } = useMarketData();
  const [settings] = useLocalStore(tradeSettings);

  return useCallback(
    (api: TxApi) => {
      if (!wallet.ready || !wallet.address) return null;
      return {
        wagmi,
        cfg,
        api,
        account: wallet.address,
        hermes,
        pyth: params?.pyth ?? null,
        approveUnlimited: settings.approveUnlimited,
        maxPriceAge: Number(params?.maxPriceAge ?? 3n),
        session: null,
      };
    },
    [wagmi, cfg, wallet.ready, wallet.address, hermes, params?.pyth, params?.maxPriceAge, settings.approveUnlimited],
  );
}

/**
 * The context for trading actions: from the instant-trading account (signed by the session key, no wallet
 * pop-up) when it is active, otherwise from the connected wallet.
 */
export function useTradeContext(): (api: TxApi) => ActionContext | null {
  const walletContext = useActionContext();
  const { config: cfg, chain, rpcUrls, hermes } = useApp();
  const wagmi = useConfig();
  const trading = useTradingAccount();
  const { params } = useMarketData();
  const key = trading.active ? trading.session?.key : undefined;
  const account = trading.active ? trading.account : null;
  const client = useMemo(() => (key ? sessionClient(chain, rpcUrls, key) : null), [chain, rpcUrls, key]);

  return useCallback(
    (api: TxApi) => {
      if (!client || !account) return walletContext(api);
      return {
        wagmi,
        cfg,
        api,
        account,
        hermes,
        pyth: params?.pyth ?? null,
        approveUnlimited: true,
        maxPriceAge: Number(params?.maxPriceAge ?? 3n),
        session: { client, account },
      };
    },
    [client, account, walletContext, wagmi, cfg, hermes, params?.pyth, params?.maxPriceAge],
  );
}
