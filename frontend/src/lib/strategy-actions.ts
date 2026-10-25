import { encodeFunctionData, parseEventLogs, type Address, type Hex } from "viem";
import type { Config } from "wagmi";
import { readContract } from "wagmi/actions";
import type { TxApi } from "@/hooks/use-tx";
import { agentAccountAbi, agentAccountFactoryAbi, agentRegistryAbi, strategiesAbi, testUSDCAbi } from "./abi";
import type { RuntimeConfig } from "./config";
import { UserFacingError } from "./errors";
import { fmtDateTime, fmtUsdc, shortAddress } from "./format";
import { type AgentPolicy, type Listing, type StrategyDraft, templateOf, toConfig } from "./strategies";
import { walletWrite } from "./wallet-write";

/** Owner transactions on the Agents page: the connected wallet signs each one. */
export type OwnerContext = { wagmi: Config; cfg: RuntimeConfig; api: TxApi; owner: Address };

const ZERO = "0x0000000000000000000000000000000000000000";

function strategiesOf(cfg: RuntimeConfig): Address {
  if (!cfg.strategies) throw new UserFacingError("This deployment has no Strategies contract (STRATEGIES_ADDRESS).");
  return cfg.strategies;
}

function registryOf(cfg: RuntimeConfig): Address {
  if (!cfg.agentRegistry) throw new UserFacingError("This deployment has no agent registry (AGENT_REGISTRY_ADDRESS).");
  return cfg.agentRegistry;
}

/** One signature of a launch, in the words shown before anything is signed. */
export type LaunchStep = { key: "account" | "deposit" | "approve" | "create"; title: string; detail: string };

export type LaunchPlan = {
  /** The account, when it exists already. */
  account: Address | null;
  market: { id: Hex; symbol: string };
  draft: StrategyDraft;
  /** Collateral to move from the wallet into the account first (0: none). */
  deposit: bigint;
  /** The approval for the Strategies contract, when it must change. */
  policy: AgentPolicy | null;
  /** The daily margin budget to set for the Strategies contract, when it must change (0: no daily limit). */
  budget: bigint | null;
  /** The account limits its agents to listed markets and this one is not listed yet. */
  allowMarket: boolean;
};

/** "Start the trend follower on BTC-USD", "Start copying 0x12ab…cdef on BTC-USD". */
export function startTitle(d: StrategyDraft, symbol: string): string {
  if (d.kind === "trend") return `Start the trend follower on ${symbol}`;
  if (d.kind === "meanRevert") return `Start mean reversion on ${symbol}`;
  return `Start copying ${d.leader ? shortAddress(d.leader) : "the trader"} on ${symbol}`;
}

/** What a strategy is called in a sentence's subject: "Trend follower", "Copy of 0x12ab…cdef". */
export function strategyName(d: Pick<StrategyDraft, "kind" | "leader">): string {
  if (d.kind === "copy") return d.leader ? `Copy of ${shortAddress(d.leader)}` : "Copy";
  return templateOf(d.kind).title;
}

/** The signatures a launch takes, each explained. */
export function launchSteps(plan: LaunchPlan, sym: string): LaunchStep[] {
  const steps: LaunchStep[] = [];
  if (!plan.account) {
    steps.push({
      key: "account",
      title: "Create your agent account",
      detail: "A contract your wallet owns, at a fixed address. Strategies trade from it; only your wallet can move money out.",
    });
  }
  if (plan.deposit > 0n) {
    steps.push({
      key: "deposit",
      title: `Deposit ${fmtUsdc(plan.deposit)} ${sym}`,
      detail: "From your wallet into the account, for margin and keeper fees. You can withdraw what is not in a position at any time.",
    });
  }
  if (plan.policy || plan.budget !== null || plan.allowMarket) {
    const parts: string[] = [];
    if (plan.policy) {
      parts.push(
        `Lets the Strategies contract place orders from the account until ${fmtDateTime(Number(plan.policy.expiry))}: up to ${plan.policy.maxLeverage}x and ${fmtUsdc(plan.policy.maxMargin)} ${sym} of margin per order.`,
      );
    }
    if (plan.budget !== null) parts.push(plan.budget === 0n ? "No daily limit on new margin." : `At most ${fmtUsdc(plan.budget)} ${sym} of new margin a day, across all your strategies.`);
    if (plan.allowMarket) parts.push(`Adds ${plan.market.symbol} to the markets your agents may trade.`);
    parts.push("It can open and close positions, never withdraw.");
    steps.push({ key: "approve", title: plan.policy ? "Approve strategies on the account" : "Update the strategy limits", detail: parts.join(" ") });
  }
  steps.push({
    key: "create",
    title: startTitle(plan.draft, plan.market.symbol),
    detail:
      plan.draft.kind === "copy"
        ? "The keeper checks the leader's position at each interval and places the orders that keep the copy in line."
        : "From the next keeper check it reads the price at each interval and places one order at a time towards its signal.",
  });
  return steps;
}

/**
 * Launches a strategy: creates the account if there is none, deposits, approves the Strategies contract (with the
 * daily budget and the market, in one `multicall`), then `Strategies.create`. Returns the new strategy's id.
 */
export async function launchStrategy(ctx: OwnerContext, plan: LaunchPlan): Promise<{ id: bigint | null; account: Address }> {
  const { wagmi, cfg, api, owner } = ctx;
  const strategies = strategiesOf(cfg);
  const factory = cfg.agentFactory;
  if (!factory) throw new UserFacingError("This deployment has no agent account factory (AGENT_FACTORY_ADDRESS).");
  const sym = cfg.collateralSymbol;
  const call = { account: owner, chainId: cfg.chainId } as const;

  let account = plan.account;
  if (!account) {
    await api.send("Create your agent account", () => walletWrite(wagmi, { address: factory, abi: agentAccountFactoryAbi, functionName: "createAccount", args: [owner], ...call }));
    const created = await readContract(wagmi, { address: factory, abi: agentAccountFactoryAbi, functionName: "accountOf", args: [owner], chainId: cfg.chainId });
    if (!created || created === ZERO) throw new UserFacingError("The account was created but could not be read back. Reload the page.");
    account = created;
  }

  if (plan.deposit > 0n) {
    const target = account;
    await api.send(`Deposit ${fmtUsdc(plan.deposit)} ${sym} into the agent account`, () =>
      walletWrite(wagmi, { address: cfg.usdc, abi: testUSDCAbi, functionName: "transfer", args: [target, plan.deposit], ...call }),
    );
  }

  const calls: Hex[] = [];
  if (plan.policy) {
    const p = plan.policy;
    calls.push(encodeFunctionData({ abi: agentAccountAbi, functionName: "setAgent", args: [strategies, p.expiry, p.maxLeverage, p.maxMargin] }));
  }
  if (plan.budget !== null) calls.push(encodeFunctionData({ abi: agentAccountAbi, functionName: "setAgentBudget", args: [strategies, plan.budget] }));
  if (plan.allowMarket) calls.push(encodeFunctionData({ abi: agentAccountAbi, functionName: "setMarketAllowed", args: [plan.market.id, true] }));
  if (calls.length > 0) {
    const target = account;
    await api.send(plan.policy ? "Approve strategies on the agent account" : "Update the strategy limits", () =>
      walletWrite(wagmi, { address: target, abi: agentAccountAbi, functionName: "multicall", args: [calls], ...call }),
    );
  }

  const target = account;
  const receipt = await api.send(startTitle(plan.draft, plan.market.symbol), () =>
    walletWrite(wagmi, { address: strategies, abi: strategiesAbi, functionName: "create", args: [target, plan.market.id, toConfig(plan.draft)], ...call }),
  );
  const created = parseEventLogs({ abi: strategiesAbi, logs: receipt.logs, eventName: "StrategyCreated" })[0];
  return { id: created ? created.args.id : null, account };
}

export async function pauseStrategy(ctx: OwnerContext, id: bigint, label: string): Promise<void> {
  const strategies = strategiesOf(ctx.cfg);
  await ctx.api.send(label, () => walletWrite(ctx.wagmi, { address: strategies, abi: strategiesAbi, functionName: "pause", args: [id], account: ctx.owner, chainId: ctx.cfg.chainId }));
}

export async function resumeStrategy(ctx: OwnerContext, id: bigint, label: string): Promise<void> {
  const strategies = strategiesOf(ctx.cfg);
  await ctx.api.send(label, () => walletWrite(ctx.wagmi, { address: strategies, abi: strategiesAbi, functionName: "resume", args: [id], account: ctx.owner, chainId: ctx.cfg.chainId }));
}

export async function stopStrategy(ctx: OwnerContext, id: bigint, label: string): Promise<void> {
  const strategies = strategiesOf(ctx.cfg);
  await ctx.api.send(label, () => walletWrite(ctx.wagmi, { address: strategies, abi: strategiesAbi, functionName: "stop", args: [id], account: ctx.owner, chainId: ctx.cfg.chainId }));
}

/** Replaces the approval of the Strategies contract (a renewal keeps the limits and moves the expiry). */
export async function setStrategiesPolicy(ctx: OwnerContext, account: Address, policy: AgentPolicy, label: string): Promise<void> {
  const strategies = strategiesOf(ctx.cfg);
  await ctx.api.send(label, () =>
    walletWrite(ctx.wagmi, { address: account, abi: agentAccountAbi, functionName: "setAgent", args: [strategies, policy.expiry, policy.maxLeverage, policy.maxMargin], account: ctx.owner, chainId: ctx.cfg.chainId }),
  );
}

/** Caps the margin `agent` (a key or the Strategies contract) may commit per UTC day; 0 removes the cap. */
export async function setDailyBudget(ctx: OwnerContext, account: Address, agent: Address, perDay: bigint, label: string): Promise<void> {
  await ctx.api.send(label, () =>
    walletWrite(ctx.wagmi, { address: account, abi: agentAccountAbi, functionName: "setAgentBudget", args: [agent, perDay], account: ctx.owner, chainId: ctx.cfg.chainId }),
  );
}

export async function registerAgent(ctx: OwnerContext, account: Address, l: Listing, update: boolean): Promise<void> {
  const registry = registryOf(ctx.cfg);
  const args = [account, l.name.trim(), l.description.trim(), l.kind.trim(), l.uri.trim()] as const;
  await ctx.api.send(update ? "Update the agent listing" : "List the account as an agent", () =>
    walletWrite(ctx.wagmi, { address: registry, abi: agentRegistryAbi, functionName: update ? "update" : "register", args, account: ctx.owner, chainId: ctx.cfg.chainId }),
  );
}

export async function unregisterAgent(ctx: OwnerContext, account: Address): Promise<void> {
  const registry = registryOf(ctx.cfg);
  await ctx.api.send("Remove the agent listing", () =>
    walletWrite(ctx.wagmi, { address: registry, abi: agentRegistryAbi, functionName: "unregister", args: [account], account: ctx.owner, chainId: ctx.cfg.chainId }),
  );
}
