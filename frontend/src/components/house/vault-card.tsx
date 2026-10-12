"use client";

import { useId, useState } from "react";
import { useConfig, useConnect, useReadContract, useReadContracts, useSwitchChain } from "wagmi";
import { simulateContract, writeContract } from "wagmi/actions";
import { useApp } from "@/components/providers";
import type { HouseStats } from "@/components/house/house-screen";
import { TxStatus } from "@/components/tx-status";
import { useActionContext } from "@/hooks/use-action-context";
import { useChainNow } from "@/hooks/use-market-data";
import { useTx } from "@/hooks/use-tx";
import { useWallet } from "@/hooks/use-wallet";
import { houseVaultAbi } from "@/lib/abi";
import { erc20Abi } from "@/lib/abis-extra";
import { ensureAllowance } from "@/lib/actions";
import { UserFacingError } from "@/lib/errors";
import { USDC_DECIMALS, fmtDuration, fmtToken, fmtUsdc, parseAmount, toInputString } from "@/lib/format";

type Mode = "deposit" | "withdraw";

/** Kept back when depositing "Max" of native USDC, so gas (paid in USDC on Arc) stays covered. */
const GAS_RESERVE = 100_000n;

function Row({ label, value, hint }: { label: string; value: React.ReactNode; hint?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3" title={hint}>
      <dt className="text-muted">{label}</dt>
      <dd className="num text-right">{value}</dd>
    </div>
  );
}

export function VaultCard({ stats }: { stats: HouseStats | undefined }) {
  const { config: cfg, chain } = useApp();
  const wagmiConfig = useConfig();
  const wallet = useWallet();
  const { connect, connectors, isPending: connecting } = useConnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const tx = useTx();
  const id = useId();
  const now = useChainNow();
  const actionContext = useActionContext();
  const sym = cfg.collateralSymbol;

  const [mode, setMode] = useState<Mode>("deposit");
  const [text, setText] = useState("");
  const [useMax, setUseMax] = useState(false);

  const owner = wallet.ready ? wallet.address : undefined;
  const vault = { abi: houseVaultAbi, address: cfg.houseVault, chainId: cfg.chainId } as const;
  const token = { abi: erc20Abi, address: cfg.usdc, chainId: cfg.chainId } as const;
  const usdcBalance = useReadContract({ ...token, functionName: "balanceOf", args: owner ? [owner] : undefined, query: { enabled: owner !== undefined, refetchInterval: 2_500 } });
  const allowance = useReadContract({ ...token, functionName: "allowance", args: owner ? [owner, cfg.houseVault] : undefined, query: { enabled: owner !== undefined, refetchInterval: 2_500 } });
  const account = useReadContracts({
    allowFailure: false,
    contracts: owner
      ? [
          { ...vault, functionName: "balanceOf", args: [owner] },
          { ...vault, functionName: "maxWithdraw", args: [owner] },
          { ...vault, functionName: "maxRedeem", args: [owner] },
          { ...vault, functionName: "withdrawUnlockTime", args: [owner] },
        ]
      : [],
    query: { enabled: owner !== undefined, refetchInterval: 2_500 },
  });
  const shares = owner ? (account.data?.[0] as bigint | undefined) : undefined;
  const maxWithdraw = owner ? (account.data?.[1] as bigint | undefined) : undefined;
  const maxRedeem = owner ? (account.data?.[2] as bigint | undefined) : undefined;
  const unlockTime = owner ? (account.data?.[3] as bigint | undefined) : undefined;

  const positionValue = useReadContract({
    ...vault,
    functionName: "convertToAssets",
    args: [shares ?? 0n],
    query: { enabled: shares !== undefined && shares > 0n },
  });

  const amount = parseAmount(text, USDC_DECIMALS);
  const isDeposit = mode === "deposit";
  const redeemAll = !isDeposit && useMax && maxRedeem !== undefined && maxRedeem > 0n;

  const depositPreview = useReadContract({
    ...vault,
    functionName: "previewDeposit",
    args: [amount ?? 0n],
    query: { enabled: isDeposit && amount !== null && amount > 0n },
  });
  const withdrawPreview = useReadContract({
    ...vault,
    functionName: "previewWithdraw",
    args: [amount ?? 0n],
    query: { enabled: !isDeposit && !redeemAll && amount !== null && amount > 0n },
  });
  const redeemPreview = useReadContract({
    ...vault,
    functionName: "previewRedeem",
    args: [maxRedeem ?? 0n],
    query: { enabled: redeemAll },
  });

  const lockRemaining = unlockTime !== undefined ? Number(unlockTime) - Math.floor(now) : 0;
  const locked = shares !== undefined && shares > 0n && lockRemaining > 0;
  const held = shares !== undefined && shares > 0n ? positionValue.data : 0n;

  const fieldError =
    text.trim() === ""
      ? null
      : amount === null
        ? "Enter a number, for example 100.00"
        : amount === 0n
          ? "Enter an amount greater than zero"
          : isDeposit
            ? usdcBalance.data !== undefined && amount > usdcBalance.data
              ? `Your wallet holds ${fmtUsdc(usdcBalance.data)} ${sym}`
              : null
            : locked
              ? null
              : maxWithdraw !== undefined && !redeemAll && amount > maxWithdraw
                ? `You can withdraw up to ${fmtUsdc(maxWithdraw)} ${sym} right now`
                : null;

  const blocking: string | null = (() => {
    if (!stats || (owner && account.data === undefined)) return "Loading vault";
    if (!isDeposit && (shares ?? 0n) === 0n) return "Nothing deposited yet";
    if (!isDeposit && locked) return `Locked for ${fmtDuration(lockRemaining)}`;
    if (!isDeposit && maxWithdraw === 0n) return "No liquidity available to withdraw";
    if (text.trim() === "") return "Enter an amount";
    if (fieldError) return fieldError;
    if (isDeposit && usdcBalance.data === undefined) return "Loading balance";
    return null;
  })();

  const needsApproval = isDeposit && amount !== null && allowance.data !== undefined && allowance.data < amount;

  const setMaxAmount = () => {
    if (isDeposit) {
      if (usdcBalance.data === undefined) return;
      const reserve = cfg.collateralIsTest ? 0n : GAS_RESERVE;
      const spendable = usdcBalance.data > reserve ? usdcBalance.data - reserve : 0n;
      setText(toInputString(spendable, USDC_DECIMALS, 6));
      setUseMax(false);
    } else {
      if (maxWithdraw === undefined) return;
      setText(toInputString(maxWithdraw, USDC_DECIMALS, 6));
      setUseMax(true);
    }
  };

  const submit = async () => {
    const who = wallet.address;
    if (blocking || !who || !wallet.ready || amount === null || amount === 0n) return;
    const ok = await tx.run(async (api) => {
      if (isDeposit) {
        const ctx = actionContext(api);
        if (!ctx) throw new UserFacingError("Connect your wallet first.");
        // The vault is approved for exactly what is deposited.
        await ensureAllowance({ ...ctx, approveUnlimited: false }, cfg.houseVault, amount);
        await api.send(`Deposit ${sym}`, async () => {
          const { request } = await simulateContract(wagmiConfig, {
            ...vault,
            functionName: "deposit",
            // The vault only accepts deposits credited to the caller.
            args: [amount, who],
            account: who,
          });
          return writeContract(wagmiConfig, request);
        });
        return `Deposited ${fmtUsdc(amount)} ${sym} into the house vault.`;
      }
      if (redeemAll && maxRedeem !== undefined) {
        // Redeeming by shares empties the position exactly, with no dust left from rounding.
        await api.send(`Withdraw ${sym}`, async () => {
          const { request } = await simulateContract(wagmiConfig, {
            ...vault,
            functionName: "redeem",
            args: [maxRedeem, who, who],
            account: who,
          });
          return writeContract(wagmiConfig, request);
        });
        return "Withdrew the maximum available from the house vault.";
      }
      await api.send(`Withdraw ${sym}`, async () => {
        const { request } = await simulateContract(wagmiConfig, {
          ...vault,
          functionName: "withdraw",
          args: [amount, who, who],
          account: who,
        });
        return writeContract(wagmiConfig, request);
      });
      return `Withdrew ${fmtUsdc(amount)} ${sym} from the house vault.`;
    });
    if (ok) {
      setText("");
      setUseMax(false);
    }
  };

  let button: React.ReactNode;
  if (!wallet.connected) {
    const connector = connectors[0];
    button = (
      <button
        type="button"
        className="btn btn-primary btn-lg"
        disabled={connecting || !connector}
        onClick={() => connector && connect({ connector, chainId: chain.id })}
      >
        {connecting ? "Connecting" : "Connect wallet"}
      </button>
    );
  } else if (wallet.wrongNetwork) {
    button = (
      <button type="button" className="btn btn-lg border-warn text-warn" disabled={switching} onClick={() => switchChain({ chainId: chain.id })}>
        Switch to {chain.name}
      </button>
    );
  } else {
    const action = isDeposit ? (needsApproval ? `Approve ${sym} and deposit` : `Deposit ${sym}`) : `Withdraw ${sym}`;
    button = (
      <button type="submit" className={`btn btn-lg ${blocking ? "" : "btn-primary"}`} disabled={blocking !== null || tx.busy} data-testid="vault-submit">
        {tx.busy ? <span className="spinner" aria-hidden="true" /> : null}
        <span className="truncate">{tx.busy ? "Working" : (blocking ?? action)}</span>
      </button>
    );
  }

  const lockPeriodText = stats ? fmtDuration(Number(stats.lockPeriod)) : "…";
  const preview = isDeposit
    ? amount && depositPreview.data !== undefined
      ? `${fmtToken(depositPreview.data, 4)} hmUSDC`
      : "—"
    : redeemAll
      ? redeemPreview.data !== undefined && maxRedeem !== undefined
        ? `${fmtUsdc(redeemPreview.data, 6)} ${sym} for ${fmtToken(maxRedeem, 4)} hmUSDC`
        : "—"
      : amount && withdrawPreview.data !== undefined
        ? `${fmtToken(withdrawPreview.data, 4)} hmUSDC`
        : "—";

  return (
    <section className="panel" aria-label="House vault deposit and withdrawal">
      <div className="flex items-center justify-between border-b border-line pr-4">
        <div role="tablist" aria-label="Vault action" className="tabs border-b-0">
          {(["deposit", "withdraw"] as const).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className="tab"
              onClick={() => {
                setMode(m);
                setText("");
                setUseMax(false);
                tx.reset();
              }}
            >
              {m === "deposit" ? "Deposit" : "Withdraw"}
            </button>
          ))}
        </div>
        <h2 className="panel-title text-muted">House vault</h2>
      </div>

      <form
        className="flex flex-col gap-4 p-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <dl className="grid gap-1.5 text-[0.8125rem]">
          <Row
            label="Your position"
            value={
              !owner
                ? "—"
                : shares === undefined
                  ? "…"
                  : shares === 0n
                    ? `0.00 ${sym}`
                    : held !== undefined
                      ? `${fmtUsdc(held)} ${sym}`
                      : "…"
            }
            hint={shares !== undefined ? `${fmtToken(shares, 6)} hmUSDC` : undefined}
          />
          <Row label="Your shares" value={owner && shares !== undefined ? `${fmtToken(shares, 4)} hmUSDC` : "—"} />
          <Row
            label="Withdrawal lock"
            hint={`Shares are locked for ${lockPeriodText} after your latest deposit.`}
            value={
              !owner || shares === undefined || shares === 0n ? (
                `${lockPeriodText} after each deposit`
              ) : locked ? (
                <span className="text-warn">Unlocks in {fmtDuration(lockRemaining)}</span>
              ) : (
                <span className="text-long">Unlocked</span>
              )
            }
          />
          <Row
            label="Available liquidity"
            hint="Vault value not reserved against the net long/short imbalance of open trades. Withdrawals cannot exceed it."
            value={stats ? `${fmtUsdc(stats.freeLiquidity)} ${sym}${stats.reservedLiquidity > 0n ? ` (${fmtUsdc(stats.reservedLiquidity)} reserved)` : ""}` : "…"}
          />
          {!isDeposit ? (
            <Row label="You can withdraw now" value={owner && maxWithdraw !== undefined ? `${fmtUsdc(maxWithdraw)} ${sym}` : "—"} />
          ) : null}
        </dl>

        <div>
          <div className="flex items-baseline justify-between">
            <label className="field-label" htmlFor={`${id}-amount`}>
              {isDeposit ? "Amount to deposit" : "Amount to withdraw"}
            </label>
            {isDeposit && owner ? (
              <span className="num text-xs text-muted">
                {usdcBalance.data !== undefined ? `Balance ${fmtUsdc(usdcBalance.data)} ${sym}` : "Balance …"}
              </span>
            ) : null}
          </div>
          <div className="field" data-invalid={fieldError !== null}>
            <input
              id={`${id}-amount`}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0.00"
              data-testid="vault-amount"
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setUseMax(false);
              }}
              aria-invalid={fieldError !== null}
              aria-describedby={fieldError ? `${id}-error` : undefined}
            />
            <span className="field-unit">{sym}</span>
            <button
              type="button"
              className="chip"
              data-testid="vault-max"
              aria-pressed={!isDeposit && useMax}
              disabled={!owner || (isDeposit ? usdcBalance.data === undefined : maxWithdraw === undefined || maxWithdraw === 0n)}
              onClick={setMaxAmount}
            >
              Max
            </button>
          </div>
          {fieldError ? (
            <p id={`${id}-error`} className="mt-1 text-xs text-short">
              {fieldError}
            </p>
          ) : null}
        </div>

        <dl className="grid gap-1.5 border-t border-line pt-3 text-[0.8125rem]">
          <Row label={isDeposit ? "You receive" : redeemAll ? "You receive" : "Shares burned"} value={preview} />
          <Row label="Share price" value={stats ? `${fmtUsdc(stats.sharePrice, 6)} ${sym}` : "…"} />
        </dl>

        {isDeposit ? (
          <p className="text-xs text-faint">
            Every deposit restarts the {lockPeriodText} lock on your whole position. Deposits buy shares at the higher of the
            realised and marked vault value, and withdrawals cash out at the lower, so nobody can step in just before a trader
            loss lands or step out just before a winner is paid.
          </p>
        ) : null}

        {button}
        <TxStatus state={tx.state} onDismiss={tx.reset} />
      </form>
    </section>
  );
}
