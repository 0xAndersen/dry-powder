import type { Config } from "wagmi";
import { readContract, simulateContract, writeContract } from "wagmi/actions";
import type { Address, Hex } from "viem";
import type { RuntimeConfig } from "./config";
import { erc20Abi, pythAbi } from "./abis-extra";
import { UserFacingError } from "./errors";
import type { MarketInfo } from "./markets";
import { fetchLatestUpdate, type PriceStore, type PriceTick } from "./pyth";
import type { TxApi } from "@/hooks/use-tx";

/**
 * Makes sure `spender` may pull `amount` of `token` from `owner`, sending an approval for exactly
 * that amount when the current allowance is short.
 */
export async function ensureAllowance(
  wagmiConfig: Config,
  cfg: RuntimeConfig,
  api: TxApi,
  args: { token: Address; owner: Address; spender: Address; amount: bigint; symbol: string },
): Promise<void> {
  if (args.amount === 0n) return;
  api.preparing(`Checking ${args.symbol} allowance`);
  const allowance = await readContract(wagmiConfig, {
    abi: erc20Abi,
    address: args.token,
    functionName: "allowance",
    args: [args.owner, args.spender],
    chainId: cfg.chainId,
  });
  if (allowance >= args.amount) return;
  await api.send(`Approve ${args.symbol}`, async () => {
    const { request } = await simulateContract(wagmiConfig, {
      abi: erc20Abi,
      address: args.token,
      functionName: "approve",
      args: [args.spender, args.amount],
      account: args.owner,
      chainId: cfg.chainId,
    });
    return writeContract(wagmiConfig, request);
  });
}

export type OracleUpdate = {
  /** `bytes[] priceUpdate` for the engine call. */
  updateData: Hex[];
  /** Native value to send: `pyth.getUpdateFee(updateData)`. */
  fee: bigint;
  tick: PriceTick;
};

/**
 * Fetches a signed price for `market` right now and the fee Pyth charges to post it. Refuses when the
 * price is already older than the engine tolerates, which is what a closed FX market looks like.
 */
export async function freshOracleUpdate(
  wagmiConfig: Config,
  cfg: RuntimeConfig,
  prices: PriceStore,
  market: MarketInfo,
  maxPriceAge: number,
): Promise<OracleUpdate> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 6_000);
  let update;
  try {
    update = await fetchLatestUpdate(cfg.hermesUrl, [market.id], controller.signal);
  } catch {
    throw new UserFacingError("Could not fetch a price update from Pyth. Check your connection and try again.");
  } finally {
    clearTimeout(timeout);
  }
  const tick = update.ticks.find((t) => t.id === market.id);
  if (!tick) throw new UserFacingError(`Pyth returned no usable ${market.symbol} price.`);
  prices.ingest(update.ticks);
  if (prices.ageOf(tick) > maxPriceAge + 2) {
    throw new UserFacingError(
      `The latest ${market.symbol} price is stale, so the engine would reject this transaction. The market is probably closed.`,
    );
  }
  const fee = await readContract(wagmiConfig, {
    abi: pythAbi,
    address: cfg.pyth,
    functionName: "getUpdateFee",
    args: [update.updateData],
    chainId: cfg.chainId,
  });
  return { updateData: update.updateData, fee, tick };
}
