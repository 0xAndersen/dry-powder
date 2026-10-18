"use client";

import { useState } from "react";
import { useConfig } from "wagmi";
import { formatEther } from "viem";
import { useApp } from "@/components/providers";
import { TxStatus } from "@/components/tx-status";
import { Sheet } from "@/components/ui/sheet";
import { useLocalStore } from "@/hooks/use-local-store";
import { useTradingAccount } from "@/hooks/use-trading-account";
import { useTx } from "@/hooks/use-tx";
import { useWallet } from "@/hooks/use-wallet";
import { UserFacingError } from "@/lib/errors";
import { fmtDuration, fmtUsdc, parseAmount, shortAddress, USDC_DECIMALS } from "@/lib/format";
import { SESSION_DURATIONS, SESSION_GAS_TOP_UP, setTradeFrom, tradeFrom } from "@/lib/session";
import {
  depositToAccount,
  enableInstantTrading,
  mintIntoAccount,
  renewInstantTrading,
  revokeInstantTrading,
  topUpGas,
  withdrawFromAccount,
  type SessionFlowContext,
} from "@/lib/session-flows";

const LEVERAGE_CHOICES = [20, 100, 250, 1000] as const;

function gasText(value: bigint | undefined): string {
  if (value === undefined) return "…";
  const n = Number(formatEther(value));
  return `${n < 0.01 && n > 0 ? "<0.01" : n.toFixed(2)} USDC`;
}

/** Compact status control: shows whether instant trading is on and opens the manager. */
export function InstantTradingChip({ className = "" }: { className?: string }) {
  const trading = useTradingAccount();
  const [open, setOpen] = useState(false);
  if (!trading.supported) return null;
  const tone = trading.active ? (trading.lowGas ? "warn" : "ok") : trading.session && !trading.approved && trading.session.status === "active" ? "bad" : "idle";
  const label = trading.active
    ? trading.lowGas
      ? "Instant: low gas"
      : "Instant trading on"
    : trading.session?.status === "active" && !trading.approved
      ? "Instant expired"
      : trading.approved && !trading.preferAccount
        ? "Trading from wallet"
        : "Enable instant trading";
  return (
    <>
      <button
        type="button"
        className={`btn btn-sm gap-1.5 ${className}`}
        onClick={() => setOpen(true)}
        data-testid="instant-chip"
        title="Trade without a wallet pop-up for every order"
      >
        <span className="status-dot" data-tone={tone === "idle" ? undefined : tone} aria-hidden="true" />
        {label}
      </button>
      {open ? <InstantTradingSheet onClose={() => setOpen(false)} /> : null}
    </>
  );
}

export function InstantTradingSheet({ onClose }: { onClose: () => void }) {
  const { config: cfg, chain, rpcUrls } = useApp();
  const wagmi = useConfig();
  const wallet = useWallet();
  const trading = useTradingAccount();
  const tx = useTx();
  const [modes] = useLocalStore(tradeFrom);
  const sym = cfg.collateralSymbol;

  const [duration, setDuration] = useState<number>(SESSION_DURATIONS[1].seconds);
  const [maxLeverage, setMaxLeverage] = useState<number>(trading.policy?.maxLeverage ?? 1000);
  const [maxMarginText, setMaxMarginText] = useState(trading.policy ? fmtUsdc(trading.policy.maxMargin, 0).replace(/,/g, "") : "10000");
  const [amountText, setAmountText] = useState("");
  const maxMargin = parseAmount(maxMarginText, USDC_DECIMALS);
  const amount = parseAmount(amountText, USDC_DECIMALS);

  const session = trading.session;
  const owner = wallet.ready ? wallet.address : undefined;
  const isOwner = owner !== undefined && session !== null && session.owner.toLowerCase() === owner.toLowerCase();
  const canSetUp = owner !== undefined && cfg.agentFactory !== null;

  const flow = (job: (ctx: SessionFlowContext) => Promise<string>) =>
    void tx.run(async (api) => {
      if (!owner) throw new UserFacingError("Connect the wallet that owns the trading account first.");
      return job({ wagmi, cfg, chain, rpcUrls, api, owner });
    });

  const policyFields = (
    <div className="grid gap-3">
      <div>
        <span className="field-label">Key expires after</span>
        <div className="segmented" role="group" aria-label="Expiry">
          {SESSION_DURATIONS.map((d) => (
            <button key={d.seconds} type="button" aria-pressed={duration === d.seconds} onClick={() => setDuration(d.seconds)}>
              {d.label}
            </button>
          ))}
        </div>
      </div>
      <div>
        <span className="field-label">Highest leverage the key may use</span>
        <div className="segmented" role="group" aria-label="Maximum leverage">
          {LEVERAGE_CHOICES.map((lev) => (
            <button key={lev} type="button" aria-pressed={maxLeverage === lev} onClick={() => setMaxLeverage(lev)}>
              {lev}x
            </button>
          ))}
        </div>
      </div>
      <label className="block">
        <span className="field-label">Most margin per order</span>
        <span className="field" data-invalid={maxMargin === null || maxMargin === 0n}>
          <input inputMode="decimal" value={maxMarginText} onChange={(event) => setMaxMarginText(event.target.value)} aria-label="Most margin per order" />
          <span className="field-unit">{sym}</span>
        </span>
      </label>
    </div>
  );

  let body: React.ReactNode;
  let footer: React.ReactNode = null;

  if (!cfg.agentFactory) {
    body = <p className="text-sm text-muted">This deployment has no agent accounts, so instant trading is not available here.</p>;
  } else if (!session || session.status === "pending") {
    body = (
      <div className="grid gap-4">
        <ul className="grid gap-2 text-[0.8125rem] text-muted">
          <li>
            <span className="text-text">No pop-up per order.</span> A key kept in this browser signs your orders from your own trading account.
          </li>
          <li>
            <span className="text-text">It can trade, never withdraw.</span> Only your wallet can move funds out, and the limits below are enforced on-chain.
          </li>
          <li>
            <span className="text-text">Revoke any time.</span> Your positions and funds stay in your account.
          </li>
          {cfg.chainId === 5042002 ? (
            <li>
              <span className="text-text">Gas on us.</span> On testnet the venue&rsquo;s keeper tops up the key&rsquo;s gas while your account holds funds.
            </li>
          ) : null}
        </ul>
        {policyFields}
        <p className="text-xs text-faint">
          One confirmation in your wallet: it approves the key and sends it {formatEther(SESSION_GAS_TOP_UP)} USDC of gas (about a hundred orders; unused gas comes back when you revoke).
          {cfg.collateralIsTest ? ` Test ${sym} is then added to the account for you.` : ""}
        </p>
      </div>
    );
    footer = (
      <button
        type="button"
        className="btn btn-primary btn-lg"
        disabled={!canSetUp || tx.busy || maxMargin === null || maxMargin === 0n}
        onClick={() =>
          flow(async (ctx) => {
            await enableInstantTrading(ctx, { durationSeconds: duration, maxLeverage, maxMargin: maxMargin ?? 0n }, SESSION_GAS_TOP_UP, session);
            return "Instant trading is on. Orders now go out without a wallet pop-up.";
          })
        }
        data-testid="instant-enable"
      >
        {tx.busy ? <span className="spinner" aria-hidden="true" /> : null}
        {!owner ? "Connect your wallet first" : "Enable instant trading"}
      </button>
    );
  } else {
    const fromAccount = modes[session.owner.toLowerCase()] !== "wallet";
    body = (
      <div className="grid gap-4">
        <dl className="grid gap-1.5">
          <div className="kv">
            <dt>Status</dt>
            <dd className={trading.approved ? "text-long" : "text-short"}>
              {trading.approved ? `On, ${fmtDuration(trading.secondsLeft)} left` : "Expired or revoked"}
            </dd>
          </div>
          <div className="kv">
            <dt>Trading account</dt>
            <dd className="num">
              <a className="link" href={`${cfg.explorerUrl}/address/${session.account}`} target="_blank" rel="noreferrer">
                {shortAddress(session.account)}
              </a>
            </dd>
          </div>
          <div className="kv">
            <dt>Balance</dt>
            <dd className="num">{trading.balance !== undefined ? `${fmtUsdc(trading.balance)} ${sym}` : "…"}</dd>
          </div>
          <div className="kv">
            <dt>Key gas</dt>
            <dd className={`num ${trading.lowGas ? "text-warn" : ""}`}>{gasText(trading.gas)}</dd>
          </div>
          <div className="kv">
            <dt>Limits</dt>
            <dd className="num">
              {trading.policy ? `${trading.policy.maxLeverage}x, ${fmtUsdc(trading.policy.maxMargin, 0)} ${sym} per order` : "—"}
            </dd>
          </div>
        </dl>

        <div>
          <span className="field-label">Trade from</span>
          <div className="segmented" role="group" aria-label="Trade from">
            <button type="button" aria-pressed={fromAccount} onClick={() => setTradeFrom(session.owner, "account")} disabled={!trading.approved}>
              Trading account
            </button>
            <button type="button" aria-pressed={!fromAccount} onClick={() => setTradeFrom(session.owner, "wallet")}>
              Wallet
            </button>
          </div>
          <p className="mt-1 text-xs text-faint">Positions live where they were opened: switch to see and manage either.</p>
        </div>

        <div className="grid gap-2">
          <span className="field-label">Move funds</span>
          <div className="flex gap-2">
            <span className="field flex-1">
              <input inputMode="decimal" placeholder="Amount" value={amountText} onChange={(event) => setAmountText(event.target.value)} aria-label="Amount" />
              <span className="field-unit">{sym}</span>
            </span>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <button
              type="button"
              className="btn"
              disabled={!isOwner || tx.busy || !amount}
              onClick={() =>
                flow(async (ctx) => {
                  await depositToAccount(ctx, session, amount ?? 0n);
                  setAmountText("");
                  return `Deposited ${fmtUsdc(amount ?? 0n)} ${sym} into your trading account.`;
                })
              }
            >
              Deposit
            </button>
            <button
              type="button"
              className="btn"
              disabled={!isOwner || tx.busy || !amount}
              onClick={() =>
                flow(async (ctx) => {
                  await withdrawFromAccount(ctx, session, amount ?? 0n);
                  setAmountText("");
                  return `Withdrew ${fmtUsdc(amount ?? 0n)} ${sym} to your wallet.`;
                })
              }
            >
              Withdraw
            </button>
          </div>
          {cfg.collateralIsTest ? (
            <button
              type="button"
              className="btn"
              disabled={tx.busy || !trading.approved}
              onClick={() =>
                void tx.run(async (api) => {
                  await mintIntoAccount({ cfg, chain, rpcUrls, api }, session);
                  return `Added test ${sym} to your trading account.`;
                })
              }
            >
              Add test {sym} (no wallet needed)
            </button>
          ) : null}
          {!isOwner ? <p className="text-xs text-faint">Connect the owner wallet ({shortAddress(session.owner)}) to deposit, withdraw, renew or revoke.</p> : null}
        </div>

        <details className="ticket-details">
          <summary>Renew or change limits</summary>
          <div className="mt-3 grid gap-3">
            {policyFields}
            <button
              type="button"
              className="btn"
              disabled={!isOwner || tx.busy || maxMargin === null || maxMargin === 0n}
              onClick={() =>
                flow(async (ctx) => {
                  await renewInstantTrading(ctx, session, { durationSeconds: duration, maxLeverage, maxMargin: maxMargin ?? 0n });
                  return "Instant trading renewed.";
                })
              }
            >
              Renew with these limits
            </button>
          </div>
        </details>
      </div>
    );
    footer = (
      <div className="grid grid-cols-2 gap-2">
        <button
          type="button"
          className="btn"
          disabled={!isOwner || tx.busy}
          onClick={() =>
            flow(async (ctx) => {
              await topUpGas(ctx, session, SESSION_GAS_TOP_UP);
              return `Sent ${formatEther(SESSION_GAS_TOP_UP)} USDC of gas to the key.`;
            })
          }
        >
          Top up gas
        </button>
        <button
          type="button"
          className="btn border-short/50 text-short"
          disabled={!isOwner || tx.busy}
          onClick={() =>
            flow(async (ctx) => {
              await revokeInstantTrading(ctx, session);
              return "Instant trading is off. Your account and positions are unchanged.";
            })
          }
          data-testid="instant-revoke"
        >
          Revoke key
        </button>
      </div>
    );
  }

  return (
    <Sheet
      title="Instant trading"
      description="Trade without a wallet pop-up for every order."
      onClose={onClose}
      testId="instant-sheet"
      footer={
        <div className="grid gap-2">
          {tx.state.phase !== "idle" ? <TxStatus state={tx.state} onDismiss={tx.reset} /> : null}
          {footer}
        </div>
      }
    >
      {body}
    </Sheet>
  );
}


