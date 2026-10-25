// Typed errors: every revert the SDK sees, and every check it makes before sending, comes out as a DryPowderError
// whose `code` is the contract's error name ("OrdersOnly", "DailyBudgetExceeded") or an SDK code in capitals
// ("UNKNOWN_MARKET"). Pre-flight checks that mirror a contract rule use the contract's name, so one `code` covers
// both: `if (e instanceof DryPowderError && e.code === "MarginTooLow")`.

/** What each contract error means for the caller, and what to do about it. */
export const ERROR_HINTS: Readonly<Record<string, string>> = {
  // PerpEngine / PerpEngineExt
  InvalidParam: "a parameter is out of range (an amount of 0 or at least the margin, an expiry in the past, a self-referral)",
  MarketNotFound: "no such market",
  MarketDisabled: "the market is not taking new positions; closing still works",
  MarketExpired: "the dated market has expired: positions can only be closed",
  MarginTooLow: "margin is below the engine's minimum (5 USDC by default)",
  LeverageOutOfRange: "leverage is outside 1x to the market's limit (margin removal stops at 100x)",
  HighLeverageNeedsOrder: "above 100x a position opens and closes only through keeper orders",
  OrdersOnly: "Turbo (Upside) markets trade through keeper orders only, which fill at the next price: use open() and close()",
  PositionExists: "you hold the other side of this market: close it first (one position per market)",
  PositionNotFound: "no position in this market",
  PositionLiquidatable: "the position is past its liquidation threshold: only a liquidation can close it",
  PositionInProfit: "margin cannot be added while the position is in profit (it would lift the profit cap)",
  ProfitCapReached: "the position is already beyond its profit cap: close it before adding to it",
  InsufficientMargin: "what stays could not cover the loss at the exit price plus the initial margin: take out less",
  MarketOiCapExceeded: "the market's open-interest cap for this side is reached",
  VaultOiCapExceeded: "the house vault's exposure cap is reached: try a smaller size",
  SlippageExceeded: "the price moved past the acceptable price",
  InvalidTrigger: "a take-profit must sit on the profit side and a stop-loss on the loss side of the price (and of the order's own trigger)",
  TriggerNotMet: "the order's trigger is not met at this price",
  OrderNotFound: "no such order (filled, cancelled or expired and removed)",
  NotOrderOwner: "the order belongs to another trader",
  NotTriggerOrderType: "open orders are placed with createLimitOrder",
  OrderHasExpired: "the order is past its expiry and can no longer fill: cancel it to get its escrow back",
  NothingToCancel: "none of these orders has expired yet",
  PriceBeforeOrder: "the price is older than the order",
  PriceNotAfterOpen: "this needs a price published after the position's last open, increase or top-up: try again in a second or two",
  NothingToClaim: "nothing to claim",
  ReferrerAlreadySet: "a referrer is already set: it can be set once",
  OraclePriceUnavailable: "the market has no price right now (its venue may be closed)",
  OraclePriceStale: "the on-chain price is too old: wait for the next one, or use a keeper order",
  OraclePriceInvalid: "the oracle price is invalid",
  OracleConfidenceTooWide: "the oracle's confidence band is too wide right now",
  EnforcedPause: "the engine is paused: closing, stops, margin top-ups and cancels still work",
  // AgentAccount
  NotOwner: "only the account's owner can do that",
  NotAuthorized: "this key is not an active agent of the account (never approved, revoked or expired)",
  InvalidPolicy: "invalid agent policy (expiry in the past, a zero cap, or the owner as agent)",
  LeverageCapExceeded: "beyond the agent's leverage cap",
  MarginCapExceeded: "beyond the agent's margin cap per call",
  DailyBudgetExceeded: "the agent's daily margin budget is used up for today (UTC); it resets at midnight UTC",
  MarketNotAllowed: "the account does not let agents trade this market",
  GasTopUpFailed: "the agent could not receive the gas sent with its approval",
  AccountExists: "this owner already has an agent account",
  // Strategies
  NotAllowed: "only the account's owner or one of its active agents can manage its strategies",
  AgentPolicyExceeded: "the strategy's margin or leverage is above your own agent caps",
  InvalidStrategy: "the strategy's configuration is invalid",
  NotApproved: "the account has not approved the Strategies contract with caps that cover one order: approveStrategies() first (owner)",
  MarketTaken: "the account already runs a strategy in this market: stop it first",
  NoStrategy: "no strategy with that id in a state that allows this",
  InsufficientGas: "the transaction needs more gas",
  // AgentRegistry
  InvalidAgent: "listing fields: name 1-48 bytes, description up to 280, kind 1-32, uri up to 256",
  AlreadyRegistered: "the account is already listed: use updateAgentListing()",
  NotRegistered: "the account is not listed",
  // PrizeDistributor
  ResultsNotPublished: "the season's results are not published yet",
  AlreadyClaimed: "this prize was already claimed",
  InvalidProof: "the proof does not match the season's results",
  ClaimWindowClosed: "the season's claim window has closed",
  // Collateral
  ERC20InsufficientBalance: "not enough collateral",
  ERC20InsufficientAllowance: "the engine may not pull that much collateral: approve it first",
  MintTooLarge: "the test faucet mints at most 1,000,000 per call",
};

/** An error from the SDK or a contract, with the contract's error name (or an SDK code) as `code`. */
export class DryPowderError extends Error {
  readonly code: string;
  /** ERROR_HINTS for a contract error, when there is one. */
  readonly hint: string | undefined;

  constructor(code: string, message?: string, options?: { cause?: unknown }) {
    const hint = ERROR_HINTS[code];
    super(message ?? (hint ? `${code}: ${hint}` : code), options);
    this.name = "DryPowderError";
    this.code = code;
    this.hint = hint;
  }
}

/** The contract error name inside a viem error (or a DryPowderError's code), else null. */
export function errorNameOf(e: unknown): string | null {
  let x = e as { cause?: unknown; data?: { errorName?: string }; code?: unknown } | undefined;
  for (let i = 0; x && i < 12; i++) {
    if (x instanceof DryPowderError) return x.code;
    if (typeof x.data?.errorName === "string") return x.data.errorName;
    x = x.cause as typeof x;
  }
  const m = /reverted with the following reason:\s*\n?\s*([A-Za-z]+)|Error: ([A-Za-z]+)\(/.exec(String((e as Error | undefined)?.message ?? ""));
  return m ? (m[1] ?? m[2] ?? null) : null;
}

/** `e` as a DryPowderError when it carries a contract error; other errors are returned unchanged. */
export function toDryPowderError(e: unknown): Error {
  if (e instanceof DryPowderError) return e;
  const name = errorNameOf(e);
  if (!name) return e instanceof Error ? e : new Error(String(e));
  const short = (e as { shortMessage?: string }).shortMessage;
  const hint = ERROR_HINTS[name];
  return new DryPowderError(name, hint ? `${name}: ${hint}` : `${name}${short ? `: ${short}` : ""}`, { cause: e });
}
