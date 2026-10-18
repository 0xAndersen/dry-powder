import {
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  createPublicClient,
  createWalletClient,
  defineChain,
  fallback,
  http,
  parseEventLogs,
  zeroAddress,
} from "viem";
import { agentAccountAbi, agentAccountFactoryAbi, engineLensAbi, perpEngineAbi, testUSDCAbi } from "./abi.js";
import { ARC_TESTNET_RPCS, type Deployment, loadDeployment } from "./deployment.js";
import { BPS, type Risk, assessRisk, feeCap, marginFor, needsKeeperOrders } from "./risk.js";

const ZERO32 = `0x${"0".repeat(64)}` as Hex;
const GWEI = 10n ** 9n;

export type MarketKind = "perpetual" | "inverted" | "cross" | "dated future";

export interface Market {
  id: Hex;
  symbol: string;
  kind: MarketKind;
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
}

export interface Order {
  id: bigint;
  marketId: Hex;
  /** 0 limit open, 1 take-profit, 2 stop-loss, 3 close. */
  orderType: number;
  isLong: boolean;
  size: bigint;
  margin: bigint;
  triggerPrice: bigint;
  executionFee: bigint;
}

export interface TradeIntent {
  /** Symbol ("BTC-USD", "BTC") or market id. */
  market: string;
  side: "long" | "short";
  /** The most this position can lose (margin), USDC 6 decimals. */
  margin: bigint;
  /** 1..market max (up to 1000). */
  leverage: number;
  /** Market order: worst acceptable fill, in bps from the current oracle price. Default 50. */
  slippageBps?: number;
  /** Limit order instead of a market order. */
  limitPrice?: bigint;
  /** Market orders: the bid/ask to apply slippage to (e.g. from your own feed). Default: the on-chain price. */
  referencePrice?: { bid: bigint; ask: bigint };
  takeProfit?: bigint;
  stopLoss?: bigint;
}

export interface Quote {
  market: Market;
  isLong: boolean;
  size: bigint;
  margin: bigint;
  /** Estimated entry: the ask for a long, the bid for a short. */
  entry: bigint;
  /** Worst fill (market order) or the limit price. */
  triggerPrice: bigint;
  openFee: bigint;
  executionFees: bigint;
  /** What leaves the wallet or account when the order is placed. */
  required: bigint;
  risk: Risk;
}

export interface TxResult {
  hash: Hex;
  url: string;
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
    const transport = fallback(rpcs.map((u) => http(u, { retryCount: 2, timeout: 20_000 })), { rank: false });
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

  /** One market by symbol ("BTC-USD", or "BTC" for "BTC-USD") or id, with a fresh price. */
  async market(symbolOrId: string): Promise<Market> {
    const all = await this.markets();
    const want = symbolOrId.toUpperCase();
    const sym = want.startsWith("0X") ? want : want.includes("-") ? want : `${want}-USD`;
    const m = all.find((x) => x.symbol.toUpperCase() === sym || x.id.toUpperCase() === sym);
    if (!m) throw new Error(`no market ${symbolOrId}; markets: ${all.map((x) => x.symbol).join(", ")}`);
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
    }));
  }

  /** Collateral the trader holds (wallet, or the agent account's balance). */
  async balance(trader: Address | null = this.trader): Promise<bigint> {
    if (!trader) return 0n;
    return this.publicClient.readContract({ address: this.deployment.usdc, abi: testUSDCAbi, functionName: "balanceOf", args: [trader] });
  }

  // ── Risk before anything else ──

  /** Everything about a trade before placing it, worst case first. Reads only. */
  async quote(t: TradeIntent): Promise<Quote> {
    const m = await this.market(t.market);
    if (!m.enabled) throw new Error(`${m.symbol} is not taking new positions`);
    if (!(t.leverage >= 1 && t.leverage <= m.maxLeverage)) throw new Error(`${m.symbol} allows 1x to ${m.maxLeverage}x`);
    const ref = t.referencePrice ?? m.price ?? m.lastPrice;
    if (!ref && t.limitPrice === undefined) throw new Error(`${m.symbol} has no price yet; pass referencePrice or limitPrice`);
    const isLong = t.side === "long";
    const margin = t.margin;
    const size = (margin * BigInt(Math.round(t.leverage * 100))) / 100n;
    if (marginFor(size, t.leverage) > margin + 1n) throw new Error("size rounding exceeded the leverage");
    const entry = t.limitPrice ?? (isLong ? ref!.ask : ref!.bid);
    const bps = BigInt(t.slippageBps ?? 50);
    const triggerPrice = t.limitPrice ?? (isLong ? (entry * (BPS + bps)) / BPS : (entry * (BPS - bps)) / BPS);
    const [openFee, execFee, minMargin, maxProfitMultiple, baseFeeBps, maxSkewFeeBps] = await Promise.all([
      this.engineRead<bigint>("quoteOpenFee", [m.id, size, isLong, margin]),
      this.engineRead<bigint>("executionFee"),
      this.engineRead<bigint>("minMargin"),
      this.engineRead<bigint>("maxProfitMultiple"),
      this.engineRead<bigint>("baseFeeBps"),
      this.engineRead<bigint>("maxSkewFeeBps"),
    ]);
    if (margin < minMargin) throw new Error(`margin is below the minimum ${minMargin} (6 decimals)`);
    const brackets = (t.takeProfit ? 1n : 0n) + (t.stopLoss ? 1n : 0n);
    const executionFees = execFee * (1n + brackets);
    // The order escrows the most the open fee can be at fill (base + max skew surcharge, capped at 10% of
    // margin); the difference to the actual fee is refunded on fill.
    const ceil = (size * (baseFeeBps + maxSkewFeeBps) + BPS - 1n) / BPS;
    const feeEscrow = ceil < feeCap(margin) ? ceil : feeCap(margin);
    const risk = assessRisk({ entry, size, margin, isLong, openFee, executionFees: executionFees + execFee, stopLoss: t.stopLoss, maxProfitMultiple });
    return { market: m, isLong, size, margin, entry, triggerPrice, openFee, executionFees, required: margin + feeEscrow + executionFees, risk };
  }

  // ── Trading ──

  /**
   * Opens a position with a keeper-filled order (a marketable limit for market orders): it always fills at a
   * price published after the order, and it is the only way to open above 100x. Returns once the order is placed;
   * use `waitForFill` to wait for the keeper.
   */
  async open(t: TradeIntent): Promise<TxResult & { orderId: bigint; quote: Quote }> {
    const q = await this.quote(t);
    if (q.risk.stopPastLiquidation) throw new Error("the stop-loss is past the liquidation price: liquidation would come first");
    await this.ensureAllowance(q.required);
    const params = { priceId: q.market.id, isLong: q.isLong, margin: q.margin, size: q.size, triggerPrice: q.triggerPrice, takeProfit: t.takeProfit ?? 0n, stopLoss: t.stopLoss ?? 0n };
    const tx = await this.send("createLimitOrder", [params]);
    const logs = parseEventLogs({ abi: perpEngineAbi, logs: tx.receipt.logs, eventName: "OrderCreated" });
    const orderId = logs.length ? (logs[logs.length - 1]!.args as { orderId: bigint }).orderId : 0n;
    return { hash: tx.hash, url: tx.url, orderId, quote: q };
  }

  /**
   * Closes a position. Above 100x (and whenever `viaKeeper` is set) this places a keeper-filled Close order;
   * otherwise it closes directly at the on-chain price, accepting at most `slippageBps` from it.
   */
  async close(market: string, opts: { viaKeeper?: boolean; slippageBps?: number } = {}): Promise<TxResult & { orderId?: bigint }> {
    const m = await this.market(market);
    const pos = (await this.positions()).find((p) => p.marketId.toLowerCase() === m.id.toLowerCase());
    if (!pos) throw new Error(`no ${m.symbol} position`);
    const bps = BigInt(opts.slippageBps ?? 50);
    const px = m.price ?? m.lastPrice;
    const mark = px ? (pos.isLong ? px.bid : px.ask) : 0n;
    const bound = mark ? (pos.isLong ? (mark * (BPS - bps)) / BPS : (mark * (BPS + bps)) / BPS) : 0n;
    if (opts.viaKeeper || (!m.settled && needsKeeperOrders(pos.size, pos.margin))) {
      const tx = await this.send("setTriggerOrder", [m.id, 3, bound]);
      const logs = parseEventLogs({ abi: perpEngineAbi, logs: tx.receipt.logs, eventName: "OrderCreated" });
      return { hash: tx.hash, url: tx.url, orderId: logs.length ? (logs[logs.length - 1]!.args as { orderId: bigint }).orderId : undefined };
    }
    const tx = await this.send("closePosition", [m.id, bound, []]);
    return { hash: tx.hash, url: tx.url };
  }

  /** Attaches (or moves) a take-profit and/or stop-loss on an open position. */
  async setStops(market: string, stops: { takeProfit?: bigint; stopLoss?: bigint }): Promise<TxResult[]> {
    const m = await this.market(market);
    const out: TxResult[] = [];
    if (stops.takeProfit) out.push(await this.send("setTriggerOrder", [m.id, 1, stops.takeProfit]));
    if (stops.stopLoss) out.push(await this.send("setTriggerOrder", [m.id, 2, stops.stopLoss]));
    return out;
  }

  async cancel(orderId: bigint): Promise<TxResult> {
    return this.send("cancelOrder", [orderId]);
  }

  /** Waits until the order leaves the book (filled, or rejected at fill). */
  async waitForFill(orderId: bigint, timeoutMs = 60_000): Promise<"done" | "resting"> {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      const o = await this.engineRead<{ trader: Address }>("getOrder", [orderId]);
      if (o.trader === zeroAddress) return "done";
      await new Promise((r) => setTimeout(r, 1_000));
    }
    return "resting";
  }

  /** Test deployments only: mints test USDC to the trader (wallet or agent account). */
  async faucet(amount: bigint): Promise<TxResult> {
    const w = this.requireWallet();
    const hash = await w.writeContract({ address: this.deployment.usdc, abi: testUSDCAbi, functionName: "mint", args: [this.trader!, amount], ...(await this.fees()) });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return { hash, url: this.explorerTx(hash) };
  }

  // ── Agent accounts ──

  /** Creates (or returns) the signer's AgentAccount: agents trade from it and can never withdraw. */
  async createAgentAccount(): Promise<Address> {
    const w = this.requireWallet();
    const factory = this.requireFactory();
    const existing = await this.publicClient.readContract({ address: factory, abi: agentAccountFactoryAbi, functionName: "accountOf", args: [w.account.address] });
    if (existing !== zeroAddress) return existing;
    const hash = await w.writeContract({ address: factory, abi: agentAccountFactoryAbi, functionName: "createAccount", args: [w.account.address], ...(await this.fees()) });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return this.publicClient.readContract({ address: factory, abi: agentAccountFactoryAbi, functionName: "accountOf", args: [w.account.address] });
  }

  /** Owner only: approves an agent key with an on-chain policy. */
  async approveAgent(account: Address, agent: Address, policy: { expiresInSeconds: number; maxLeverage: number; maxMarginPerOrder: bigint }): Promise<TxResult> {
    const w = this.requireWallet();
    const now = (await this.publicClient.getBlock()).timestamp;
    const hash = await w.writeContract({
      address: account,
      abi: agentAccountAbi,
      functionName: "setAgent",
      args: [agent, now + BigInt(policy.expiresInSeconds), policy.maxLeverage, policy.maxMarginPerOrder],
      ...(await this.fees()),
    });
    await this.publicClient.waitForTransactionReceipt({ hash });
    return { hash, url: this.explorerTx(hash) };
  }

  // ── Internals ──

  private requireWallet(): WalletClient<Transport, Chain, Account> {
    if (!this.walletClient) throw new Error("read-only client: pass `account` to trade");
    return this.walletClient;
  }

  private requireFactory(): Address {
    if (!this.deployment.agentFactory) throw new Error("this deployment has no agent account factory");
    return this.deployment.agentFactory;
  }

  private engineRead<T>(functionName: string, args: readonly unknown[] = []): Promise<T> {
    // biome-ignore lint: viem's overloads do not narrow on a string variable
    return this.publicClient.readContract({ address: this.deployment.engine, abi: perpEngineAbi, functionName, args } as any) as Promise<T>;
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
    const hash = await w.writeContract({ address: this.deployment.usdc, abi: testUSDCAbi, functionName: "approve", args: [this.deployment.engine, 2n ** 256n - 1n], ...(await this.fees()) });
    await this.publicClient.waitForTransactionReceipt({ hash });
  }

  private async send(functionName: "createLimitOrder" | "closePosition" | "setTriggerOrder" | "cancelOrder", args: readonly unknown[]) {
    const w = this.requireWallet();
    const target = this.agentAccount
      ? { address: this.agentAccount, abi: [...agentAccountAbi, ...perpEngineAbi.filter((x) => x.type === "error")] }
      : { address: this.deployment.engine, abi: perpEngineAbi };
    // biome-ignore lint: one call site for four functions on two ABIs
    const { request } = await this.publicClient.simulateContract({ ...target, functionName, args, account: w.account } as any);
    const hash = await w.writeContract({ ...(request as object), ...(await this.fees()) } as never);
    const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: 90_000 });
    if (receipt.status !== "success") throw new Error(`transaction reverted: ${hash}`);
    return { hash, url: this.explorerTx(hash), receipt };
  }
}
