"use client";

import { useId, useState } from "react";
import { useConfig, useConnect, useReadContracts, useSwitchChain } from "wagmi";
import { simulateContract, writeContract } from "wagmi/actions";
import { useApp } from "@/components/providers";
import type { HouseStats } from "@/components/house/house-screen";
import { TxStatus } from "@/components/tx-status";
import { useTx } from "@/hooks/use-tx";
import { useWallet } from "@/hooks/use-wallet";
import { rewardTokenAbi } from "@/lib/abi";
import { TOKEN_DECIMALS, fmtPercent, fmtToken, fmtUsdc, parseAmount, toInputString } from "@/lib/format";
import { ratio } from "@/lib/math";

type Mode = "stake" | "unstake";

function Figure({ label, value, unit, tone }: { label: string; value: React.ReactNode; unit?: string; tone?: "brass" }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`num mt-0.5 truncate text-lg font-semibold ${tone === "brass" ? "text-brass" : ""}`}>
        {value}
        {unit ? <span className="ml-1 text-xs font-normal text-muted">{unit}</span> : null}
      </dd>
    </div>
  );
}

export function StakingCard({ stats }: { stats: HouseStats | undefined }) {
  const { config: cfg, chain } = useApp();
  const wagmiConfig = useConfig();
  const wallet = useWallet();
  const { connect, connectors, isPending: connecting } = useConnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  const tx = useTx();
  const id = useId();

  const [mode, setMode] = useState<Mode>("stake");
  const [text, setText] = useState("");

  const owner = wallet.ready ? wallet.address : undefined;
  const reward = { abi: rewardTokenAbi, address: cfg.rewardToken, chainId: cfg.chainId } as const;
  const account = useReadContracts({
    allowFailure: false,
    contracts: owner
      ? [
          { ...reward, functionName: "balanceOf", args: [owner] },
          { ...reward, functionName: "stakedBalance", args: [owner] },
          { ...reward, functionName: "earned", args: [owner] },
        ]
      : [],
    query: { enabled: owner !== undefined },
  });
  const walletHouse = owner ? (account.data?.[0] as bigint | undefined) : undefined;
  const staked = owner ? (account.data?.[1] as bigint | undefined) : undefined;
  const earned = owner ? (account.data?.[2] as bigint | undefined) : undefined;

  const isStake = mode === "stake";
  const available = isStake ? walletHouse : staked;
  const amount = parseAmount(text, TOKEN_DECIMALS);
  const poolShare = stats && staked !== undefined && stats.totalStaked > 0n ? ratio(staked, stats.totalStaked) : null;

  const fieldError =
    text.trim() === ""
      ? null
      : amount === null
        ? "Enter a number, for example 500"
        : amount === 0n
          ? "Enter an amount greater than zero"
          : available !== undefined && amount > available
            ? isStake
              ? `Your wallet holds ${fmtToken(available)} HOUSE`
              : `You have ${fmtToken(available)} HOUSE staked`
            : null;

  const blocking: string | null = (() => {
    if (owner && account.data === undefined) return account.isError ? "Could not read your HOUSE balances" : "Loading balances";
    if (available === 0n) return isStake ? "No HOUSE in your wallet" : "No HOUSE staked";
    if (text.trim() === "") return "Enter an amount";
    return fieldError;
  })();

  const submit = async () => {
    const who = wallet.address;
    if (blocking || !who || !wallet.ready || amount === null || amount === 0n) return;
    const ok = await tx.run(async (api) => {
      const label = isStake ? "Stake HOUSE" : "Unstake HOUSE";
      await api.send(label, async () => {
        const { request } = await simulateContract(wagmiConfig, {
          ...reward,
          functionName: isStake ? "stake" : "unstake",
          args: [amount],
          account: who,
        });
        return writeContract(wagmiConfig, request);
      });
      return isStake
        ? `Staked ${fmtToken(amount)} HOUSE. It earns from the next inflow on.`
        : `Unstaked ${fmtToken(amount)} HOUSE. Yield earned so far stays claimable.`;
    });
    if (ok) setText("");
  };

  const claim = () => {
    const who = wallet.address;
    if (!who || !wallet.ready || !earned || tx.busy) return;
    void tx.run(async (api) => {
      await api.send("Claim yield", async () => {
        const { request } = await simulateContract(wagmiConfig, {
          ...reward,
          functionName: "claimYield",
          account: who,
        });
        return writeContract(wagmiConfig, request);
      });
      return `Claimed ${fmtUsdc(earned, 6)} USDC of staking yield.`;
    });
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
    button = (
      <button type="submit" className={`btn btn-lg ${blocking ? "" : "btn-primary"}`} disabled={blocking !== null || tx.busy}>
        {tx.busy ? <span className="spinner" aria-hidden="true" /> : null}
        <span className="truncate">{tx.busy ? "Working" : (blocking ?? (isStake ? "Stake HOUSE" : "Unstake HOUSE"))}</span>
      </button>
    );
  }

  const dash = "—";
  const canClaim = wallet.ready && earned !== undefined && earned > 0n && !tx.busy;

  return (
    <section className="panel" aria-labelledby={`${id}-title`}>
      <div className="border-b border-line px-4 py-3">
        <h2 id={`${id}-title`} className="panel-title">
          Loss rebates and staking
        </h2>
        <p className="mt-1.5 max-w-[62ch] text-[0.8125rem] text-muted">
          Every 1 USDC a trader loses mints them 100 HOUSE. Stake HOUSE to share 15% of everything that flows into the
          house (trader losses and fees), paid in USDC in proportion to your share of the staking pool. No approval is
          needed to stake, and you can unstake at any time.
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 border-b border-line px-4 py-4">
        <Figure label="HOUSE in wallet" value={walletHouse !== undefined ? fmtToken(walletHouse) : dash} />
        <Figure label="HOUSE staked" value={staked !== undefined ? fmtToken(staked) : dash} />
        <Figure label="Your share of the pool" value={staked !== undefined ? (poolShare !== null ? fmtPercent(poolShare, 2) : "0.00%") : dash} />
        <Figure label="Claimable yield" value={earned !== undefined ? fmtUsdc(earned, 4) : dash} unit="USDC" tone="brass" />
      </dl>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <p className="text-xs text-faint">
          {stats
            ? stats.totalStaked === 0n
              ? "Nobody is staking yet, so the house currently keeps the full inflow."
              : `${fmtUsdc(stats.stakerYieldAllocated)} USDC allocated to stakers since launch, ${fmtUsdc(stats.pendingStakerYield)} not yet claimed.`
            : "…"}
        </p>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canClaim}
          title={wallet.ready && earned === 0n ? "There is no yield to claim yet" : undefined}
          onClick={claim}
        >
          Claim yield
        </button>
      </div>

      <div role="tablist" aria-label="Staking action" className="tabs">
        {(["stake", "unstake"] as const).map((m) => (
          <button
            key={m}
            type="button"
            role="tab"
            aria-selected={mode === m}
            className="tab"
            onClick={() => {
              setMode(m);
              setText("");
            }}
          >
            {m === "stake" ? "Stake" : "Unstake"}
          </button>
        ))}
      </div>

      <form
        className="flex flex-col gap-4 p-4"
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          void submit();
        }}
      >
        <div>
          <div className="flex items-baseline justify-between">
            <label className="field-label" htmlFor={`${id}-amount`}>
              {isStake ? "Amount to stake" : "Amount to unstake"}
            </label>
            {owner ? (
              <span className="num text-xs text-muted">
                {available !== undefined ? `${isStake ? "Wallet" : "Staked"} ${fmtToken(available)} HOUSE` : "…"}
              </span>
            ) : null}
          </div>
          <div className="field" data-invalid={fieldError !== null}>
            <input
              id={`${id}-amount`}
              inputMode="decimal"
              autoComplete="off"
              placeholder="0"
              value={text}
              onChange={(event) => setText(event.target.value)}
              aria-invalid={fieldError !== null}
              aria-describedby={fieldError ? `${id}-error` : undefined}
            />
            <span className="field-unit">HOUSE</span>
            <button
              type="button"
              className="chip"
              disabled={available === undefined || available === 0n}
              onClick={() => available !== undefined && setText(toInputString(available, TOKEN_DECIMALS, TOKEN_DECIMALS))}
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

        {button}
        <TxStatus state={tx.state} onDismiss={tx.reset} />
      </form>
    </section>
  );
}
