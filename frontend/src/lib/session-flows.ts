import type { Config } from "wagmi";
import { readContract, sendTransaction, simulateContract, writeContract } from "wagmi/actions";
import { zeroAddress, type Address, type Chain } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import type { TxApi } from "@/hooks/use-tx";
import { agentAccountAbi, agentAccountFactoryAbi, testUSDCAbi } from "./abi";
import { erc20Abi } from "./abis-extra";
import { TEST_MINT_AMOUNT } from "./actions";
import type { RuntimeConfig } from "./config";
import { UserFacingError } from "./errors";
import { arcFees, forgetSession, saveSession, sessionClient, setTradeFrom, type Session } from "./session";

/** Everything the instant-trading flows need. */
export type SessionFlowContext = {
  wagmi: Config;
  cfg: RuntimeConfig;
  chain: Chain;
  rpcUrls: readonly string[];
  api: TxApi;
  /** The connected wallet: it owns the account and approves the key. */
  owner: Address;
};

export type SessionPolicy = { durationSeconds: number; maxLeverage: number; maxMargin: bigint };

function factoryOf(cfg: RuntimeConfig): Address {
  if (!cfg.agentFactory) throw new UserFacingError("This deployment has no agent account factory, so instant trading is not available.");
  return cfg.agentFactory;
}

/** Whether a revert means "this contract predates v3.1" (no such function, or not payable) rather than a refusal. */
function unsupported(error: unknown): boolean {
  const text = error instanceof Error ? `${error.message} ${(error as { shortMessage?: string }).shortMessage ?? ""}` : String(error);
  return !/InvalidPolicy|ZeroAddress|AccountExists|NotOwner|insufficient funds|User rejected|denied/i.test(text);
}

/**
 * Sets up instant trading: a new key in this browser, its on-chain policy, gas for it and, if needed, the owner's
 * AgentAccount. On v3.1 contracts that is one wallet confirmation (the factory creates the account with the key
 * approved, or the account approves it, and either forwards the gas to it); older contracts take two (the gas
 * transfer, then the approval, with the key creating the account in between). On a test deployment the key then
 * mints test collateral straight into the account.
 */
export async function enableInstantTrading(ctx: SessionFlowContext, policy: SessionPolicy, gas: bigint, previous: Session | null): Promise<Session> {
  const { wagmi, cfg, chain, rpcUrls, api, owner } = ctx;
  const factory = factoryOf(cfg);

  // Reuse a key that was created but never approved (it may already hold the gas sent for it).
  const reuse = previous && previous.owner.toLowerCase() === owner.toLowerCase() && previous.status === "pending" ? previous : null;
  const key = reuse?.key ?? generatePrivateKey();
  const agent = privateKeyToAccount(key).address;

  api.preparing("Preparing your trading account");
  const existing = await readContract(wagmi, { address: factory, abi: agentAccountFactoryAbi, functionName: "accountOf", args: [owner], chainId: cfg.chainId });
  const account =
    existing !== zeroAddress
      ? existing
      : await readContract(wagmi, { address: factory, abi: agentAccountFactoryAbi, functionName: "predictAccount", args: [owner], chainId: cfg.chainId });

  const draft: Session = {
    chainId: cfg.chainId,
    factory,
    owner,
    account,
    agent,
    key,
    expiry: 0,
    maxLeverage: policy.maxLeverage,
    maxMargin: policy.maxMargin.toString(),
    createdAt: Math.floor(Date.now() / 1000),
    status: "pending",
  };
  // Saved before any gas moves, so a reload mid-way never strands the key that holds it.
  saveSession(draft);

  const client = sessionClient(chain, rpcUrls, key);
  const have = await client.getBalance({ address: agent });
  const topUp = have < gas / 2n ? gas - have : 0n;
  const block = await client.getBlock();
  const expiry = Number(block.timestamp) + policy.durationSeconds;
  const policyArgs = [agent, BigInt(expiry), policy.maxLeverage, policy.maxMargin] as const;

  // One confirmation where the contracts allow it.
  let request: unknown = null;
  try {
    request =
      existing === zeroAddress
        ? (await simulateContract(wagmi, { address: factory, abi: agentAccountFactoryAbi, functionName: "createAccountWithAgent", args: policyArgs, value: topUp, account: owner, chainId: cfg.chainId })).request
        : (await simulateContract(wagmi, { address: account, abi: agentAccountAbi, functionName: "setAgent", args: policyArgs, value: topUp, account: owner, chainId: cfg.chainId })).request;
  } catch (error) {
    if (!unsupported(error)) throw error;
  }

  if (request) {
    await api.send(existing === zeroAddress ? "Create your trading account and approve this browser" : "Approve this browser's trading key", () => writeContract(wagmi, request as never));
  } else {
    if (topUp > 0n) await api.send("Send gas to the trading key", () => sendTransaction(wagmi, { to: agent, value: topUp, chainId: cfg.chainId }));
    if (existing === zeroAddress) {
      await api.send("Create your trading account", async () => {
        const { request: create } = await client.simulateContract({ address: factory, abi: agentAccountFactoryAbi, functionName: "createAccount", args: [owner], account: client.account });
        return client.writeContract({ ...(create as object), ...(await arcFees(client)) } as never);
      });
    }
    await api.send("Approve the trading key", async () => {
      const { request: approve } = await simulateContract(wagmi, { address: account, abi: agentAccountAbi, functionName: "setAgent", args: policyArgs, account: owner, chainId: cfg.chainId });
      return writeContract(wagmi, approve);
    });
  }

  const session: Session = { ...draft, expiry, status: "active" };
  saveSession(session);
  setTradeFrom(owner, "account");

  if (cfg.collateralIsTest) {
    const balance = await readContract(wagmi, { address: cfg.usdc, abi: erc20Abi, functionName: "balanceOf", args: [account], chainId: cfg.chainId });
    if (balance < 100_000_000n) await mintIntoAccount(ctx, session);
  }
  return session;
}

/** Renews the key's approval (new expiry and limits). One wallet confirmation. */
export async function renewInstantTrading(ctx: SessionFlowContext, session: Session, policy: SessionPolicy): Promise<Session> {
  const { wagmi, cfg, chain, rpcUrls, api, owner } = ctx;
  const client = sessionClient(chain, rpcUrls, session.key);
  const block = await client.getBlock();
  const expiry = Number(block.timestamp) + policy.durationSeconds;
  await api.send("Renew the trading key", async () => {
    const { request } = await simulateContract(wagmi, {
      address: session.account,
      abi: agentAccountAbi,
      functionName: "setAgent",
      args: [session.agent, BigInt(expiry), policy.maxLeverage, policy.maxMargin],
      account: owner,
      chainId: cfg.chainId,
    });
    return writeContract(wagmi, request);
  });
  const next: Session = { ...session, expiry, maxLeverage: policy.maxLeverage, maxMargin: policy.maxMargin.toString(), status: "active" };
  saveSession(next);
  return next;
}

/** Sends the key more native USDC for gas. One wallet confirmation. */
export async function topUpGas(ctx: SessionFlowContext, session: Session, amount: bigint): Promise<void> {
  await ctx.api.send("Top up the trading key's gas", () => sendTransaction(ctx.wagmi, { to: session.agent, value: amount, chainId: ctx.cfg.chainId }));
}

/**
 * Revokes the key on-chain (one wallet confirmation), sends its leftover gas back to the owner and forgets it here.
 * Positions and funds stay in the account; the owner can trade or withdraw from it with the wallet.
 */
export async function revokeInstantTrading(ctx: SessionFlowContext, session: Session): Promise<void> {
  const { wagmi, cfg, chain, rpcUrls, api, owner } = ctx;
  if (session.status === "active") {
    await api.send("Revoke the trading key", async () => {
      const { request } = await simulateContract(wagmi, {
        address: session.account,
        abi: agentAccountAbi,
        functionName: "revokeAgent",
        args: [session.agent],
        account: owner,
        chainId: cfg.chainId,
      });
      return writeContract(wagmi, request);
    });
  }
  const client = sessionClient(chain, rpcUrls, session.key);
  try {
    const balance = await client.getBalance({ address: session.agent });
    const fees = await arcFees(client);
    const cost = 21_000n * fees.maxFeePerGas;
    if (balance > cost * 2n) {
      await api.send("Return leftover gas", () =>
        client.sendTransaction({ to: owner, value: balance - cost, gas: 21_000n, ...fees }),
      );
    }
  } catch {
    // Returning dust is best effort; the key is revoked either way.
  }
  forgetSession(session);
  setTradeFrom(owner, "wallet");
}

/** Moves collateral from the wallet into the trading account. One wallet confirmation. */
export async function depositToAccount(ctx: SessionFlowContext, session: Session, amount: bigint): Promise<void> {
  const { wagmi, cfg, api, owner } = ctx;
  await api.send(`Deposit ${cfg.collateralSymbol}`, async () => {
    const { request } = await simulateContract(wagmi, {
      address: cfg.usdc,
      abi: testUSDCAbi,
      functionName: "transfer",
      args: [session.account, amount],
      account: owner,
      chainId: cfg.chainId,
    });
    return writeContract(wagmi, request);
  });
}

/** Sends collateral from the trading account back to the owner's wallet. Only the owner can. */
export async function withdrawFromAccount(ctx: SessionFlowContext, session: Session, amount: bigint): Promise<void> {
  const { wagmi, cfg, api, owner } = ctx;
  await api.send(`Withdraw ${cfg.collateralSymbol}`, async () => {
    const { request } = await simulateContract(wagmi, {
      address: session.account,
      abi: agentAccountAbi,
      functionName: "withdraw",
      args: [cfg.usdc, owner, amount],
      account: owner,
      chainId: cfg.chainId,
    });
    return writeContract(wagmi, request);
  });
}

/** Test deployments: the key mints test collateral straight into the account (no wallet involved). */
export async function mintIntoAccount(ctx: Pick<SessionFlowContext, "cfg" | "chain" | "rpcUrls" | "api">, session: Session): Promise<void> {
  const { cfg, chain, rpcUrls, api } = ctx;
  const client = sessionClient(chain, rpcUrls, session.key);
  await api.send(`Add test ${cfg.collateralSymbol} to your trading account`, async () => {
    const { request } = await client.simulateContract({ address: cfg.usdc, abi: testUSDCAbi, functionName: "mint", args: [session.account, TEST_MINT_AMOUNT], account: client.account });
    return client.writeContract({ ...(request as object), ...(await arcFees(client)) } as never);
  });
}
