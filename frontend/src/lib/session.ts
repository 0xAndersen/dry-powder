import {
  createWalletClient,
  fallback,
  http,
  publicActions,
  type Abi,
  type Address,
  type Chain,
  type Hex,
  type PublicActions,
  type Transport,
  type WalletClient,
} from "viem";
import { privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { createLocalStore } from "./storage";

/**
 * Instant trading: a key generated in this browser is approved as an agent on the trader's AgentAccount, with an
 * on-chain policy (expiry, max leverage, max margin per order). Orders then go out signed by that key, with no
 * wallet pop-up. The key can trade from the account but never withdraw from it; the owner can revoke it at any
 * time. It lives in this browser's storage only (testnet: plain localStorage), so clearing site data forgets it.
 */
export type Session = {
  chainId: number;
  factory: Address;
  owner: Address;
  /** The AgentAccount the key trades for. */
  account: Address;
  /** Address of the session key (the approved agent). */
  agent: Address;
  key: Hex;
  /** Unix seconds; the policy stops working after this. */
  expiry: number;
  maxLeverage: number;
  /** 6-decimal collateral units, as a decimal string. */
  maxMargin: string;
  createdAt: number;
  /** "pending" until the owner has approved the key on-chain. */
  status: "pending" | "active";
};

const isAddr = (v: unknown): v is Address => typeof v === "string" && /^0x[0-9a-fA-F]{40}$/.test(v);
const isKey = (v: unknown): v is Hex => typeof v === "string" && /^0x[0-9a-fA-F]{64}$/.test(v);

export const sessions = createLocalStore<Session[]>("dp:sessions:v1", [], (stored) => {
  if (!Array.isArray(stored)) return null;
  const out: Session[] = [];
  for (const s of stored as Partial<Session>[]) {
    if (!s || !isAddr(s.factory) || !isAddr(s.owner) || !isAddr(s.account) || !isAddr(s.agent) || !isKey(s.key)) continue;
    out.push({
      chainId: Number(s.chainId) || 0,
      factory: s.factory,
      owner: s.owner,
      account: s.account,
      agent: s.agent,
      key: s.key,
      expiry: Number(s.expiry) || 0,
      maxLeverage: Number(s.maxLeverage) || 1,
      maxMargin: typeof s.maxMargin === "string" && /^\d+$/.test(s.maxMargin) ? s.maxMargin : "0",
      createdAt: Number(s.createdAt) || 0,
      status: s.status === "active" ? "active" : "pending",
    });
  }
  return out.slice(-20);
});

/** Where orders go from: the instant-trading account (when set up) or the wallet itself. Per owner. */
export const tradeFrom = createLocalStore<Record<string, "account" | "wallet">>("dp:trade-from:v1", {}, (stored) => {
  if (!stored || typeof stored !== "object") return null;
  const out: Record<string, "account" | "wallet"> = {};
  for (const [k, v] of Object.entries(stored as Record<string, unknown>)) if (v === "account" || v === "wallet") out[k.toLowerCase()] = v;
  return out;
});

const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** The latest session for `owner` on this deployment, if any. Without an owner: the latest one for the deployment. */
export function findSession(list: readonly Session[], chainId: number, factory: Address | null, owner: Address | undefined): Session | null {
  if (!factory) return null;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const s = list[i]!;
    if (s.chainId !== chainId || !same(s.factory, factory)) continue;
    if (owner && !same(s.owner, owner)) continue;
    return s;
  }
  return null;
}

export function saveSession(next: Session): void {
  sessions.set((list) => [...list.filter((s) => !(s.chainId === next.chainId && same(s.factory, next.factory) && same(s.owner, next.owner))), next]);
}

export function forgetSession(target: Session): void {
  sessions.set((list) => list.filter((s) => !(s.chainId === target.chainId && same(s.factory, target.factory) && same(s.owner, target.owner))));
}

export function setTradeFrom(owner: Address, mode: "account" | "wallet"): void {
  tradeFrom.set((map) => ({ ...map, [owner.toLowerCase()]: mode }));
}

export type SessionClient = WalletClient<Transport, Chain, PrivateKeyAccount> & PublicActions<Transport, Chain>;

/** A signer for the session key on the app's RPCs (same fallback list as the wallet transport). */
export function sessionClient(chain: Chain, rpcUrls: readonly string[], key: Hex): SessionClient {
  const transport = fallback(rpcUrls.map((u) => http(u, { retryCount: 1 })), { rank: false });
  return createWalletClient({ account: privateKeyToAccount(key), chain, transport, pollingInterval: 500 }).extend(publicActions) as SessionClient;
}

const GWEI = 1_000_000_000n;

/**
 * Gas limit for a call estimated at `gas`. eth_estimateGas finds the least gas that works on the state it ran on;
 * the transaction runs in a later block, where other transactions may have changed what it does (an addition
 * becomes a new position, funding accrues), and a tight limit then runs out. A quarter more, plus room for a
 * few fresh storage slots. Unused gas is not charged.
 */
export const withGasHeadroom = (gas: bigint): bigint => (gas * 5n) / 4n + 50_000n;

/** Simulates a call from the session key (a revert surfaces with its reason), then sends it with gas headroom. */
export async function sessionWrite(
  client: SessionClient,
  call: { address: Address; abi: Abi; functionName: string; args?: readonly unknown[]; value?: bigint },
): Promise<Hex> {
  const params = { ...call, account: client.account } as never;
  const { request } = await client.simulateContract(params);
  // By address: with a local account viem estimates twice and caps the second estimate at the first.
  const gas = await client.estimateContractGas({ ...call, account: client.account.address } as never);
  return client.writeContract({ ...(request as object), gas: withGasHeadroom(gas), ...(await arcFees(client)) } as never);
}

/** Arc charges at least 20 gwei: pay twice the base fee plus a 1 gwei tip, never less than 25 gwei. */
export async function arcFees(client: PublicActions<Transport, Chain>): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
  const block = await client.getBlock();
  const base = block.baseFeePerGas ?? 20n * GWEI;
  const tip = GWEI;
  const max = base * 2n + tip;
  return { maxFeePerGas: max < 25n * GWEI ? 25n * GWEI : max, maxPriorityFeePerGas: tip };
}

/** Native USDC (18 decimals) sent to a new session key for gas: about a hundred orders on Arc Testnet. */
export const SESSION_GAS_TOP_UP = 1_000_000_000_000_000_000n;
/** Below this the app asks for a top-up. */
export const SESSION_GAS_LOW = 50_000_000_000_000_000n;

export const SESSION_DURATIONS = [
  { label: "1 day", seconds: 86_400 },
  { label: "7 days", seconds: 7 * 86_400 },
  { label: "30 days", seconds: 30 * 86_400 },
] as const;
