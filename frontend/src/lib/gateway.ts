// Circle Gateway on testnet: one USDC balance across chains. Deposit into the Gateway Wallet on any supported chain
// (credited after that chain's finality), then move any part of the balance to Arc in seconds with a signed burn
// intent; Circle's Forwarding Service mints it on Arc, so no Arc gas is needed.
//
// Sources (checked 2026-10-25): developers.circle.com/gateway/references/supported-blockchains (Arc Testnet is
// domain 26), /gateway/quickstarts/unified-balance (contracts, typed data, /v1/balances, /v1/transfer),
// /gateway/howtos/forwarding-service (/v1/estimate, transfer status), /gateway/references/fees. The testnet examples
// send no API key. Browser (CORS) access is not documented; failures are reported as such.
import { createPublicClient, createWalletClient, custom, erc20Abi, http, maxUint256, parseUnits, toHex, type Address, type Hex } from "viem";
import { CCTP, CCTP_SOURCES, addressToBytes32, ZERO_BYTES32, type CctpSource } from "./cctp-core";
import { switchWalletChain, type Eip1193 } from "./cctp";
import { UserFacingError } from "./errors";

export const GATEWAY = {
  api: "https://gateway-api-testnet.circle.com",
  wallet: "0x0077777d7EBA4688BDeF3E311b846F25870A19B9",
  minter: "0x0022222ABE238Cc2C7Bb1f21003F0a260052475B",
} as const satisfies Record<string, string>;

/** Source chains Gateway supports among the ones this app knows (Linea is not one). */
export const GATEWAY_SOURCES: readonly CctpSource[] = CCTP_SOURCES.filter((s) => [0, 1, 2, 3, 6, 7, 10, 14].includes(s.domain));
const DOMAINS = [...GATEWAY_SOURCES.map((s) => s.domain), CCTP.arcDomain];

const GATEWAY_WALLET_ABI = [
  { type: "function", name: "deposit", stateMutability: "nonpayable", inputs: [{ name: "token", type: "address" }, { name: "value", type: "uint256" }], outputs: [] },
] as const;

const TRANSFER_SPEC = [
  { name: "version", type: "uint32" },
  { name: "sourceDomain", type: "uint32" },
  { name: "destinationDomain", type: "uint32" },
  { name: "sourceContract", type: "bytes32" },
  { name: "destinationContract", type: "bytes32" },
  { name: "sourceToken", type: "bytes32" },
  { name: "destinationToken", type: "bytes32" },
  { name: "sourceDepositor", type: "bytes32" },
  { name: "destinationRecipient", type: "bytes32" },
  { name: "sourceSigner", type: "bytes32" },
  { name: "destinationCaller", type: "bytes32" },
  { name: "value", type: "uint256" },
  { name: "salt", type: "bytes32" },
  { name: "hookData", type: "bytes" },
] as const;
const BURN_INTENT = [
  { name: "maxBlockHeight", type: "uint256" },
  { name: "maxFee", type: "uint256" },
  { name: "spec", type: "TransferSpec" },
] as const;

export type GatewayBalance = { domain: number; balance: bigint };

async function call(path: string, init?: RequestInit): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(`${GATEWAY.api}${path}`, { ...init, headers: { "content-type": "application/json", accept: "application/json", ...(init?.headers ?? {}) } });
  } catch {
    throw new UserFacingError("Circle Gateway could not be reached from this page (its API may not accept calls from browsers yet). Use CCTP instead.");
  }
  const text = await response.text();
  if (!response.ok) throw new UserFacingError(`Circle Gateway refused the request (${response.status}): ${text.slice(0, 160)}`);
  return text ? (JSON.parse(text) as unknown) : null;
}

/** The depositor's Gateway balance on each supported chain (USDC, 6 decimals). */
export async function fetchGatewayBalances(depositor: Address): Promise<GatewayBalance[]> {
  const json = (await call("/v1/balances", { method: "POST", body: JSON.stringify({ token: "USDC", sources: DOMAINS.map((domain) => ({ domain, depositor })) }) })) as {
    balances?: { domain: number; balance: string }[];
  } | null;
  return (json?.balances ?? []).map((b) => ({ domain: Number(b.domain), balance: parseUnits(String(b.balance ?? "0"), 6) }));
}

/** Deposits USDC into the Gateway Wallet on `source` (approve, then deposit). Credited after the chain's finality. */
export async function depositToGateway(provider: Eip1193, source: CctpSource, amount: bigint, onStep: (label: string, hash?: Hex) => void): Promise<Hex> {
  const [from] = (await provider.request({ method: "eth_requestAccounts" })) as Address[];
  if (!from) throw new UserFacingError("Your browser wallet did not share an account.");
  await switchWalletChain(provider, source.chain);
  const pub = createPublicClient({ chain: source.chain, transport: http() });
  const wallet = createWalletClient({ account: from, chain: source.chain, transport: custom(provider) });
  const allowance = await pub.readContract({ address: source.usdc, abi: erc20Abi, functionName: "allowance", args: [from, GATEWAY.wallet] });
  if (allowance < amount) {
    onStep("Approve USDC for Gateway in your wallet");
    const approval = await wallet.writeContract({ address: source.usdc, abi: erc20Abi, functionName: "approve", args: [GATEWAY.wallet, amount] });
    onStep("Waiting for the approval", approval);
    await pub.waitForTransactionReceipt({ hash: approval });
  }
  onStep("Confirm the deposit in your wallet");
  const hash = await wallet.writeContract({ address: GATEWAY.wallet, abi: GATEWAY_WALLET_ABI, functionName: "deposit", args: [source.usdc, amount] });
  onStep("Waiting for the deposit to confirm", hash);
  const receipt = await pub.waitForTransactionReceipt({ hash });
  if (receipt.status !== "success") throw new UserFacingError("The Gateway deposit reverted.");
  return hash;
}

type Spec = {
  version: number;
  sourceDomain: number;
  destinationDomain: number;
  sourceContract: Hex;
  destinationContract: Hex;
  sourceToken: Hex;
  destinationToken: Hex;
  sourceDepositor: Hex;
  destinationRecipient: Hex;
  sourceSigner: Hex;
  destinationCaller: Hex;
  value: bigint;
  salt: Hex;
  hookData: Hex;
};

const asJson = (spec: Spec) => ({ ...spec, value: spec.value.toString() });

/**
 * Moves `amount` of the depositor's Gateway balance on `source` to `recipient` on Arc, minted by Circle's
 * Forwarding Service. The browser wallet signs one EIP-712 burn intent (no transaction, no gas). Resolves with the
 * transfer id once Circle reports it confirmed.
 */
export async function moveGatewayToArc(input: {
  provider: Eip1193;
  source: CctpSource;
  amount: bigint;
  recipient: Address;
  onStep: (label: string) => void;
}): Promise<{ transferId: string; fee: bigint }> {
  const { provider, source, amount, recipient, onStep } = input;
  const [from] = (await provider.request({ method: "eth_requestAccounts" })) as Address[];
  if (!from) throw new UserFacingError("Your browser wallet did not share an account.");
  const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
  const spec: Spec = {
    version: 1,
    sourceDomain: source.domain,
    destinationDomain: CCTP.arcDomain,
    sourceContract: addressToBytes32(GATEWAY.wallet),
    destinationContract: addressToBytes32(GATEWAY.minter),
    sourceToken: addressToBytes32(source.usdc),
    destinationToken: addressToBytes32(CCTP.arcUsdc),
    sourceDepositor: addressToBytes32(from),
    destinationRecipient: addressToBytes32(recipient),
    sourceSigner: addressToBytes32(from),
    destinationCaller: ZERO_BYTES32,
    value: amount,
    salt,
    hookData: "0x",
  };

  onStep("Getting Circle's fee");
  const estimate = (await call("/v1/estimate?enableForwarder=true", { method: "POST", body: JSON.stringify([{ spec: asJson(spec) }]) })) as {
    body?: { burnIntent?: { maxFee?: string; maxBlockHeight?: string } }[];
  } | null;
  const quoted = estimate?.body?.[0]?.burnIntent;
  if (!quoted?.maxFee) throw new UserFacingError("Circle Gateway did not return a fee estimate.");
  // A 10% cushion on the quote for gas moving between the estimate and the signature.
  const maxFee = (BigInt(quoted.maxFee) * 110n) / 100n;
  const maxBlockHeight = quoted.maxBlockHeight ? BigInt(quoted.maxBlockHeight) : maxUint256;

  onStep("Sign the transfer in your wallet (a signature, no gas)");
  const wallet = createWalletClient({ account: from, chain: source.chain, transport: custom(provider) });
  const signature = await wallet.signTypedData({
    domain: { name: "GatewayWallet", version: "1" },
    types: { TransferSpec: TRANSFER_SPEC, BurnIntent: BURN_INTENT },
    primaryType: "BurnIntent",
    message: { maxBlockHeight, maxFee, spec },
  });

  onStep("Sending to Circle");
  const submitted = (await call("/v1/transfer?enableForwarder=true", {
    method: "POST",
    body: JSON.stringify([{ burnIntent: { maxBlockHeight: maxBlockHeight.toString(), maxFee: maxFee.toString(), spec: asJson(spec) }, signature }]),
  })) as { transferId?: string } | { transferId?: string }[] | null;
  const transferId = (Array.isArray(submitted) ? submitted[0]?.transferId : submitted?.transferId) ?? null;
  if (!transferId) throw new UserFacingError("Circle Gateway accepted the request but returned no transfer id.");

  onStep("Circle is minting on Arc");
  for (let i = 0; i < 72; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 5_000));
    type TransferStatus = { status?: string; forwardingDetails?: { failureReason?: string } } | null;
    let status: TransferStatus;
    try {
      status = (await call(`/v1/transfer/${transferId}`)) as TransferStatus;
    } catch {
      status = (await call(`/v1/transfers/${transferId}`).catch(() => null)) as TransferStatus;
    }
    const state = String(status?.status ?? "").toLowerCase();
    if (state === "confirmed" || state === "finalized") return { transferId, fee: maxFee };
    if (state === "failed") throw new UserFacingError(`Circle Gateway could not complete the transfer: ${status?.forwardingDetails?.failureReason ?? "no reason given"}.`);
    if (state === "expired") throw new UserFacingError("The transfer expired before Circle forwarded it. Nothing was moved; try again.");
  }
  throw new UserFacingError(`Circle Gateway has not confirmed transfer ${transferId} after six minutes. It may still complete.`);
}
