import {
  type Abi,
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type TransactionReceipt,
  type Transport,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  defineChain,
  encodeFunctionData,
  fallback,
  http,
  parseEventLogs,
  zeroAddress,
} from "viem";
import { agentAccountAbi, agentAccountFactoryAbi, agentRegistryAbi, engineLensAbi, perpEngineAbi, prizeDistributorAbi, rewardTokenAbi, strategiesAbi, testUSDCAbi } from "./abi.js";
import { ARC_TESTNET_RPCS, type Deployment, loadDeployment } from "./deployment.js";
import { DryPowderError, toDryPowderError } from "./errors.js";
import { BPS, type FeeModel, type Risk, assessRisk, discounted, feeCap, ladderPrices, marginFor, mergedPosition, needsKeeperOrders, removableMargin } from "./risk.js";
import { type AgentListing, type AgentListingInput, type RawStrategy, type StrategyInfo, type StrategySpec, strategyConfig, strategyInfo, validateListing, validateStrategy } from "./strategies.js";

const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const GWEI = 10n ** 9n;

/** Every custom error of every contract the client calls, so a revert from any of them decodes by name. */
const ERRORS = (() => {
  const seen = new Set<string>();
  const out: Abi[number][] = [];
  for (const abi of [perpEngineAbi, agentAccountAbi, agentAccountFactoryAbi, strategiesAbi, agentRegistryAbi, prizeDistributorAbi, testUSDCAbi] as readonly Abi[]) {
    for (const x of abi) {
      if (x.type !== "error") continue;
      const sig = `${x.name}(${x.inputs.map((i) => i.type).join(",")})`;
      if (!seen.has(sig)) {
        seen.add(sig);
        out.push(x);
      }
    }
  }
  return out;
})();

export type MarketKind = "perpetual" | "inverted" | "cross" | "dated future";

export interface Market {
  id: Hex;
  symbol: string;
  kind: MarketKind;
  /** "upside" for the Turbo markets: no fee unless you win, mid-price keeper fills. */
  feeModel: FeeModel;
  enabled: boolean;
  maxLeverage: number;
  /** 0 for perpetuals; unix seconds otherwise. */
  expiry: number;
  settled: boolean;
  longOi: bigint;
  shortOi: bigint;
  maxOiPerSide: bigint;
  /** Per second, 18 decimals; positive: longs pay. */
  fundingRatePerSecond: bigint;
  /** The oracle's current price, or null when it has none within the engine's max price age. */
  price: { mid: bigint; bid: bigint; ask: bigint; publishTime: number } | null;
  /** The last price on-chain even if older than that (the keeper pushes on moves and on a heartbeat, and
   *  always with a fill, so a keeper order never needs a fresh one). Null if the market was never priced. */
  lastPrice: { mid: bigint; bid: bigint; ask: bigint; publishTime: number } | null;
}

export interface Position {
  marketId: Hex;
  isLong: boolean;
  size: bigint;
  margin: bigint;
  entryPrice: bigint;
  fundingOwed: bigint;
  /** Long: liquidatable at or below (0n = never). Short: at or above. */
  liquidationPrice: bigint;
  takeProfitOrderId: bigint;
  stopLossOrderId: bigint;
  closeOrderId: bigint;
  /** Unix seconds of the last open, increase or margin top-up: a close or margin removal needs a later price. */
  openedAt: number;
}

export interface Order {
  id: bigint;
  marketId: Hex;
  /** 0 limit open, 1 take-profit, 2 stop-loss, 3 close, 4 stop-entry open. */
  orderType: number;
  isLong: boolean;
  size: bigint;
  margin: bigint;
  triggerPrice: bigint;
  executionFee: bigint;
  /** Open orders: the brackets attached on fill (0n: none). */
  takeProfit: bigint;
  stopLoss: bigint;
  /** Open orders: the most the open fee can be, escrowed (0n in Upside markets). */
  feeBudget: bigint;
  /** Unix seconds. */
  createdAt: number;
  /** Unix seconds after which the order cannot fill; 0: good until cancelled. */
  expiresAt: number;
}

export interface TradeIntent {
  /** Symbol ("BTC-USD", "BTC", "BTC-USD-TURBO", "BTC-TURBO") or market id. */
  market: string;
  side: "long" | "short";
  /** The most this position can lose (margin), USDC 6 decimals. */
  margin: bigint;
  /** 1..market max (up to 5000 on the Turbo markets). */
  leverage: number;
  /** Market order: worst acceptable fill, in bps from the current oracle price. Default 50. */
  slippageBps?: number;
  /** Limit order instead of a market order. */
  limitPrice?: bigint;
  /** Stop-entry (breakout) order instead: fills once a long's ask is at or above this price (a short's bid at or
   *  below it). */
  stopEntryPrice?: bigint;
  /** Market orders: the bid/ask to apply slippage to (e.g. from your own feed). Default: the on-chain price. */
  referencePrice?: { bid: bigint; ask: bigint; mid?: bigint };
  takeProfit?: bigint;
  stopLoss?: bigint;
  /** Good-til-time: the order cannot fill after this unix time (v3.2). */
  expiresAt?: number;
  /** Good-til-time, in seconds from now (chain time). Pass this or `expiresAt`. */
  expiresIn?: number;
}

export interface Quote {
  market: Market;
  isLong: boolean;
  size: bigint;
  margin: bigint;
  /** Estimated entry: the mid in an Upside market, else the ask for a long and the bid for a short. */
  entry: bigint;
  /** Worst fill (market order) or the limit price. */
  triggerPrice: bigint;
  /** After any referral discount; 0 in an Upside market. */
  openFee: bigint;
  executionFees: bigint;
  /** What leaves the wallet or account when the order is placed. */
  required: bigint;
  /** Risk of this trade on its own. */
  risk: Risk;
  /** When the trader already holds this side, the position the fill would leave (the order adds to it). */
  afterFill: { size: bigint; margin: bigint; entry: bigint; leverage: number; liquidationPrice: bigint | null } | null;
  feeModel: FeeModel;
  /** Upside markets: the share of a winning close's profit the house keeps, after any referral discount. */
  profitShareBps: number;
  /** The trader has a referrer: every fee (the profit share included) is discounted. */
  referred: boolean;
  /** Unix seconds after which the order cannot fill; 0: good until cancelled. */
  expiresAt: number;
  /** The fees in one line, for people. */
  feeNote: string;
}

export interface TxResult {
  hash: Hex;
  url: string;
}

export interface AgentPolicyInput {
  expiresInSeconds: number;
  maxLeverage: number;
  maxMarginPerOrder: bigint;
  /** Native USDC (18 decimals) sent to the agent key with its approval. */
  gas?: bigint;
  /** The most margin the agent may commit per UTC day (v3.2); omitted: no daily cap. */
  dailyBudget?: bigint;
}

export interface DryPowderOptions {
  /** A deployment object, a path/URL to its JSON, or omitted for the live Arc Testnet deployment. */
  deployment?: Deployment | string;
  /** RPCs tried in order (Arc Testnet's public RPCs are appended automatically). */
  rpcUrls?: string[];
  /** The key that signs: a wallet trading for itself, or an agent key trading for `agentAccount`. */
  account?: Account;
  /** Trade through this AgentAccount (the signer must be an approved agent or the owner). */
  agentAccount?: Address;
}

type TradeFn = "createLimitOrder" | "createLimitOrderUntil" | "closePosition" | "setTriggerOrder" | "cancelOrder" | "addMargin" | "removeMargin" | "setOrderExpiry" | "claim" | "setReferrer" | "multicall";
type Px = { mid: bigint; bid: bigint; ask: bigint; publishTime: number };

/**
 * A client for one Dry Powder deployment. Reads need nothing; trading needs `account`.
 *
 *   const dp = await DryPowder.connect({ account: privateKeyToAccount(key) });
 *   const q = await dp.quote({ market: "BTC", side: "long", margin: usd(10), leverage: 1000 });
 *   console.log(q.risk.maxLoss, q.risk.liquidationMove); // know the worst case first
 *   const { orderId } = await dp.open({ market: "BTC", side: "long", margin: usd(10), leverage: 1000, stopLoss: price(99_950) });
 */
export class DryPowder {
  readonly deployment: Deployment;
  readonly chain: Chain;
  readonly publicClient: PublicClient<Transport, Chain>;
  readonly walletClient: WalletClient<Transport, Chain, Account> | null;
  readonly agentAccount: Address | null;
  private marketCache: Market[] | null = null;

  private constructor(deployment: Deployment, opts: DryPowderOptions) {
    this.deployment = deployment;
    const rpcs = [...new Set([...(opts.rpcUrls ?? []), deployment.rpcUrl, ...(deployment.chainId === 5042002 ? ARC_TESTNET_RPCS : [])].filter(Boolean) as string[])];
    this.chain = defineChain({
      id: deployment.chainId,
      name: deployment.chainId === 5042002 ? "Arc Testnet" : `chain ${deployment.chainId}`,
      nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 },
      rpcUrls: { default: { http: rpcs } },
    });
    const transport = fallback(rpcs.map((u) => retryTransient(http(u, { retryCount: 2, timeout: 20_000 }))), { rank: false });
    this.publicClient = createPublicClient({ chain: this.chain, transport, pollingInterval: 750 }) as PublicClient<Transport, Chain>;
    this.walletClient = opts.account ? createWalletClient({ chain: this.chain, transport, account: opts.account }) : null;
    this.agentAccount = opts.agentAccount ?? null;
  }

  static async connect(opts: DryPowderOptions = {}): Promise<DryPowder> {
    const d = typeof opts.deployment === "object" ? opts.deployment : await loadDeployment(opts.deployment);
    return new DryPowder(d, opts);
  }

  /** The address the engine sees as the trader: the agent account, else the signing wallet. */
  get trader(): Address | null {
    return this.agentAccount ?? this.walletClient?.account.address ?? null;
  }

  explorerTx(hash: Hex): string {
    return `${this.deployment.explorerUrl ?? "https://explorer.testnet.arc.io"}/tx/${hash}`;
  }

  // ── Reads ──

  async markets(): Promise<Market[]> {
    const list = await this.publicClient.readContract({ address: this.deployment.lens, abi: engineLensAbi, functionName: "getMarkets" });
    this.marketCache = list.map((v) => {
      const m = v.market;
      return {
        id: v.id,
        symbol: m.symbol,
        kind: (m.expiry ? "dated future" : m.quoteFeedId !== ZERO32 ? "cross" : m.invert ? "inverted" : "perpetual") as MarketKind,
        feeModel: (Number(m.feeMode) === 1 ? "upside" : "standard") as FeeModel,
        enabled: m.enabled,
        maxLeverage: Number(m.maxLeverage),
        expiry: Number(m.expiry),
        settled: m.settlementPrice !== 0n,
        longOi: m.longOi,
        shortOi: m.shortOi,
        maxOiPerSide: m.maxOiPerSide,
        fundingRatePerSecond: v.fundingRate,
        price: v.hasPrice ? { mid: v.price.mid, bid: v.price.bid, ask: v.price.ask, publishTime: Number(v.price.publishTime) } : null,
        lastPrice: v.price.mid > 0n ? { mid: v.price.mid, bid: v.price.bid, ask: v.price.ask, publishTime: Number(v.price.publishTime) } : null,
      };
    });
    return this.marketCache;
  }

  /**
   * One market by symbol or id, with a fresh price: "BTC-USD", "BTC" (BTC-USD), "BTC-USD-TURBO" or "BTC-TURBO"
   * (BTC-USD-TURBO).
   */
  async market(symbolOrId: string): Promise<Market> {
    const all = await this.markets();
    const want = symbolOrId.toUpperCase();
    const candidates = want.startsWith("0X") ? [want] : [want, `${want}-USD`, want.replace(/-TURBO$/, "-USD-TURBO")];
    const m = all.find((x) => candidates.includes(x.symbol.toUpperCase()) || x.id.toUpperCase() === want);
    if (!m) throw new DryPowderError("UNKNOWN_MARKET", `no market ${symbolOrId}; markets: ${all.map((x) => x.symbol).join(", ")}`);
    return m;
  }

  async positions(trader: Address | null = this.trader): Promise<Position[]> {
    if (!trader) return [];
    const list = await this.publicClient.readContract({ address: this.deployment.lens, abi: engineLensAbi, functionName: "getTraderPositions", args: [trader] });
    return list.map((v) => ({
      marketId: v.position.priceId,
      isLong: v.position.isLong,
      size: v.position.size,
      margin: v.position.margin,
      entryPrice: v.position.entryPrice,
      fundingOwed: v.fundingOwed,
      liquidationPrice: v.liquidationPrice,
      takeProfitOrderId: BigInt(v.position.tpOrderId),
      stopLossOrderId: BigInt(v.position.slOrderId),
      closeOrderId: BigInt(v.position.closeOrderId),
      openedAt: Number(v.position.openedAt),
    }));
  }

  async orders(trader: Address | null = this.trader): Promise<Order[]> {
    if (!trader) return [];
    const [ids, list] = await this.publicClient.readContract({ address: this.deployment.lens, abi: engineLensAbi, functionName: "getTraderOrders", args: [trader] });
    return list.map((o, i) => ({
      id: ids[i]!,
      marketId: o.priceId,
      orderType: Number(o.orderType),
      isLong: o.isLong,
      size: o.size,
      margin: o.margin,
      triggerPrice: o.triggerPrice,
      executionFee: o.executionFee,
      takeProfit: o.takeProfit,
      stopLoss: o.stopLoss,
      feeBudget: o.feeBudget,
      createdAt: Number(o.createdAt),
      expiresAt: Number(o.expiresAt),
    }));
  }

  /** Collateral the trader holds (wallet, or the agent account's balance). */
  async balance(trader: Address | null = this.trader): Promise<bigint> {
    if (!trader) return 0n;
    return this.publicClient.readContract({ address: this.deployment.usdc, abi: testUSDCAbi, functionName: "balanceOf", args: [trader] });
  }

  /** The chain's time (the latest block's timestamp), which expiries and daily budgets are measured in. */
  async now(): Promise<number> {
    return Number((await this.publicClient.getBlock()).timestamp);
  }

  // ── Risk before anything else ──

  /** Everything about a trade before placing it, worst case first. Reads only. */
  async quote(t: TradeIntent): Promise<Quote> {
    const m = await this.market(t.market);
    if (!m.enabled) throw new DryPowderError("MarketDisabled", `${m.symbol} is not taking new positions`);
    if (!(t.leverage >= 1 && t.leverage <= m.maxLeverage)) throw new DryPowderError("LeverageOutOfRange", `${m.symbol} allows 1x to ${m.maxLeverage}x`);
    const upside = m.feeModel === "upside";
    const ref = t.referencePrice ?? m.price ?? m.lastPrice;
    const isLong = t.side === "long";
    const margin = t.margin;
    const size = (margin * BigInt(Math.round(t.leverage * 100))) / 100n;
    if (marginFor(size, t.leverage) > margin + 1n) throw new Error("size rounding exceeded the leverage");
    if (t.limitPrice !== undefined && t.stopEntryPrice !== undefined) throw new DryPowderError("BAD_ARGUMENTS", "pass limitPrice or stopEntryPrice, not both");
    const fixed = t.limitPrice ?? t.stopEntryPrice;
    if (!ref && fixed === undefined) throw new DryPowderError("NO_PRICE", `${m.symbol} has no price yet; pass referencePrice, limitPrice or stopEntryPrice`);
    // Upside markets fill at the mid; the marketable bound still starts from the adverse side of the band, which
    // the venue's keeper checks before it fills.
    const mid = ref ? (ref.mid ?? (ref.bid + ref.ask) / 2n) : 0n;
    const entry = fixed ?? (upside ? mid : isLong ? ref!.ask : ref!.bid);
    const adverse = fixed ?? (isLong ? ref!.ask : ref!.bid);
    const bps = BigInt(t.slippageBps ?? 50);
    const triggerPrice = fixed ?? (isLong ? (adverse * (BPS + bps)) / BPS : (adverse * (BPS - bps)) / BPS);
    // One position per market: an order on the side held adds to it; the other side is refused at fill.
    const held = (await this.positions()).find((p) => p.marketId.toLowerCase() === m.id.toLowerCase());
    if (held && held.isLong !== isLong) throw new DryPowderError("PositionExists", `you hold a ${held.isLong ? "long" : "short"} on ${m.symbol}: close it (or part of it) instead`);
    const [quotedFee, execFee, minMargin, maxProfitMultiple, baseFeeBps, maxSkewFeeBps, fp, expiresAt] = await Promise.all([
      this.engineRead<bigint>("quoteOpenFee", [m.id, size, isLong, margin]),
      this.engineRead<bigint>("executionFee"),
      this.engineRead<bigint>("minMargin"),
      this.engineRead<bigint>("maxProfitMultiple"),
      this.engineRead<bigint>("baseFeeBps"),
      this.engineRead<bigint>("maxSkewFeeBps"),
      this.feeParams(this.trader),
      this.expiryOf(t),
    ]);
    if (margin < minMargin) throw new DryPowderError("MarginTooLow", `margin is below the minimum ${minMargin} (6 decimals)`);
    const brackets = (t.takeProfit ? 1n : 0n) + (t.stopLoss ? 1n : 0n);
    const executionFees = execFee * (1n + brackets);
    const openFee = upside ? 0n : fp.referred ? discounted(quotedFee, fp.referralDiscountBps) : quotedFee;
    // The order escrows the most the open fee can be at fill (base + max skew surcharge, capped at 10% of
    // margin; nothing in an Upside market); the difference to the actual fee is refunded on fill.
    const ceil = (size * (baseFeeBps + maxSkewFeeBps) + BPS - 1n) / BPS;
    const feeEscrow = upside ? 0n : ceil < feeCap(margin) ? ceil : feeCap(margin);
    const closeCeil = (size * baseFeeBps + BPS - 1n) / BPS;
    const closeFee = upside ? 0n : discountedIf(fp.referred, closeCeil < feeCap(margin) ? closeCeil : feeCap(margin), fp.referralDiscountBps);
    const risk = assessRisk({
      entry, size, margin, isLong, openFee, closeFee, executionFees: executionFees + execFee, stopLoss: t.stopLoss, maxProfitMultiple,
      feeModel: m.feeModel, profitShareBps: fp.profitShareBps, referred: fp.referred, referralDiscountBps: fp.referralDiscountBps,
    });
    const afterFill = held ? mergedPosition({ position: { size: held.size, margin: held.margin, entry: held.entryPrice, isLong }, add: { size, margin, price: entry } }) : null;
    const usd = (x: bigint) => `${Number(x) / 1e6} USDC`;
    const feeNote = upside
      ? `No fee unless you win: nothing to open or close; a winning close pays ${risk.profitShareBps / 100}% of its profit to the house${fp.referred ? " (referral discount included)" : ""}. Keeper fees ${usd(executionFees)}.`
      : `About ${usd(openFee)} to open and up to ${usd(closeFee)} to close (each capped at 10% of margin), plus ${usd(executionFees)} keeper fees.`;
    return {
      market: m, isLong, size, margin, entry, triggerPrice, openFee, executionFees, required: margin + feeEscrow + executionFees, risk, afterFill,
      feeModel: m.feeModel, profitShareBps: risk.profitShareBps, referred: fp.referred, expiresAt, feeNote,
    };
  }

  // ── Trading ──

  /**
   * Opens a position, or adds to the one held on the same side, with a keeper-filled order (a marketable limit
   * for market orders, a resting limit with `limitPrice`, a breakout with `stopEntryPrice`): it always fills at a
   * price published after the order, and it is the only way to open above 100x and in the Turbo markets. With
   * `expiresIn` / `expiresAt` the order cannot fill after that time. Returns once the order is placed; use
   * `waitForFill` to wait for the keeper. Brackets on an addition move the position's existing ones.
   */
  async open(t: TradeIntent): Promise<TxResult & { orderId: bigint; quote: Quote }> {
    const q = await this.quote(t);
    if (q.risk.stopPastLiquidation) throw new DryPowderError("STOP_PAST_LIQUIDATION", "the stop-loss is past the liquidation price: liquidation would come first");
    await this.ensureAllowance(q.required);
    const params = {
      priceId: q.market.id,
      isLong: q.isLong,
      margin: q.margin,
      size: q.size,
      triggerPrice: q.triggerPrice,
      takeProfit: t.takeProfit ?? 0n,
      stopLoss: t.stopLoss ?? 0n,
      stopEntry: t.stopEntryPrice !== undefined,
    };
    const tx = q.expiresAt ? await this.send("createLimitOrderUntil", [params, BigInt(q.expiresAt)]) : await this.send("createLimitOrder", [params]);
    const orderId = orderIdFrom(tx.receipt) ?? 0n;
    return { hash: tx.hash, url: tx.url, orderId, quote: q };
  }

  /**
   * Closes a position, or part of it: `size` (USDC notional) or `fraction` (0..1); neither closes everything.
   * If what would remain holds less than the minimum margin, everything closes. Above 100x, in the Turbo markets
   * and whenever `viaKeeper` is set this places a keeper-filled Close order; otherwise it closes directly at the
   * on-chain price, accepting at most `slippageBps` from it.
   */
  async close(market: string, opts: { size?: bigint; fraction?: number; viaKeeper?: boolean; slippageBps?: number } = {}): Promise<TxResult & { orderId?: bigint }> {
    const m = await this.market(market);
    const pos = (await this.positions()).find((p) => p.marketId.toLowerCase() === m.id.toLowerCase());
    if (!pos) throw new DryPowderError("PositionNotFound", `no ${m.symbol} position`);
    const size = closeSizeOf(pos.size, opts);
    const bound = closeBound(m, pos.isLong, BigInt(opts.slippageBps ?? 50));
    if (opts.viaKeeper || (!m.settled && needsKeeperOrders(pos.size, pos.margin, m.feeModel))) {
      const tx = await this.send("setTriggerOrder", [m.id, 3, bound, size]);
      return { hash: tx.hash, url: tx.url, orderId: orderIdFrom(tx.receipt, true) ?? undefined };
    }
    const tx = await this.send("closePosition", [m.id, size, bound, []]);
    return { hash: tx.hash, url: tx.url };
  }

  /**
   * Attaches (or moves) a take-profit and/or stop-loss on an open position; with `size` they close only that
   * much notional when they fire (0 or omitted: the whole position). With a fresh price the engine refuses one
   * already through it (a long's take-profit at or below the mid, its stop at or above), and so does this.
   */
  async setStops(market: string, stops: { takeProfit?: bigint; stopLoss?: bigint; size?: bigint }): Promise<TxResult[]> {
    const m = await this.market(market);
    if (m.price && (stops.takeProfit || stops.stopLoss)) {
      const pos = (await this.positions()).find((p) => p.marketId.toLowerCase() === m.id.toLowerCase());
      const mid = m.price.mid;
      if (pos && stops.takeProfit && (pos.isLong ? stops.takeProfit <= mid : stops.takeProfit >= mid)) throw new DryPowderError("InvalidTrigger", `the take-profit of a ${pos.isLong ? "long must be above" : "short must be below"} the current price`);
      if (pos && stops.stopLoss && (pos.isLong ? stops.stopLoss >= mid : stops.stopLoss <= mid)) throw new DryPowderError("InvalidTrigger", `the stop-loss of a ${pos.isLong ? "long must be below" : "short must be above"} the current price`);
    }
    const out: TxResult[] = [];
    const size = stops.size ?? 0n;
    if (stops.takeProfit) out.push(await this.send("setTriggerOrder", [m.id, 1, stops.takeProfit, size]));
    if (stops.stopLoss) out.push(await this.send("setTriggerOrder", [m.id, 2, stops.stopLoss, size]));
    return out.map(({ hash, url }) => ({ hash, url }));
  }

  /**
   * Adds margin to a position: lower leverage, liquidation further away. Refused while the position is in
   * profit (it would lift the profit cap) or below 1x.
   */
  async addMargin(market: string, amount: bigint): Promise<TxResult> {
    const m = await this.market(market);
    await this.ensureAllowance(amount);
    const tx = await this.send("addMargin", [m.id, amount]);
    return { hash: tx.hash, url: tx.url };
  }

  /**
   * Takes margin out of a position (v3.2): higher leverage, liquidation closer. What stays must hold the minimum
   * margin, at most min(market max, 100x) leverage (an agent's own cap too) and cover any loss at the exit price;
   * unrealised profit never comes out. It trades on the on-chain price, which must be fresh and newer than the
   * position's last open or top-up: this waits up to `waitMs` (default 75 s) for the keeper to push one.
   */
  async removeMargin(market: string, amount: bigint, opts: { waitMs?: number } = {}): Promise<TxResult> {
    if (amount <= 0n) throw new DryPowderError("InvalidParam", "amount must be positive");
    let m = await this.market(market);
    const pos = (await this.positions()).find((p) => p.marketId.toLowerCase() === m.id.toLowerCase());
    if (!pos) throw new DryPowderError("PositionNotFound", `no ${m.symbol} position`);
    const until = Date.now() + (opts.waitMs ?? 75_000);
    while (!(m.price && m.price.publishTime > pos.openedAt)) {
      if (Date.now() > until) throw new DryPowderError(m.price ? "PriceNotAfterOpen" : "OraclePriceStale", `no fresh ${m.symbol} price newer than the position's last open yet: try again shortly`);
      await new Promise((r) => setTimeout(r, 2_000));
      m = await this.market(m.id);
    }
    const max = await this.maxRemovableMargin(m.id).catch(() => null);
    if (max !== null && amount > max) throw new DryPowderError("InsufficientMargin", `at most ${max} (6 decimals) can come out of ${m.symbol} now`);
    const tx = await this.send("removeMargin", [m.id, amount, []]);
    return { hash: tx.hash, url: tx.url };
  }

  /** The most `removeMargin` can take out of the position now, at the on-chain price (0n: nothing). */
  async maxRemovableMargin(market: string): Promise<bigint> {
    const m = await this.market(market);
    const pos = (await this.positions()).find((p) => p.marketId.toLowerCase() === m.id.toLowerCase());
    if (!pos) throw new DryPowderError("PositionNotFound", `no ${m.symbol} position`);
    const px = m.price ?? m.lastPrice;
    if (!px) throw new DryPowderError("OraclePriceUnavailable", `${m.symbol} has no price`);
    let agentMaxLeverage: number | undefined;
    const signer = this.walletClient?.account.address;
    if (this.agentAccount && signer) {
      const owner = await this.publicClient.readContract({ address: this.agentAccount, abi: agentAccountAbi, functionName: "owner" });
      if (owner.toLowerCase() !== signer.toLowerCase()) agentMaxLeverage = (await this.agentPolicy(this.agentAccount, signer)).maxLeverage;
    }
    return removableMargin({
      size: pos.size, margin: pos.margin, entry: pos.entryPrice, isLong: pos.isLong, exitPrice: pos.isLong ? px.bid : px.ask, fundingOwed: pos.fundingOwed,
      marketMaxLeverage: m.maxLeverage, minMargin: await this.engineRead<bigint>("minMargin"), agentMaxLeverage,
    });
  }

  /**
   * A ladder of `count` limit orders from `from` to `to`, splitting `totalMargin` evenly at one leverage. Through
   * an agent account the whole ladder is one atomic transaction (multicall); from a wallet, one order each.
   */
  async scale(s: { market: string; side: "long" | "short"; totalMargin: bigint; leverage: number; from: bigint; to: bigint; count: number; takeProfit?: bigint; stopLoss?: bigint; expiresAt?: number; expiresIn?: number }): Promise<TxResult[]> {
    const m = await this.market(s.market);
    const prices = ladderPrices(s.from, s.to, s.count);
    const margin = s.totalMargin / BigInt(s.count);
    const expiresAt = await this.expiryOf(s);
    const quotes = await Promise.all(prices.map((limitPrice) => this.quote({ market: m.id, side: s.side, margin, leverage: s.leverage, limitPrice, takeProfit: s.takeProfit, stopLoss: s.stopLoss })));
    const orders = quotes.map((q) => ({ priceId: m.id, isLong: q.isLong, margin: q.margin, size: q.size, triggerPrice: q.triggerPrice, takeProfit: s.takeProfit ?? 0n, stopLoss: s.stopLoss ?? 0n, stopEntry: false }));
    await this.ensureAllowance(quotes.reduce((sum, q) => sum + q.required, 0n));
    if (this.agentAccount) {
      const calls = orders.map((o) =>
        expiresAt
          ? encodeFunctionData({ abi: agentAccountAbi, functionName: "createLimitOrderUntil", args: [o, BigInt(expiresAt)] })
          : encodeFunctionData({ abi: agentAccountAbi, functionName: "createLimitOrder", args: [o] }),
      );
      const tx = await this.send("multicall", [calls]);
      return [{ hash: tx.hash, url: tx.url }];
    }
    const out: TxResult[] = [];
    for (const o of orders) {
      const tx = expiresAt ? await this.send("createLimitOrderUntil", [o, BigInt(expiresAt)]) : await this.send("createLimitOrder", [o]);
      out.push({ hash: tx.hash, url: tx.url });
    }
    return out;
  }

  /** Cancels every resting order (of one market, if given): one transaction through an agent account. */
  async cancelAll(market?: string): Promise<TxResult[]> {
    const m = market ? await this.market(market) : null;
    const ids = (await this.orders()).filter((o) => !m || o.marketId.toLowerCase() === m.id.toLowerCase()).map((o) => o.id);
    return this.cancelMany(ids);
  }

  /**
   * Closes every position: keeper Close orders for those above 100x and in Turbo markets, direct closes for the
   * rest. One transaction through an agent account.
   */
  async closeAll(opts: { slippageBps?: number } = {}): Promise<TxResult[]> {
    const [positions, markets] = await Promise.all([this.positions(), this.markets()]);
    const bps = BigInt(opts.slippageBps ?? 50);
    const calls: { fn: "setTriggerOrder" | "closePosition"; args: readonly unknown[] }[] = [];
    for (const pos of positions) {
      const m = markets.find((x) => x.id.toLowerCase() === pos.marketId.toLowerCase());
      if (!m) continue;
      const bound = closeBound(m, pos.isLong, bps);
      if (!m.settled && needsKeeperOrders(pos.size, pos.margin, m.feeModel)) calls.push({ fn: "setTriggerOrder", args: [m.id, 3, bound, 0n] });
      else calls.push({ fn: "closePosition", args: [m.id, 0n, bound, []] });
    }
    if (calls.length === 0) return [];
    if (this.agentAccount) {
      // biome-ignore lint: the union of two forwarders' argument tuples
      const data = calls.map((c) => encodeFunctionData({ abi: agentAccountAbi, functionName: c.fn, args: c.args } as any));
      const tx = await this.send("multicall", [data]);
      return [{ hash: tx.hash, url: tx.url }];
    }
    const out: TxResult[] = [];
    for (const c of calls) {
      const tx = await this.send(c.fn, c.args);
      out.push({ hash: tx.hash, url: tx.url });
    }
    return out;
  }

  async cancel(orderId: bigint): Promise<TxResult> {
    const { hash, url } = await this.send("cancelOrder", [orderId]);
    return { hash, url };
  }

  /** Waits until the order leaves the book (filled, rejected at fill, or expired and removed). */
  async waitForFill(orderId: bigint, timeoutMs = 60_000): Promise<"done" | "resting"> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const trader = await this.engineRead<Address>("orderTrader", [orderId]);
      if (trader === zeroAddress) return "done";
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return "resting";
  }

  // ── Order expiry (v3.2) ──

  /** Sets when an order of the trader stops being executable (unix seconds), or clears it with null / 0. */
  async setOrderExpiry(orderId: bigint, expiresAt: number | null): Promise<TxResult> {
    const at = expiresAt ?? 0;
    if (at !== 0 && at <= (await this.now())) throw new DryPowderError("InvalidParam", "expiresAt must be in the future");
    const { hash, url } = await this.send("setOrderExpiry", [orderId, BigInt(at)]);
    return { hash, url };
  }

  /** The trader's orders that are past their expiry (they can no longer fill; cancelling refunds their escrow). */
  async expiredOrders(trader: Address | null = this.trader): Promise<Order[]> {
    const [orders, now] = await Promise.all([this.orders(trader), this.now()]);
    return orders.filter((o) => o.expiresAt !== 0 && now > o.expiresAt);
  }

  /** Cancels the trader's own expired orders with a full refund (one transaction through an agent account). */
  async cancelExpired(): Promise<TxResult[]> {
    return this.cancelMany((await this.expiredOrders()).map((o) => o.id));
  }

  /**
   * Removes anyone's expired orders (PerpEngine.cancelExpired): the signer's wallet earns each one's execution
   * fee and the rest of its escrow goes back to its trader. Reverts with NothingToCancel if none has expired.
   */
  async sweepExpired(ids: bigint[]): Promise<TxResult & { cancelled: bigint }> {
    const tx = await this.write({ address: this.deployment.engine, abi: perpEngineAbi }, "cancelExpired", [ids]);
    return { hash: tx.hash, url: tx.url, cancelled: tx.result as bigint };
  }

  // ── Referrals and claims (v3.2) ──

  /**
   * Records who referred the trader (once): from then on its fees, the Upside profit share included, are
   * `referralDiscountBps` lower and the referrer earns `referralShareBps` of them. For an agent account only the
   * owner can set it.
   */
  async setReferrer(referrer: Address): Promise<TxResult> {
    if (referrer === zeroAddress || referrer.toLowerCase() === this.trader?.toLowerCase()) throw new DryPowderError("InvalidParam", "the referrer must be another address");
    const current = this.trader ? await this.engineRead<Address>("referrerOf", [this.trader]) : zeroAddress;
    if (current !== zeroAddress) throw new DryPowderError("ReferrerAlreadySet", `the referrer is already ${current}`);
    const { hash, url } = await this.send("setReferrer", [referrer]);
    return { hash, url };
  }

  /** The trader's referral standing: their referrer, the discount they get, and what the engine holds for them. */
  async referral(trader: Address | null = this.trader): Promise<{ referrer: Address | null; discountBps: number; referrerShareBps: number; claimable: bigint }> {
    const fp = await this.feeParams(trader);
    const claimable = trader ? await this.engineRead<bigint>("claimable", [trader]) : 0n;
    return { referrer: fp.referred ? fp.referrer : null, discountBps: Number(fp.referralDiscountBps), referrerShareBps: Number(fp.referralShareBps), claimable };
  }

  /**
   * Collects the USDC the engine holds for the trader: referral earnings and payouts it could not deliver.
   * Through an agent account it lands in the account.
   */
  async claim(): Promise<TxResult & { amount: bigint }> {
    const amount = this.trader ? await this.engineRead<bigint>("claimable", [this.trader]) : 0n;
    if (amount === 0n) throw new DryPowderError("NothingToClaim");
    const { hash, url } = await this.send("claim", []);
    return { hash, url, amount };
  }

  /**
   * DRY loss rebates (v3.2): DRY minted only as the trader's running result (each close capped at 1% of its
   * notional) falls below its previous low. `lossBeforeRebates` is how much has to be lost again before the
   * next rebate; `ratePerUsdc` what one more USDC of new net loss mints now (18 decimals).
   */
  async rebates(trader: Address | null = this.trader): Promise<{ dry: bigint; net: bigint; low: bigint; lossBeforeRebates: bigint; ratePerUsdc: bigint; totalRebatedLoss: bigint }> {
    const token = { address: this.deployment.token, abi: rewardTokenAbi } as const;
    const [dry, results, ratePerUsdc, totalRebatedLoss] = await Promise.all([
      trader ? this.publicClient.readContract({ ...token, functionName: "balanceOf", args: [trader] }) : 0n,
      trader ? this.publicClient.readContract({ ...token, functionName: "results", args: [trader] }) : ([0n, 0n] as const),
      this.publicClient.readContract({ ...token, functionName: "rebateRate" }),
      this.publicClient.readContract({ ...token, functionName: "totalRebatedLoss" }),
    ]);
    const [net, low] = results as readonly [bigint, bigint];
    return { dry, net, low, lossBeforeRebates: net - low, ratePerUsdc, totalRebatedLoss };
  }

  /** Test deployments only: mints test USDC to the trader (wallet or agent account). */
  async faucet(amount: bigint): Promise<TxResult> {
    const { hash, url } = await this.write({ address: this.deployment.usdc, abi: testUSDCAbi }, "mint", [this.trader!, amount]);
    return { hash, url };
  }

  // ── Agent accounts ──

  /** Creates (or returns) the signer's AgentAccount: agents trade from it and can never withdraw. */
  async createAgentAccount(): Promise<Address> {
    const w = this.requireWallet();
    const factory = this.requireFactory();
    const existing = await this.publicClient.readContract({ address: factory, abi: agentAccountFactoryAbi, functionName: "accountOf", args: [w.account.address] });
    if (existing !== zeroAddress) return existing;
    await this.write({ address: factory, abi: agentAccountFactoryAbi }, "createAccount", [w.account.address]);
    return this.publicClient.readContract({ address: factory, abi: agentAccountFactoryAbi, functionName: "accountOf", args: [w.account.address] });
  }

  /**
   * Owner only: approves an agent key with an on-chain policy, and with `dailyBudget` caps the margin it may
   * commit per UTC day. `gas` (native USDC, 18 decimals) is forwarded to the key in the same transaction.
   */
  async approveAgent(account: Address, agent: Address, policy: AgentPolicyInput): Promise<TxResult> {
    const expiry = BigInt(await this.now()) + BigInt(policy.expiresInSeconds);
    const target = { address: account, abi: agentAccountAbi };
    const setAgent = [agent, expiry, policy.maxLeverage, policy.maxMarginPerOrder] as const;
    if (policy.dailyBudget !== undefined && !policy.gas) {
      // One transaction: the policy and the budget together (multicall is not payable, hence no gas here).
      const calls = [encodeFunctionData({ abi: agentAccountAbi, functionName: "setAgent", args: setAgent }), encodeFunctionData({ abi: agentAccountAbi, functionName: "setAgentBudget", args: [agent, policy.dailyBudget] })];
      const { hash, url } = await this.write(target, "multicall", [calls]);
      return { hash, url };
    }
    const { hash, url } = await this.write(target, "setAgent", setAgent, policy.gas ?? 0n);
    if (policy.dailyBudget !== undefined) await this.setAgentBudget(account, agent, policy.dailyBudget);
    return { hash, url };
  }

  /** Owner only: removes an agent at once (its positions and orders stay; the owner manages them). */
  async revokeAgent(account: Address, agent: Address): Promise<TxResult> {
    const { hash, url } = await this.write({ address: account, abi: agentAccountAbi }, "revokeAgent", [agent]);
    return { hash, url };
  }

  /** Owner only: the most margin `agent` may commit per UTC day (0n: no daily cap). Counts today's spending. */
  async setAgentBudget(account: Address, agent: Address, perDay: bigint): Promise<TxResult> {
    const { hash, url } = await this.write({ address: account, abi: agentAccountAbi }, "setAgentBudget", [agent, perDay]);
    return { hash, url };
  }

  /** An agent's policy on an account (`active` while not expired). */
  async agentPolicy(account: Address, agent: Address): Promise<{ expiry: number; maxLeverage: number; maxMargin: bigint; active: boolean }> {
    const [[expiry, maxLeverage, maxMargin], now] = await Promise.all([this.publicClient.readContract({ address: account, abi: agentAccountAbi, functionName: "agents", args: [agent] }), this.now()]);
    return { expiry: Number(expiry), maxLeverage: Number(maxLeverage), maxMargin, active: Number(expiry) > now };
  }

  /** An agent's daily budget: `remainingToday` is null when it has no daily cap. */
  async agentBudget(account: Address, agent: Address): Promise<{ perDay: bigint; spentToday: bigint; remainingToday: bigint | null }> {
    const [[perDay, day, spent], now] = await Promise.all([this.publicClient.readContract({ address: account, abi: agentAccountAbi, functionName: "budgets", args: [agent] }), this.now()]);
    const spentToday = Number(day) === Math.floor(now / 86_400) ? spent : 0n;
    return { perDay, spentToday, remainingToday: perDay === 0n ? null : perDay > spentToday ? perDay - spentToday : 0n };
  }

  /**
   * Creates the signer's AgentAccount with `agent` approved and funded with `gas` in one transaction (v3.1
   * factories). Returns the account.
   */
  async createAgentAccountWithAgent(agent: Address, policy: { expiresInSeconds: number; maxLeverage: number; maxMarginPerOrder: bigint; gas?: bigint }): Promise<Address> {
    const w = this.requireWallet();
    const factory = this.requireFactory();
    const expiry = BigInt(await this.now()) + BigInt(policy.expiresInSeconds);
    await this.write({ address: factory, abi: agentAccountFactoryAbi }, "createAccountWithAgent", [agent, expiry, policy.maxLeverage, policy.maxMarginPerOrder], policy.gas ?? 0n);
    return this.publicClient.readContract({ address: factory, abi: agentAccountFactoryAbi, functionName: "accountOf", args: [w.account.address] });
  }

  // ── Strategies (v3.2): on-chain trend, mean-reversion and copy agents ──

  /**
   * Owner only: lets the Strategies contract trade the account, each order within `maxMarginPerOrder` and
   * `maxLeverage`, and with `dailyBudget` at most that much margin per UTC day across all its strategies.
   */
  async approveStrategies(account: Address, policy: Omit<AgentPolicyInput, "gas">): Promise<TxResult> {
    return this.approveAgent(account, this.requireAddress("strategies"), { ...policy, gas: undefined });
  }

  /**
   * Starts a strategy on an agent account (default: this client's) in one market. The signer is the account's
   * owner or one of its active agents (an agent only within its own caps), and the account must have approved
   * the Strategies contract (`approveStrategies`). Every rule the contract checks is checked first.
   */
  async createStrategy(spec: StrategySpec, opts: { account?: Address } = {}): Promise<TxResult & { id: bigint }> {
    const w = this.requireWallet();
    const strategies = this.requireAddress("strategies");
    const account = opts.account ?? this.agentAccount;
    if (!account) throw new DryPowderError("NO_ACCOUNT", "strategies run on an agent account: pass `account` or connect with `agentAccount`");
    const m = await this.market(spec.market);
    const config = strategyConfig(spec);
    const minMargin = await this.engineRead<bigint>("minMargin");
    const problems = validateStrategy(config, m, minMargin, account, await this.now());
    if (problems.length) throw new DryPowderError("InvalidStrategy", `InvalidStrategy: ${problems.join("; ")}`);
    const acct = { address: account, abi: agentAccountAbi } as const;
    const [owner, approval, restricted, allowed, taken] = await Promise.all([
      this.publicClient.readContract({ ...acct, functionName: "owner" }),
      this.agentPolicy(account, strategies),
      this.publicClient.readContract({ ...acct, functionName: "restrictMarkets" }),
      this.publicClient.readContract({ ...acct, functionName: "marketAllowed", args: [m.id] }),
      this.publicClient.readContract({ address: strategies, abi: strategiesAbi, functionName: "strategyOf", args: [account, m.id] }),
    ]);
    if (owner.toLowerCase() !== w.account.address.toLowerCase()) {
      const mine = await this.agentPolicy(account, w.account.address);
      if (!mine.active) throw new DryPowderError("NotAllowed", "the signer is neither the account's owner nor one of its active agents");
      if (config.margin > mine.maxMargin || config.leverage > mine.maxLeverage) throw new DryPowderError("AgentPolicyExceeded", `your agent caps are ${mine.maxLeverage}x and ${mine.maxMargin} margin per order`);
    }
    if (!approval.active || config.margin > approval.maxMargin || config.leverage > approval.maxLeverage || (restricted && !allowed)) {
      const need = `margin ${config.margin} per order at ${config.leverage}x${restricted && !allowed ? `, and ${m.symbol} allowed for agents` : ""}`;
      throw new DryPowderError("NotApproved", `NotApproved: the account's owner must approve the Strategies contract (approveStrategies) for ${need}; now: ${approval.active ? `${approval.maxLeverage}x, ${approval.maxMargin} per order` : "not approved"}`);
    }
    if (taken !== 0n) throw new DryPowderError("MarketTaken", `strategy ${taken} already runs on ${m.symbol} for this account: stop it first`);
    const budget = await this.agentBudget(account, strategies);
    if (budget.perDay !== 0n && budget.perDay < config.margin) throw new DryPowderError("DailyBudgetExceeded", `the Strategies daily budget (${budget.perDay}) is below one order's margin (${config.margin})`);
    const tx = await this.write({ address: strategies, abi: strategiesAbi }, "create", [account, m.id, config]);
    const logs = parseEventLogs({ abi: strategiesAbi, logs: tx.receipt.logs, eventName: "StrategyCreated" });
    const id = logs.length ? (logs[logs.length - 1]!.args as { id: bigint }).id : (tx.result as bigint);
    return { hash: tx.hash, url: tx.url, id };
  }

  /** One strategy, with its config as a spec and its live state. */
  async strategy(id: bigint): Promise<StrategyInfo> {
    const s = (await this.publicClient.readContract({ address: this.requireAddress("strategies"), abi: strategiesAbi, functionName: "getStrategy", args: [id] })) as unknown as RawStrategy;
    if (s.account === zeroAddress) throw new DryPowderError("NoStrategy", `no strategy ${id}`);
    return strategyInfo(id, s, await this.symbolOf(s.marketId));
  }

  /** Every strategy an account ran (default: this client's), stopped ones included, oldest first. */
  async strategies(account: Address | null = this.agentAccount): Promise<StrategyInfo[]> {
    if (!account) return [];
    const ids = await this.publicClient.readContract({ address: this.requireAddress("strategies"), abi: strategiesAbi, functionName: "strategiesOf", args: [account] });
    return Promise.all(ids.map((id) => this.strategy(id)));
  }

  /** Live (active or paused) strategies of every account, a page at a time. */
  async liveStrategies(opts: { offset?: number; limit?: number } = {}): Promise<StrategyInfo[]> {
    const [ids, list] = await this.publicClient.readContract({ address: this.requireAddress("strategies"), abi: strategiesAbi, functionName: "getStrategies", args: [BigInt(opts.offset ?? 0), BigInt(opts.limit ?? 100)] });
    const out: StrategyInfo[] = [];
    for (let i = 0; i < ids.length; i++) out.push(strategyInfo(ids[i]!, list[i] as unknown as RawStrategy, await this.symbolOf(list[i]!.marketId)));
    return out;
  }

  /** Pauses a strategy: no samples, no orders; an open order of its own still on the book is cancelled. */
  async pauseStrategy(id: bigint): Promise<TxResult> {
    return this.strategyCall("pause", id);
  }

  /** Resumes a paused strategy (trend and mean reversion warm up again first). */
  async resumeStrategy(id: bigint): Promise<TxResult> {
    return this.strategyCall("resume", id);
  }

  /** Stops a strategy for good and frees its market. Its position stays: close it on the account if wanted. */
  async stopStrategy(id: bigint): Promise<TxResult> {
    return this.strategyCall("stop", id);
  }

  /** Whether a poke would do something for the strategy now. */
  async strategyDue(id: bigint): Promise<boolean> {
    return this.publicClient.readContract({ address: this.requireAddress("strategies"), abi: strategiesAbi, functionName: "due", args: [id] });
  }

  /** Runs each strategy that has something to do (anyone may; the venue's keeper does it too). */
  async pokeStrategies(ids: bigint[]): Promise<TxResult> {
    const { hash, url } = await this.write({ address: this.requireAddress("strategies"), abi: strategiesAbi }, "poke", [ids]);
    return { hash, url };
  }

  // ── Agent registry (v3.2) ──

  /** Owner only: lists an agent account in the registry (a label for the app; it grants nothing). */
  async registerAgent(account: Address, listing: AgentListingInput): Promise<TxResult> {
    return this.registryCall("register", account, listing);
  }

  /** Owner only: replaces the listing's name, description, kind and URI. */
  async updateAgentListing(account: Address, listing: AgentListingInput): Promise<TxResult> {
    return this.registryCall("update", account, listing);
  }

  /** Owner only: removes the listing. */
  async unregisterAgent(account: Address): Promise<TxResult> {
    const { hash, url } = await this.write({ address: this.requireAddress("agentRegistry"), abi: agentRegistryAbi }, "unregister", [account]);
    return { hash, url };
  }

  /** The registry's listing of an account, or null. */
  async agentListing(account: Address): Promise<AgentListing | null> {
    const a = await this.publicClient.readContract({ address: this.requireAddress("agentRegistry"), abi: agentRegistryAbi, functionName: "getAgent", args: [account] });
    return a.owner === zeroAddress ? null : listingOf(account, a);
  }

  /** Listed agents, a page at a time. */
  async agentListings(opts: { offset?: number; limit?: number } = {}): Promise<AgentListing[]> {
    const [accounts, list] = await this.publicClient.readContract({ address: this.requireAddress("agentRegistry"), abi: agentRegistryAbi, functionName: "getAgents", args: [BigInt(opts.offset ?? 0), BigInt(opts.limit ?? 100)] });
    return accounts.map((a, i) => listingOf(a, list[i]!));
  }

  // ── Season prizes (v3.2) ──

  /** A season's prize pool and results (`published` once its Merkle root is set). */
  async prizeSeason(seasonId: bigint | number): Promise<{ funded: bigint; allocated: bigint; claimed: bigint; root: Hex; claimDeadline: number; closed: boolean; published: boolean }> {
    const [funded, allocated, claimed, root, claimDeadline, closed] = await this.publicClient.readContract({ address: this.requireAddress("prizeDistributor"), abi: prizeDistributorAbi, functionName: "seasons", args: [BigInt(seasonId)] });
    return { funded, allocated, claimed, root, claimDeadline: Number(claimDeadline), closed, published: root !== ZERO32 };
  }

  /** Whether `account` can still claim `amount` for the season with `proof` (from the season's results). */
  async canClaimPrize(seasonId: bigint | number, account: Address, amount: bigint, proof: Hex[]): Promise<boolean> {
    return this.publicClient.readContract({ address: this.requireAddress("prizeDistributor"), abi: prizeDistributorAbi, functionName: "canClaim", args: [BigInt(seasonId), account, amount, proof] });
  }

  /** Pays `account` its prize (anyone may submit; the prize always goes to `account`). */
  async claimPrize(seasonId: bigint | number, account: Address, amount: bigint, proof: Hex[]): Promise<TxResult> {
    const { hash, url } = await this.write({ address: this.requireAddress("prizeDistributor"), abi: prizeDistributorAbi }, "claim", [BigInt(seasonId), account, amount, proof]);
    return { hash, url };
  }

  // ── Internals ──

  private requireWallet(): WalletClient<Transport, Chain, Account> {
    if (!this.walletClient) throw new DryPowderError("READ_ONLY", "read-only client: pass `account` to trade");
    return this.walletClient;
  }

  private requireFactory(): Address {
    if (!this.deployment.agentFactory) throw new DryPowderError("NOT_DEPLOYED", "this deployment has no agent account factory");
    return this.deployment.agentFactory;
  }

  private requireAddress(k: "strategies" | "agentRegistry" | "prizeDistributor"): Address {
    const a = this.deployment[k];
    if (!a) throw new DryPowderError("NOT_DEPLOYED", `this deployment has no ${k} contract (v3.2)`);
    return a;
  }

  private engineRead<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    // biome-ignore lint: viem's overloads do not narrow on a string variable
    return this.publicClient.readContract({ address: this.deployment.engine, abi: perpEngineAbi, functionName, args } as any) as Promise<T>;
  }

  /** The engine's share and referral parameters, and whether `trader` has a referrer. */
  private async feeParams(trader: Address | null) {
    const [profitShareBps, referralDiscountBps, referralShareBps, referrer] = await Promise.all([
      this.engineRead<bigint>("profitShareBps"),
      this.engineRead<bigint>("referralDiscountBps"),
      this.engineRead<bigint>("referralShareBps"),
      trader ? this.engineRead<Address>("referrerOf", [trader]) : Promise.resolve(zeroAddress as Address),
    ]);
    return { profitShareBps, referralDiscountBps, referralShareBps, referrer, referred: referrer !== zeroAddress };
  }

  /** An order's expiry from `expiresAt` / `expiresIn` (0: none), checked against chain time. */
  private async expiryOf(t: { expiresAt?: number; expiresIn?: number }): Promise<number> {
    if (t.expiresAt !== undefined && t.expiresIn !== undefined) throw new DryPowderError("BAD_ARGUMENTS", "pass expiresAt or expiresIn, not both");
    if (t.expiresAt === undefined && t.expiresIn === undefined) return 0;
    const now = await this.now();
    const at = t.expiresAt ?? now + Math.round(t.expiresIn!);
    if (!(Number.isInteger(at) && at > now)) throw new DryPowderError("InvalidParam", "the order's expiry must be in the future");
    return at;
  }

  private async symbolOf(marketId: Hex): Promise<string | null> {
    const list = this.marketCache ?? (await this.markets());
    return list.find((m) => m.id.toLowerCase() === marketId.toLowerCase())?.symbol ?? null;
  }

  private async strategyCall(fn: "pause" | "resume" | "stop", id: bigint): Promise<TxResult> {
    const { hash, url } = await this.write({ address: this.requireAddress("strategies"), abi: strategiesAbi }, fn, [id]);
    return { hash, url };
  }

  private async registryCall(fn: "register" | "update", account: Address, l: AgentListingInput): Promise<TxResult> {
    const problems = validateListing(l);
    if (problems.length) throw new DryPowderError("InvalidAgent", `InvalidAgent: ${problems.join("; ")}`);
    const { hash, url } = await this.write({ address: this.requireAddress("agentRegistry"), abi: agentRegistryAbi }, fn, [account, l.name, l.description ?? "", l.kind, l.uri ?? ""]);
    return { hash, url };
  }

  private async cancelMany(ids: bigint[]): Promise<TxResult[]> {
    if (ids.length === 0) return [];
    if (this.agentAccount) {
      const tx = await this.send("multicall", [ids.map((id) => encodeFunctionData({ abi: agentAccountAbi, functionName: "cancelOrder", args: [id] }))]);
      return [{ hash: tx.hash, url: tx.url }];
    }
    const out: TxResult[] = [];
    for (const id of ids) out.push(await this.cancel(id));
    return out;
  }

  /** Arc charges at least 20 gwei; pay the base fee twice over plus a 1 gwei tip, never below 25 gwei. */
  private async fees() {
    const block = await this.publicClient.getBlock();
    const base = block.baseFeePerGas ?? 20n * GWEI;
    const tip = GWEI;
    const max = base * 2n + tip;
    return { maxFeePerGas: max < 25n * GWEI ? 25n * GWEI : max, maxPriorityFeePerGas: tip };
  }

  private async ensureAllowance(amount: bigint): Promise<void> {
    if (this.agentAccount) return; // the account approved the engine when it was created
    const w = this.requireWallet();
    const have = await this.publicClient.readContract({ address: this.deployment.usdc, abi: testUSDCAbi, functionName: "allowance", args: [w.account.address, this.deployment.engine] });
    if (have >= amount) return;
    await this.write({ address: this.deployment.usdc, abi: testUSDCAbi }, "approve", [this.deployment.engine, 2n ** 256n - 1n]);
  }

  /** A trading call: through the agent account when there is one, else straight to the engine. */
  private send(functionName: TradeFn, args: readonly unknown[]) {
    const target = this.agentAccount ? { address: this.agentAccount, abi: agentAccountAbi as Abi } : { address: this.deployment.engine, abi: perpEngineAbi as Abi };
    return this.write(target, functionName, args);
  }

  /** Simulates (reverts come out as DryPowderError), sends with gas headroom and waits for success. */
  private async write(target: { address: Address; abi: Abi }, functionName: string, args: readonly unknown[], value = 0n): Promise<TxResult & { receipt: TransactionReceipt; result: unknown }> {
    const w = this.requireWallet();
    // biome-ignore lint: one call site for every function of every contract
    const call = { address: target.address, abi: [...target.abi, ...ERRORS], functionName, args, account: w.account, ...(value ? { value } : {}) } as any;
    let request: unknown;
    let result: unknown;
    let gas: bigint;
    try {
      ({ request, result } = await this.publicClient.simulateContract(call));
      // The estimate is the least gas that works on the state it ran on; the transaction runs on a later one.
      // By address: with a local account viem estimates twice and caps the second at the first.
      gas = withGasHeadroom(await this.publicClient.estimateContractGas({ ...call, account: w.account.address }));
    } catch (e) {
      throw toDryPowderError(e);
    }
    const hash = await w.writeContract({ ...(request as object), gas, ...(await this.fees()) } as never);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
    if (receipt.status !== "success") throw new DryPowderError("REVERTED", `transaction reverted: ${hash}`);
    return { hash, url: this.explorerTx(hash), receipt, result };
  }
}

/** A node that answered from behind the head, or (anvil --prune-history) dropped the state it had just resolved. */
const TRANSIENT_RPC = /BlockOutOfRange|header not found|block not found|unknown block|missing trie node/i;

/**
 * `t`, retrying a request that failed with a transient RPC error, up to three times. Never a transaction send:
 * only reads, calls and estimates, which are safe to repeat.
 */
export function retryTransient(t: Transport): Transport {
  return ((opts: Parameters<Transport>[0]) => {
    const inner = t(opts);
    const request = (async (args: { method: string; params?: unknown }, options?: unknown) => {
      for (let i = 0; ; i++) {
        try {
          // biome-ignore lint: the EIP-1193 request signature is generic over every method
          return await (inner.request as any)(args, options);
        } catch (e) {
          const text = `${(e as { details?: string }).details ?? ""} ${(e as Error).message ?? ""}`;
          if (i >= 3 || /^eth_send/.test(args.method) || !TRANSIENT_RPC.test(text)) throw e;
          await new Promise((r) => setTimeout(r, 100 * (i + 1)));
        }
      }
    }) as typeof inner.request;
    return { ...inner, request };
  }) as Transport;
}

/**
 * Gas limit for a call estimated at `gas`: a quarter more plus room for a few fresh storage slots. The block
 * the transaction lands in may differ from the one it was estimated on (an addition becomes a new position,
 * funding accrues), and a tight limit then runs out. Unused gas is not charged.
 */
export const withGasHeadroom = (gas: bigint): bigint => (gas * 5n) / 4n + 50_000n;

/** The notional to close: `size`, or `fraction` of the position, or 0 (everything). */
export function closeSizeOf(positionSize: bigint, opts: { size?: bigint; fraction?: number }): bigint {
  if (opts.size !== undefined && opts.fraction !== undefined) throw new Error("pass size or fraction, not both");
  if (opts.size !== undefined) {
    if (opts.size < 0n) throw new Error("size must be positive");
    return opts.size >= positionSize ? 0n : opts.size;
  }
  if (opts.fraction !== undefined) {
    if (!(opts.fraction > 0 && opts.fraction <= 1)) throw new Error("fraction must be in (0, 1]");
    if (opts.fraction === 1) return 0n;
    return (positionSize * BigInt(Math.round(opts.fraction * 1_000_000))) / 1_000_000n;
  }
  return 0n;
}

/**
 * Worst acceptable price for closing: `bps` beyond the bid (a long) or the ask (a short). Upside markets fill at
 * the mid, which is never worse than that; the venue's keeper checks the bid/ask before it fills. 0n: no price.
 */
function closeBound(m: Market, isLong: boolean, bps: bigint): bigint {
  const px: Px | null = m.price ?? m.lastPrice;
  const mark = px ? (isLong ? px.bid : px.ask) : 0n;
  return mark ? (isLong ? (mark * (BPS - bps)) / BPS : (mark * (BPS + bps)) / BPS) : 0n;
}

/** The order a transaction created, or with `moved` the one it moved (a close order already on the book). */
function orderIdFrom(receipt: TransactionReceipt, moved = false): bigint | null {
  for (const eventName of moved ? (["OrderCreated", "OrderUpdated"] as const) : (["OrderCreated"] as const)) {
    const logs = parseEventLogs({ abi: perpEngineAbi, logs: receipt.logs, eventName });
    if (logs.length) return (logs[logs.length - 1]!.args as { orderId: bigint }).orderId;
  }
  return null;
}

const discountedIf = (referred: boolean, fee: bigint, bps: bigint) => (referred ? discounted(fee, bps) : fee);

function listingOf(account: Address, a: { owner: Address; registeredAt: bigint; updatedAt: bigint; name: string; description: string; kind: string; uri: string }): AgentListing {
  return { account, owner: a.owner, name: a.name, description: a.description, kind: a.kind, uri: a.uri, registeredAt: Number(a.registeredAt), updatedAt: Number(a.updatedAt) };
}
