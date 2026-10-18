// Configuration, chain access, market data and the trading identity for the MCP server.
import { readFileSync } from "node:fs";
import { createPublicClient, createWalletClient, defineChain, fallback, http, parseEventLogs } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { agentAccountAbi, engineLensAbi, perpEngineAbi, rewardTokenAbi, testUSDCAbi } from "./abi.mjs";
import { ConfirmationStore, Guardrails, ToolError } from "./guard.mjs";

export const DEFAULT_DEPLOYMENT = "https://raw.githubusercontent.com/0xAndersen/dry-powder/main/deployments/arc-testnet.json";
const ZERO32 = "0x" + "0".repeat(64);
const E18 = 10n ** 18n;

// Kraken pairs for each Pyth feed id the venue uses (reference prices for marketable orders and price bands).
const FEEDS = {
  "0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43": ["XBTUSD", "XXBTZUSD"],
  "0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace": ["ETHUSD", "XETHZUSD"],
  "0xef0d8b6fda2ceba41da15d4095d1da392a0d2f8ed0c6c7bc0f4cfac8c280b56d": ["SOLUSD", "SOLUSD"],
  "0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b": ["EURUSD", "ZEURZUSD"],
  "0xef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52": ["USDJPY", "ZUSDZJPY"],
  "0x765d2ba906dbc32ca17cc11f5310a89e9ee1f6420508c63861f2f8ba4ee34bb2": ["PAXGUSD", "PAXGUSD"],
};

export function loadConfig(env = process.env) {
  const num = (k, d) => (env[k] === undefined || env[k] === "" ? d : Number(env[k]));
  const key = (k) => {
    const v = env[k];
    if (v && !/^0x[0-9a-fA-F]{64}$/.test(v)) throw new ToolError("CONFIG_ERROR", `${k} must be a 0x-prefixed 32-byte private key`);
    return v || undefined;
  };
  const account = env.DP_ACCOUNT || undefined;
  if (account && !/^0x[0-9a-fA-F]{40}$/.test(account)) throw new ToolError("CONFIG_ERROR", "DP_ACCOUNT must be an address");
  const allowed = (env.DP_ALLOWED_MARKETS || "").split(",").map((s) => s.trim().toUpperCase()).filter(Boolean);
  return {
    deployment: env.DP_DEPLOYMENT || DEFAULT_DEPLOYMENT,
    rpcUrl: env.DP_RPC_URL || undefined,
    krakenUrl: env.DP_KRAKEN_URL || "https://api.kraken.com",
    account,
    agentKey: key("DP_AGENT_KEY"),
    walletKey: key("DP_PRIVATE_KEY"),
    guard: {
      allowedMarkets: allowed.length && !allowed.includes("*") ? allowed.map((s) => (s.includes("-") ? s : `${s}-USD`)) : undefined,
      maxNotional: BigInt(Math.round(num("DP_MAX_NOTIONAL_USD", 10_000) * 1e6)),
      maxLeverage: num("DP_MAX_LEVERAGE", 20),
      maxSlippageBps: num("DP_MAX_SLIPPAGE_BPS", 300),
    },
    defaultSlippageBps: num("DP_DEFAULT_SLIPPAGE_BPS", 50),
    requireConfirm: !["0", "false", "no"].includes(String(env.DP_REQUIRE_CONFIRM ?? "true").toLowerCase()),
    confirmTtlMs: num("DP_CONFIRM_TTL_SECONDS", 120) * 1000,
    fillTimeoutMs: num("DP_FILL_TIMEOUT_SECONDS", 30) * 1000,
  };
}

async function loadDeployment(src) {
  if (/^https?:\/\//.test(src)) {
    const r = await fetch(src, { signal: AbortSignal.timeout(10_000) });
    if (!r.ok) throw new ToolError("CONFIG_ERROR", `deployment ${src}: http ${r.status}`);
    return r.json();
  }
  return JSON.parse(readFileSync(src, "utf8"));
}

export class Context {
  constructor(config) {
    this.config = config;
    this.guard = new Guardrails(config.guard);
    this.confirm = new ConfirmationStore(config.confirmTtlMs);
    this._ready = null;
  }

  ready() {
    return (this._ready ??= this._init().catch((e) => {
      this._ready = null;
      throw e;
    }));
  }

  async _init() {
    const d = await loadDeployment(this.config.deployment);
    const rpcUrl = this.config.rpcUrl || d.rpcUrl || "https://rpc.testnet.arc.io";
    const chainId = Number(d.chainId ?? 5042002);
    this.chain = defineChain({ id: chainId, name: `chain ${chainId}`, nativeCurrency: { name: "USDC", symbol: "USDC", decimals: 18 }, rpcUrls: { default: { http: [rpcUrl] } } });
    const rpcs = [rpcUrl, ...(chainId === 5042002 ? ["https://rpc.testnet.arc.io", "https://rpc.quicknode.testnet.arc.io", "https://rpc.drpc.testnet.arc.io"] : [])];
    this.transport = fallback([...new Set(rpcs)].map((u) => http(u, { retryCount: 1, timeout: 20_000 })), { rank: false });
    this.pub = createPublicClient({ chain: this.chain, transport: this.transport, pollingInterval: 500 });
    this.d = {
      engine: d.engine, lens: d.lens, vault: d.vault, token: d.token, usdc: d.usdc, factory: d.agentFactory ?? null,
      collateralIsTest: d.collateral ? d.collateral === "test" : d.collateralIsTest ?? true,
      explorer: d.explorerUrl ?? "https://explorer.testnet.arc.io", app: d.appUrl ?? null, chainId,
    };
    for (const k of ["engine", "lens", "usdc"]) if (!/^0x[0-9a-fA-F]{40}$/.test(this.d[k] || "")) throw new ToolError("CONFIG_ERROR", `deployment is missing ${k}`);
    const c = this.config;
    if (c.agentKey && c.walletKey) throw new ToolError("CONFIG_ERROR", "set DP_AGENT_KEY (with DP_ACCOUNT) or DP_PRIVATE_KEY, not both");
    if (c.agentKey && !c.account) throw new ToolError("CONFIG_ERROR", "DP_AGENT_KEY needs DP_ACCOUNT, the agent account it trades for");
    const pk = c.agentKey ?? c.walletKey;
    this.wallet = pk ? createWalletClient({ chain: this.chain, transport: this.transport, account: privateKeyToAccount(pk) }) : null;
    // The trader the engine sees: the agent account, or the wallet itself in direct mode.
    this.trader = c.account ?? this.wallet?.account.address ?? null;
    if (c.agentKey) {
      const owner = await this.pub.readContract({ address: c.account, abi: agentAccountAbi, functionName: "owner" });
      if (owner.toLowerCase() === this.wallet.account.address.toLowerCase()) {
        throw new ToolError("CONFIG_ERROR", "DP_AGENT_KEY is the account owner's key. Give the agent its own key and approve it with setAgent: the owner key can withdraw.");
      }
    }
    return this;
  }

  get mode() {
    return this.config.agentKey ? "agent-account" : this.config.walletKey ? "wallet" : "read-only";
  }

  async markets() {
    const list = await this.pub.readContract({ address: this.d.lens, abi: engineLensAbi, functionName: "getMarkets" });
    const ref = await this.referencePrices(list).catch(() => new Map());
    const now = Number((await this.pub.getBlock()).timestamp);
    return list.map((v) => {
      const m = v.market;
      const settled = m.settlementPrice !== 0n;
      return {
        id: v.id, symbol: m.symbol, enabled: m.enabled, maxLeverage: Number(m.maxLeverage),
        kind: Number(m.expiry) ? "dated future" : m.quoteFeedId !== ZERO32 ? "cross" : m.invert ? "inverted" : "perpetual",
        expiry: Number(m.expiry) || 0, settled, settlementPrice: settled ? m.settlementPrice : 0n,
        feedId: m.feedId, quoteFeedId: m.quoteFeedId, invert: m.invert,
        longOi: m.longOi, shortOi: m.shortOi, maxOiPerSide: m.maxOiPerSide, fundingRatePerSecond: v.fundingRate,
        onchain: v.hasPrice ? { mid: v.price.mid, bid: v.price.bid, ask: v.price.ask, ageSeconds: now - Number(v.price.publishTime) } : null,
        reference: ref.get(v.id.toLowerCase()) ?? null,
      };
    });
  }

  async market(symbolOrId) {
    const want = String(symbolOrId).toUpperCase();
    const s = want.startsWith("0X") ? want : want.includes("-") ? want : `${want}-USD`;
    const all = await this.markets();
    const m = all.find((x) => x.symbol.toUpperCase() === s || x.id.toUpperCase() === s);
    if (!m) throw new ToolError("UNKNOWN_MARKET", `no market ${symbolOrId}; markets: ${all.map((x) => x.symbol).join(", ")}`);
    return m;
  }

  /** Kraken-derived bid/ask/mid per market, 18 decimals (what the keeper will publish next). */
  async referencePrices(list) {
    const pairs = Object.values(FEEDS).map((p) => p[0]).join(",");
    const r = await fetch(`${this.config.krakenUrl}/0/public/Ticker?pair=${pairs}`, { signal: AbortSignal.timeout(6_000) });
    const j = await r.json();
    const q = (feedId) => {
      const p = FEEDS[feedId.toLowerCase()];
      const t = p && (j.result?.[p[1]] ?? j.result?.[p[0]]);
      return t ? { bid: +t.b[0], ask: +t.a[0] } : null;
    };
    const out = new Map();
    for (const v of list) {
      const m = v.market;
      const a = q(m.feedId);
      if (!a) continue;
      let { bid, ask } = a;
      if (m.quoteFeedId !== ZERO32) {
        const b = q(m.quoteFeedId);
        if (!b) continue;
        [bid, ask] = [bid / b.ask, ask / b.bid];
      }
      if (m.invert) [bid, ask] = [1 / ask, 1 / bid];
      const s = (x) => BigInt(Math.round(x * 1e9)) * 10n ** 9n;
      out.set(v.id.toLowerCase(), { bid: s(bid), ask: s(ask), mid: s((bid + ask) / 2) });
    }
    return out;
  }

  /** Price the next fill is expected near: Kraken reference, else the on-chain price. */
  refPrice(m) {
    const p = m.reference ?? m.onchain;
    if (!p) throw new ToolError("NO_PRICE", `${m.symbol} has no reference or on-chain price right now (market closed?)`);
    return p;
  }

  requireTrading() {
    if (!this.wallet) throw new ToolError("TRADING_DISABLED", "read-only: set DP_ACCOUNT + DP_AGENT_KEY (recommended) or DP_PRIVATE_KEY to trade");
  }

  async positions(trader = this.trader) {
    if (!trader) return [];
    return this.pub.readContract({ address: this.d.lens, abi: engineLensAbi, functionName: "getTraderPositions", args: [trader] });
  }

  async orders(trader = this.trader) {
    if (!trader) return [];
    const [ids, list] = await this.pub.readContract({ address: this.d.lens, abi: engineLensAbi, functionName: "getTraderOrders", args: [trader] });
    return list.map((o, i) => ({ id: ids[i], ...o }));
  }

  async balances(trader = this.trader) {
    const [usdc, keg, claimable] = await Promise.all([
      this.pub.readContract({ address: this.d.usdc, abi: testUSDCAbi, functionName: "balanceOf", args: [trader] }),
      this.d.token ? this.pub.readContract({ address: this.d.token, abi: rewardTokenAbi, functionName: "balanceOf", args: [trader] }) : 0n,
      this.pub.readContract({ address: this.d.engine, abi: perpEngineAbi, functionName: "claimable", args: [trader] }),
    ]);
    return { usdc, keg, claimable };
  }

  /** Send a trading call: through the agent account in agent mode, straight to the engine in wallet mode. */
  async trade(functionName, args) {
    this.requireTrading();
    const viaAccount = this.mode === "agent-account";
    const target = viaAccount ? { address: this.config.account, abi: agentAccountAbi } : { address: this.d.engine, abi: perpEngineAbi };
    const errors = [...agentAccountAbi, ...perpEngineAbi].filter((x) => x.type === "error");
    const call = { ...target, abi: [...target.abi, ...errors], functionName, args, account: this.wallet.account };
    const { request, result } = await this.pub.simulateContract(call);
    // The estimate is the least gas that works on the state it ran on; the transaction runs on a later one.
    // By address: with a local account viem estimates twice and caps the second at the first.
    const gas = ((await this.pub.estimateContractGas({ ...call, account: this.wallet.account.address })) * 5n) / 4n + 50_000n;
    const block = await this.pub.getBlock();
    const base = block.baseFeePerGas ?? 20n * 10n ** 9n;
    const tip = 10n ** 9n;
    let maxFeePerGas = base * 2n + tip;
    if (maxFeePerGas < 25n * 10n ** 9n) maxFeePerGas = 25n * 10n ** 9n;
    const hash = await this.wallet.writeContract({ ...request, gas, maxFeePerGas, maxPriorityFeePerGas: tip });
    const receipt = await this.pub.waitForTransactionReceipt({ hash, timeout: 60_000 });
    if (receipt.status !== "success") throw new ToolError("TX_REVERTED", `transaction reverted: ${hash}`);
    return { hash, result, receipt, url: `${this.d.explorer}/tx/${hash}` };
  }

  /** Wallet mode only: make sure the engine may pull `amount` of collateral. */
  async ensureAllowance(amount) {
    if (this.mode !== "wallet") return null;
    const have = await this.pub.readContract({ address: this.d.usdc, abi: testUSDCAbi, functionName: "allowance", args: [this.trader, this.d.engine] });
    if (have >= amount) return null;
    const hash = await this.wallet.writeContract({ address: this.d.usdc, abi: testUSDCAbi, functionName: "approve", args: [this.d.engine, 2n ** 256n - 1n] });
    await this.pub.waitForTransactionReceipt({ hash });
    return hash;
  }

  /** Waits until order `id` leaves the book; reports whether a position now exists. */
  async waitForFill(id, marketId) {
    const until = Date.now() + this.config.fillTimeoutMs;
    while (Date.now() < until) {
      const o = await this.pub.readContract({ address: this.d.engine, abi: perpEngineAbi, functionName: "getOrder", args: [id] });
      if (o.trader === "0x0000000000000000000000000000000000000000") {
        const p = await this.pub.readContract({ address: this.d.engine, abi: perpEngineAbi, functionName: "getPosition", args: [this.trader, marketId] });
        return { status: "done", position: p.trader !== "0x0000000000000000000000000000000000000000" ? p : null };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { status: "resting" };
  }

  orderIdFrom(receipt) {
    const logs = parseEventLogs({ abi: perpEngineAbi, logs: receipt.logs, eventName: "OrderCreated" });
    return logs.length ? logs[logs.length - 1].args.orderId : null;
  }
}

export const toUsd = (x6) => Number(x6) / 1e6;
export const toPx = (x18) => Number((x18 * 10n ** 9n) / E18) / 1e9;
export const fromUsd = (s) => BigInt(Math.round(Number(s) * 1e6));
export const fromPx = (s) => BigInt(Math.round(Number(s) * 1e9)) * 10n ** 9n;
