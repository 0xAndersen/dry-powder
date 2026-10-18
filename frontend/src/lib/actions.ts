import type { Config } from "wagmi";
import { readContract, simulateContract, writeContract } from "wagmi/actions";
import { maxUint256, parseEventLogs, type Address, type Hex, type TransactionReceipt } from "viem";
import { perpEngineAbi, testUSDCAbi } from "./abi";
import { erc20Abi, pythAbi } from "./abis-extra";
import type { RuntimeConfig } from "./config";
import { UserFacingError } from "./errors";
import { feedIdsOf, type Instrument } from "./instruments";
import { needsKeeperOrders, withSlippageDown, withSlippageUp } from "./math";
import type { Quote } from "./oracle";
import { fetchLatestUpdate, type HermesStore } from "./pyth";
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
};

export const ORDER_TYPE = { LimitOpen: 0, TakeProfit: 1, StopLoss: 2, Close: 3 } as const;

/** Makes sure `spender` may pull `amount` of the collateral token, approving when the allowance is short. */
export async function ensureAllowance(ctx: ActionContext, spender: Address, amount: bigint): Promise<void> {
  if (amount === 0n) return;
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
  /** "market" uses the venue's market path; "limit" rests at `limitPrice`. */
  type: "market" | "limit";
  limitPrice: bigint;
  /** Price reference the slippage bound is measured from (market orders). */
  reference: Quote | null;
  slippageBps: number;
  takeProfit: bigint;
  stopLoss: bigint;
  /** Collateral the engine will pull: margin + fee budget + execution fees. */
  required: bigint;
};

export type OpenResult = { receipt: TransactionReceipt; orderId: bigint | null; trigger: bigint | null };

/** The trigger a keeper-filled market order rests at: the reference price pushed out by the slippage tolerance. */
export function marketableTrigger(reference: Quote, isLong: boolean, slippageBps: number): bigint {
  return isLong ? withSlippageUp(reference.ask, BigInt(slippageBps)) : withSlippageDown(reference.bid, BigInt(slippageBps));
}

/**
 * Opens a position. Publisher mode never sends a price update: a market order is a marketable limit order a
 * keeper fills against the next price. Pyth mode opens directly with a fresh Hermes update.
 */
export async function submitOpen(ctx: ActionContext, req: OpenRequest, label: string): Promise<OpenResult> {
  const { wagmi, cfg, api, account } = ctx;
  await ensureAllowance(ctx, cfg.perpEngine, req.required);
  const { instrument, isLong, margin, size, takeProfit, stopLoss } = req;

  // Above 100x the engine refuses direct opens (they would read a stored price); always use a keeper order.
  if (req.type === "limit" || cfg.oracleMode === "publisher" || needsKeeperOrders(size, margin)) {
    let triggerPrice = req.limitPrice;
    if (req.type === "market") {
      if (!req.reference) throw new UserFacingError("No price is available to anchor the order to yet.");
      triggerPrice = marketableTrigger(req.reference, isLong, req.slippageBps);
    }
    if (triggerPrice === 0n) throw new UserFacingError("Enter a price greater than zero.");
    const receipt = await api.send(label, async () => {
      const { request } = await simulateContract(wagmi, {
        abi: perpEngineAbi,
        address: cfg.perpEngine,
        functionName: "createLimitOrder",
        args: [{ priceId: instrument.id, isLong, margin, size, triggerPrice, takeProfit, stopLoss }],
        account,
        chainId: cfg.chainId,
      });
      return writeContract(wagmi, request);
    });
    return { receipt, orderId: orderIdFrom(receipt, "OrderCreated"), trigger: triggerPrice };
  }

  if (!req.reference) throw new UserFacingError("No price available yet.");
  const acceptablePrice = marketableTrigger(req.reference, isLong, req.slippageBps);
  // The engine accepts prices at most `maxPriceAge` seconds old, so the update is fetched last.
  api.preparing(`Fetching the latest ${instrument.symbol} price`);
  const oracle = await freshOracleUpdate(ctx, instrument);
  const receipt = await api.send(label, async () => {
    const { request } = await simulateContract(wagmi, {
      abi: perpEngineAbi,
      address: cfg.perpEngine,
      functionName: "openPosition",
      args: [{ priceId: instrument.id, isLong, margin, size, acceptablePrice, takeProfit, stopLoss }, oracle.updateData],
      value: oracle.fee,
      account,
      chainId: cfg.chainId,
    });
    return writeContract(wagmi, request);
  });
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
};

export type CloseResult = { receipt: TransactionReceipt; orderId: bigint | null; direct: boolean };

/**
 * Closes the caller's position. A settled dated market closes directly at the settlement price with no price
 * update. Otherwise publisher mode places (or moves) a keeper-executed Close order and Pyth mode closes directly.
 */
export async function submitClose(ctx: ActionContext, req: CloseRequest, label: string): Promise<CloseResult> {
  const { wagmi, cfg, api, account } = ctx;
  const { instrument, isLong } = req;
  const engine = { abi: perpEngineAbi, address: cfg.perpEngine, account, chainId: cfg.chainId } as const;

  if (instrument.settlementPrice !== 0n) {
    const receipt = await api.send(label, async () => {
      const { request } = await simulateContract(wagmi, { ...engine, functionName: "closePosition", args: [instrument.id, 0n, []] });
      return writeContract(wagmi, request);
    });
    return { receipt, orderId: null, direct: true };
  }

  // Selling a long fills at the bid, buying back a short at the ask; the bound sits `slippage` beyond it.
  const worst = req.reference
    ? isLong
      ? withSlippageDown(req.reference.bid, BigInt(req.slippageBps))
      : withSlippageUp(req.reference.ask, BigInt(req.slippageBps))
    : 0n;

  if (req.highLeverage && req.direct) {
    throw new UserFacingError(
      `Positions above 100x close only through a keeper order, which costs one execution fee. Add a little ${cfg.collateralSymbol} to your wallet and close again.`,
    );
  }

  if (cfg.oracleMode === "publisher" && req.direct) {
    // No update data: this only succeeds while the on-chain price is fresh (the publisher posts about once a second).
    const receipt = await api.send(label, async () => {
      const { request } = await simulateContract(wagmi, { ...engine, functionName: "closePosition", args: [instrument.id, worst, []] });
      return writeContract(wagmi, request);
    });
    return { receipt, orderId: null, direct: true };
  }

  if (cfg.oracleMode === "publisher" || req.highLeverage) {
    await ensureAllowance(ctx, cfg.perpEngine, req.executionFee);
    const receipt = await api.send(label, async () => {
      const { request } = await simulateContract(wagmi, {
        ...engine,
        functionName: "setTriggerOrder",
        args: [instrument.id, ORDER_TYPE.Close, worst],
      });
      return writeContract(wagmi, request);
    });
    return { receipt, orderId: orderIdFrom(receipt, "OrderCreated") ?? orderIdFrom(receipt, "OrderUpdated"), direct: false };
  }

  api.preparing(`Fetching the latest ${instrument.symbol} price`);
  const oracle = await freshOracleUpdate(ctx, instrument);
  const receipt = await api.send(label, async () => {
    const { request } = await simulateContract(wagmi, {
      ...engine,
      functionName: "closePosition",
      args: [instrument.id, worst, oracle.updateData],
      value: oracle.fee,
    });
    return writeContract(wagmi, request);
  });
  return { receipt, orderId: null, direct: true };
}

/** Sets or moves a take-profit / stop-loss on the caller's position. Creating one escrows the execution fee. */
export async function submitTrigger(
  ctx: ActionContext,
  marketId: Hex,
  orderType: 1 | 2,
  triggerPrice: bigint,
  executionFee: bigint,
  label: string,
): Promise<TransactionReceipt> {
  const { wagmi, cfg, api, account } = ctx;
  await ensureAllowance(ctx, cfg.perpEngine, executionFee);
  return api.send(label, async () => {
    const { request } = await simulateContract(wagmi, {
      abi: perpEngineAbi,
      address: cfg.perpEngine,
      functionName: "setTriggerOrder",
      args: [marketId, orderType, triggerPrice],
      account,
      chainId: cfg.chainId,
    });
    return writeContract(wagmi, request);
  });
}

export async function submitCancel(ctx: ActionContext, orderId: bigint, label: string): Promise<TransactionReceipt> {
  const { wagmi, cfg, api, account } = ctx;
  return api.send(label, async () => {
    const { request } = await simulateContract(wagmi, {
      abi: perpEngineAbi,
      address: cfg.perpEngine,
      functionName: "cancelOrder",
      args: [orderId],
      account,
      chainId: cfg.chainId,
    });
    return writeContract(wagmi, request);
  });
}

/** Fixes the settlement price of an expired dated market from the price already on-chain. Anyone may call. */
export async function submitSettleMarket(ctx: ActionContext, marketId: Hex, label: string): Promise<TransactionReceipt> {
  const { wagmi, cfg, api, account } = ctx;
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
  const { wagmi, cfg, api, account } = ctx;
  return api.send(label, async () => {
    const { request } = await simulateContract(wagmi, {
      abi: perpEngineAbi,
      address: cfg.perpEngine,
      functionName: "claim",
      account,
      chainId: cfg.chainId,
    });
    return writeContract(wagmi, request);
  });
}

export const TEST_MINT_AMOUNT = 10_000_000_000n;

/** Mints test collateral to the caller (`TestUSDC.mint`). Only offered when the deployment says the token is a test token. */
export async function submitTestMint(ctx: ActionContext, label: string): Promise<TransactionReceipt> {
  const { wagmi, cfg, api, account } = ctx;
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
