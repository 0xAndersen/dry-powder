// Bringing USDC to Arc from another testnet with CCTP V2, from the browser: burn on the source chain with the
// user's browser wallet, Circle attests, and the USDC is minted on Arc (by Circle's Forwarding Service, so no Arc
// gas is needed, or by the user's own claim). USDC on Arc is the gas token; practice trading uses test tUSDC.
import { createPublicClient, createWalletClient, custom, erc20Abi, http, numberToHex, type Address, type Chain, type Hex } from "viem";
import type { Config } from "wagmi";
import { writeContract, simulateContract } from "wagmi/actions";
import {
  CCTP,
  addressToBytes32,
  feesUrl,
  messagesUrl,
  nextStatus,
  planBurn,
  readIrisMessage,
  ZERO_BYTES32,
  type BurnPlan,
  type CctpSource,
  type IrisFee,
  type IrisMessage,
  type PendingTransfer,
} from "./cctp-core";
import { createLocalStore } from "./storage";
import { UserFacingError } from "./errors";

/** The bits of an EIP-1193 provider this flow uses. */
export type Eip1193 = { request: (args: { method: string; params?: unknown }) => Promise<unknown> };

export const TOKEN_MESSENGER_ABI = [
  {
    type: "function",
    name: "depositForBurn",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
    ],
    outputs: [],
  },
  {
    type: "function",
    name: "depositForBurnWithHook",
    stateMutability: "nonpayable",
    inputs: [
      { name: "amount", type: "uint256" },
      { name: "destinationDomain", type: "uint32" },
      { name: "mintRecipient", type: "bytes32" },
      { name: "burnToken", type: "address" },
      { name: "destinationCaller", type: "bytes32" },
      { name: "maxFee", type: "uint256" },
      { name: "minFinalityThreshold", type: "uint32" },
      { name: "hookData", type: "bytes" },
    ],
    outputs: [],
  },
] as const;

export const MESSAGE_TRANSMITTER_ABI = [
  {
    type: "function",
    name: "receiveMessage",
    stateMutability: "nonpayable",
    inputs: [
      { name: "message", type: "bytes" },
      { name: "attestation", type: "bytes" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

const isTransfer = (t: unknown): t is PendingTransfer => {
  const x = t as PendingTransfer;
  return !!x && typeof x.burnTx === "string" && /^0x[0-9a-fA-F]{64}$/.test(x.burnTx) && Number.isFinite(x.sourceDomain) && typeof x.recipient === "string";
};

/** Burns this browser started, until they have arrived (and a few finished ones, for the record). */
export const cctpTransfers = createLocalStore<PendingTransfer[]>("dp:cctp:v1", [], (stored) => (Array.isArray(stored) ? stored.filter(isTransfer).slice(-20) : null));

/** Circle's fee quote for a route. Throws a readable error when the attestation service cannot be reached. */
export async function fetchFees(sourceDomain: number, forward: boolean): Promise<IrisFee[]> {
  let response: Response;
  try {
    response = await fetch(feesUrl(sourceDomain, CCTP.arcDomain, forward), { headers: { accept: "application/json" } });
  } catch {
    throw new UserFacingError("Could not reach Circle's attestation service. Check your connection and try again.");
  }
  if (!response.ok) throw new UserFacingError(`Circle's fee quote failed (${response.status}). Try again in a moment.`);
  const json = (await response.json()) as unknown;
  if (!Array.isArray(json)) throw new UserFacingError("Circle's fee quote came back in an unexpected shape.");
  return json as IrisFee[];
}

/** The burn's message from Circle's attestation service (null until it has seen the burn). */
export async function fetchMessage(sourceDomain: number, burnTx: Hex): Promise<IrisMessage | null> {
  const response = await fetch(messagesUrl(sourceDomain, burnTx), { headers: { accept: "application/json" } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`Attestation lookup failed (${response.status})`);
  return readIrisMessage(await response.json());
}

/** Asks the wallet to switch to `chain`, adding it first if the wallet does not know it. */
export async function switchWalletChain(provider: Eip1193, chain: Chain): Promise<void> {
  const chainId = numberToHex(chain.id);
  try {
    await provider.request({ method: "wallet_switchEthereumChain", params: [{ chainId }] });
  } catch (error) {
    const code = (error as { code?: number; data?: { originalError?: { code?: number } } }).code ?? (error as { data?: { originalError?: { code?: number } } }).data?.originalError?.code;
    if (code !== 4902) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [
        {
          chainId,
          chainName: chain.name,
          nativeCurrency: chain.nativeCurrency,
          rpcUrls: chain.rpcUrls.default.http,
          blockExplorerUrls: chain.blockExplorers ? [chain.blockExplorers.default.url] : undefined,
        },
      ],
    });
  }
}

/** USDC held on the source chain (6 decimals), read from the chain's public RPC. */
export async function sourceUsdcBalance(source: CctpSource, owner: Address): Promise<bigint> {
  const client = createPublicClient({ chain: source.chain, transport: http() });
  return client.readContract({ address: source.usdc, abi: erc20Abi, functionName: "balanceOf", args: [owner] });
}

export type DepositStep = (label: string, hash?: Hex) => void;

/**
 * Burns USDC on `source` so that `amount` arrives at `recipient` on Arc. Switches the browser wallet to the source
 * chain, approves the TokenMessenger if needed, burns, records the burn (so a reload can pick it up) and switches
 * back to Arc. Returns the recorded transfer.
 */
export async function startCctpDeposit(input: {
  provider: Eip1193;
  source: CctpSource;
  amount: bigint;
  recipient: Address;
  fast: boolean;
  forward: boolean;
  /** The app's chain, to switch back to afterwards. */
  homeChain: Chain;
  onStep: DepositStep;
}): Promise<{ transfer: PendingTransfer; plan: BurnPlan }> {
  const { provider, source, amount, recipient, fast, forward, homeChain, onStep } = input;
  onStep("Asking your browser wallet for its account");
  const accounts = (await provider.request({ method: "eth_requestAccounts" })) as Address[];
  const from = accounts[0];
  if (!from) throw new UserFacingError("Your browser wallet did not share an account.");

  onStep(`Getting Circle's fee for ${source.chain.name} to Arc`);
  const plan = planBurn(amount, await fetchFees(source.domain, forward), { fast, forward });

  onStep(`Switching your wallet to ${source.chain.name}`);
  await switchWalletChain(provider, source.chain);
  const pub = createPublicClient({ chain: source.chain, transport: http() });
  const wallet = createWalletClient({ account: from, chain: source.chain, transport: custom(provider) });

  const balance = await pub.readContract({ address: source.usdc, abi: erc20Abi, functionName: "balanceOf", args: [from] });
  if (balance < plan.burn) {
    throw new UserFacingError(`Not enough USDC on ${source.chain.name}: ${Number(plan.burn) / 1e6} needed (including Circle's fee), ${Number(balance) / 1e6} held. Get testnet USDC at faucet.circle.com.`);
  }
  const allowance = await pub.readContract({ address: source.usdc, abi: erc20Abi, functionName: "allowance", args: [from, CCTP.tokenMessenger] });
  if (allowance < plan.burn) {
    onStep(`Approve ${Number(plan.burn) / 1e6} USDC for CCTP in your wallet`);
    const approval = await wallet.writeContract({ address: source.usdc, abi: erc20Abi, functionName: "approve", args: [CCTP.tokenMessenger, plan.burn] });
    onStep("Waiting for the approval", approval);
    const r = await pub.waitForTransactionReceipt({ hash: approval });
    if (r.status !== "success") throw new UserFacingError("The approval reverted on the source chain.");
  }

  onStep("Confirm the burn in your wallet");
  const common = [plan.burn, CCTP.arcDomain, addressToBytes32(recipient), source.usdc, ZERO_BYTES32, plan.maxFee, plan.threshold] as const;
  const burnTx = forward
    ? await wallet.writeContract({ address: CCTP.tokenMessenger, abi: TOKEN_MESSENGER_ABI, functionName: "depositForBurnWithHook", args: [...common, CCTP.forwardHookData] })
    : await wallet.writeContract({ address: CCTP.tokenMessenger, abi: TOKEN_MESSENGER_ABI, functionName: "depositForBurn", args: [...common] });
  const transfer: PendingTransfer = {
    burnTx,
    sourceChainId: source.chain.id,
    sourceDomain: source.domain,
    amount: amount.toString(),
    maxFee: plan.maxFee.toString(),
    recipient,
    forward,
    fast,
    createdAt: Date.now(),
    status: "attesting",
    note: "Burn sent; waiting for it to confirm",
  };
  cctpTransfers.set((list) => [...list.filter((t) => t.burnTx !== burnTx), transfer]);
  onStep("Waiting for the burn to confirm", burnTx);
  const receipt = await pub.waitForTransactionReceipt({ hash: burnTx });
  if (receipt.status !== "success") {
    const failed: PendingTransfer = { ...transfer, status: "failed", note: "The burn reverted on the source chain; nothing left your wallet" };
    cctpTransfers.set((list) => list.map((t) => (t.burnTx === burnTx ? failed : t)));
    throw new UserFacingError("The burn reverted on the source chain. Nothing was sent.");
  }
  // Best effort: put the wallet back on Arc so the rest of the app keeps working without a "switch network" step.
  try {
    await switchWalletChain(provider, homeChain);
  } catch {
    // The user can switch back from the header.
  }
  return { transfer, plan };
}

/** Polls Circle once and stores the transfer's new status. */
export async function refreshTransfer(t: PendingTransfer): Promise<PendingTransfer> {
  if (t.status === "done" || t.status === "failed") return t;
  const msg = await fetchMessage(t.sourceDomain, t.burnTx);
  const next: PendingTransfer = { ...t, ...nextStatus(t, msg, Date.now()) };
  cctpTransfers.set((list) => list.map((x) => (x.burnTx === t.burnTx ? next : x)));
  return next;
}

/** Mints an attested transfer on Arc from the connected Arc wallet (needs a little Arc USDC for gas). */
export async function claimOnArc(wagmi: Config, chainId: number, account: Address, t: PendingTransfer): Promise<Hex> {
  if (!t.message || !t.attestation) throw new UserFacingError("This transfer is not attested yet.");
  const { request } = await simulateContract(wagmi, {
    address: CCTP.messageTransmitter,
    abi: MESSAGE_TRANSMITTER_ABI,
    functionName: "receiveMessage",
    args: [t.message, t.attestation],
    account,
    chainId,
  });
  return writeContract(wagmi, request);
}

/** Marks a transfer as arrived after a successful claim. */
export function markClaimed(burnTx: Hex, mintTx: Hex): void {
  cctpTransfers.set((list) => list.map((t) => (t.burnTx === burnTx ? { ...t, status: "done", mintTx, note: "Claimed on Arc" } : t)));
}
