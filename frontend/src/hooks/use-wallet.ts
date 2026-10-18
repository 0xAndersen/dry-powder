"use client";

import { useCallback, useMemo } from "react";
import { useSearchParams } from "next/navigation";
import { useAccount } from "wagmi";
import { getAddress, isAddress, type Address } from "viem";
import { useAppConfig } from "@/components/providers";
import { useTradingAccount } from "@/hooks/use-trading-account";

export type WalletState = {
  address: Address | undefined;
  connected: boolean;
  /** Connected, but the wallet is on a different chain than the app. */
  wrongNetwork: boolean;
  /** Connected to the right chain: transactions can be sent. */
  ready: boolean;
};

export function useWallet(): WalletState {
  const { chainId: appChainId } = useAppConfig();
  const { address, isConnected, chainId } = useAccount();
  const connected = isConnected && address !== undefined;
  const wrongNetwork = connected && chainId !== appChainId;
  return { address, connected, wrongNetwork, ready: connected && !wrongNetwork };
}

export type AccountView = {
  /** The account whose positions, orders and history are shown. */
  address: Address | undefined;
  /** True when `?account=` names an account other than the connected wallet: read-only. */
  watching: boolean;
  /** The connected wallet (or the instant-trading key) can act on the account shown. */
  canTrade: boolean;
  /** Orders go out from the instant-trading account, signed by the session key (no wallet pop-ups). */
  instant: boolean;
  watch: (address: Address | null) => void;
};

/**
 * Which account the screen shows: `?account=0x…` if present (watch mode), otherwise the instant-trading account
 * when it is set up and chosen, otherwise the connected wallet.
 */
export function useAccountView(): AccountView {
  const wallet = useWallet();
  const trading = useTradingAccount();
  const searchParams = useSearchParams();
  const raw = searchParams.get("account");
  const watched = useMemo(() => (raw && isAddress(raw, { strict: false }) ? getAddress(raw) : undefined), [raw]);
  const own = trading.active && trading.account ? trading.account : wallet.address;
  const watching = watched !== undefined && watched.toLowerCase() !== own?.toLowerCase() && watched.toLowerCase() !== wallet.address?.toLowerCase();

  const watch = useCallback((address: Address | null) => {
    const params = new URLSearchParams(window.location.search);
    if (address) params.set("account", address);
    else params.delete("account");
    const text = params.toString();
    window.history.pushState(null, "", text ? `?${text}` : window.location.pathname);
  }, []);

  const instant = trading.active && !watching;
  return {
    address: watching ? watched : own,
    watching,
    canTrade: !watching && (instant || wallet.ready),
    instant,
    watch,
  };
}
