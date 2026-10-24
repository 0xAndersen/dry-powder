"use client";

import { useEffect, useRef, useState } from "react";
import { useConnect, useDisconnect, useReadContract, useSwitchChain } from "wagmi";
import { useApp } from "@/components/providers";
import { useWallet } from "@/hooks/use-wallet";
import { erc20Abi } from "@/lib/abis-extra";
import { humanizeError } from "@/lib/errors";
import { fmtUsdc, shortAddress } from "@/lib/format";

function connectErrorMessage(error: unknown): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "ProviderNotFoundError") {
    return "No browser wallet found. Install a wallet extension such as MetaMask or Rabby, then reload.";
  }
  return humanizeError(error);
}

/** Connect / switch-network / account menu. Uses the browser's injected wallet only. */
export function WalletButton() {
  const { config, chain } = useApp();
  const wallet = useWallet();
  const { connect, connectors, isPending: connecting, error: connectError, reset: resetConnect } = useConnect();
  const { disconnect } = useDisconnect();
  const { switchChain, isPending: switching, error: switchError, reset: resetSwitch } = useSwitchChain();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

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

  const connector = connectors[0];
  const addOrSwitch = () => {
    resetSwitch();
    switchChain({ chainId: chain.id });
  };

  if (!wallet.connected) {
    return (
      <div className="relative" ref={rootRef}>
        <button
          type="button"
          className="btn btn-primary h-8 px-2.5 sm:px-3.5"
          aria-label="Connect wallet"
          disabled={connecting || !connector}
          onClick={() => {
            if (!connector) return;
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
          <button type="button" role="menuitem" className="btn btn-ghost w-full justify-start" onClick={addOrSwitch} disabled={switching}>
            Add / switch to {chain.name}
          </button>
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
            Disconnect
          </button>
          {switchError ? (
            <p role="alert" className="px-2.5 py-2 text-xs text-short">
              {humanizeError(switchError)}
            </p>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
