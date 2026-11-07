"use client";

import { useCallback } from "react";
import { useConfig } from "wagmi";
import { useApp } from "@/components/providers";
import { useLocalStore } from "@/hooks/use-local-store";
import { useMarketData } from "@/hooks/use-market-data";
import type { TxApi } from "@/hooks/use-tx";
import { useWallet } from "@/hooks/use-wallet";
import type { ActionContext } from "@/lib/actions";
import { tradeSettings } from "@/lib/storage";

/** Builds the context every on-chain action takes. Returns null when no wallet can sign right now. */
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
      };
    },
    [wagmi, cfg, wallet.ready, wallet.address, hermes, params?.pyth, params?.maxPriceAge, settings.approveUnlimited],
  );
}
