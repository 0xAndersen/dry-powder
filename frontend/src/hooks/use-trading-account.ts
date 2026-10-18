"use client";

import { useMemo } from "react";
import { useBalance, useBlockNumber, useReadContracts } from "wagmi";
import { zeroAddress, type Address } from "viem";
import { useApp } from "@/components/providers";
import { useLocalStore } from "@/hooks/use-local-store";
import { useWallet } from "@/hooks/use-wallet";
import { agentAccountAbi, agentAccountFactoryAbi, testUSDCAbi } from "@/lib/abi";
import { findSession, SESSION_GAS_LOW, sessions, tradeFrom, type Session } from "@/lib/session";

export type TradingAccount = {
  /** This deployment supports instant trading (it has an agent account factory). */
  supported: boolean;
  /** The stored session for the connected wallet (or, with no wallet connected, the latest one here). */
  session: Session | null;
  /** The owner's AgentAccount address once it exists. */
  account: Address | null;
  /** On-chain policy of the session key; null until read or when not approved. */
  policy: { expiry: number; maxLeverage: number; maxMargin: bigint } | null;
  /** The key is approved on-chain and not expired. */
  approved: boolean;
  /** Seconds left on the approval (0 when expired or not approved). */
  secondsLeft: number;
  /** Native USDC (18 decimals) the session key holds for gas. */
  gas: bigint | undefined;
  lowGas: boolean;
  /** Collateral held by the account. */
  balance: bigint | undefined;
  /** The user chose to trade from the account (default once set up). */
  preferAccount: boolean;
  /** Orders go out signed by the session key, from the account. */
  active: boolean;
  /** The wallet that owns the session is the connected one (needed for deposits, withdrawals, renewals). */
  ownerConnected: boolean;
};

/** State of instant trading for the current wallet: session key, account, policy, gas. */
export function useTradingAccount(): TradingAccount {
  const { config: cfg } = useApp();
  const wallet = useWallet();
  const [list] = useLocalStore(sessions);
  const [modes] = useLocalStore(tradeFrom);
  const factory = cfg.agentFactory;
  const session = findSession(list, cfg.chainId, factory, wallet.connected ? wallet.address : undefined);
  const block = useBlockNumber({ chainId: cfg.chainId, query: { refetchInterval: 15_000, enabled: session !== null } });

  const reads = useReadContracts({
    allowFailure: true,
    contracts: session
      ? [
          { address: factory!, abi: agentAccountFactoryAbi, functionName: "accountOf", args: [session.owner], chainId: cfg.chainId },
          { address: session.account, abi: agentAccountAbi, functionName: "agents", args: [session.agent], chainId: cfg.chainId },
          { address: cfg.usdc, abi: testUSDCAbi, functionName: "balanceOf", args: [session.account], chainId: cfg.chainId },
        ]
      : [],
    query: { enabled: session !== null, refetchInterval: 10_000 },
  });
  const gas = useBalance({ address: session?.agent, chainId: cfg.chainId, query: { enabled: session !== null, refetchInterval: 15_000 } });

  return useMemo(() => {
    const supported = factory !== null;
    const accountOf = reads.data?.[0]?.result as Address | undefined;
    const account = accountOf && accountOf !== zeroAddress ? accountOf : null;
    const raw = reads.data?.[1]?.result as readonly [bigint, number, bigint] | undefined;
    const policy = raw && raw[0] > 0n ? { expiry: Number(raw[0]), maxLeverage: Number(raw[1]), maxMargin: raw[2] } : null;
    const now = Math.floor(Date.now() / 1000);
    void block.data; // re-evaluate expiry as blocks arrive
    const secondsLeft = policy ? Math.max(0, policy.expiry - now) : 0;
    const approved = session !== null && account !== null && secondsLeft > 0 && session.account.toLowerCase() === account.toLowerCase();
    const balance = reads.data?.[2]?.result as bigint | undefined;
    const ownerKey = session?.owner.toLowerCase();
    const preferAccount = ownerKey ? modes[ownerKey] !== "wallet" : false;
    const ownerConnected = session !== null && wallet.connected && wallet.address?.toLowerCase() === ownerKey;
    // With a wallet connected that is not the owner, never trade from someone else's stored session.
    const walletMismatch = wallet.connected && !ownerConnected;
    return {
      supported,
      session,
      account,
      policy,
      approved,
      secondsLeft,
      gas: gas.data?.value,
      lowGas: gas.data !== undefined && gas.data.value < SESSION_GAS_LOW,
      balance,
      preferAccount,
      active: approved && preferAccount && !walletMismatch && !wallet.wrongNetwork,
      ownerConnected,
    };
  }, [factory, reads.data, block.data, session, modes, wallet.connected, wallet.address, wallet.wrongNetwork, gas.data]);
}
