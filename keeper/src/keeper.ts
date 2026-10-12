import { IPythAbi } from "@pythnetwork/pyth-evm-js";
import {
  type Account,
  type Address,
  type Chain,
  type Hex,
  type PublicClient,
  type Transport,
  type WalletClient,
  BaseError,
  ContractFunctionRevertedError,
  formatEther,
  formatUnits,
  parseEther,
  parseGwei,
} from "viem";
import { perpEngineAbi } from "./abi.js";
import type { Config } from "./config.js";
import { describeError, log } from "./logger.js";
import { type EnginePrice, OrderType, chunk, isLiquidatable, isTriggered, toEnginePrice } from "./math.js";
import type { PriceFeed } from "./prices.js";

const PAGE_SIZE = 200n;
/** Arc's protocol-enforced base fee floor. Transactions offering less are dropped without an error. */
const ARC_MIN_BASE_FEE = parseGwei("20");
/** Warn when the keeper's native USDC (gas + Pyth fees) falls below this. */
const LOW_BALANCE = parseEther("0.5");
const MAX_ORDERS_PER_TICK = 10;
const RECEIPT_TIMEOUT_MS = 30_000;

interface Position {
  key: Hex;
  trader: Address;
  priceId: Hex;
  isLong: boolean;
  margin: bigint;
  openedAt: number;
  liquidationPrice: bigint;
}

interface Order {
  id: bigint;
  trader: Address;
  priceId: Hex;
  orderType: number;
  isLong: boolean;
  createdAt: number;
  triggerPrice: bigint;
  executionFee: bigint;
}

interface Backoff {
  attempts: number;
  until: number;
}

/** Revert reasons that mean "someone else got there first" or "not yet": expected in normal operation. */
const BENIGN_REVERTS = new Set([
  "NothingToLiquidate",
  "OrderNotFound",
  "TriggerNotMet",
  "PriceBeforeOrder",
  "PriceNotAfterOpen",
  "PositionLiquidatable",
  "PositionExists",
  "OraclePriceStale",
  "InvalidTrigger",
  "EnforcedPause",
  "MarketDisabled",
  "LeverageOutOfRange",
  "MarginTooLow",
  "MarketOiCapExceeded",
  "VaultOiCapExceeded",
]);

function revertName(err: unknown): string | undefined {
  if (!(err instanceof BaseError)) return undefined;
  const revert = err.walk((e) => e instanceof ContractFunctionRevertedError);
  if (revert instanceof ContractFunctionRevertedError) return revert.data?.errorName ?? revert.reason;
  return undefined;
}

export class Keeper {
  private readonly invert = new Map<Hex, boolean>();
  private positions: Position[] = [];
  private orders: Order[] = [];
  private maxPriceAge = 3;
  private readonly backoff = new Map<string, Backoff>();
  private ticking = false;
  private refreshing = false;
  private stopped = false;
  private timers: NodeJS.Timeout[] = [];
  private stats = { liquidations: 0, ordersExecuted: 0, txFailed: 0 };

  private prices!: PriceFeed;

  constructor(
    private readonly cfg: Config,
    private readonly publicClient: PublicClient<Transport, Chain>,
    private readonly walletClient: WalletClient<Transport, Chain, Account>,
  ) {}

  private get account(): Address {
    return this.walletClient.account.address;
  }

  /** Reads the market list. Call once before `start`. Returns the Pyth feed ids to subscribe to. */
  async init(): Promise<Hex[]> {
    const chainId = await this.publicClient.getChainId();
    if (chainId !== this.cfg.chainId) {
      throw new Error(`RPC is on chain ${chainId}, expected ${this.cfg.chainId}`);
    }
    const engine = { address: this.cfg.engine, abi: perpEngineAbi } as const;
    const [ids, maxPriceAge] = await Promise.all([
      this.publicClient.readContract({ ...engine, functionName: "getMarketIds" }),
      this.publicClient.readContract({ ...engine, functionName: "maxPriceAge" }),
    ]);
    if (ids.length === 0) throw new Error("PerpEngine has no markets");
    this.maxPriceAge = Number(maxPriceAge);
    for (const id of ids) {
      const market = await this.publicClient.readContract({ ...engine, functionName: "markets", args: [id] });
      this.invert.set(id.toLowerCase() as Hex, market[1]);
    }
    const balance = await this.publicClient.getBalance({ address: this.account });
    log.info("keeper initialised", {
      account: this.account,
      engine: this.cfg.engine,
      markets: ids.length,
      maxPriceAge: this.maxPriceAge,
      nativeUsdc: formatEther(balance),
      dryRun: this.cfg.dryRun,
    });
    if (balance < LOW_BALANCE) log.warn("keeper balance is low; fund it with USDC on Arc", { nativeUsdc: formatEther(balance) });
    return [...ids];
  }

  /** Starts the loops. `prices` must already be streaming the feeds returned by `init`. */
  start(prices: PriceFeed): void {
    this.prices = prices;
    void this.refresh();
    this.timers.push(setInterval(() => void this.refresh(), this.cfg.refreshIntervalMs));
    this.timers.push(setInterval(() => void this.tick(), this.cfg.tickIntervalMs));
    this.timers.push(setInterval(() => void this.heartbeat(), 60_000));
  }

  stop(): void {
    this.stopped = true;
    for (const timer of this.timers) clearInterval(timer);
  }

  // ───────────────────────────── Chain state ─────────────────────────────

  /** Re-reads every open position and order. Liquidation prices drift with funding, so this runs often. */
  private async refresh(): Promise<void> {
    if (this.refreshing || this.stopped) return;
    this.refreshing = true;
    try {
      const engine = { address: this.cfg.engine, abi: perpEngineAbi } as const;
      const [positionCount, orderCount] = await Promise.all([
        this.publicClient.readContract({ ...engine, functionName: "positionCount" }),
        this.cfg.executeOrders
          ? this.publicClient.readContract({ ...engine, functionName: "orderCount" })
          : Promise.resolve(0n),
      ]);

      const positions: Position[] = [];
      for (let offset = 0n; offset < positionCount; offset += PAGE_SIZE) {
        const page = await this.publicClient.readContract({
          ...engine,
          functionName: "getPositions",
          args: [offset, PAGE_SIZE],
        });
        for (const view of page) {
          positions.push({
            key: view.key,
            trader: view.position.trader,
            priceId: view.position.priceId.toLowerCase() as Hex,
            isLong: view.position.isLong,
            margin: view.position.margin,
            openedAt: Number(view.position.openedAt),
            liquidationPrice: view.liquidationPrice,
          });
        }
      }

      const orders: Order[] = [];
      for (let offset = 0n; offset < orderCount; offset += PAGE_SIZE) {
        const [ids, page] = await this.publicClient.readContract({
          ...engine,
          functionName: "getOrders",
          args: [offset, PAGE_SIZE],
        });
        page.forEach((order, i) => {
          const id = ids[i];
          if (id === undefined) return;
          orders.push({
            id,
            trader: order.trader,
            priceId: order.priceId.toLowerCase() as Hex,
            orderType: order.orderType,
            isLong: order.isLong,
            createdAt: Number(order.createdAt),
            triggerPrice: order.triggerPrice,
            executionFee: order.executionFee,
          });
        });
      }

      // The set is paged without a snapshot, so a position that moved between pages can appear twice.
      this.positions = [...new Map(positions.map((p) => [p.key, p])).values()];
      this.orders = [...new Map(orders.map((o) => [o.id, o])).values()];
      log.debug("state refreshed", { positions: this.positions.length, orders: this.orders.length });
    } catch (err) {
      log.warn("refresh failed; keeping previous state", { error: describeError(err) });
    } finally {
      this.refreshing = false;
    }
  }

  // ───────────────────────────── Decision loop ─────────────────────────────

  private enginePrice(priceId: Hex): EnginePrice | null {
    const raw = this.prices.get(priceId);
    if (!raw) return null;
    // Skip markets whose feed has stopped (FX at the weekend): the contract would reject the price.
    if (Date.now() / 1000 - raw.publishTime > this.maxPriceAge + 5) return null;
    return toEnginePrice(raw, this.invert.get(priceId) ?? false);
  }

  private ready(id: string): boolean {
    const entry = this.backoff.get(id);
    return !entry || Date.now() >= entry.until;
  }

  /** Exponential backoff per position/order so a stuck item cannot monopolise the keeper. */
  private defer(id: string): void {
    const attempts = (this.backoff.get(id)?.attempts ?? 0) + 1;
    const delay = Math.min(30_000, 250 * 2 ** attempts);
    this.backoff.set(id, { attempts, until: Date.now() + delay });
  }

  private async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      // Liquidations first: they protect the vault, and a liquidatable position's stop-loss cannot execute.
      const liquidatable = this.positions.filter((p) => {
        if (!this.ready(p.key)) return false;
        const px = this.enginePrice(p.priceId);
        return px !== null && isLiquidatable(p.isLong, p.liquidationPrice, px.mid);
      });
      // Largest margin first: that is where both the risk to the vault and the keeper fee are greatest.
      liquidatable.sort((a, b) => (a.margin === b.margin ? 0 : a.margin > b.margin ? -1 : 1));
      for (const batch of chunk(liquidatable, this.cfg.batchSize)) {
        await this.liquidate(batch);
      }

      if (this.cfg.executeOrders) {
        const doomed = new Set(liquidatable.map((p) => p.key));
        const byOwner = new Map(this.positions.map((p) => [`${p.trader.toLowerCase()}:${p.priceId}`, p]));
        const due = this.orders.filter((o) => {
          if (!this.ready(`order:${o.id}`)) return false;
          const px = this.enginePrice(o.priceId);
          if (px === null || px.publishTime < o.createdAt) return false;
          if (o.orderType !== OrderType.LimitOpen) {
            const position = byOwner.get(`${o.trader.toLowerCase()}:${o.priceId}`);
            if (!position || doomed.has(position.key) || px.publishTime <= position.openedAt) return false;
          }
          return isTriggered(o.orderType, o.isLong, o.triggerPrice, px);
        });
        for (const order of due.slice(0, MAX_ORDERS_PER_TICK)) {
          await this.executeOrder(order);
        }
      }

      // Forget backoff entries for things that no longer exist.
      if (this.backoff.size > 5_000) {
        const live = new Set<string>([...this.positions.map((p) => p.key), ...this.orders.map((o) => `order:${o.id}`)]);
        for (const id of this.backoff.keys()) if (!live.has(id)) this.backoff.delete(id);
      }
    } catch (err) {
      log.error("tick failed", { error: describeError(err) });
    } finally {
      this.ticking = false;
    }
  }

  // ───────────────────────────── Actions ─────────────────────────────

  private async liquidate(batch: Position[]): Promise<void> {
    const keys = batch.map((p) => p.key);
    const feeds = [...new Set(batch.map((p) => p.priceId))];
    try {
      const priceUpdate = await this.prices.fetchUpdate(feeds);
      const value = await this.updateFee(priceUpdate);
      const call = {
        address: this.cfg.engine,
        abi: perpEngineAbi,
        functionName: "liquidateBatch",
        args: [keys, priceUpdate],
        value,
        account: this.walletClient.account,
      } as const;

      // The contract is the judge: simulate with the exact update that will be sent.
      const { result: count } = await this.publicClient.simulateContract(call);
      if (this.cfg.dryRun) {
        log.info("dry run: would liquidate", { positions: Number(count), candidates: keys.length });
        keys.forEach((key) => this.defer(key));
        return;
      }
      const gas = await this.publicClient.estimateContractGas(call);
      const hash = await this.walletClient.writeContract({ ...call, gas: (gas * 13n) / 10n, ...(await this.fees()) });
      log.info("liquidation sent", { hash, candidates: keys.length, expected: Number(count) });

      const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
      if (receipt.status === "success") {
        this.stats.liquidations += Number(count);
        const gone = new Set(keys);
        // Drop them locally right away; the next refresh confirms. Healthy ones in the batch reappear then.
        this.positions = this.positions.filter((p) => !gone.has(p.key));
        log.info("liquidation confirmed", { hash, liquidated: Number(count), gasUsed: receipt.gasUsed });
      } else {
        this.stats.txFailed++;
        keys.forEach((key) => this.defer(key));
        log.warn("liquidation reverted on-chain", { hash });
      }
    } catch (err) {
      keys.forEach((key) => this.defer(key));
      this.report("liquidation", err, { candidates: keys.length });
    }
  }

  private async executeOrder(order: Order): Promise<void> {
    const id = `order:${order.id}`;
    try {
      const priceUpdate = await this.prices.fetchUpdate([order.priceId]);
      const value = await this.updateFee(priceUpdate);
      const call = {
        address: this.cfg.engine,
        abi: perpEngineAbi,
        functionName: "executeOrder",
        args: [order.id, priceUpdate],
        value,
        account: this.walletClient.account,
      } as const;

      await this.publicClient.simulateContract(call);
      if (this.cfg.dryRun) {
        log.info("dry run: would execute order", { orderId: order.id, type: order.orderType });
        this.defer(id);
        return;
      }
      const gas = await this.publicClient.estimateContractGas(call);
      const hash = await this.walletClient.writeContract({ ...call, gas: (gas * 13n) / 10n, ...(await this.fees()) });
      log.info("order execution sent", { hash, orderId: order.id, type: order.orderType });

      const receipt = await this.publicClient.waitForTransactionReceipt({ hash, timeout: RECEIPT_TIMEOUT_MS });
      if (receipt.status === "success") {
        this.stats.ordersExecuted++;
        this.orders = this.orders.filter((o) => o.id !== order.id);
        log.info("order executed", {
          hash,
          orderId: order.id,
          earnedUsdc: formatUnits(order.executionFee, 6),
          gasUsed: receipt.gasUsed,
        });
      } else {
        this.stats.txFailed++;
        this.defer(id);
        log.warn("order execution reverted on-chain", { hash, orderId: order.id });
      }
    } catch (err) {
      this.defer(id);
      this.report("order execution", err, { orderId: order.id });
    }
  }

  /** Expected reverts (lost a race, trigger no longer met) are routine; anything else is worth a warning. */
  private report(action: string, err: unknown, fields: Record<string, unknown>): void {
    const reason = revertName(err);
    if (reason && BENIGN_REVERTS.has(reason)) {
      log.debug(`${action} skipped`, { ...fields, reason });
    } else {
      this.stats.txFailed++;
      log.warn(`${action} failed`, { ...fields, reason, error: describeError(err) });
    }
  }

  private async updateFee(priceUpdate: Hex[]): Promise<bigint> {
    return this.publicClient.readContract({
      address: this.cfg.pyth,
      abi: IPythAbi,
      functionName: "getUpdateFee",
      args: [priceUpdate],
    });
  }

  /**
   * EIP-1559 fees for Arc. The fee cap covers a doubling of the base fee and never goes below Arc's
   * 20 gwei floor (below it a transaction is silently dropped); the tip is what buys priority over
   * competing keepers. Both are bounded by MAX_FEE_GWEI.
   */
  private async fees(): Promise<{ maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }> {
    const block = await this.publicClient.getBlock({ blockTag: "latest" });
    const baseFee = block.baseFeePerGas ?? (await this.publicClient.getGasPrice());
    const floor = baseFee > ARC_MIN_BASE_FEE ? baseFee : ARC_MIN_BASE_FEE;
    let maxFeePerGas = floor * 2n + this.cfg.priorityFee;
    if (maxFeePerGas > this.cfg.maxFee) maxFeePerGas = this.cfg.maxFee;
    const maxPriorityFeePerGas = this.cfg.priorityFee < maxFeePerGas ? this.cfg.priorityFee : maxFeePerGas;
    return { maxFeePerGas, maxPriorityFeePerGas };
  }

  private async heartbeat(): Promise<void> {
    try {
      const balance = await this.publicClient.getBalance({ address: this.account });
      log.info("heartbeat", {
        positions: this.positions.length,
        orders: this.orders.length,
        hermesSilenceMs: this.prices.silenceMs(),
        nativeUsdc: formatEther(balance),
        ...this.stats,
      });
      if (balance < LOW_BALANCE) log.warn("keeper balance is low; fund it with USDC on Arc", { nativeUsdc: formatEther(balance) });
    } catch (err) {
      log.warn("heartbeat failed", { error: describeError(err) });
    }
  }
}
