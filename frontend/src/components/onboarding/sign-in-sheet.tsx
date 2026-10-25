"use client";

import { useEffect, useState, useSyncExternalStore } from "react";
import { useAccount, useBalance, useConfig, useConnect, useDisconnect } from "wagmi";
import { formatEther } from "viem";
import { openFunds } from "@/components/onboarding/open-sheets";
import { useApp } from "@/components/providers";
import { TxStatus } from "@/components/tx-status";
import { Sheet } from "@/components/ui/sheet";
import { useLocalStore } from "@/hooks/use-local-store";
import { useTradingAccount } from "@/hooks/use-trading-account";
import { useTx } from "@/hooks/use-tx";
import { useWallet } from "@/hooks/use-wallet";
import { humanizeError, UserFacingError } from "@/lib/errors";
import { fmtUsdc, shortAddress } from "@/lib/format";
import {
  PASSKEY_CONNECTOR_ID,
  PasskeyUnsupportedError,
  createPasskeyWallet,
  passkeySupport,
  passkeys,
  rememberedPasskeys,
  revealPasskeyKey,
  subscribeUnlocked,
  unlockPasskeyWallet,
  unlockedCredentialId,
} from "@/lib/passkey-wallet";
import { SESSION_DURATIONS, SESSION_GAS_TOP_UP } from "@/lib/session";
import { enableInstantTrading } from "@/lib/session-flows";

/** Room for the setup transaction itself, on top of the gas handed to the trading key. */
const SETUP_FEE_ROOM = 50_000_000_000_000_000n;
/** Below this the account cannot pay for any transaction: show how to get gas. */
const GAS_FLOOR = 20_000_000_000_000_000n;
const DEFAULT_POLICY = { durationSeconds: SESSION_DURATIONS[1].seconds, maxLeverage: 1000, maxMargin: 10_000_000_000n };

function passkeyError(error: unknown): string {
  if (error instanceof PasskeyUnsupportedError) return error.message;
  const name = error instanceof Error ? error.name : "";
  if (name === "NotAllowedError") return "The passkey prompt was closed or timed out. Try again when you're ready.";
  if (name === "InvalidStateError") return "A passkey for this account already exists on this device: use Sign in instead.";
  if (name === "SecurityError") return "Passkeys need a secure page (https) on a named site.";
  return humanizeError(error);
}

const noBrowserWallet = () => typeof window === "undefined" || !("ethereum" in window) || !(window as { ethereum?: unknown }).ethereum;

/**
 * Signing in, then everything a new trader needs before the first order: a passkey (Face ID, Touch ID or a
 * security key; no extension, no seed phrase) or a browser wallet; gas on Arc (native USDC) from the faucet or
 * another chain; instant trading with test funds in one confirmation.
 */
export function SignInSheet({ onClose }: { onClose: () => void }) {
  const { config: cfg, chain, rpcUrls } = useApp();
  const wagmi = useConfig();
  const wallet = useWallet();
  const { connector } = useAccount();
  const { connectAsync, connectors } = useConnect();
  const { disconnect } = useDisconnect();
  const trading = useTradingAccount();
  const tx = useTx();
  const [list] = useLocalStore(passkeys);
  const credentialId = useSyncExternalStore(subscribeUnlocked, unlockedCredentialId, () => null);
  const [support, setSupport] = useState<{ webauthn: boolean; prf: boolean | null } | null>(null);
  const [busy, setBusy] = useState<null | "create" | "unlock" | "browser" | "reveal">(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revealed, setRevealed] = useState<string | null>(null);

  useEffect(() => {
    void passkeySupport().then(setSupport);
  }, []);

  const passkeyConnector = connectors.find((c) => c.id === PASSKEY_CONNECTOR_ID);
  const browserConnector = connectors.find((c) => c.id !== PASSKEY_CONNECTOR_ID);
  const remembered = rememberedPasskeys(list);
  const viaPasskey = wallet.connected && connector?.id === PASSKEY_CONNECTOR_ID;

  const gas = useBalance({ address: wallet.address, chainId: cfg.chainId, query: { enabled: wallet.connected, refetchInterval: 3_000 } });
  const gasValue = gas.data?.value;

  const withPasskey = async (job: () => Promise<unknown>, kind: "create" | "unlock") => {
    if (!passkeyConnector) return;
    setBusy(kind);
    setError(null);
    try {
      await job();
      await connectAsync({ connector: passkeyConnector, chainId: chain.id });
    } catch (e) {
      setError(passkeyError(e));
    } finally {
      setBusy(null);
    }
  };

  const connectBrowser = async () => {
    setError(null);
    if (noBrowserWallet() || !browserConnector) return;
    setBusy("browser");
    try {
      await connectAsync({ connector: browserConnector, chainId: chain.id });
    } catch (e) {
      setError(humanizeError(e));
    } finally {
      setBusy(null);
    }
  };

  const copyAddress = async () => {
    if (!wallet.address) return;
    try {
      await navigator.clipboard.writeText(wallet.address);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };

  const reveal = async () => {
    if (!credentialId) return;
    setBusy("reveal");
    setError(null);
    try {
      setRevealed(await revealPasskeyKey(credentialId));
    } catch (e) {
      setError(passkeyError(e));
    } finally {
      setBusy(null);
    }
  };

  const enoughForSetup = gasValue !== undefined && gasValue >= GAS_FLOOR + SETUP_FEE_ROOM;
  const keyGas = gasValue === undefined ? 0n : gasValue >= SESSION_GAS_TOP_UP + SETUP_FEE_ROOM ? SESSION_GAS_TOP_UP : gasValue > SETUP_FEE_ROOM ? gasValue - SETUP_FEE_ROOM : 0n;
  const startInstant = () =>
    void tx.run(async (api) => {
      if (!wallet.address) throw new UserFacingError("Sign in first.");
      if (!cfg.agentFactory) throw new UserFacingError("This deployment has no trading accounts.");
      await enableInstantTrading({ wagmi, cfg, chain, rpcUrls, api, owner: wallet.address }, DEFAULT_POLICY, keyGas, trading.session);
      return cfg.collateralIsTest
        ? `Instant trading is on and test ${cfg.collateralSymbol} is in your trading account. Orders go out without pop-ups.`
        : "Instant trading is on. Orders go out without pop-ups.";
    });

  // ── Not signed in: choose how ──
  if (!wallet.connected) {
    const prfMissing = support?.prf === false;
    return (
      <Sheet title="Sign in to trade" description="No extension or seed phrase needed: a passkey on this device is your wallet." onClose={onClose} testId="sign-in-sheet">
        <div className="grid gap-4">
          <section className="grid gap-2" aria-label="Passkey">
            <p className="field-label">Passkey (Face ID, Touch ID or a security key)</p>
            {support && !support.webauthn ? (
              <p className="notice" data-tone="warn">This browser has no passkeys. Use a browser wallet below, or open the app in a recent Chrome, Safari or Edge.</p>
            ) : null}
            {prfMissing ? (
              <p className="notice" data-tone="warn">
                This browser cannot turn a passkey into a wallet key (no PRF support). A recent Chrome, Safari 18 or Edge can; or use a browser wallet below.
              </p>
            ) : null}
            {remembered.map((p) => (
              <button
                key={p.credentialId}
                type="button"
                className="btn btn-primary btn-lg w-full justify-between"
                disabled={busy !== null || !support?.webauthn}
                onClick={() => void withPasskey(() => unlockPasskeyWallet(p.credentialId), "unlock")}
                data-testid="passkey-continue"
              >
                <span>Continue with your passkey</span>
                <span className="num text-xs opacity-80">{shortAddress(p.address)}</span>
              </button>
            ))}
            <button
              type="button"
              className={`btn btn-lg w-full ${remembered.length === 0 ? "btn-primary" : ""}`}
              disabled={busy !== null || !support?.webauthn}
              onClick={() => void withPasskey(() => createPasskeyWallet(), "create")}
              data-testid="passkey-create"
            >
              {busy === "create" ? <span className="spinner" aria-hidden="true" /> : null}
              Create a passkey account
            </button>
            <button
              type="button"
              className="btn w-full"
              disabled={busy !== null || !support?.webauthn}
              onClick={() => void withPasskey(() => unlockPasskeyWallet(), "unlock")}
              data-testid="passkey-signin"
            >
              {busy === "unlock" ? <span className="spinner" aria-hidden="true" /> : null}
              Sign in with a passkey you already have
            </button>
            <p className="text-xs text-faint">
              The passkey derives your key on this device each time you sign in; the key is never stored. It works where the passkey syncs (iCloud Keychain, Google
              Password Manager) and on this site.
            </p>
          </section>
          <div className="flex items-center gap-3 text-xs text-faint" aria-hidden="true">
            <span className="h-px flex-1 bg-line" />
            or
            <span className="h-px flex-1 bg-line" />
          </div>
          <section className="grid gap-2" aria-label="Browser wallet">
            <button type="button" className="btn w-full" disabled={busy !== null || noBrowserWallet()} onClick={() => void connectBrowser()} data-testid="connect-browser-wallet">
              {busy === "browser" ? <span className="spinner" aria-hidden="true" /> : null}
              Connect a browser wallet (MetaMask, Rabby, …)
            </button>
            {noBrowserWallet() ? (
              <p role="alert" className="notice text-[0.8125rem]" data-tone="warn">
                No browser wallet found. Install a wallet extension such as MetaMask or Rabby, then reload, or use a passkey above.
              </p>
            ) : null}
          </section>
          {error ? (
            <p role="alert" className="notice text-[0.8125rem]" data-tone="error">
              {error}
            </p>
          ) : null}
        </div>
      </Sheet>
    );
  }

  // ── Signed in: gas, instant trading, funds ──
  const lowGas = gasValue !== undefined && gasValue < GAS_FLOOR;
  return (
    <Sheet
      title={viaPasskey ? "Your passkey account" : "Your account"}
      description={trading.active ? "You're set: orders go out from your trading account without pop-ups." : "Two steps to your first trade: gas on Arc, then instant trading."}
      onClose={onClose}
      testId="sign-in-sheet"
      footer={
        trading.active ? (
          <button type="button" className="btn btn-primary btn-lg w-full" onClick={onClose} data-testid="signin-done">
            Start trading
          </button>
        ) : (
          <button
            type="button"
            className="btn btn-primary btn-lg w-full"
            disabled={tx.busy || !enoughForSetup || !cfg.agentFactory}
            onClick={startInstant}
            data-testid="signin-instant"
          >
            {tx.busy ? <span className="spinner" aria-hidden="true" /> : null}
            {enoughForSetup ? "Turn on instant trading" : "Waiting for gas"}
          </button>
        )
      }
    >
      <div className="grid gap-4">
        <dl className="grid gap-1.5 text-[0.8125rem]">
          <div className="kv">
            <dt>Address on Arc</dt>
            <dd className="flex items-center gap-2">
              <span className="num" data-testid="signin-address">
                {wallet.address ? shortAddress(wallet.address) : "—"}
              </span>
              <button type="button" className="link text-xs" onClick={() => void copyAddress()}>
                {copied ? "Copied" : "Copy"}
              </button>
            </dd>
          </div>
          <div className="kv">
            <dt>Gas (USDC on Arc)</dt>
            <dd className={`num ${lowGas ? "text-warn" : "text-long"}`} data-testid={gasValue !== undefined && !lowGas ? "gas-ready" : "gas-waiting"}>
              {gasValue === undefined ? "…" : `${Number(formatEther(gasValue)).toFixed(4)} USDC`}
            </dd>
          </div>
          {trading.active ? (
            <div className="kv">
              <dt>Trading account</dt>
              <dd className="num">{trading.balance !== undefined ? `${fmtUsdc(trading.balance)} ${cfg.collateralSymbol}` : "…"}</dd>
            </div>
          ) : null}
        </dl>

        {lowGas || gasValue === undefined ? (
          <div className="notice grid gap-2 text-[0.8125rem]" data-tone="warn">
            <p>
              Arc pays gas in USDC. Send a little to your address: copy it above, then use{" "}
              <a className="link" href="https://faucet.circle.com" target="_blank" rel="noreferrer">
                Circle&rsquo;s faucet
              </a>{" "}
              (Arc Testnet), or bring USDC from another chain.
            </p>
            <div className="flex flex-wrap gap-2">
              <button type="button" className="btn btn-sm" onClick={() => { onClose(); openFunds("bridge"); }} data-testid="signin-bridge">
                Bring USDC from another chain
              </button>
              <span className="inline-flex items-center gap-1.5 text-xs text-muted">
                <span className="spinner" aria-hidden="true" /> Watching for it to arrive
              </span>
            </div>
          </div>
        ) : !trading.active ? (
          <p className="text-[0.8125rem] text-muted">
            Gas received. Instant trading creates your trading account, approves a key in this browser to trade from it (never withdraw), sends that key{" "}
            {Number(formatEther(keyGas)).toFixed(2)} USDC of gas{cfg.collateralIsTest ? ` and adds test ${cfg.collateralSymbol}` : ""}: one confirmation.
          </p>
        ) : null}

        <TxStatus state={tx.state} onDismiss={tx.reset} />

        <div className="flex flex-wrap gap-2">
          <button type="button" className="btn btn-sm" onClick={() => { onClose(); openFunds("add"); }} data-testid="signin-funds">
            Add funds
          </button>
          {trading.active ? (
            <button type="button" className="btn btn-sm" onClick={() => { onClose(); openFunds("withdraw"); }}>
              Withdraw
            </button>
          ) : null}
          {viaPasskey ? (
            <button type="button" className="btn btn-sm btn-ghost" disabled={busy !== null} onClick={() => void reveal()} data-testid="passkey-backup">
              {busy === "reveal" ? <span className="spinner" aria-hidden="true" /> : null}
              Back up the key
            </button>
          ) : null}
          <button
            type="button"
            className="btn btn-sm btn-ghost"
            onClick={() => {
              setRevealed(null);
              disconnect();
            }}
            data-testid="signin-signout"
          >
            Sign out
          </button>
        </div>

        {revealed ? (
          <div className="notice grid gap-2 text-[0.8125rem]" data-tone="warn" data-testid="passkey-key">
            <p>
              <span className="text-text">Anyone with this key controls the account.</span> Store it somewhere safe and offline. You need it only if this passkey is
              lost or the app moves to another address (a passkey works only on the site it was made for).
            </p>
            <code className="num block break-all rounded bg-bg/60 p-2 text-xs">{revealed}</code>
            <div className="flex gap-2">
              <button type="button" className="btn btn-sm" onClick={() => void navigator.clipboard.writeText(revealed).catch(() => undefined)}>
                Copy
              </button>
              <button type="button" className="btn btn-sm btn-ghost" onClick={() => setRevealed(null)}>
                Hide
              </button>
            </div>
          </div>
        ) : null}

        {error ? (
          <p role="alert" className="notice text-[0.8125rem]" data-tone="error">
            {error}
          </p>
        ) : null}
      </div>
    </Sheet>
  );
}
