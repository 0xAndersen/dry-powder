// Plain-language descriptions of what a passkey-wallet request does, for the app's approval step: which contract,
// which action, what it sends and the most it can cost in gas.
import { decodeFunctionData, formatEther, formatUnits, type Abi, type Address } from "viem";
import { agentAccountAbi, agentAccountFactoryAbi, houseVaultAbi, perpEngineAbi, rewardTokenAbi, testUSDCAbi, trailingStopsAbi, twapOrdersAbi } from "./abi";
import { CCTP } from "./cctp-core";
import type { RuntimeConfig } from "./config";
import { shortAddress } from "./format";
import type { ApprovalLine, Describer, TxPreview } from "./passkey-wallet";

const CCTP_RECEIVE_ABI = [
  { type: "function", name: "receiveMessage", stateMutability: "nonpayable", inputs: [{ name: "message", type: "bytes" }, { name: "attestation", type: "bytes" }], outputs: [{ name: "", type: "bool" }] },
] as const;
const GATEWAY_MINT_ABI = [
  { type: "function", name: "gatewayMint", stateMutability: "nonpayable", inputs: [{ name: "attestationPayload", type: "bytes" }, { name: "signature", type: "bytes" }], outputs: [] },
] as const;

const ABIS: readonly Abi[] = [
  agentAccountFactoryAbi,
  agentAccountAbi,
  testUSDCAbi,
  perpEngineAbi,
  houseVaultAbi,
  rewardTokenAbi,
  trailingStopsAbi,
  twapOrdersAbi,
  CCTP_RECEIVE_ABI,
  GATEWAY_MINT_ABI,
] as unknown as readonly Abi[];

/** What a function call does, in a few words. */
const ACTIONS: Record<string, string> = {
  approve: "Allow spending",
  transfer: "Transfer",
  mint: "Get test funds",
  createAccount: "Create your trading account",
  createAccountWithAgent: "Create your trading account and approve this browser's trading key",
  setAgent: "Approve a trading key (or helper contract) on your trading account",
  initAgent: "Approve a trading key",
  revokeAgent: "Revoke a trading key",
  withdraw: "Withdraw from your trading account",
  deposit: "Deposit into the house vault",
  redeem: "Withdraw from the house vault",
  stake: "Stake DRY",
  unstake: "Unstake DRY",
  claimYield: "Claim staking yield",
  settleEpoch: "Settle the epoch",
  openPosition: "Open a position",
  closePosition: "Close a position",
  createLimitOrder: "Place an order",
  setTriggerOrder: "Set a take-profit, stop-loss or close order",
  cancelOrder: "Cancel an order",
  addMargin: "Add margin",
  receiveMessage: "Receive USDC sent with CCTP",
  gatewayMint: "Receive USDC from your Gateway balance",
};

function contractNames(cfg: RuntimeConfig): Map<string, string> {
  const entries: [string | null, string][] = [
    [cfg.perpEngine, "Perp engine"],
    [cfg.houseVault, "House vault"],
    [cfg.rewardToken, "DRY token"],
    [cfg.usdc, `${cfg.collateralSymbol} token`],
    [cfg.agentFactory, "Trading account factory"],
    [cfg.trailingStops, "Trailing stops"],
    [cfg.twapOrders, "TWAP orders"],
    [CCTP.messageTransmitter, "CCTP message transmitter"],
  ];
  return new Map(entries.filter((e): e is [string, string] => e[0] !== null).map(([a, n]) => [a.toLowerCase(), n]));
}

function decode(data: `0x${string}` | undefined): { name: string; args: readonly unknown[] } | null {
  if (!data || data === "0x") return null;
  for (const abi of ABIS) {
    try {
      const decoded = decodeFunctionData({ abi, data });
      return { name: decoded.functionName, args: (decoded.args ?? []) as readonly unknown[] };
    } catch {
      // Not this contract.
    }
  }
  return null;
}

const usdc = (value: bigint): string => `${Number(formatUnits(value, 6)).toLocaleString("en-US", { maximumFractionDigits: 6 })}`;

/** Builds the describer the passkey connector uses, with this deployment's contract names. */
export function passkeyDescriber(cfg: RuntimeConfig): Describer {
  const names = contractNames(cfg);
  const nameOf = (to: Address | null): string => (to ? (names.get(to.toLowerCase()) ?? shortAddress(to)) : "a new contract");

  return {
    transaction(tx: TxPreview) {
      const call = decode(tx.data);
      const lines: ApprovalLine[] = [];
      const target = call && /^(setAgent|revokeAgent|withdraw|multicall)$/.test(call.name) && !names.has(tx.to?.toLowerCase() ?? "") ? "Your trading account" : nameOf(tx.to);
      lines.push({ label: "With", value: target });
      if (call) {
        // The title names the action; functions without a plain-language name show theirs here.
        if (!ACTIONS[call.name]) lines.push({ label: "Function", value: call.name });
        if (call.name === "approve" || call.name === "transfer") {
          const [who, amount] = call.args as [Address, bigint];
          lines.push({ label: call.name === "approve" ? "Spender" : "To", value: nameOf(who) });
          if (typeof amount === "bigint") lines.push({ label: "Amount", value: amount > 10n ** 30n ? "Unlimited" : `${usdc(amount)} ${cfg.collateralSymbol}` });
        }
      } else if (tx.data && tx.data !== "0x") {
        lines.push({ label: "Action", value: `Contract call ${tx.data.slice(0, 10)}` });
      }
      if (tx.value > 0n) lines.push({ label: "Sends", value: `${Number(formatEther(tx.value)).toLocaleString("en-US", { maximumFractionDigits: 6 })} USDC (Arc gas)` });
      lines.push({ label: "Network fee, at most", value: `${Number(formatEther(tx.gas * tx.maxFeePerGas)).toFixed(4)} USDC` });
      return { title: call ? (ACTIONS[call.name] ?? "Confirm transaction") : tx.value > 0n && !tx.data ? "Send USDC" : "Confirm transaction", lines };
    },
    message(text: string) {
      return { title: "Sign a message", lines: [{ label: "Message", value: text.length > 280 ? `${text.slice(0, 280)}…` : text }] };
    },
    typedData({ domain, primaryType, message }) {
      const lines: ApprovalLine[] = [];
      if (domain && typeof domain.name === "string") lines.push({ label: "For", value: domain.name });
      if (primaryType) lines.push({ label: "Type", value: primaryType });
      const spec = (message as { spec?: { value?: unknown; destinationDomain?: unknown } } | undefined)?.spec;
      if (primaryType === "BurnIntent" && spec) {
        if (typeof spec.value === "bigint") lines.push({ label: "Moves", value: `${usdc(spec.value)} USDC` });
        if (spec.destinationDomain !== undefined) lines.push({ label: "To domain", value: String(spec.destinationDomain) });
      }
      return { title: primaryType === "BurnIntent" ? "Move USDC from your Gateway balance" : "Sign typed data", lines };
    },
  };
}
