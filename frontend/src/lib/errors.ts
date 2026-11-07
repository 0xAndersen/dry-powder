import { BaseError, ContractFunctionRevertedError, decodeErrorResult, type Abi, type Hex } from "viem";
import { engineLensAbi, houseVaultAbi, perpEngineAbi, publisherOracleAbi, rewardTokenAbi, testUSDCAbi } from "./abi";
import { erc20Abi, pythErrorsAbi } from "./abis-extra";

/** Thrown by our own pre-flight checks; the message is already fit for display. */
export class UserFacingError extends Error {}

const MESSAGES: Record<string, string> = {
  // PerpEngine
  MarketNotFound: "This market is not listed on the engine.",
  MarketDisabled: "This market is not accepting new positions.",
  MarketExpired: "This dated market has expired and no longer accepts new positions.",
  MarketNotExpired: "This market has not reached its expiry yet.",
  MarketAlreadySettled: "This market has already been settled.",
  PriceBeforeExpiry: "The on-chain price was published before expiry. Settlement needs a price from after expiry; a keeper will post one shortly.",
  MarginTooLow: "Margin is below the minimum.",
  LeverageOutOfRange: "Leverage is outside the range allowed for this market.",
  PositionExists: "You already have a position in this market. Close it before opening another.",
  PositionNotFound: "You have no open position in this market.",
  PositionLiquidatable: "This position is past its liquidation threshold and can no longer be closed.",
  MarketOiCapExceeded: "This side of the market is full (open interest cap reached). Try a smaller size.",
  VaultOiCapExceeded: "The house vault cannot back more open interest right now. Try a smaller size.",
  SlippageExceeded: "Price moved beyond your slippage limit. Try again or raise the limit.",
  InvalidTrigger: "Trigger price is on the wrong side of the entry price.",
  TriggerNotMet: "The order's trigger price has not been reached.",
  OrderNotFound: "This order no longer exists (it may have been filled or cancelled).",
  NotOrderOwner: "This order belongs to another account.",
  NotTriggerOrderType: "Only take-profit, stop-loss and close orders can be attached to a position.",
  PriceBeforeOrder: "The on-chain price is older than the order. It executes on the next price.",
  PriceNotAfterOpen: "This position was opened a moment ago. Wait a second for the next price and try again.",
  NothingToLiquidate: "No position qualifies for liquidation.",
  InsufficientOracleFee: "The oracle fee sent with the transaction was too low. Try again.",
  RefundFailed: "The oracle fee refund could not be delivered to your account.",
  OraclePriceUnavailable: "The oracle has no price for this market yet.",
  OraclePriceStale: "The on-chain price is too old for a direct transaction. Use a keeper-filled order, or try again when prices are flowing.",
  OraclePriceInvalid: "The oracle reported an unusable price.",
  OracleConfidenceTooWide: "The oracle's price is too uncertain right now. Try again shortly.",
  InvalidParam: "Invalid parameter.",
  MarketExists: "This market is already listed.",
  EnforcedPause: "Trading is paused. Existing positions can still be closed.",
  ExpectedPause: "The engine is not paused.",
  ReentrancyGuardReentrantCall: "The call was rejected (re-entrancy guard).",
  OwnableUnauthorizedAccount: "Only the protocol owner can do this.",
  OwnableInvalidOwner: "Invalid owner.",
  SafeCastOverflowedIntToUint: "Amount out of range.",
  SafeCastOverflowedUintToInt: "Amount out of range.",
  SafeERC20FailedOperation: "The USDC transfer failed. Check your balance and allowance.",
  ZeroAddress: "Invalid address.",
  // HouseVault
  ReceiverMustBeCaller: "Deposits can only be made to your own account.",
  SharesLocked: "Your vault shares are still locked after your latest deposit.",
  OnlyEngine: "Only the trading engine can do this.",
  OnlyRewardToken: "Only the HOUSE token can do this.",
  ERC4626ExceededMaxDeposit: "Deposit exceeds the vault's limit.",
  ERC4626ExceededMaxMint: "Deposit exceeds the vault's limit.",
  ERC4626ExceededMaxWithdraw: "Amount exceeds what you can withdraw right now (deposit lock or liquidity backing open trades).",
  ERC4626ExceededMaxRedeem: "Amount exceeds what you can withdraw right now (deposit lock or liquidity backing open trades).",
  ERC20InsufficientBalance: "Insufficient token balance.",
  ERC20InsufficientAllowance: "Token allowance is too low. Approve and try again.",
  ERC20InvalidApprover: "Invalid approver.",
  ERC20InvalidReceiver: "Invalid receiver.",
  ERC20InvalidSender: "Invalid sender.",
  ERC20InvalidSpender: "Invalid spender.",
  // RewardToken
  ZeroAmount: "Enter an amount greater than zero.",
  InsufficientStake: "Amount exceeds your staked HOUSE.",
  NothingToClaim: "There is nothing to claim yet.",
  EpochNotOver: "The current epoch has not ended yet.",
  MintTooLarge: "That is more than the test token lets one call mint.",
  NotPublisher: "The price update was not signed by an authorised publisher.",
  PublishTimeInFuture: "The price update is dated in the future.",
  OnlyVault: "Only the house vault can do this.",
  // Pyth
  InsufficientFee: "The oracle fee sent with the transaction was too low. Try again.",
  InvalidUpdateData: "The oracle rejected the price update. Try again.",
  InvalidUpdateDataSource: "The oracle rejected the price update's source.",
  InvalidWormholeVaa: "The oracle rejected the price update's signature.",
  InvalidGovernanceMessage: "The oracle rejected the message.",
  NoFreshUpdate: "The oracle already has a newer price.",
  PriceFeedNotFound: "The oracle does not know this price feed.",
  StalePrice: "The oracle price is stale.",
};

const errorItems = [
  ...perpEngineAbi,
  ...engineLensAbi,
  ...houseVaultAbi,
  ...rewardTokenAbi,
  ...publisherOracleAbi,
  ...testUSDCAbi,
  ...erc20Abi,
  ...pythErrorsAbi,
].filter(
  (item) => item.type === "error",
);
/** Every custom error the protocol (or a contract it calls) can bubble up, for decoding nested reverts. */
export const allErrorsAbi: Abi = errorItems;

function messageForName(name: string): string {
  return MESSAGES[name] ?? `The contract rejected the transaction (${name.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase()}).`;
}

function decodeRaw(data: Hex | undefined): string | null {
  if (!data || data === "0x") return null;
  try {
    const decoded = decodeErrorResult({ abi: allErrorsAbi, data });
    return decoded.errorName;
  } catch {
    return null;
  }
}

function hasCode(error: unknown, code: number): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current && typeof current === "object"; depth += 1) {
    if ("code" in current && (current as { code?: unknown }).code === code) return true;
    current = (current as { cause?: unknown }).cause;
  }
  return false;
}

/** Turns anything thrown by viem/wagmi/a wallet into one short sentence. Never returns a raw selector. */
export function humanizeError(error: unknown): string {
  if (error instanceof UserFacingError) return error.message;

  if (hasCode(error, 4001)) return "You rejected the request in your wallet.";

  if (error instanceof BaseError) {
    const reverted = error.walk((e) => e instanceof ContractFunctionRevertedError);
    if (reverted instanceof ContractFunctionRevertedError) {
      const name = reverted.data?.errorName;
      if (name && name !== "Error" && name !== "Panic") return messageForName(name);
      const fromRaw = decodeRaw(reverted.raw);
      if (fromRaw) return messageForName(fromRaw);
      if (name === "Error" && reverted.reason) return `The contract rejected the transaction: ${reverted.reason}.`;
      if (name === "Panic") return "The contract hit an arithmetic error. Check the amounts and try again.";
      return "The contract rejected the transaction, and gave no reason this app recognises.";
    }

    const text = `${error.name} ${error.shortMessage ?? ""} ${error.details ?? ""}`.toLowerCase();
    if (text.includes("user rejected") || text.includes("user denied")) return "You rejected the request in your wallet.";
    if (text.includes("insufficient funds")) return "Not enough native USDC to cover network fees.";
    if (text.includes("chainmismatch") || text.includes("does not match the target chain")) {
      return "Your wallet is on a different network. Switch network and try again.";
    }
    if (text.includes("connectornotconnected") || text.includes("connector not connected")) return "Connect your wallet first.";
    if (text.includes("timeout") || text.includes("timed out")) return "The network took too long to respond. Check the explorer before retrying.";
    if (text.includes("http request failed") || text.includes("failed to fetch")) return "Could not reach the RPC. Check your connection and try again.";

    const short = error.shortMessage ?? "";
    if (short && !/0x[0-9a-f]{8}/i.test(short)) return short;
    return "The transaction could not be sent.";
  }

  if (error instanceof Error) {
    const lower = error.message.toLowerCase();
    if (error.name === "AbortError") return "The request timed out. Try again.";
    if (lower.includes("failed to fetch") || lower.includes("networkerror")) {
      return "A network request failed. Check your connection and try again.";
    }
    if (error.message && !/0x[0-9a-f]{8}/i.test(error.message) && error.message.length < 200) return error.message;
  }
  return "Something went wrong. Try again.";
}
