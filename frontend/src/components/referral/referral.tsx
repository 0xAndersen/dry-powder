"use client";

import { useEffect, useState } from "react";
import { useReadContract } from "wagmi";
import { zeroAddress, type Address } from "viem";
import { useApp } from "@/components/providers";
import { TxStatus } from "@/components/tx-status";
import { useActionContext, useTradeContext } from "@/hooks/use-action-context";
import { useLocalStore } from "@/hooks/use-local-store";
import { useMarketData } from "@/hooks/use-market-data";
import { useTx } from "@/hooks/use-tx";
import { useAccountView, useWallet } from "@/hooks/use-wallet";
import { perpEngineAbi } from "@/lib/abi";
import { submitSetReferrer } from "@/lib/actions";
import { UserFacingError } from "@/lib/errors";
import { fmtBps, fmtUsdc, shortAddress } from "@/lib/format";
import { captureReferral, referralLink, referralStore } from "@/lib/referral";
import { writeContract, simulateContract } from "wagmi/actions";
import { useConfig } from "wagmi";

/** Remembers `?ref=` from the address the app was opened with (first touch wins). Renders nothing. */
export function ReferralCapture() {
  useEffect(() => {
    captureReferral(window.location.search);
  }, []);
  return null;
}

/** The trading account's referrer on the engine (v3.2); undefined while loading or on an older engine. */
function useReferrerOf(trader: Address | undefined) {
  const { config: cfg } = useApp();
  const q = useReadContract({
    abi: perpEngineAbi,
    address: cfg.perpEngine,
    chainId: cfg.chainId,
    functionName: "referrerOf",
    args: trader ? [trader] : undefined,
    query: { enabled: trader !== undefined, refetchInterval: 30_000 },
  });
  return q.isError ? null : (q.data as Address | undefined);
}

/**
 * Offers to record the referrer this visitor arrived with: shown once a trading account exists, until it is linked
 * or dismissed. Recording is one transaction, once; it lowers every fee and cannot be changed later.
 */
export function ReferralPrompt() {
  const { params } = useMarketData();
  const view = useAccountView();
  const [stored, setStored] = useLocalStore(referralStore);
  const trader = view.watching ? undefined : view.address;
  const current = useReferrerOf(trader);
  const tradeContext = useTradeContext();
  const tx = useTx();
  if (!stored || stored.dismissed || !trader || !view.canTrade) return null;
  if (params?.referralDiscountBps === null || params?.referralDiscountBps === undefined) return null;
  if (current === undefined || current === null || current !== zeroAddress) return tx.state.phase === "confirmed" ? <TxStatus state={tx.state} onDismiss={tx.reset} /> : null;
  if (stored.referrer.toLowerCase() === trader.toLowerCase()) return null;

  const link = () =>
    void tx.run(async (api) => {
      const ctx = tradeContext(api);
      if (!ctx) throw new UserFacingError("Connect your wallet first.");
      await submitSetReferrer(ctx, stored.referrer, "Record your referrer");
      return `Linked. Your fees are ${fmtBps(params.referralDiscountBps ?? 0n)} lower from now on.`;
    });

  return (
    <div className="notice flex flex-wrap items-center justify-between gap-2" data-tone="ok" role="status" data-testid="referral-prompt">
      <span>
        You came from {shortAddress(stored.referrer)}&apos;s link. Link it to pay {fmtBps(params.referralDiscountBps)} less on every fee: one transaction, once.
      </span>
      <span className="flex gap-1.5">
        <button type="button" className="btn btn-sm btn-primary" disabled={tx.busy} onClick={link} data-testid="referral-link">
          Link and save {fmtBps(params.referralDiscountBps)}
        </button>
        <button type="button" className="btn btn-sm btn-ghost" onClick={() => setStored({ ...stored, dismissed: true })} data-testid="referral-dismiss">
          Not now
        </button>
      </span>
      <TxStatus state={tx.state} onDismiss={tx.reset} className="w-full" />
    </div>
  );
}

/**
 * Your referral link and what it has earned: `referralShareBps` of every fee the traders you bring pay, credited to
 * your wallet on the engine and collected with one claim. Works the same for a front-end or an agent builder.
 */
export function ReferralCard() {
  const { config: cfg } = useApp();
  const { params } = useMarketData();
  const wagmi = useConfig();
  const wallet = useWallet();
  const actionContext = useActionContext();
  const tx = useTx();
  const [copied, setCopied] = useState(false);
  const owner = wallet.address;
  const claimable = useReadContract({
    abi: perpEngineAbi,
    address: cfg.perpEngine,
    chainId: cfg.chainId,
    functionName: "claimable",
    args: owner ? [owner] : undefined,
    query: { enabled: owner !== undefined, refetchInterval: 15_000 },
  });
  if (!owner || params?.referralShareBps === null || params?.referralShareBps === undefined) return null;
  const link = referralLink(owner);
  const earned = (claimable.data as bigint | undefined) ?? 0n;
  const sym = cfg.collateralSymbol;

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    } catch {
      setCopied(false);
    }
  };
  const claim = () =>
    void tx.run(async (api) => {
      const ctx = actionContext(api);
      if (!ctx) throw new UserFacingError("Connect your wallet first.");
      await api.send("Collect referral earnings", async () => {
        const { request } = await simulateContract(wagmi, { abi: perpEngineAbi, address: cfg.perpEngine, functionName: "claim", account: owner, chainId: cfg.chainId });
        return writeContract(wagmi, request);
      });
      return `${fmtUsdc(earned)} ${sym} sent to your wallet.`;
    });

  return (
    <section className="panel grid gap-3 p-4" aria-label="Refer traders" data-testid="referral-card">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <h2 className="text-sm font-semibold">Refer traders</h2>
        <span className="text-xs text-muted">
          They pay {fmtBps(params.referralDiscountBps ?? 0n)} less on every fee; you earn {fmtBps(params.referralShareBps)} of what they pay.
        </span>
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <code className="num min-w-0 flex-1 truncate rounded-[var(--radius-ui)] border border-line bg-bg px-2 py-1.5 text-xs" data-testid="referral-url">
          {link}
        </code>
        <button type="button" className="btn btn-sm" onClick={() => void copy()} data-testid="referral-copy">
          {copied ? "Copied" : "Copy link"}
        </button>
      </div>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-[0.8125rem]">
          Earned, ready to collect: <span className="num font-semibold">{fmtUsdc(earned)} {sym}</span>
        </span>
        <button type="button" className="btn btn-sm btn-primary" disabled={tx.busy || earned === 0n} onClick={claim} data-testid="referral-claim">
          Collect
        </button>
      </div>
      <p className="text-xs text-faint">
        A trader&apos;s referrer is set once, by them, the first time they link it. Builders and wallets that send traders earn the same way.
      </p>
      <TxStatus state={tx.state} onDismiss={tx.reset} />
    </section>
  );
}
