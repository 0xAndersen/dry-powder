"use client";

import { useEffect, useId, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import { useConfig, useConnect, useReadContracts, useSwitchChain } from "wagmi";
import { simulateContract, writeContract } from "wagmi/actions";
import { getAddress, isAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AppLink } from "@/components/app-link";
import { KeyBudget } from "@/components/agents/key-budget";
import { AgentDirectory, ListingCard } from "@/components/agents/registry";
import { StrategyList } from "@/components/agents/strategy-list";
import { AgentStudio, type StudioPrefill } from "@/components/agents/studio";
import { useApp } from "@/components/providers";
import { TxStatus } from "@/components/tx-status";
import { useAccountStrategies } from "@/hooks/use-strategies";
import { useTx } from "@/hooks/use-tx";
import { useWallet } from "@/hooks/use-wallet";
import { agentAccountAbi, agentAccountFactoryAbi, rewardTokenAbi, testUSDCAbi } from "@/lib/abi";
import { USDC_DECIMALS, fmtDateTime, fmtToken, fmtUsdc, parseAmount, shortAddress, toInputString } from "@/lib/format";
import { kindOf, listingKindFor } from "@/lib/strategies";

const ZERO = "0x0000000000000000000000000000000000000000";
const DEPLOYMENT_URL = "https://raw.githubusercontent.com/0xAndersen/dry-powder/main/deployments/arc-testnet.json";

function useKnownAgents(account: Address | undefined) {
  const key = account ? `dp.agents.${account.toLowerCase()}` : null;
  const [list, setList] = useState<Address[]>([]);
  useEffect(() => {
    if (!key) return setList([]);
    try {
      const raw = JSON.parse(localStorage.getItem(key) ?? "[]") as string[];
      setList(raw.filter((a) => isAddress(a)).map((a) => getAddress(a)));
    } catch {
      setList([]);
    }
  }, [key]);
  const add = (a: Address) => {
    if (!key) return;
    setList((cur) => {
      const next = cur.some((x) => x.toLowerCase() === a.toLowerCase()) ? cur : [...cur, a];
      try {
        localStorage.setItem(key, JSON.stringify(next));
      } catch {
        // Private mode: the list lives for this visit only.
      }
      return next;
    });
  };
  return { list, add };
}

function ConnectButton() {
  const { chain } = useApp();
  const wallet = useWallet();
  const { connect, connectors, isPending } = useConnect();
  const { switchChain, isPending: switching } = useSwitchChain();
  if (wallet.wrongNetwork) {
    return (
      <button type="button" className="btn btn-lg border-warn text-warn" disabled={switching} onClick={() => switchChain({ chainId: chain.id })}>
        Switch to {chain.name}
      </button>
    );
  }
  const connector = connectors[0];
  return (
    <button type="button" className="btn btn-primary btn-lg" disabled={isPending || !connector} onClick={() => connector && connect({ connector, chainId: chain.id })}>
      {isPending ? "Connecting" : "Connect wallet"}
    </button>
  );
}

export function AgentsScreen() {
  const { config: cfg } = useApp();
  const wallet = useWallet();
  const wagmiConfig = useConfig();
  const tx = useTx();
  const owner = wallet.ready ? wallet.address : undefined;
  const factory = cfg.agentFactory;

  const lookup = useReadContracts({
    allowFailure: false,
    contracts: factory && owner ? [{ address: factory, abi: agentAccountFactoryAbi, functionName: "accountOf", args: [owner], chainId: cfg.chainId }] : [],
    query: { enabled: !!factory && !!owner, refetchInterval: 5_000 },
  });
  const account = lookup.data?.[0] && lookup.data[0] !== ZERO ? (lookup.data[0] as Address) : undefined;
  const accountKnown = !!owner && lookup.data !== undefined;
  const strategies = useAccountStrategies(account);
  const firstLive = strategies.live[0];
  const suggestedKind = firstLive ? listingKindFor(kindOf(firstLive.config.kind)) : null;

  // "Copy this agent" from the directory, or a link with ?copy=0x…&market=SYMBOL.
  const searchParams = useSearchParams();
  const [prefill, setPrefill] = useState<StudioPrefill | null>(() => {
    const raw = searchParams.get("copy");
    return raw && isAddress(raw, { strict: false }) ? { leader: getAddress(raw), marketId: searchParams.get("market"), nonce: 1 } : null;
  });
  const copyAgent = (leader: Address, marketId: Hex | null) => {
    setPrefill({ leader, marketId, nonce: Date.now() });
    document.getElementById("studio")?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const create = () => {
    if (!factory || !owner) return;
    void tx.run(async (api) => {
      await api.send("Create agent account", async () => {
        const { request } = await simulateContract(wagmiConfig, { address: factory, abi: agentAccountFactoryAbi, functionName: "createAccount", args: [owner], account: owner });
        return writeContract(wagmiConfig, request);
      });
      void lookup.refetch();
      return "Agent account created. Fund it, then approve an agent key.";
    });
  };

  const accountPanel = !factory ? (
    <div className="notice" data-tone="warn" role="status">
      This deployment has no agent account factory configured (AGENT_FACTORY_ADDRESS). Trading is unaffected.
    </div>
  ) : !wallet.ready ? (
    <section className="panel flex flex-col items-start gap-3 p-4">
      <p className="text-muted">Connect the wallet that will own the agent account.</p>
      <ConnectButton />
    </section>
  ) : lookup.data === undefined ? (
    <section className="panel p-4 text-muted">{lookup.isError ? "Could not read the agent account factory." : "Looking up your agent account…"}</section>
  ) : !account ? (
    <section className="panel flex flex-col items-start gap-3 p-4" data-testid="agents-create">
      <h2 className="panel-title">Create your agent account</h2>
      <p className="max-w-[62ch] text-[0.8125rem] text-muted">
        One account per wallet, at a fixed address. Creating it costs a little gas and nothing else. Launching a strategy creates it for you.
      </p>
      <button type="button" className="btn btn-primary btn-lg" disabled={tx.busy} onClick={create} data-testid="agents-create-button">
        {tx.busy ? <span className="spinner" aria-hidden="true" /> : null}
        Create agent account
      </button>
      <TxStatus state={tx.state} onDismiss={tx.reset} className="w-full" />
    </section>
  ) : (
    <>
      <FundsCard account={account} owner={owner!} />
      <AgentsCard account={account} owner={owner!} />
    </>
  );

  return (
    <div className="flex flex-col gap-2">
      <div className="px-1 pb-1 pt-3 sm:pt-4">
        <h1 className="wide text-2xl font-semibold leading-tight sm:text-[2rem]">Let agents trade. Never let them withdraw.</h1>
        <p className="mt-2 max-w-[72ch] text-muted">
          An agent account is a contract your wallet owns. You fund it and approve agent keys (an AI agent, a bot, a script)
          with a policy: how long, how much leverage, how much margin per trade. Agents can open, close and manage orders from
          it. Every payout returns to the account, and only your wallet can move money out.
        </p>
        <nav className="mt-3 flex flex-wrap gap-1.5" aria-label="On this page">
          <a className="chip" href="#studio">
            Strategy studio
          </a>
          {account && strategies.rows.length > 0 ? (
            <a className="chip" href="#running">
              Running <span className="num ml-1 text-faint">{strategies.live.length}</span>
            </a>
          ) : null}
          {cfg.agentRegistry ? (
            <a className="chip" href="#directory">
              Agent directory
            </a>
          ) : null}
          <a className="chip" href="#account">
            Account and keys
          </a>
        </nav>
      </div>

      <div className="grid items-start gap-2 lg:grid-cols-[minmax(0,1fr)_22rem] 2xl:grid-cols-[minmax(0,1fr)_24rem]">
        <div className="flex min-w-0 flex-col gap-2">
          <AgentStudio account={account} accountKnown={accountKnown} prefill={prefill} />
          {account ? <StrategyList account={account} owner={owner} /> : null}
          <AgentDirectory me={account} onCopy={copyAgent} />
        </div>
        <aside className="flex min-w-0 scroll-mt-16 flex-col gap-2" id="account" aria-label="Account and keys">
          {accountPanel}
          {account ? <ListingCard account={account} owner={owner} suggestedKind={suggestedKind} /> : null}
        </aside>
      </div>
    </div>
  );
}

function FundsCard({ account, owner }: { account: Address; owner: Address }) {
  const { config: cfg } = useApp();
  const wagmiConfig = useConfig();
  const tx = useTx();
  const id = useId();
  const sym = cfg.collateralSymbol;
  const [mode, setMode] = useState<"deposit" | "withdraw">("deposit");
  const [text, setText] = useState("");
  const reads = useReadContracts({
    allowFailure: false,
    contracts: [
      { address: cfg.usdc, abi: testUSDCAbi, functionName: "balanceOf", args: [account], chainId: cfg.chainId },
      { address: cfg.usdc, abi: testUSDCAbi, functionName: "balanceOf", args: [owner], chainId: cfg.chainId },
      { address: cfg.rewardToken, abi: rewardTokenAbi, functionName: "balanceOf", args: [account], chainId: cfg.chainId },
    ],
    query: { refetchInterval: 3_000 },
  });
  const [inAccount, inWallet, keg] = (reads.data ?? []) as (bigint | undefined)[];
  const amount = parseAmount(text, USDC_DECIMALS);
  const available = mode === "deposit" ? inWallet : inAccount;
  const problem =
    text.trim() === "" ? "Enter an amount" : amount === null || amount === 0n ? "Enter a positive amount" : available !== undefined && amount > available ? `Only ${fmtUsdc(available)} ${sym} available` : null;

  const submit = () => {
    if (problem || amount === null) return;
    void tx.run(async (api) => {
      if (mode === "deposit") {
        await api.send(`Deposit ${sym}`, async () => {
          const { request } = await simulateContract(wagmiConfig, { address: cfg.usdc, abi: testUSDCAbi, functionName: "transfer", args: [account, amount], account: owner });
          return writeContract(wagmiConfig, request);
        });
      } else {
        await api.send(`Withdraw ${sym}`, async () => {
          const { request } = await simulateContract(wagmiConfig, { address: account, abi: agentAccountAbi, functionName: "withdraw", args: [cfg.usdc, owner, amount], account: owner });
          return writeContract(wagmiConfig, request);
        });
      }
      setText("");
      return mode === "deposit" ? `Moved ${fmtUsdc(amount)} ${sym} into the agent account.` : `Withdrew ${fmtUsdc(amount)} ${sym} to your wallet.`;
    });
  };

  const withdrawKeg = () => {
    if (!keg) return;
    void tx.run(async (api) => {
      await api.send("Withdraw DRY", async () => {
        const { request } = await simulateContract(wagmiConfig, { address: account, abi: agentAccountAbi, functionName: "withdraw", args: [cfg.rewardToken, owner, keg], account: owner });
        return writeContract(wagmiConfig, request);
      });
      return `Withdrew ${fmtToken(keg)} DRY to your wallet; stake it on the House page.`;
    });
  };

  return (
    <section className="panel" aria-labelledby={`${id}-t`} data-testid="agents-funds">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
        <h2 id={`${id}-t`} className="panel-title">
          Agent account
        </h2>
        <span className="num text-xs text-muted" title={account}>
          {shortAddress(account)}{" "}
          <a className="link" href={`${cfg.explorerUrl}/address/${account}`} target="_blank" rel="noreferrer">
            explorer
          </a>
        </span>
      </div>
      <dl className="grid grid-cols-2 gap-4 border-b border-line px-4 py-4">
        <div>
          <dt className="text-xs text-muted">Trading balance</dt>
          <dd className="num mt-0.5 text-lg font-semibold">
            {inAccount !== undefined ? fmtUsdc(inAccount) : "—"} <span className="text-xs font-normal text-muted">{sym}</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-muted">Loss rebates</dt>
          <dd className="num mt-0.5 flex items-center gap-2 text-lg font-semibold">
            {keg !== undefined ? fmtToken(keg) : "—"} <span className="text-xs font-normal text-muted">DRY</span>
            {keg ? (
              <button type="button" className="btn btn-sm" disabled={tx.busy} onClick={withdrawKeg}>
                Withdraw
              </button>
            ) : null}
          </dd>
        </div>
        <div className="col-span-2 text-xs text-muted">
          Positions and orders the agents open belong to this account.{" "}
          <AppLink route="trade" params={{ account }} className="link" data-testid="agents-watch">
            Watch them on the trade page
          </AppLink>
          .
        </div>
      </dl>
      <div role="tablist" aria-label="Funds" className="tabs">
        {(["deposit", "withdraw"] as const).map((m) => (
          <button key={m} type="button" role="tab" aria-selected={mode === m} className="tab" onClick={() => (setMode(m), setText(""))}>
            {m === "deposit" ? "Deposit" : "Withdraw"}
          </button>
        ))}
      </div>
      <form className="flex flex-col gap-3 p-4" noValidate onSubmit={(e) => (e.preventDefault(), submit())}>
        <div>
          <div className="flex items-baseline justify-between">
            <label className="field-label" htmlFor={`${id}-amt`}>
              {mode === "deposit" ? "From your wallet" : "To your wallet"}
            </label>
            <span className="num text-xs text-muted">{available !== undefined ? `${fmtUsdc(available)} ${sym}` : "…"}</span>
          </div>
          <div className="field">
            <input id={`${id}-amt`} inputMode="decimal" autoComplete="off" placeholder="0.00" value={text} onChange={(e) => setText(e.target.value)} data-testid="agents-amount" />
            <span className="field-unit">{sym}</span>
            <button type="button" className="chip" disabled={!available} onClick={() => available && setText(toInputString(available, USDC_DECIMALS, USDC_DECIMALS))}>
              Max
            </button>
          </div>
        </div>
        <button type="submit" className={`btn btn-lg ${problem ? "" : "btn-primary"}`} disabled={problem !== null || tx.busy} data-testid="agents-funds-submit">
          {tx.busy ? <span className="spinner" aria-hidden="true" /> : null}
          {problem ?? (mode === "deposit" ? "Deposit" : "Withdraw")}
        </button>
        <TxStatus state={tx.state} onDismiss={tx.reset} />
      </form>
    </section>
  );
}

const EXPIRIES = [
  { label: "1 day", s: 86_400 },
  { label: "7 days", s: 7 * 86_400 },
  { label: "30 days", s: 30 * 86_400 },
  { label: "90 days", s: 90 * 86_400 },
];

function AgentsCard({ account, owner }: { account: Address; owner: Address }) {
  const { config: cfg } = useApp();
  const wagmiConfig = useConfig();
  const tx = useTx();
  const id = useId();
  const sym = cfg.collateralSymbol;
  const known = useKnownAgents(account);
  const [agentText, setAgentText] = useState("");
  const [generated, setGenerated] = useState<{ key: string; address: Address } | null>(null);
  const [expiry, setExpiry] = useState(EXPIRIES[1]!.s);
  const [lev, setLev] = useState("10");
  const [margin, setMargin] = useState("1000");

  const policies = useReadContracts({
    allowFailure: false,
    contracts: known.list.map((a) => ({ address: account, abi: agentAccountAbi, functionName: "agents", args: [a], chainId: cfg.chainId }) as const),
    query: { enabled: known.list.length > 0, refetchInterval: 5_000 },
  });
  // Each key's daily margin budget (`setAgentBudget`), edited per row.
  const budgets = useReadContracts({
    allowFailure: false,
    contracts: known.list.map((a) => ({ address: account, abi: agentAccountAbi, functionName: "budgets", args: [a], chainId: cfg.chainId }) as const),
    query: { enabled: known.list.length > 0, refetchInterval: 10_000 },
  });

  const agent = isAddress(agentText.trim(), { strict: false }) ? getAddress(agentText.trim()) : null;
  const levN = Number(lev);
  const maxMargin = parseAmount(margin, USDC_DECIMALS);
  const problem = !agent
    ? "Enter or generate an agent address"
    : agent.toLowerCase() === owner.toLowerCase()
      ? "The agent must not be your own wallet"
      : !(Number.isInteger(levN) && levN >= 1 && levN <= 100)
        ? "Max leverage: a whole number from 1 to 100"
        : !maxMargin
          ? "Enter a max margin per trade"
          : null;

  const approve = () => {
    if (problem || !agent || !maxMargin) return;
    void tx.run(async (api) => {
      const until = BigInt(Math.floor(Date.now() / 1000) + expiry);
      await api.send("Approve agent", async () => {
        const { request } = await simulateContract(wagmiConfig, { address: account, abi: agentAccountAbi, functionName: "setAgent", args: [agent, until, levN, maxMargin], account: owner });
        return writeContract(wagmiConfig, request);
      });
      known.add(agent);
      void policies.refetch();
      return `Agent ${shortAddress(agent)} approved until ${fmtDateTime(Number(until))}: up to ${levN}x and ${fmtUsdc(maxMargin)} ${sym} margin per trade.`;
    });
  };

  const revoke = (a: Address) => {
    void tx.run(async (api) => {
      await api.send("Revoke agent", async () => {
        const { request } = await simulateContract(wagmiConfig, { address: account, abi: agentAccountAbi, functionName: "revokeAgent", args: [a], account: owner });
        return writeContract(wagmiConfig, request);
      });
      void policies.refetch();
      return `Agent ${shortAddress(a)} revoked. Its open positions stay in the account for you to manage.`;
    });
  };

  const generate = () => {
    const key = generatePrivateKey();
    const address = privateKeyToAccount(key).address;
    setGenerated({ key, address });
    setAgentText(address);
  };

  const mcpConfig = useMemo(
    () =>
      JSON.stringify(
        {
          mcpServers: {
            "dry-powder": {
              command: "node",
              args: ["/path/to/dry-powder/mcp/src/index.mjs"],
              env: { DP_DEPLOYMENT: DEPLOYMENT_URL, DP_ACCOUNT: account, DP_AGENT_KEY: generated?.key ?? "0x<agent private key>", DP_MAX_NOTIONAL_USD: "2500" },
            },
          },
        },
        null,
        2,
      ),
    [account, generated],
  );
  const now = Math.floor(Date.now() / 1000);

  return (
    <section className="panel" aria-labelledby={`${id}-t`} data-testid="agents-list">
      <div className="border-b border-line px-4 py-3">
        <h2 id={`${id}-t`} className="panel-title">
          Agents
        </h2>
        <p className="mt-1.5 max-w-[62ch] text-[0.8125rem] text-muted">
          An agent key signs its own transactions and needs a little native USDC for gas (faucet.circle.com). It can trade
          within the policy below and nothing else.
        </p>
      </div>

      {known.list.length > 0 ? (
        <ul className="divide-y divide-line border-b border-line">
          {known.list.map((a, i) => {
            const p = policies.data?.[i] as readonly [bigint, number, bigint] | undefined;
            const active = p ? Number(p[0]) > now : false;
            return (
              <li key={a} className="flex flex-wrap items-center gap-3 px-4 py-2.5 text-[0.8125rem]">
                <span className="num" title={a}>
                  {shortAddress(a)}
                </span>
                <span className={`tag ${active ? "" : "text-faint"}`} data-tone={active ? "long" : undefined}>
                  {p ? (active ? "active" : Number(p[0]) === 0 ? "revoked" : "expired") : "…"}
                </span>
                {p && active ? (
                  <span className="num text-xs text-muted">
                    until {fmtDateTime(Number(p[0]))} · {p[1]}x · {fmtUsdc(p[2])} {sym}/trade
                  </span>
                ) : null}
                {active ? (
                  <button type="button" className="btn btn-sm ml-auto" disabled={tx.busy} onClick={() => revoke(a)}>
                    Revoke
                  </button>
                ) : null}
                {active ? <KeyBudget account={account} owner={owner} agent={a} budget={budgets.data?.[i] as readonly [bigint, number, bigint] | undefined} onDone={() => void budgets.refetch()} /> : null}
              </li>
            );
          })}
        </ul>
      ) : null}

      <form className="flex flex-col gap-3 p-4" noValidate onSubmit={(e) => (e.preventDefault(), approve())}>
        <div>
          <label className="field-label" htmlFor={`${id}-a`}>
            Agent address
          </label>
          <div className="field">
            <input id={`${id}-a`} autoComplete="off" spellCheck={false} placeholder="0x…" value={agentText} onChange={(e) => (setAgentText(e.target.value), setGenerated(null))} data-testid="agent-address" />
            <button type="button" className="chip" onClick={generate} data-testid="agent-generate">
              Generate key
            </button>
          </div>
        </div>
        {generated ? (
          <div className="notice text-xs" data-tone="warn" role="status">
            New agent key, shown once and never stored: <span className="num break-all text-text">{generated.key}</span>. Copy it into your
            agent now. It can only trade within this policy, never withdraw.
          </div>
        ) : null}
        <div className="grid grid-cols-2 gap-2">
          <div className="col-span-2">
            <label className="field-label" htmlFor={`${id}-e`}>
              Expires in
            </label>
            <select id={`${id}-e`} className="field w-full" value={expiry} onChange={(e) => setExpiry(Number(e.target.value))}>
              {EXPIRIES.map((x) => (
                <option key={x.s} value={x.s}>
                  {x.label}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className="field-label" htmlFor={`${id}-l`}>
              Max leverage
            </label>
            <div className="field">
              <input id={`${id}-l`} inputMode="numeric" value={lev} onChange={(e) => setLev(e.target.value)} />
              <span className="field-unit">x</span>
            </div>
          </div>
          <div>
            <label className="field-label" htmlFor={`${id}-m`}>
              Max margin / trade
            </label>
            <div className="field">
              <input id={`${id}-m`} inputMode="decimal" value={margin} onChange={(e) => setMargin(e.target.value)} />
              <span className="field-unit">{sym}</span>
            </div>
          </div>
        </div>
        <button type="submit" className={`btn btn-lg ${problem ? "" : "btn-primary"}`} disabled={problem !== null || tx.busy} data-testid="agent-approve">
          {tx.busy ? <span className="spinner" aria-hidden="true" /> : null}
          {problem ?? "Approve agent"}
        </button>
        <TxStatus state={tx.state} onDismiss={tx.reset} />
      </form>

      <details className="border-t border-line px-4 py-3 text-[0.8125rem]">
        <summary className="text-muted">Connect an AI agent (MCP server)</summary>
        <p className="mt-2 text-xs text-muted">
          The repository&rsquo;s <span className="num">mcp/</span> server gives Claude and other MCP clients tools to read markets and trade from
          this account with caps and a confirmation step. Add this to your client&rsquo;s MCP config:
        </p>
        <pre className="num mt-2 overflow-x-auto bg-bg p-3 text-[0.7rem] leading-relaxed">{mcpConfig}</pre>
      </details>
      <p className="border-t border-line px-4 py-2 text-[0.7rem] text-faint">
        Approved agents are remembered in this browser; an agent approved elsewhere can be re-entered above to see or change it.
      </p>
    </section>
  );
}
