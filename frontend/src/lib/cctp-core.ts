// CCTP V2 (Circle's Cross-Chain Transfer Protocol) on testnets: the constants and the pure arithmetic behind
// "bring USDC from another chain to Arc". No browser or wallet code here, so it can be tested on its own.
//
// Sources (checked 2026-10-25): developers.circle.com/cctp/references/contract-addresses (V2 testnet addresses are
// the same on every testnet chain; Arc Testnet is domain 26), /cctp/quickstarts/transfer-usdc-ethereum-to-arc,
// /cctp/howtos/transfer-usdc-with-forwarding-service, /cctp/cctp-finality-and-fees. USDC token addresses per chain
// match Circle's own sample app (circlefin/cctp-v2-web-app, src/lib/chains.ts).
import type { Address, Hex } from "viem";
import { arbitrumSepolia, avalancheFuji, baseSepolia, lineaSepolia, optimismSepolia, polygonAmoy, sepolia, unichainSepolia, worldchainSepolia } from "viem/chains";
import type { Chain } from "viem";

export const CCTP = {
  tokenMessenger: "0x8FE6B999Dc680CcFDD5Bf7EB0974218be2542DAA",
  messageTransmitter: "0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275",
  /** Circle's attestation service for testnets. */
  iris: "https://iris-api-sandbox.circle.com",
  arcDomain: 26,
  /** Arc's USDC: the native gas token, exposed through a 6-decimal ERC-20 interface at this address. */
  arcUsdc: "0x3600000000000000000000000000000000000000",
  /** "Fast": Iris attests at the confirmed level (seconds). "Standard": at finality (minutes; ~15-19 on Sepolia). */
  fastThreshold: 1000,
  standardThreshold: 2000,
  /** Static hook data asking Circle's Forwarding Service to submit the mint on the destination ("cctp-forward", v0). */
  forwardHookData: "0x636374702d666f72776172640000000000000000000000000000000000000000",
} as const satisfies Record<string, string | number>;

export type CctpSource = {
  chain: Chain;
  /** CCTP domain id of the chain. */
  domain: number;
  usdc: Address;
};

/** Testnets that can send USDC to Arc with CCTP V2 (all EVM, same contract addresses). */
export const CCTP_SOURCES: readonly CctpSource[] = [
  { chain: sepolia, domain: 0, usdc: "0x1c7D4B196Cb0C7B01d743Fbc6116a902379C7238" },
  { chain: baseSepolia, domain: 6, usdc: "0x036CbD53842c5426634e7929541eC2318f3dCF7e" },
  { chain: arbitrumSepolia, domain: 3, usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d" },
  { chain: optimismSepolia, domain: 2, usdc: "0x5fd84259d66Cd46123540766Be93DFE6D43130D7" },
  { chain: avalancheFuji, domain: 1, usdc: "0x5425890298aed601595a70AB815c96711a31Bc65" },
  { chain: polygonAmoy, domain: 7, usdc: "0x41E94Eb019C0762f9Bfcf9Fb1E58725BfB0e7582" },
  { chain: unichainSepolia, domain: 10, usdc: "0x31d0220469e10c4E71834a79b1f276d740d3768F" },
  { chain: worldchainSepolia, domain: 14, usdc: "0x66145f38cBAC35Ca6F1Dfb4914dF98F1614aeA88" },
  { chain: lineaSepolia, domain: 11, usdc: "0xFEce4462D57bD51A6A552365A011b95f0E16d9B7" },
];

export const sourceByChainId = (id: number): CctpSource | undefined => CCTP_SOURCES.find((s) => s.chain.id === id);
export const sourceByDomain = (domain: number): CctpSource | undefined => CCTP_SOURCES.find((s) => s.domain === domain);

/** An EVM address as the 32-byte word CCTP uses for recipients and callers (left-padded). */
export function addressToBytes32(address: string): Hex {
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) throw new Error(`Not an address: ${address}`);
  return `0x${"0".repeat(24)}${address.slice(2).toLowerCase()}` as Hex;
}

export const ZERO_BYTES32: Hex = `0x${"0".repeat(64)}`;

/** One entry of GET {iris}/v2/burn/USDC/fees/{source}/{destination}[?forward=true]. */
export type IrisFee = {
  finalityThreshold: number | string;
  /** Protocol fee in basis points, possibly fractional ("1.3" is 0.013%). */
  minimumFee: number | string;
  /** Forwarding Service fee in USDC subunits (6 decimals), when `forward=true` was asked for. */
  forwardFee?: { low?: number | string; med?: number | string; high?: number | string } | null;
};

/** "1.3" bp as hundredths of a basis point (130), exactly, without floating point. */
export function bpsToHundredths(bps: number | string): bigint {
  const text = String(bps).trim();
  if (!/^\d+(\.\d+)?$/.test(text)) throw new Error(`Unexpected fee: ${text}`);
  const [whole = "0", fraction = ""] = text.split(".");
  return BigInt(whole) * 100n + BigInt(`${fraction}00`.slice(0, 2));
}

export type BurnPlan = {
  /** minFinalityThreshold to burn with. */
  threshold: number;
  protocolFee: bigint;
  forwardFee: bigint;
  /** The most Circle may take: forwarding fee plus the protocol fee with a 20% cushion. */
  maxFee: bigint;
  /** What is burned on the source chain: the amount to deliver plus `maxFee`. */
  burn: bigint;
  /** What arrives at the least (if the whole `maxFee` is charged). */
  receiveAtLeast: bigint;
};

/**
 * Plans a burn that delivers `amount` (6 decimals) to Arc. The protocol fee is charged in basis points of the
 * burn; the cushion keeps a fee that moves between the quote and the burn from turning a Fast transfer into a
 * Standard one. With forwarding, Circle submits the mint on Arc, so the recipient needs no Arc gas.
 */
export function planBurn(amount: bigint, fees: readonly IrisFee[], options: { fast: boolean; forward: boolean }): BurnPlan {
  if (amount <= 0n) throw new Error("Enter an amount greater than zero");
  const wanted = options.fast ? CCTP.fastThreshold : CCTP.standardThreshold;
  const entry = fees.find((f) => Number(f.finalityThreshold) === wanted) ?? (options.fast ? undefined : fees.find((f) => Number(f.finalityThreshold) >= CCTP.standardThreshold));
  if (!entry) throw new Error(options.fast ? "Circle has no Fast transfer quote for this route right now" : "Circle has no quote for this route right now");
  const hundredths = bpsToHundredths(entry.minimumFee);
  // amount * bps / 10_000, with bps in hundredths -> / 1_000_000, rounded up. Circle charges on the whole burn,
  // which includes the fee itself: the 20% cushion below covers that.
  const protocolFee = (amount * hundredths + 999_999n) / 1_000_000n;
  const cushioned = (protocolFee * 120n + 99n) / 100n;
  const forwardText = options.forward ? (entry.forwardFee?.med ?? entry.forwardFee?.high ?? null) : 0;
  if (options.forward && (forwardText === null || forwardText === undefined)) throw new Error("Circle did not quote a forwarding fee for this route");
  const forwardFee = BigInt(String(forwardText).split(".")[0] ?? "0");
  const maxFee = forwardFee + cushioned;
  const burn = amount + maxFee;
  return { threshold: wanted, protocolFee, forwardFee, maxFee, burn, receiveAtLeast: amount };
}

/** The first message of GET {iris}/v2/messages/{sourceDomain}?transactionHash=…, as far as this app needs it. */
export type IrisMessage = {
  status: string;
  message: Hex | null;
  attestation: Hex | null;
  /** Set once the Forwarding Service has minted on the destination. */
  forwardTxHash: Hex | null;
  forwardState: string | null;
  delayReason: string | null;
};

const hexOrNull = (v: unknown): Hex | null => (typeof v === "string" && /^0x[0-9a-fA-F]*$/.test(v) && v.length > 2 ? (v as Hex) : null);

export function readIrisMessage(json: unknown): IrisMessage | null {
  const list = (json as { messages?: unknown[] } | null)?.messages;
  const first = Array.isArray(list) ? (list[0] as Record<string, unknown> | undefined) : undefined;
  if (!first) return null;
  return {
    status: typeof first.status === "string" ? first.status : "unknown",
    message: hexOrNull(first.message),
    attestation: hexOrNull(first.attestation),
    forwardTxHash: hexOrNull(first.forwardTxHash),
    forwardState: typeof first.forwardState === "string" ? first.forwardState : null,
    delayReason: typeof first.delayReason === "string" ? first.delayReason : null,
  };
}

export type TransferStatus = "attesting" | "forwarding" | "claimable" | "done" | "failed";

/** A burn this browser started, kept until it has arrived on Arc so it survives a reload. */
export type PendingTransfer = {
  burnTx: Hex;
  sourceChainId: number;
  sourceDomain: number;
  /** What was asked to arrive (6 decimals). */
  amount: string;
  maxFee: string;
  recipient: Address;
  forward: boolean;
  fast: boolean;
  createdAt: number;
  status: TransferStatus;
  mintTx?: Hex;
  message?: Hex;
  attestation?: Hex;
  note?: string;
};

/** How long forwarding may take before the app offers to claim on Arc by hand. */
export const FORWARD_PATIENCE_MS = 10 * 60_000;

/** The next status of `t` given the latest Iris message (null: Iris has not seen the burn yet). */
export function nextStatus(t: PendingTransfer, msg: IrisMessage | null, now: number): Pick<PendingTransfer, "status" | "mintTx" | "message" | "attestation" | "note"> {
  if (t.status === "done" || t.status === "failed") return t;
  if (!msg) return { status: "attesting", note: "Waiting for Circle to see the burn" };
  if (msg.forwardTxHash) return { status: "done", mintTx: msg.forwardTxHash, note: "Minted on Arc by Circle's Forwarding Service" };
  const complete = msg.status === "complete" && msg.message !== null && msg.attestation !== null;
  if (!complete) return { status: "attesting", note: msg.delayReason ? `Attestation delayed (${msg.delayReason})` : "Circle is attesting the burn" };
  const failedForward = msg.forwardState !== null && /fail|error|revert/i.test(msg.forwardState);
  if (t.forward && !failedForward && now - t.createdAt < FORWARD_PATIENCE_MS) {
    return { status: "forwarding", message: msg.message ?? undefined, attestation: msg.attestation ?? undefined, note: "Attested; Circle is minting on Arc" };
  }
  return {
    status: "claimable",
    message: msg.message ?? undefined,
    attestation: msg.attestation ?? undefined,
    note: t.forward ? "Forwarding has not completed: you can claim on Arc yourself (needs a little Arc USDC for gas)" : "Attested: claim it on Arc",
  };
}

export const feesUrl = (sourceDomain: number, destinationDomain: number, forward: boolean): string =>
  `${CCTP.iris}/v2/burn/USDC/fees/${sourceDomain}/${destinationDomain}${forward ? "?forward=true" : ""}`;

export const messagesUrl = (sourceDomain: number, burnTx: Hex): string => `${CCTP.iris}/v2/messages/${sourceDomain}?transactionHash=${burnTx}`;
