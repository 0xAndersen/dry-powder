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
import { useChainNow } from "@/hooks/use-market-data";
import { TOKEN_DECIMALS, fmtDuration, fmtPercent, fmtToken, fmtUsdc, parseAmount, toInputString } from "@/lib/format";
import { ONE, ratio } from "@/lib/math";

type Mode = "stake" | "unstake";

function Figure({ label, value, unit, tone }: { label: string; value: React.ReactNode; unit?: string; tone?: "neon" }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`num mt-0.5 truncate text-lg font-semibold ${tone === "neon" ? "text-neon" : ""}`}>
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
  const now = useChainNow();
  const sym = cfg.collateralSymbol;

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
    query: { enabled: owner !== undefined, refetchInterval: 2_500 },
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
        ? `Staked ${fmtToken(amount)} HOUSE. It earns its share of the yield stream from now on.`
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
      return `Claimed ${fmtUsdc(earned, 6)} ${sym} of staking yield.`;
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
      <button type="submit" className={`btn btn-lg ${blocking ? "" : "btn-primary"}`} disabled={blocking !== null || tx.busy} data-testid="stake-submit">
        {tx.busy ? <span className="spinner" aria-hidden="true" /> : null}
        <span className="truncate">{tx.busy ? "Working" : (blocking ?? (isStake ? "Stake HOUSE" : "Unstake HOUSE"))}</span>
      </button>
    );
  }

  const dash = "—";
  const streamLeft = stats ? Math.max(0, Number(stats.periodFinish) - now) : 0;
  const streaming = stats !== undefined && stats.yieldRate > 0n && streamLeft > 0;
  const perDay = stats ? (stats.yieldRate * 86_400n) / ONE : 0n;
  const leftInStream = stats ? (stats.yieldRate * BigInt(Math.floor(streamLeft))) / ONE : 0n;
  const myPerDay = poolShare !== null ? (perDay * BigInt(Math.round(poolShare * 1e6))) / 1_000_000n : 0n;
  const canClaim = wallet.ready && earned !== undefined && earned > 0n && !tx.busy;

  return (
    <section className="panel" aria-labelledby={`${id}-title`}>
      <div className="border-b border-line px-4 py-3">
        <h2 id={`${id}-title`} className="panel-title">
          Loss rebates and staking
        </h2>
        <p className="mt-1.5 max-w-[62ch] text-[0.8125rem] text-muted">
          Every 1 {sym} a trader loses mints them 100 HOUSE. Staked HOUSE shares 15% of house profit above the vault&rsquo;s
          high-water mark: each epoch&rsquo;s share is streamed to stakers second by second, in {sym}, in proportion to
          their stake. Nothing is paid while the house is below its previous high. No approval is needed to stake, and you can
          unstake at any time.
        </p>
      </div>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-4 border-b border-line px-4 py-4">
        <Figure label="HOUSE in wallet" value={walletHouse !== undefined ? fmtToken(walletHouse) : dash} />
        <Figure label="HOUSE staked" value={staked !== undefined ? fmtToken(staked) : dash} />
        <Figure label="Your share of the pool" value={staked !== undefined ? (poolShare !== null ? fmtPercent(poolShare, 2) : "0.00%") : dash} />
        <Figure label="Claimable yield" value={earned !== undefined ? fmtUsdc(earned, 4) : dash} unit={sym} tone="neon" />
      </dl>

      <dl className="grid grid-cols-2 gap-x-4 gap-y-3 border-b border-line bg-bg/40 px-4 py-3 text-[0.8125rem]" data-testid="yield-stream">
        <div>
          <dt className="text-xs text-muted">Yield stream</dt>
          <dd className="num mt-0.5">
            {stats ? (streaming ? `${fmtUsdc(perDay, 4)} ${sym} / day to all stakers` : "Not streaming") : "…"}
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">{streaming ? "Ends in" : "Starts"}</dt>
          <dd className="num mt-0.5">
            {stats ? (streaming ? `${fmtDuration(streamLeft)} (${fmtUsdc(leftInStream, 4)} ${sym} left)` : "when an epoch settles with a gain") : "…"}
          </dd>
        </div>
        {streaming && staked !== undefined && staked > 0n ? (
          <div className="col-span-2 text-xs text-faint">
            At your current share you earn about <span className="num text-text">{fmtUsdc(myPerDay, 4)} {sym}</span> a day while this stream runs. Each settled
            epoch with a gain restarts the stream with whatever is left plus the new amount.
          </div>
        ) : null}
      </dl>

      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
        <p className="text-xs text-faint">
          {stats
            ? stats.totalStaked === 0n
              ? "Nobody is staking yet, so the house keeps all of its profit."
              : `${fmtUsdc(stats.stakerYieldAllocated)} ${sym} allocated to stakers since launch, ${fmtUsdc(stats.pendingStakerYield)} not yet claimed.`
            : "…"}
        </p>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!canClaim}
          data-testid="claim-yield"
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
              data-testid="stake-amount"
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
              data-testid="stake-max"
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
