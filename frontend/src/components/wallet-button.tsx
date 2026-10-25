"use client";

import { useEffect, useRef, useState } from "react";
import { useAccount, useConnect, useDisconnect, useReadContract, useSwitchChain } from "wagmi";
import { FundsSheet } from "@/components/onboarding/funds-sheet";
import { FUNDS_EVENT, SIGN_IN_EVENT, type FundsTab } from "@/components/onboarding/open-sheets";
import { SignInSheet } from "@/components/onboarding/sign-in-sheet";
import { useApp } from "@/components/providers";
import { useLocalStore } from "@/hooks/use-local-store";
import { useWallet } from "@/hooks/use-wallet";
import { erc20Abi } from "@/lib/abis-extra";
import { humanizeError } from "@/lib/errors";
import { fmtUsdc, shortAddress } from "@/lib/format";
import { PASSKEY_CONNECTOR_ID, passkeys, rememberedPasskeys } from "@/lib/passkey-wallet";

function connectErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "ProviderNotFoundError") {
    return "No browser wallet found. Install a wallet extension such as MetaMask or Rabby, then reload.";
  }
  return humanizeError(error);
}

const hasBrowserWallet = () => typeof window !== "undefined" && !!(window as { ethereum?: unknown }).ethereum;

/**
 * Connect / switch-network / account menu, and the home of the sign-in and funds sheets. With a browser wallet
 * installed, Connect connects it at once (as before); without one, or once a passkey has been used here, Connect
 * opens the sign-in sheet (passkey or browser wallet). Other screens open the sheets with `openSignIn()` and
 * `openFunds()` from components/onboarding/open-sheets.
 */
export function WalletButton() {
  const { config, chain } = useApp();
  const wallet = useWallet();
  const { connector: activeConnector } = useAccount();
  const { connect, connectors, isPending: connecting, error: connectError, reset: resetConnect } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching, error: switchError, reset: resetSwitch } = useSwitchChain();
  const [open, setOpen] = useState(false);
  const [signIn, setSignIn] = useState(false);
  const [funds, setFunds] = useState<FundsTab | null>(null);
  const [knownPasskeys] = useLocalStore(passkeys);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const onSignIn = () => setSignIn(true);
    const onFunds = (event: Event) => setFunds((event as CustomEvent<FundsTab | undefined>).detail ?? "add");
    window.addEventListener(SIGN_IN_EVENT, onSignIn);
    window.addEventListener(FUNDS_EVENT, onFunds);
    return () => {
      window.removeEventListener(SIGN_IN_EVENT, onSignIn);
      window.removeEventListener(FUNDS_EVENT, onFunds);
    };
  }, []);

  const balance = useReadContract({
    abi: erc20Abi,
    address: config.usdc,
    functionName: "balanceOf",
    args: wallet.address ? [wallet.address] : undefined,
    chainId: config.chainId,
    query: { enabled: wallet.address !== undefined, refetchInterval: 4_000 },
  });

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("pointerdown", onPointer);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointer);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  // The popover doubles as the connect-error surface; once connected it starts closed.
  useEffect(() => {
    if (wallet.connected) setOpen(false);
  }, [wallet.connected]);

  const connector = connectors.find((c) => c.id !== PASSKEY_CONNECTOR_ID) ?? connectors[0];
  const viaPasskey = activeConnector?.id === PASSKEY_CONNECTOR_ID;
  const sheets = (
    <>
      {signIn ? <SignInSheet onClose={() => setSignIn(false)} /> : null}
      {funds ? <FundsSheet initialTab={funds} onClose={() => setFunds(null)} /> : null}
    </>
  );
  const addOrSwitch = () => {
    resetSwitch();
    switchChain({ chainId: chain.id });
  };

  if (!wallet.connected) {
    return (
      <div className="relative flex items-center gap-2" ref={rootRef}>
        <button
          type="button"
          className="btn hidden h-8 px-2.5 xl:inline-flex"
          aria-label="Sign in with a passkey"
          title="Sign in with a passkey: no extension, no seed phrase"
          onClick={() => setSignIn(true)}
          data-testid="open-sign-in"
        >
          Passkey
        </button>
        <button
          type="button"
          className="btn btn-primary h-8 px-2.5 sm:px-3.5"
          aria-label="Connect wallet"
          disabled={connecting}
          onClick={() => {
            // No extension here, or a passkey was used on this site before: offer both ways in.
            if (!connector || !hasBrowserWallet() || rememberedPasskeys(knownPasskeys).length > 0) {
              setSignIn(true);
              return;
            }
            resetConnect();
            setOpen(true);
            connect({ connector, chainId: chain.id });
          }}
        >
          {connecting ? <span className="spinner" aria-hidden="true" /> : null}
          {connecting ? "Connecting" : (
            <>
              Connect<span className="hidden sm:inline">&nbsp;wallet</span>
            </>
          )}
        </button>
        {open && connectError ? (
          <div role="alert" className="panel absolute right-0 top-full z-40 mt-2 w-72 p-3 text-[0.8125rem] text-short">
            {connectErrorMessage(connectError)}
          </div>
        ) : null}
        {sheets}
      </div>
    );
  }

  return (
    <div className="relative flex items-center gap-2" ref={rootRef}>
      {wallet.wrongNetwork ? (
        <button type="button" className="btn h-8 border-warn text-warn" onClick={addOrSwitch} disabled={switching}>
          {switching ? <span className="spinner" aria-hidden="true" /> : null}
          <span className="hidden sm:inline">Switch to {chain.name}</span>
          <span className="sm:hidden">Switch network</span>
        </button>
      ) : null}
      <button
        type="button"
        className="btn h-8"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        {!wallet.wrongNetwork && balance.data !== undefined ? (
          <span className="num hidden text-muted lg:inline">{fmtUsdc(balance.data)} {config.collateralSymbol}</span>
        ) : null}
        <span className="num">{wallet.address ? shortAddress(wallet.address) : ""}</span>
      </button>
      {open ? (
        <div role="menu" className="panel absolute right-0 top-full z-40 mt-2 w-64 p-1.5 shadow-[0_12px_32px_rgba(4,8,14,0.55)]">
          <div className="px-2.5 py-2">
            <p className="text-xs text-muted">Wallet balance</p>
            <p className="num mt-0.5 text-base">
              {wallet.wrongNetwork ? "—" : balance.data !== undefined ? `${fmtUsdc(balance.data)} ${config.collateralSymbol}` : "…"}
            </p>
          </div>
          <div className="my-1 border-t border-line" />
          <button
            type="button"
            role="menuitem"
            className="btn btn-ghost w-full justify-start"
            onClick={() => {
              setOpen(false);
              setFunds("add");
            }}
            data-testid="wallet-menu-funds"
          >
            Add funds
          </button>
          <button
            type="button"
            role="menuitem"
            className="btn btn-ghost w-full justify-start"
            onClick={() => {
              setOpen(false);
              setFunds("withdraw");
            }}
          >
            Withdraw
          </button>
          <button
            type="button"
            role="menuitem"
            className="btn btn-ghost w-full justify-start"
            onClick={() => {
              setOpen(false);
              setSignIn(true);
            }}
            data-testid="wallet-menu-account"
          >
            {viaPasskey ? "Passkey account, gas and backup" : "Account and gas"}
          </button>
          {!viaPasskey ? (
            <button type="button" role="menuitem" className="btn btn-ghost w-full justify-start" onClick={addOrSwitch} disabled={switching}>
              Add / switch to {chain.name}
            </button>
          ) : null}
          {wallet.address ? (
            <a
              role="menuitem"
              className="btn btn-ghost w-full justify-start"
              href={`${config.explorerUrl}/address/${wallet.address}`}
              target="_blank"
              rel="noreferrer"
            >
              View account on explorer
            </a>
          ) : null}
          <button
            type="button"
            role="menuitem"
            className="btn btn-ghost w-full justify-start"
            onClick={() => {
              setOpen(false);
              disconnect();
            }}
          >
            {viaPasskey ? "Sign out" : "Disconnect"}
          </button>
          {switchError ? (
            <p role="alert" className="px-2.5 py-2 text-xs text-short">
              {humanizeError(switchError)}
            </p>
          ) : null}
        </div>
      ) : null}
      {sheets}
    </div>
  );
}
