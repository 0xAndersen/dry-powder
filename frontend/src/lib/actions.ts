import type { Config } from "wagmi";
import { getPublicClient, readContract, simulateContract, writeContract } from "wagmi/actions";
import { encodeFunctionData, maxUint256, parseEventLogs, type Address, type Hex, type TransactionReceipt } from "viem";
import { agentAccountAbi, perpEngineAbi, testUSDCAbi } from "./abi";
import { erc20Abi, pythAbi } from "./abis-extra";
import type { RuntimeConfig } from "./config";
import { UserFacingError } from "./errors";
import { feedIdsOf, type Instrument } from "./instruments";
import { needsKeeperOrders, withSlippageDown, withSlippageUp } from "./math";
import type { Quote } from "./oracle";
import { fetchLatestUpdate, type HermesStore } from "./pyth";
import { sessionWrite, withGasHeadroom, type SessionClient } from "./session";
import type { TxApi } from "@/hooks/use-tx";

/** Everything an on-chain action needs. Built once per flow by the calling component. */
export type ActionContext = {
  wagmi: Config;
  cfg: RuntimeConfig;
  api: TxApi;
  account: Address;
  /** Pyth mode only. */
  hermes: HermesStore | null;
  /** Engine address read from `engine.pyth()`; needed for the update fee in Pyth mode. */
  pyth: Address | null;
  approveUnlimited: boolean;
  maxPriceAge: number;
  /**
   * Instant trading: orders go to the trader's AgentAccount, signed by the browser's session key (no wallet
   * pop-up). `account` above is then the AgentAccount. Null for wallet trading.
   */
  session: { client: SessionClient; account: Address } | null;
};

/** AgentAccount forwarders plus the engine's errors, so reverts from the engine decode with their names. */
const ACCOUNT_CALL_ABI = [...agentAccountAbi, ...perpEngineAbi.filter((item) => item.type === "error")] as const;

type EngineFn =
  | "openPosition"
  | "createLimitOrder"
  | "createLimitOrderUntil"
  | "closePosition"
  | "setTriggerOrder"
  | "setOrderExpiry"
  | "cancelOrder"
  | "claim"
  | "addMargin"
  | "removeMargin";

/**
 * Sends a trading call: straight to the engine from the wallet, or through the AgentAccount from the session key.
 * Both paths simulate first, so a revert surfaces with the engine's error before anything is signed.
 */
async function sendEngine(ctx: ActionContext, label: string, functionName: EngineFn, args: readonly unknown[], value?: bigint): Promise<TransactionReceipt> {
  const { wagmi, cfg, api, account, session } = ctx;
  if (session) {
    return api.send(label, () => sessionWrite(session.client, { address: session.account, abi: ACCOUNT_CALL_ABI, functionName, args, value }));
  }
  return api.send(label, async () => {
    const params = { abi: perpEngineAbi, address: cfg.perpEngine, functionName, args, value, account, chainId: cfg.chainId } as never;
    const { request } = await simulateContract(wagmi, params);
    return writeContract(wagmi, { ...(request as object), gas: await walletGas(wagmi, cfg.chainId, params) } as never);
  });
}

/**
 * Gas limit with headroom for a wallet transaction (see `withGasHeadroom`); wallets that re-estimate may still
 * override it. Undefined when the estimate fails, leaving the wallet to estimate.
 */
async function walletGas(wagmi: Config, chainId: number, params: never): Promise<bigint | undefined> {
  try {
    const client = getPublicClient(wagmi, { chainId });
    return client ? withGasHeadroom(await client.estimateContractGas(params)) : undefined;
  } catch {
    return undefined;
  }
}

export const ORDER_TYPE = { LimitOpen: 0, TakeProfit: 1, StopLoss: 2, Close: 3, StopOpen: 4 } as const;

/** Makes sure `spender` may pull `amount` of the collateral token, approving when the allowance is short. */
export async function ensureAllowance(ctx: ActionContext, spender: Address, amount: bigint): Promise<void> {
  // An AgentAccount approves the engine for good when it is created.
  if (amount === 0n || ctx.session) return;
  const { wagmi, cfg, api, account } = ctx;
  api.preparing(`Checking ${cfg.collateralSymbol} allowance`);
  const allowance = await readContract(wagmi, {
    abi: erc20Abi,
    address: cfg.usdc,
    functionName: "allowance",
    args: [account, spender],
    chainId: cfg.chainId,
  });
  if (allowance >= amount) return;
  await api.send(`Approve ${cfg.collateralSymbol}`, async () => {
    const { request } = await simulateContract(wagmi, {
      abi: erc20Abi,
      address: cfg.usdc,
      functionName: "approve",
      args: [spender, ctx.approveUnlimited ? maxUint256 : amount],
      account,
      chainId: cfg.chainId,
    });
    return writeContract(wagmi, request);
  });
}

function orderIdFrom(receipt: TransactionReceipt, eventName: "OrderCreated" | "OrderUpdated"): bigint | null {
  const logs = parseEventLogs({ abi: perpEngineAbi, logs: receipt.logs, eventName });
  return logs[0]?.args.orderId ?? null;
}

type OracleUpdate = { updateData: Hex[]; fee: bigint };

/**
 * Pyth mode: a signed price for `instrument` fetched right now, and the fee Pyth charges to post it.
 * Refuses when the price is already older than the engine tolerates (a closed FX market looks like that).
 */
async function freshOracleUpdate(ctx: ActionContext, instrument: Instrument): Promise<OracleUpdate> {
  if (!ctx.hermes || !ctx.pyth) throw new UserFacingError("Pyth prices are not available in this deployment.");
  const ids = feedIdsOf(instrument);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);
  let update;
  try {
    update = await fetchLatestUpdate(ctx.cfg.hermesUrl, ids, ctx.cfg.pythApiKey, controller.signal);
  } catch (error) {
    const detail = error instanceof Error && /API key/.test(error.message) ? " Hermes needs an API key (PYTH_API_KEY)." : "";
    throw new UserFacingError(`Could not fetch a price update from Pyth.${detail}`);
  } finally {
    clearTimeout(timeout);
  }
  ctx.hermes.ingest(update.quotes);
  for (const id of ids) {
    const quote = update.quotes.get(id);
    if (!quote) throw new UserFacingError(`Pyth returned no usable ${instrument.symbol} price.`);
    if (ctx.hermes.ageOf(quote.publishTime) > ctx.maxPriceAge + 2) {
      throw new UserFacingError(
        `The latest ${instrument.symbol} price is stale, so the engine would reject this transaction. The market is probably closed.`,
      );
    }
  }
  const fee = await readContract(ctx.wagmi, {
    abi: pythAbi,
    address: ctx.pyth,
    functionName: "getUpdateFee",
    args: [update.updateData],
    chainId: ctx.cfg.chainId,
  });
  return { updateData: update.updateData, fee };
}

export type OpenRequest = {
  instrument: Instrument;
  isLong: boolean;
  margin: bigint;
  size: bigint;
  /** "market" uses the venue's market path; "limit" rests at `limitPrice`; "stop" is a breakout entry at it. */
  type: "market" | "limit" | "stop";
  /** The limit price, or the stop-entry trigger. */
  limitPrice: bigint;
  /** Price reference the slippage bound is measured from (market orders). */
  reference: Quote | null;
  slippageBps: number;
  takeProfit: bigint;
  stopLoss: bigint;
  /** Collateral the engine will pull: margin + fee budget + execution fees. */
  required: bigint;
  /** Unix seconds after which a resting order can no longer execute (v3.2); omitted: good until cancelled. */
  expiresAt?: number;
};

export type OpenResult = { receipt: TransactionReceipt; orderId: bigint | null; trigger: bigint | null };

/**
 * The trigger a keeper-filled market order rests at: the price it fills at (the ask or bid, or the mid in a Turbo
 * market) pushed out by the slippage tolerance.
 */
export function marketableTrigger(reference: Quote, isLong: boolean, slippageBps: number, atMid = false): bigint {
  const bound = BigInt(slippageBps);
  if (atMid) return isLong ? withSlippageUp(reference.mid, bound) : withSlippageDown(reference.mid, bound);
  return isLong ? withSlippageUp(reference.ask, bound) : withSlippageDown(reference.bid, bound);
}

/**
 * Opens a position. Publisher mode never sends a price update: a market order is a marketable limit order a
 * keeper fills against the next price. Pyth mode opens directly with a fresh Hermes update.
 */
export async function submitOpen(ctx: ActionContext, req: OpenRequest, label: string): Promise<OpenResult> {
  const { cfg, api } = ctx;
  await ensureAllowance(ctx, cfg.perpEngine, req.required);
  const { instrument, isLong, margin, size, takeProfit, stopLoss } = req;

  // Above 100x the engine refuses direct opens (they would read a stored price), and Upside (Turbo) markets take
  // keeper orders only: always use a keeper order there.
  if (req.type !== "market" || cfg.oracleMode === "publisher" || needsKeeperOrders(size, margin) || instrument.upside) {
    let triggerPrice = req.limitPrice;
    if (req.type === "market") {
      if (!req.reference) throw new UserFacingError("No price is available to anchor the order to yet.");
      triggerPrice = marketableTrigger(req.reference, isLong, req.slippageBps, instrument.upside);
    }
    if (triggerPrice === 0n) throw new UserFacingError("Enter a price greater than zero.");
    const order = { priceId: instrument.id, isLong, margin, size, triggerPrice, takeProfit, stopLoss, stopEntry: req.type === "stop" };
    // Good-til-time (v3.2): the order cannot execute after `expiresAt` and a keeper sweeps it, refunding the escrow.
    const receipt = req.expiresAt
      ? await sendEngine(ctx, label, "createLimitOrderUntil", [order, BigInt(req.expiresAt)])
      : await sendEngine(ctx, label, "createLimitOrder", [order]);
    return { receipt, orderId: orderIdFrom(receipt, "OrderCreated"), trigger: triggerPrice };
  }

  if (!req.reference) throw new UserFacingError("No price available yet.");
  const acceptablePrice = marketableTrigger(req.reference, isLong, req.slippageBps);
  // The engine accepts prices at most `maxPriceAge` seconds old, so the update is fetched last.
  api.preparing(`Fetching the latest ${instrument.symbol} price`);
  const oracle = await freshOracleUpdate(ctx, instrument);
  const receipt = await sendEngine(
    ctx,
    label,
    "openPosition",
    [{ priceId: instrument.id, isLong, margin, size, acceptablePrice, takeProfit, stopLoss }, oracle.updateData],
    oracle.fee,
  );
  return { receipt, orderId: null, trigger: null };
}

export type CloseRequest = {
  instrument: Instrument;
  isLong: boolean;
  reference: Quote | null;
  slippageBps: number;
  /** Execution fee the engine pulls when it creates a close order (0 when one already exists). */
  executionFee: bigint;
  /**
   * Publisher mode only: close directly against the price already on-chain instead of placing a keeper order.
   * Used when the wallet cannot pay the execution fee, which would otherwise leave no way out of a position.
   */
  direct?: boolean;
  /** Leverage above 100x: the engine accepts only keeper-executed closes. */
  highLeverage?: boolean;
  /** Notional to close; 0 or omitted closes everything (the engine closes everything when the rest would be too small). */
  size?: bigint;
};

export type CloseResult = { receipt: TransactionReceipt; orderId: bigint | null; direct: boolean };

/**
 * Closes the caller's position. A settled dated market closes directly at the settlement price with no price
 * update. Otherwise publisher mode places (or moves) a keeper-executed Close order and Pyth mode closes directly.
 */
export async function submitClose(ctx: ActionContext, req: CloseRequest, label: string): Promise<CloseResult> {
  const { cfg, api } = ctx;
  const { instrument, isLong } = req;
  const size = req.size ?? 0n;

  if (instrument.settlementPrice !== 0n) {
    const receipt = await sendEngine(ctx, label, "closePosition", [instrument.id, size, 0n, []]);
    return { receipt, orderId: null, direct: true };
  }

  // Selling a long fills at the bid, buying back a short at the ask (both at the mid in a Turbo market); the bound
  // sits `slippage` beyond it.
  const upside = instrument.upside;
  const worst = req.reference
    ? isLong
      ? withSlippageDown(upside ? req.reference.mid : req.reference.bid, BigInt(req.slippageBps))
      : withSlippageUp(upside ? req.reference.mid : req.reference.ask, BigInt(req.slippageBps))
    : 0n;
  const keeperOnly = req.highLeverage || upside;

  if (keeperOnly && req.direct) {
    throw new UserFacingError(
      upside
        ? `Turbo positions close only through a keeper order, which costs one execution fee. Add a little ${cfg.collateralSymbol} to your wallet and close again.`
        : `Positions above 100x close only through a keeper order, which costs one execution fee. Add a little ${cfg.collateralSymbol} to your wallet and close again.`,
    );
  }

  if (cfg.oracleMode === "publisher" && req.direct) {
    // No update data: this only succeeds while the on-chain price is fresh (the publisher posts about once a second).
    const receipt = await sendEngine(ctx, label, "closePosition", [instrument.id, size, worst, []]);
    return { receipt, orderId: null, direct: true };
  }

  if (cfg.oracleMode === "publisher" || keeperOnly) {
    await ensureAllowance(ctx, cfg.perpEngine, req.executionFee);
    const receipt = await sendEngine(ctx, label, "setTriggerOrder", [instrument.id, ORDER_TYPE.Close, worst, size]);
    return { receipt, orderId: orderIdFrom(receipt, "OrderCreated") ?? orderIdFrom(receipt, "OrderUpdated"), direct: false };
  }

  api.preparing(`Fetching the latest ${instrument.symbol} price`);
  const oracle = await freshOracleUpdate(ctx, instrument);
  const receipt = await sendEngine(ctx, label, "closePosition", [instrument.id, size, worst, oracle.updateData], oracle.fee);
  return { receipt, orderId: null, direct: true };
}

/**
 * Sets or moves a take-profit / stop-loss on the caller's position. Creating one escrows the execution fee.
 * `size` is the notional it closes when it fires (0: the whole position).
 */
export async function submitTrigger(
  ctx: ActionContext,
  marketId: Hex,
  orderType: 1 | 2,
  triggerPrice: bigint,
  executionFee: bigint,
  label: string,
  size = 0n,
): Promise<TransactionReceipt> {
  await ensureAllowance(ctx, ctx.cfg.perpEngine, executionFee);
  return sendEngine(ctx, label, "setTriggerOrder", [marketId, orderType, triggerPrice, size]);
}

/** Adds margin to the caller's position (refused by the engine while it is in profit). */
export async function submitAddMargin(ctx: ActionContext, marketId: Hex, amount: bigint, label: string): Promise<TransactionReceipt> {
  await ensureAllowance(ctx, ctx.cfg.perpEngine, amount);
  return sendEngine(ctx, label, "addMargin", [marketId, amount]);
}

/**
 * Takes margin back out of the caller's position (v3.2). The engine checks it against a price newer than the
 * position's last change; in publisher mode that is the one on-chain (the publisher posts on every 5 bp move and at
 * each heartbeat), in Pyth mode a fresh update goes with it.
 */
export async function submitRemoveMargin(ctx: ActionContext, instrument: Instrument, amount: bigint, label: string): Promise<TransactionReceipt> {
  if (ctx.cfg.oracleMode === "pyth") {
    ctx.api.preparing(`Fetching the latest ${instrument.symbol} price`);
    const oracle = await freshOracleUpdate(ctx, instrument);
    return sendEngine(ctx, label, "removeMargin", [instrument.id, amount, oracle.updateData], oracle.fee);
  }
  return sendEngine(ctx, label, "removeMargin", [instrument.id, amount, []]);
}

/** Sets when one of the caller's orders stops being executable (0: never). v3.2. */
export async function submitOrderExpiry(ctx: ActionContext, orderId: bigint, expiresAt: number, label: string): Promise<TransactionReceipt> {
  return sendEngine(ctx, label, "setOrderExpiry", [orderId, BigInt(expiresAt)]);
}

/**
 * Records the trader's referrer (once, v3.2): their fees are discounted and the referrer earns a share. With
 * instant trading the trader is the agent account, whose owner (the wallet) must sign it.
 */
export async function submitSetReferrer(ctx: ActionContext, referrer: Address, label: string): Promise<TransactionReceipt> {
  const { wagmi, cfg, api, account, session } = ctx;
  const params = session
    ? ({ abi: agentAccountAbi, address: session.account, functionName: "setReferrer", args: [referrer], account, chainId: cfg.chainId } as never)
    : ({ abi: perpEngineAbi, address: cfg.perpEngine, functionName: "setReferrer", args: [referrer], account, chainId: cfg.chainId } as never);
  return api.send(label, async () => {
    const { request } = await simulateContract(wagmi, params);
    return writeContract(wagmi, { ...(request as object), gas: await walletGas(wagmi, cfg.chainId, params) } as never);
  });
}

export type BatchCall = { functionName: EngineFn; args: readonly unknown[]; label: string };

/**
 * Several trading calls. With instant trading they go out as one atomic transaction (the AgentAccount's
 * multicall: all or nothing, no pop-up); from a wallet, one transaction each, in order.
 */
export async function submitBatch(ctx: ActionContext, label: string, calls: readonly BatchCall[]): Promise<TransactionReceipt[]> {
  if (calls.length === 0) return [];
  const { api, session } = ctx;
  if (session && calls.length > 1) {
    const data = calls.map((c) => encodeFunctionData({ abi: agentAccountAbi, functionName: c.functionName, args: c.args } as never));
    const receipt = await api.send(label, () => sessionWrite(session.client, { address: session.account, abi: ACCOUNT_CALL_ABI, functionName: "multicall", args: [data] }));
    return [receipt];
  }
  const out: TransactionReceipt[] = [];
  for (const c of calls) out.push(await sendEngine(ctx, c.label, c.functionName, c.args));
  return out;
}

export async function submitCancel(ctx: ActionContext, orderId: bigint, label: string): Promise<TransactionReceipt> {
  return sendEngine(ctx, label, "cancelOrder", [orderId]);
}

/** Fixes the settlement price of an expired dated market from the price already on-chain. Anyone may call. */
export async function submitSettleMarket(ctx: ActionContext, marketId: Hex, label: string): Promise<TransactionReceipt> {
  const { wagmi, cfg, api, account, session } = ctx;
  if (session) {
    // Anyone may settle: the session key pays the gas itself.
    return api.send(label, () => sessionWrite(session.client, { abi: perpEngineAbi, address: cfg.perpEngine, functionName: "settleMarket", args: [marketId, []] }));
  }
  return api.send(label, async () => {
    const { request } = await simulateContract(wagmi, {
      abi: perpEngineAbi,
      address: cfg.perpEngine,
      functionName: "settleMarket",
      args: [marketId, []],
      account,
      chainId: cfg.chainId,
    });
    return writeContract(wagmi, request);
  });
}

export async function submitClaim(ctx: ActionContext, label: string): Promise<TransactionReceipt> {
  return sendEngine(ctx, label, "claim", []);
}

export const TEST_MINT_AMOUNT = 10_000_000_000n;

/** Mints test collateral to the caller (`TestUSDC.mint`). Only offered when the deployment says the token is a test token. */
export async function submitTestMint(ctx: ActionContext, label: string): Promise<TransactionReceipt> {
  const { wagmi, cfg, api, account, session } = ctx;
  if (session) {
    // Test collateral is free to mint for anyone: the session key mints straight into the trading account.
    return api.send(label, () => sessionWrite(session.client, { abi: testUSDCAbi, address: cfg.usdc, functionName: "mint", args: [session.account, TEST_MINT_AMOUNT] }));
  }
  return api.send(label, async () => {
    const { request } = await simulateContract(wagmi, {
      abi: testUSDCAbi,
      address: cfg.usdc,
      functionName: "mint",
      args: [account, TEST_MINT_AMOUNT],
      account,
      chainId: cfg.chainId,
    });
    return writeContract(wagmi, request);
  });
}
