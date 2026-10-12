"use client";

import { useAccount } from "wagmi";
import type { Address } from "viem";
import { useAppConfig } from "@/components/providers";

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
