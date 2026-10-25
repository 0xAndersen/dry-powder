"use client";

import { useEffect, useMemo, useState } from "react";
import { useAccount, useBalance, useConfig, useReadContract } from "wagmi";
import { simulateContract, writeContract } from "wagmi/actions";
import { formatEther, type Address, type Chain, type Hex } from "viem";
import type { FundsTab } from "@/components/onboarding/open-sheets";
import { useApp } from "@/components/providers";
import { TxStatus } from "@/components/tx-status";
import { Sheet } from "@/components/ui/sheet";
import { useLocalStore } from "@/hooks/use-local-store";
import { useTradingAccount } from "@/hooks/use-trading-account";
import { useTx } from "@/hooks/use-tx";
import { useWallet } from "@/hooks/use-wallet";
import { testUSDCAbi } from "@/lib/abi";
import { erc20Abi } from "@/lib/abis-extra";
import { TEST_MINT_AMOUNT } from "@/lib/actions";
import { cctpTransfers, claimOnArc, fetchFees, markClaimed, refreshTransfer, sourceUsdcBalance, startCctpDeposit, type Eip1193 } from "@/lib/cctp";
import { CCTP, CCTP_SOURCES, planBurn, sourceByChainId, type BurnPlan, type PendingTransfer } from "@/lib/cctp-core";
import { humanizeError, UserFacingError } from "@/lib/errors";
import { fmtUsdc, parseAmount, shortAddress, USDC_DECIMALS } from "@/lib/format";
import { GATEWAY_SOURCES, depositToGateway, fetchGatewayBalances, moveGatewayToArc, type GatewayBalance } from "@/lib/gateway";
import { PASSKEY_CONNECTOR_ID } from "@/lib/passkey-wallet";
import { depositToAccount, mintIntoAccount, withdrawFromAccount } from "@/lib/session-flows";

const TABS: { key: FundsTab; label: string }[] = [
  { key: "add", label: "Add" },
  { key: "bridge", label: "From another chain" },
  { key: "gateway", label: "Gateway" },
  { key: "withdraw", label: "Withdraw" },
];

type Progress = { label: string; hash?: Hex; chain?: Chain } | null;

const usd = (v: bigint) => fmtUsdc(v, 2);

/** The browser wallet that holds USDC on other chains: the connected one, or the extension next to a passkey. */
async function sourceWallet(connector: ReturnType<typeof useAccount>["connector"]): Promise<Eip1193 | null> {
  if (connector && connector.id !== PASSKEY_CONNECTOR_ID) return (await connector.getProvider()) as Eip1193;
  const injected = typeof window === "undefined" ? undefined : (window as { ethereum?: Eip1193 }).ethereum;
  return injected ?? null;
}

function StepLine({ progress }: { progress: Progress }) {
  if (!progress) return null;
  const href = progress.hash && progress.chain?.blockExplorers ? `${progress.chain.blockExplorers.default.url}/tx/${progress.hash}` : null;
  return (
    <div className="notice flex items-center gap-2 text-[0.8125rem]" role="status" aria-live="polite">
      <span className="spinner text-accent" aria-hidden="true" />
      <span className="min-w-0 flex-1">{progress.label}</span>
      {href ? (
        <a className="link whitespace-nowrap" href={href} target="_blank" rel="noreferrer">
          Explorer
        </a>
      ) : null}
    </div>
  );
}

function statusText(t: PendingTransfer): { text: string; tone: string } {
  switch (t.status) {
    case "done":
      return { text: "Arrived on Arc", tone: "text-long" };
    case "failed":
      return { text: "Failed", tone: "text-short" };
    case "claimable":
      return { text: "Ready to claim", tone: "text-warn" };
    case "forwarding":
      return { text: "Circle is minting on Arc", tone: "text-accent" };
    default:
      return { text: "Attesting", tone: "text-muted" };
  }
}

/**
 * Money in and out in one place: test funds and gas, USDC from another chain (CCTP V2, delivered by Circle so no
 * Arc gas is needed), a Circle Gateway balance, and getting funds back out of the trading account.
 */
export function FundsSheet({ onClose, initialTab = "add" }: { onClose: () => void; initialTab?: FundsTab }) {
  const { config: cfg, chain, rpcUrls } = useApp();
  const wagmi = useConfig();
  const wallet = useWallet();
  const { connector } = useAccount();
  const trading = useTradingAccount();
  const tx = useTx({ autoDismissMs: 12_000 });
  const [tab, setTab] = useState<FundsTab>(initialTab);
  const [transfers] = useLocalStore(cctpTransfers);
  const sym = cfg.collateralSymbol;

  const gas = useBalance({ address: wallet.address, chainId: cfg.chainId, query: { enabled: wallet.connected, refetchInterval: 4_000 } });
  const walletCollateral = useReadContract({
    abi: erc20Abi,
    address: cfg.usdc,
    functionName: "balanceOf",
    args: wallet.address ? [wallet.address] : undefined,
    chainId: cfg.chainId,
    query: { enabled: wallet.address !== undefined, refetchInterval: 4_000 },
  });

  // ── CCTP form ──
  const [sourceId, setSourceId] = useState<number>(CCTP_SOURCES[1]!.chain.id);
  const source = sourceByChainId(sourceId) ?? CCTP_SOURCES[0]!;
  const [bridgeText, setBridgeText] = useState("10");
  const [fast, setFast] = useState(true);
  const [forward, setForward] = useState(true);
  const [plan, setPlan] = useState<BurnPlan | null>(null);
  const [quoteError, setQuoteError] = useState<string | null>(null);
  const [sourceAccount, setSourceAccount] = useState<Address | null>(null);
  const [sourceBalance, setSourceBalance] = useState<bigint | null>(null);
  const [progress, setProgress] = useState<Progress>(null);
  const [flowError, setFlowError] = useState<string | null>(null);
  const [flowDone, setFlowDone] = useState<string | null>(null);
  const bridgeAmount = parseAmount(bridgeText, USDC_DECIMALS);

  // The browser wallet's account (no prompt) and its USDC on the chosen chain.
  useEffect(() => {
    if (tab !== "bridge" && tab !== "gateway") return;
    let stop = false;
    void (async () => {
      const provider = await sourceWallet(connector);
      if (!provider) return;
      const accounts = (await provider.request({ method: "eth_accounts" }).catch(() => [])) as Address[];
      if (stop) return;
      setSourceAccount(accounts[0] ?? null);
      if (accounts[0] && tab === "bridge") {
        const balance = await sourceUsdcBalance(source, accounts[0]).catch(() => null);
        if (!stop) setSourceBalance(balance);
      }
    })();
    return () => {
      stop = true;
    };
  }, [tab, connector, source]);

  // A live quote while the amount or route changes.
  useEffect(() => {
    if (tab !== "bridge" || !bridgeAmount || bridgeAmount <= 0n) {
      setPlan(null);
      return;
    }
    let stop = false;
    const timer = setTimeout(() => {
      fetchFees(source.domain, forward)
        .then((fees) => {
          if (stop) return;
          setPlan(planBurn(bridgeAmount, fees, { fast, forward }));
          setQuoteError(null);
        })
        .catch((e) => {
          if (stop) return;
          setPlan(null);
          setQuoteError(humanizeError(e));
        });
    }, 400);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [tab, source, bridgeAmount, fast, forward]);

  // Pending transfers are checked every 5 seconds until they arrive.
  const open = useMemo(() => transfers.filter((t) => t.status !== "done" && t.status !== "failed"), [transfers]);
  useEffect(() => {
    if (open.length === 0) return;
    const timer = setInterval(() => {
      for (const t of open) void refreshTransfer(t).catch(() => undefined);
    }, 5_000);
    for (const t of open) void refreshTransfer(t).catch(() => undefined);
    return () => clearInterval(timer);
  }, [open]);

  const sendFromOtherChain = async () => {
    setFlowError(null);
    setFlowDone(null);
    if (!wallet.address) {
      setFlowError("Sign in first: the USDC arrives at your Arc address.");
      return;
    }
    if (!bridgeAmount || bridgeAmount <= 0n) {
      setFlowError("Enter an amount greater than zero.");
      return;
    }
    const provider = await sourceWallet(connector);
    if (!provider) {
      setFlowError("Sending from another chain needs a browser wallet (MetaMask, Rabby, …) that holds testnet USDC there.");
      return;
    }
    try {
      const { transfer } = await startCctpDeposit({
        provider,
        source,
        amount: bridgeAmount,
        recipient: wallet.address,
        fast,
        forward,
        homeChain: chain,
        onStep: (label, hash) => setProgress({ label, hash, chain: source.chain }),
      });
      setFlowDone(
        forward
          ? `Burn confirmed on ${source.chain.name}. Circle mints ${usd(BigInt(transfer.amount))} USDC on Arc in ${fast ? "about a minute" : "15-20 minutes"}; it shows below.`
          : `Burn confirmed on ${source.chain.name}. Once Circle attests it, claim it on Arc below.`,
      );
    } catch (e) {
      setFlowError(humanizeError(e));
    } finally {
      setProgress(null);
    }
  };

  const claim = (t: PendingTransfer) =>
    void tx.run(async (api) => {
      if (!wallet.address || !wallet.ready) throw new UserFacingError("Connect your Arc wallet to claim.");
      const receipt = await api.send("Claim USDC on Arc", () => claimOnArc(wagmi, cfg.chainId, wallet.address!, t));
      markClaimed(t.burnTx, receipt.transactionHash);
      return `${usd(BigInt(t.amount))} USDC claimed on Arc.`;
    });

  // ── Gateway ──
  const [gatewayBalances, setGatewayBalances] = useState<GatewayBalance[] | null>(null);
  const [gatewayText, setGatewayText] = useState("5");
  const [gatewayFrom, setGatewayFrom] = useState<number>(GATEWAY_SOURCES[1]?.domain ?? 6);
  const gatewayAmount = parseAmount(gatewayText, USDC_DECIMALS);
  const gatewaySource = GATEWAY_SOURCES.find((s) => s.domain === gatewayFrom) ?? GATEWAY_SOURCES[0]!;

  const gatewayJob = async (job: (provider: Eip1193, account: Address) => Promise<string>) => {
    setFlowError(null);
    setFlowDone(null);
    const provider = await sourceWallet(connector);
    if (!provider) {
      setFlowError("Gateway needs a browser wallet (MetaMask, Rabby, …): it holds the balance and signs the transfer.");
      return;
    }
    try {
      const [account] = (await provider.request({ method: "eth_requestAccounts" })) as Address[];
      if (!account) throw new UserFacingError("Your browser wallet did not share an account.");
      setFlowDone(await job(provider, account));
    } catch (e) {
      setFlowError(humanizeError(e));
    } finally {
      setProgress(null);
    }
  };

  // ── Withdraw ──
  const [withdrawText, setWithdrawText] = useState("");
  const withdrawAmount = parseAmount(withdrawText, USDC_DECIMALS);
  const session = trading.session;
  const isOwner = wallet.address !== undefined && session !== null && session.owner.toLowerCase() === wallet.address.toLowerCase();

  const flowCtx = (api: Parameters<Parameters<typeof tx.run>[0]>[0]) => {
    if (!wallet.address || !wallet.ready) throw new UserFacingError("Connect the wallet that owns the trading account first.");
    return { wagmi, cfg, chain, rpcUrls, api, owner: wallet.address };
  };

  const mintTest = () =>
    void tx.run(async (api) => {
      if (trading.active && session) {
        await mintIntoAccount({ cfg, chain, rpcUrls, api }, session);
        return `${usd(TEST_MINT_AMOUNT)} test ${sym} added to your trading account.`;
      }
      if (!wallet.address || !wallet.ready) throw new UserFacingError("Sign in first.");
      await api.send(`Get test ${sym}`, async () => {
        const { request } = await simulateContract(wagmi, { address: cfg.usdc, abi: testUSDCAbi, functionName: "mint", args: [wallet.address!, TEST_MINT_AMOUNT], account: wallet.address!, chainId: cfg.chainId });
        return writeContract(wagmi, request);
      });
      return `${usd(TEST_MINT_AMOUNT)} test ${sym} added to your wallet.`;
    });

  const moveIn = () =>
    void tx.run(async (api) => {
      if (!session) throw new UserFacingError("Turn on instant trading first: it creates your trading account.");
      const amount = walletCollateral.data ?? 0n;
      if (amount === 0n) throw new UserFacingError(`Your wallet holds no ${sym}.`);
      await depositToAccount(flowCtx(api), session, amount);
      return `${usd(amount)} ${sym} moved into your trading account.`;
    });

  const withdraw = (all: boolean) =>
    void tx.run(async (api) => {
      if (!session) throw new UserFacingError("There is no trading account in this browser.");
      const amount = all ? (trading.balance ?? 0n) : withdrawAmount;
      if (!amount || amount <= 0n) throw new UserFacingError("Enter an amount greater than zero.");
      if (trading.balance !== undefined && amount > trading.balance) throw new UserFacingError(`Your trading account holds ${usd(trading.balance)} ${sym}.`);
      await withdrawFromAccount(flowCtx(api), session, amount);
      setWithdrawText("");
      return `${usd(amount)} ${sym} sent to your wallet.`;
    });

  const sourceExplorer = (t: PendingTransfer) => sourceByChainId(t.sourceChainId)?.chain.blockExplorers?.default.url;

  return (
    <Sheet title="Funds" description="Add money, bring USDC from another chain, or take it out." onClose={onClose} testId="funds-sheet" wide>
      <div className="grid gap-4">
        <div className="segmented" role="tablist" aria-label="Funds">
          {TABS.map((t) => (
            <button key={t.key} type="button" role="tab" aria-pressed={tab === t.key} aria-selected={tab === t.key} onClick={() => setTab(t.key)} data-testid={`funds-tab-${t.key}`}>
              {t.label}
            </button>
          ))}
        </div>

        {tab === "add" ? (
          <div className="grid gap-4">
            {cfg.collateralIsTest ? (
              <section className="grid gap-2">
                <p className="field-label">Practice money</p>
                <p className="text-[0.8125rem] text-muted">
                  Trading here uses test {sym}: free, unlimited, worth nothing. {trading.active ? "It goes straight into your trading account." : "It goes to your wallet."}
                </p>
                <button type="button" className="btn btn-primary" disabled={tx.busy || (!trading.active && !wallet.ready)} onClick={mintTest} data-testid="funds-mint">
                  Get {usd(TEST_MINT_AMOUNT)} test {sym}
                </button>
                {trading.active && (walletCollateral.data ?? 0n) > 0n ? (
                  <button type="button" className="btn" disabled={tx.busy || !isOwner} onClick={moveIn} data-testid="funds-move-in">
                    Move {usd(walletCollateral.data ?? 0n)} {sym} from your wallet into the trading account
                  </button>
                ) : null}
              </section>
            ) : null}
            <section className="grid gap-2">
              <p className="field-label">Gas on Arc</p>
              <dl className="grid gap-1.5 text-[0.8125rem]">
                <div className="kv">
                  <dt>Your address</dt>
                  <dd className="num">{wallet.address ? shortAddress(wallet.address) : "Sign in first"}</dd>
                </div>
                <div className="kv">
                  <dt>Gas balance</dt>
                  <dd className="num">{gas.data ? `${Number(formatEther(gas.data.value)).toFixed(4)} USDC` : "…"}</dd>
                </div>
              </dl>
              <p className="text-xs text-faint">
                Arc&rsquo;s gas is USDC. Get some at{" "}
                <a className="link" href="https://faucet.circle.com" target="_blank" rel="noreferrer">
                  faucet.circle.com
                </a>{" "}
                (choose Arc Testnet), or bring it from another chain.
              </p>
            </section>
            <TxStatus state={tx.state} onDismiss={tx.reset} />
          </div>
        ) : null}

        {tab === "bridge" ? (
          <div className="grid gap-3">
            <p className="text-[0.8125rem] text-muted">
              Burn USDC on another testnet and have it minted on Arc with Circle&rsquo;s CCTP. It arrives as USDC on Arc (that is gas here); practice trading
              uses test {sym}.
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="field-label">From</span>
                <span className="field">
                  <select className="w-full bg-transparent" value={sourceId} onChange={(event) => setSourceId(Number(event.target.value))} aria-label="Source chain" data-testid="bridge-source">
                    {CCTP_SOURCES.map((s) => (
                      <option key={s.chain.id} value={s.chain.id}>
                        {s.chain.name}
                      </option>
                    ))}
                  </select>
                </span>
              </label>
              <label className="block">
                <span className="field-label">Amount to arrive</span>
                <span className="field" data-invalid={bridgeText.trim() !== "" && (!bridgeAmount || bridgeAmount <= 0n)}>
                  <input inputMode="decimal" value={bridgeText} onChange={(event) => setBridgeText(event.target.value)} aria-label="Amount to arrive" data-testid="bridge-amount" />
                  <span className="field-unit">USDC</span>
                </span>
              </label>
            </div>
            <label className="flex items-start gap-2 text-[0.8125rem]">
              <input type="checkbox" className="check mt-0.5" checked={forward} onChange={(event) => setForward(event.target.checked)} />
              <span>
                <span className="text-text">Circle delivers it on Arc</span>
                <span className="block text-xs text-faint">The Forwarding Service submits the mint for a small fee, so you need no Arc gas. Off: you claim it yourself.</span>
              </span>
            </label>
            <label className="flex items-start gap-2 text-[0.8125rem]">
              <input type="checkbox" className="check mt-0.5" checked={fast} onChange={(event) => setFast(event.target.checked)} />
              <span>
                <span className="text-text">Fast transfer</span>
                <span className="block text-xs text-faint">Attested in seconds for a small fee. Off: free, after the source chain finalises (15-20 minutes on Ethereum Sepolia).</span>
              </span>
            </label>
            <dl className="grid gap-1.5 text-[0.8125rem]" data-testid="bridge-quote">
              <div className="kv">
                <dt>Arrives at</dt>
                <dd className="num">{wallet.address ? `${shortAddress(wallet.address)} on Arc` : "Sign in first"}</dd>
              </div>
              <div className="kv">
                <dt>Your USDC on {source.chain.name}</dt>
                <dd className="num">{sourceAccount ? (sourceBalance !== null ? usd(sourceBalance) : "…") : "connect a browser wallet"}</dd>
              </div>
              <div className="kv">
                <dt>Circle&rsquo;s fee, at most</dt>
                <dd className="num">{plan ? `${fmtUsdc(plan.maxFee, 6)} USDC` : quoteError ? "unavailable" : "…"}</dd>
              </div>
              <div className="kv">
                <dt>Burned on {source.chain.name}</dt>
                <dd className="num">{plan ? `${fmtUsdc(plan.burn, 6)} USDC` : "—"}</dd>
              </div>
            </dl>
            {quoteError ? <p className="text-xs text-short">{quoteError}</p> : null}
            <button type="button" className="btn btn-primary" disabled={progress !== null || !plan} onClick={() => void sendFromOtherChain()} data-testid="bridge-send">
              Send to Arc
            </button>
            <StepLine progress={progress} />
            {flowDone ? (
              <p className="notice text-[0.8125rem]" data-tone="ok">
                {flowDone}
              </p>
            ) : null}
            {flowError ? (
              <p role="alert" className="notice text-[0.8125rem]" data-tone="error">
                {flowError}
              </p>
            ) : null}
            {transfers.length > 0 ? (
              <section className="grid gap-1.5" aria-label="Transfers">
                <p className="field-label">Transfers from this browser</p>
                <ul className="divide-y divide-line rounded-md border border-line text-[0.8125rem]" data-testid="bridge-transfers">
                  {[...transfers].reverse().map((t) => {
                    const s = statusText(t);
                    const from = sourceByChainId(t.sourceChainId)?.chain.name ?? `domain ${t.sourceDomain}`;
                    return (
                      <li key={t.burnTx} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2">
                        <span>
                          <span className="num">{usd(BigInt(t.amount))} USDC</span> from {from} <span className={s.tone}>· {s.text}</span>
                          {t.note ? <span className="block text-xs text-faint">{t.note}</span> : null}
                        </span>
                        <span className="flex items-center gap-2 text-xs">
                          {sourceExplorer(t) ? (
                            <a className="link" href={`${sourceExplorer(t)}/tx/${t.burnTx}`} target="_blank" rel="noreferrer">
                              Burn
                            </a>
                          ) : null}
                          {t.mintTx ? (
                            <a className="link" href={`${cfg.explorerUrl}/tx/${t.mintTx}`} target="_blank" rel="noreferrer">
                              Mint
                            </a>
                          ) : null}
                          {t.status === "claimable" ? (
                            <button type="button" className="btn btn-sm" disabled={tx.busy} onClick={() => claim(t)}>
                              Claim on Arc
                            </button>
                          ) : null}
                        </span>
                      </li>
                    );
                  })}
                </ul>
              </section>
            ) : null}
            <TxStatus state={tx.state} onDismiss={tx.reset} />
            <p className="text-xs text-faint">
              CCTP V2 TokenMessenger <span className="num">{shortAddress(CCTP.tokenMessenger)}</span> on every testnet; Arc is domain {CCTP.arcDomain}. Need testnet USDC?{" "}
              <a className="link" href="https://faucet.circle.com" target="_blank" rel="noreferrer">
                faucet.circle.com
              </a>
            </p>
          </div>
        ) : null}

        {tab === "gateway" ? (
          <div className="grid gap-3">
            <p className="text-[0.8125rem] text-muted">
              Circle Gateway keeps one USDC balance across chains: deposit on any of them, then move what you need to Arc in seconds with a signature. Circle mints
              it on Arc, so no Arc gas is needed.
            </p>
            <dl className="grid gap-1.5 text-[0.8125rem]">
              <div className="kv">
                <dt>Browser wallet</dt>
                <dd className="num">{sourceAccount ? shortAddress(sourceAccount) : "not connected"}</dd>
              </div>
            </dl>
            <button
              type="button"
              className="btn"
              disabled={progress !== null}
              onClick={() =>
                void gatewayJob(async (_provider, account) => {
                  setProgress({ label: "Reading your Gateway balance" });
                  const balances = await fetchGatewayBalances(account);
                  setGatewayBalances(balances);
                  const total = balances.reduce((s, b) => s + b.balance, 0n);
                  const best = [...balances].sort((a, b) => (a.balance < b.balance ? 1 : -1))[0];
                  if (best && best.balance > 0n) setGatewayFrom(best.domain === CCTP.arcDomain ? gatewayFrom : best.domain);
                  return `Gateway balance: ${usd(total)} USDC across ${balances.filter((b) => b.balance > 0n).length} chain(s).`;
                })
              }
              data-testid="gateway-balance"
            >
              Check my Gateway balance
            </button>
            {gatewayBalances ? (
              <ul className="grid gap-1 text-[0.8125rem]">
                {gatewayBalances.map((b) => (
                  <li key={b.domain} className="kv">
                    <span>{b.domain === CCTP.arcDomain ? "Arc" : (GATEWAY_SOURCES.find((s) => s.domain === b.domain)?.chain.name ?? `Domain ${b.domain}`)}</span>
                    <span className="num">{usd(b.balance)} USDC</span>
                  </li>
                ))}
              </ul>
            ) : null}
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="block">
                <span className="field-label">Gateway chain</span>
                <span className="field">
                  <select className="w-full bg-transparent" value={gatewayFrom} onChange={(event) => setGatewayFrom(Number(event.target.value))} aria-label="Gateway chain">
                    {GATEWAY_SOURCES.map((s) => (
                      <option key={s.domain} value={s.domain}>
                        {s.chain.name}
                      </option>
                    ))}
                  </select>
                </span>
              </label>
              <label className="block">
                <span className="field-label">Amount</span>
                <span className="field">
                  <input inputMode="decimal" value={gatewayText} onChange={(event) => setGatewayText(event.target.value)} aria-label="Gateway amount" />
                  <span className="field-unit">USDC</span>
                </span>
              </label>
            </div>
            <div className="grid gap-2 sm:grid-cols-2">
              <button
                type="button"
                className="btn btn-primary"
                disabled={progress !== null || !gatewayAmount || !wallet.address}
                onClick={() =>
                  void gatewayJob(async (provider) => {
                    if (!gatewayAmount || !wallet.address) throw new UserFacingError("Enter an amount and sign in first.");
                    const { fee } = await moveGatewayToArc({ provider, source: gatewaySource, amount: gatewayAmount, recipient: wallet.address, onStep: (label) => setProgress({ label }) });
                    return `${usd(gatewayAmount)} USDC moved to Arc (Circle's fee at most ${fmtUsdc(fee, 6)}).`;
                  })
                }
              >
                Move to Arc
              </button>
              <button
                type="button"
                className="btn"
                disabled={progress !== null || !gatewayAmount}
                onClick={() =>
                  void gatewayJob(async (provider) => {
                    if (!gatewayAmount) throw new UserFacingError("Enter an amount.");
                    await depositToGateway(provider, gatewaySource, gatewayAmount, (label, hash) => setProgress({ label, hash, chain: gatewaySource.chain }));
                    return `Deposited ${usd(gatewayAmount)} USDC into Gateway on ${gatewaySource.chain.name}. It counts toward your balance once that chain finalises it (minutes).`;
                  })
                }
              >
                Deposit into Gateway
              </button>
            </div>
            <StepLine progress={progress} />
            {flowDone ? (
              <p className="notice text-[0.8125rem]" data-tone="ok">
                {flowDone}
              </p>
            ) : null}
            {flowError ? (
              <p role="alert" className="notice text-[0.8125rem]" data-tone="error">
                {flowError}
              </p>
            ) : null}
          </div>
        ) : null}

        {tab === "withdraw" ? (
          <div className="grid gap-3">
            {!session ? (
              <p className="text-[0.8125rem] text-muted">There is no trading account in this browser. Funds in your wallet are already yours to move.</p>
            ) : (
              <>
                <dl className="grid gap-1.5 text-[0.8125rem]">
                  <div className="kv">
                    <dt>Trading account</dt>
                    <dd className="num">{shortAddress(session.account)}</dd>
                  </div>
                  <div className="kv">
                    <dt>Available to withdraw</dt>
                    <dd className="num" data-testid="withdraw-available">
                      {trading.balance !== undefined ? `${usd(trading.balance)} ${sym}` : "…"}
                    </dd>
                  </div>
                  <div className="kv">
                    <dt>Goes to</dt>
                    <dd className="num">{shortAddress(session.owner)} (your wallet)</dd>
                  </div>
                </dl>
                <p className="text-xs text-faint">Margin in open positions and orders comes back to the account when they close or are cancelled.</p>
                {!isOwner ? (
                  <p className="notice text-[0.8125rem]" data-tone="warn">
                    Only the wallet that owns the account can withdraw: sign in with {shortAddress(session.owner)}.
                  </p>
                ) : null}
                <button type="button" className="btn btn-primary btn-lg" disabled={tx.busy || !isOwner || !trading.balance} onClick={() => withdraw(true)} data-testid="withdraw-all">
                  Withdraw everything ({trading.balance !== undefined ? usd(trading.balance) : "…"} {sym})
                </button>
                <div className="flex items-end gap-2">
                  <label className="block flex-1">
                    <span className="field-label">Or an amount</span>
                    <span className="field">
                      <input inputMode="decimal" value={withdrawText} onChange={(event) => setWithdrawText(event.target.value)} aria-label="Amount to withdraw" />
                      <span className="field-unit">{sym}</span>
                    </span>
                  </label>
                  <button type="button" className="btn" disabled={tx.busy || !isOwner || !withdrawAmount} onClick={() => withdraw(false)}>
                    Withdraw
                  </button>
                </div>
              </>
            )}
            <TxStatus state={tx.state} onDismiss={tx.reset} />
          </div>
        ) : null}
      </div>
    </Sheet>
  );
}
