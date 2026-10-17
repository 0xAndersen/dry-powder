// Dry Powder MCP server: market data, account risk and guarded trading for AI agents.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { agentAccountAbi, perpEngineAbi, testUSDCAbi } from "./abi.mjs";
import { Context, fromPx, fromUsd, loadConfig, toPx, toUsd } from "./context.mjs";
import { ToolError, fingerprint } from "./guard.mjs";

export const SERVER_NAME = "dry-powder";
export const SERVER_VERSION = "0.1.0";
const BPS = 10_000n;
const ZERO = "0x0000000000000000000000000000000000000000";
const LIQ_THRESHOLD = 0.9; // PerpEngine.LIQUIDATION_THRESHOLD_BPS / 10_000

const INSTRUCTIONS = `Dry Powder is a perpetuals venue on Arc (USDC-margined, USDC gas). A house vault takes the other side of
every trade at the oracle price, so there is no order book: any size up to the market's open-interest cap fills
at the oracle bid/ask plus a skew fee.

- Sizes are USDC notional ("sizeUsd": "2500" = $2,500 of exposure); margin = size / leverage. Prices are USD.
- One position per market per trader. Market orders are filled by a keeper at the next oracle price, usually
  within a few seconds; dp_open waits for the fill and reports it.
- Positions are liquidated once losses reach 90% of margin. Profit per position is capped at 10x margin.
- Leverage goes up to 1000x on markets that allow it (each market has its own max). Above 100x a 0.09% move
  liquidates; each side's fee is capped at 10% of margin. The most a trade can lose is its margin plus fees.
- Guardrails: per-order notional cap, max leverage, allowed markets, slippage cap and a price band.
- When confirmation is required, dp_open / dp_limit / dp_close first return a preview and a confirmToken.
  Show the preview to the user and call again with the same arguments plus the token only after approval.
- With an agent account (DP_ACCOUNT + DP_AGENT_KEY) this server can trade but can never withdraw funds.`;

const json = (o) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
const ok = (o) => ({ content: [{ type: "text", text: json(o) }] });
const err = (e) => {
  const code = e instanceof ToolError ? e.code : e?.name === "ContractFunctionExecutionError" ? "REVERTED" : "INTERNAL_ERROR";
  let message = String(e?.shortMessage ?? e?.message ?? e);
  const name = e?.cause?.data?.errorName ?? e?.data?.errorName;
  if (name) message = `${name}: ${message}`;
  return { isError: true, content: [{ type: "text", text: json({ error: { code, message } }) }] };
};

const decimal = (what) => z.string().regex(/^\d+(\.\d+)?$/, `${what} must be a positive decimal string, e.g. "2500"`);
const market = z.string().min(1).describe('Market symbol, e.g. "BTC-USD", "ETH-BTC", "JPY-USD" (a bare "BTC" means BTC-USD)');
const side = z.enum(["long", "short"]);
const slippageBps = z.number().int().min(0).max(5000).optional().describe("Worst fill distance from the reference price, basis points");
const confirmToken = z.string().optional().describe("Token from a preview of exactly the same request");

const fmtMarket = (m) => ({
  symbol: m.symbol,
  kind: m.kind,
  maxLeverage: m.maxLeverage,
  enabled: m.enabled,
  referencePrice: m.reference ? toPx(m.reference.mid) : null,
  onchainPrice: m.onchain ? { bid: toPx(m.onchain.bid), ask: toPx(m.onchain.ask), ageSeconds: m.onchain.ageSeconds } : null,
  fundingPerHourPct: (Number(m.fundingRatePerSecond) / 1e18) * 3600 * 100,
  openInterestUsd: { long: toUsd(m.longOi), short: toUsd(m.shortOi), capPerSide: toUsd(m.maxOiPerSide) },
  ...(m.expiry ? { expiry: new Date(m.expiry * 1000).toISOString(), settled: m.settled, settlementPrice: m.settled ? toPx(m.settlementPrice) : null } : {}),
});

function fmtPosition(v, markets) {
  const p = v.position;
  const m = markets.find((x) => x.id.toLowerCase() === p.priceId.toLowerCase());
  const px = m?.settled ? { mid: m.settlementPrice } : m?.onchain ?? m?.reference;
  let pnl = null;
  if (px) {
    const diff = Number(px.mid - p.entryPrice) / Number(p.entryPrice);
    pnl = (p.isLong ? diff : -diff) * toUsd(p.size) - Number(v.fundingOwed) / 1e6;
  }
  return {
    market: m?.symbol ?? p.priceId, side: p.isLong ? "long" : "short", sizeUsd: toUsd(p.size), marginUsd: toUsd(p.margin),
    leverage: Math.round((Number(p.size) / Number(p.margin)) * 100) / 100, entryPrice: toPx(p.entryPrice),
    markPrice: px ? toPx(px.mid) : null, unrealizedPnlUsd: pnl === null ? null : Math.round(pnl * 100) / 100,
    fundingOwedUsd: Number(v.fundingOwed) / 1e6, liquidationPrice: v.liquidationPrice === 0n ? (p.isLong ? "none" : "now") : toPx(v.liquidationPrice),
    takeProfitOrderId: p.tpOrderId ? String(p.tpOrderId) : null, stopLossOrderId: p.slOrderId ? String(p.slOrderId) : null,
    openedAt: new Date(Number(p.openedAt) * 1000).toISOString(),
  };
}

const TYPES = ["limit open", "take-profit", "stop-loss", "close"];

export function createServer(ctx = new Context(loadConfig())) {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  const tool = (name, description, inputSchema, fn, readOnly) =>
    server.registerTool(name, { description, inputSchema, annotations: { readOnlyHint: !!readOnly, openWorldHint: true } }, async (args) => {
      try {
        await ctx.ready();
        return ok(await fn(args ?? {}));
      } catch (e) {
        return err(e);
      }
    });

  const engineRead = (functionName, args = []) => ctx.pub.readContract({ address: ctx.d.engine, abi: perpEngineAbi, functionName, args });

  // ───────────────────────────── Read ─────────────────────────────

  tool("dp_markets", "All markets: kind, reference (Kraken) and on-chain oracle price, max leverage, funding per hour, open interest; plus the active guardrails.", {}, async () => {
    const ms = await ctx.markets();
    return {
      markets: ms.map(fmtMarket),
      guardrails: { allowedMarkets: ctx.config.guard.allowedMarkets ?? "all", maxNotionalUsd: toUsd(ctx.config.guard.maxNotional), maxLeverage: ctx.config.guard.maxLeverage, maxSlippageBps: ctx.config.guard.maxSlippageBps, requireConfirm: ctx.config.requireConfirm },
      mode: ctx.mode, trader: ctx.trader, app: ctx.d.app,
    };
  }, true);

  tool("dp_account", "Balances, open positions (PnL, liquidation price), open orders and, for an agent account, this agent's policy. Defaults to the configured trader.", {
    address: z.string().regex(/^0x[0-9a-fA-F]{40}$/).optional(),
  }, async ({ address }) => {
    const trader = address ?? ctx.trader;
    if (!trader) throw new ToolError("NO_ADDRESS", "pass an address or configure a trading key");
    const [markets, positions, orders, bal] = await Promise.all([ctx.markets(), ctx.positions(trader), ctx.orders(trader), ctx.balances(trader)]);
    const out = {
      trader, mode: address ? "read" : ctx.mode,
      balances: { usdc: toUsd(bal.usdc), dry: Number(bal.keg) / 1e18, claimableUsdc: toUsd(bal.claimable) },
      positions: positions.map((v) => fmtPosition(v, markets)),
      orders: orders.map((o) => ({
        id: String(o.id), market: markets.find((m) => m.id.toLowerCase() === o.priceId.toLowerCase())?.symbol, type: TYPES[o.orderType],
        side: o.isLong ? "long" : "short", triggerPrice: o.triggerPrice === 0n ? null : toPx(o.triggerPrice),
        ...(o.orderType === 0 ? { sizeUsd: toUsd(o.size), marginUsd: toUsd(o.margin) } : {}), createdAt: new Date(Number(o.createdAt) * 1000).toISOString(),
      })),
    };
    if (!address && ctx.mode === "agent-account") {
      const [expiry, maxLeverage, maxMargin] = await ctx.pub.readContract({ address: ctx.config.account, abi: agentAccountAbi, functionName: "agents", args: [ctx.wallet.account.address] });
      out.agentPolicy = { agent: ctx.wallet.account.address, expires: new Date(Number(expiry) * 1000).toISOString(), maxLeverage: Number(maxLeverage), maxMarginUsd: toUsd(maxMargin) };
    }
    return out;
  }, true);

  async function plan({ market: sym, side: s, sizeUsd, leverage, price, takeProfit, stopLoss, slippageBps }) {
    const m = await ctx.market(sym);
    ctx.guard.checkMarket(m);
    const isLong = s === "long";
    const size = fromUsd(sizeUsd);
    ctx.guard.checkNotional(size);
    ctx.guard.checkLeverage(m, leverage);
    const margin = (size * 100n + BigInt(Math.round(leverage * 100)) - 1n) / BigInt(Math.round(leverage * 100));
    const minMargin = await engineRead("minMargin");
    if (margin < minMargin) throw new ToolError("MARGIN_TOO_LOW", `margin $${toUsd(margin)} is below the minimum $${toUsd(minMargin)}: raise sizeUsd or lower leverage`);
    const ref = ctx.refPrice(m);
    let trigger;
    if (price !== undefined) trigger = fromPx(price);
    else {
      const bps = BigInt(slippageBps ?? ctx.config.defaultSlippageBps);
      ctx.guard.checkSlippage(Number(bps));
      trigger = isLong ? (ref.ask * (BPS + bps)) / BPS : (ref.bid * (BPS - bps)) / BPS;
    }
    ctx.guard.checkBand(m, isLong, trigger, ref.mid);
    const tp = takeProfit ? fromPx(takeProfit) : 0n;
    const sl = stopLoss ? fromPx(stopLoss) : 0n;
    const entry = isLong ? ref.ask : ref.bid;
    if (tp && (isLong ? tp <= entry : tp >= entry)) throw new ToolError("INVALID_TAKE_PROFIT", `take-profit must be ${isLong ? "above" : "below"} the entry price (~${toPx(entry)})`);
    if (sl && (isLong ? sl >= entry : sl <= entry)) throw new ToolError("INVALID_STOP_LOSS", `stop-loss must be ${isLong ? "below" : "above"} the entry price (~${toPx(entry)})`);
    if (ctx.trader) {
      const p = await engineRead("getPosition", [ctx.trader, m.id]);
      if (p.trader !== ZERO) throw new ToolError("POSITION_EXISTS", `there is already a ${m.symbol} position; close it first (one position per market)`);
    }
    const [fee, execFee] = await Promise.all([engineRead("quoteOpenFee", [m.id, size, isLong, margin]), engineRead("executionFee")]);
    const loss = LIQ_THRESHOLD * (Number(margin) / Number(size));
    const liq = toPx(entry) * (isLong ? 1 - loss : 1 + loss);
    return {
      m, isLong, size, margin, trigger, tp, sl, fee, execFee,
      preview: {
        market: m.symbol, side: s, sizeUsd: toUsd(size), leverage, marginUsd: toUsd(margin), estimatedEntry: toPx(entry),
        [price !== undefined ? "limitPrice" : "worstFillPrice"]: toPx(trigger), openFeeUsd: toUsd(fee),
        keeperFeesUsd: toUsd(execFee * (1n + (tp ? 1n : 0n) + (sl ? 1n : 0n))), approxLiquidationPrice: Math.round(liq * 1e6) / 1e6,
        liquidationMovePct: Math.round(loss * 1e6) / 1e4,
        maxLossUsd: toUsd(margin + fee * 2n + execFee * (1n + (tp ? 1n : 0n) + (sl ? 1n : 0n))),
        maxProfitUsd: toUsd(margin * 10n),
        takeProfit: tp ? toPx(tp) : null, stopLoss: sl ? toPx(sl) : null,
        notes: price !== undefined ? "Rests until the price is reached; a keeper fills it." : "Keeper-filled market order at the next oracle price.",
      },
    };
  }

  tool("dp_quote", "Preview a trade without placing it: margin, fees, estimated entry and liquidation price.", {
    market, side, sizeUsd: decimal("sizeUsd"), leverage: z.number().min(1).max(1000),
  }, async (a) => (await plan(a)).preview, true);

  async function placeOrder(name, args, wait) {
    ctx.requireTrading();
    const p = await plan(args);
    const fp = fingerprint(args);
    if (ctx.config.requireConfirm && !args.confirmToken) {
      const { token, expiresAt } = ctx.confirm.issue(name, fp, null);
      return { preview: p.preview, confirmToken: token, expiresAt: new Date(expiresAt).toISOString(), next: "Show this to the user; call again with the same arguments and confirmToken to place it." };
    }
    if (ctx.config.requireConfirm) ctx.confirm.consume(args.confirmToken, name, fp);
    await ctx.ensureAllowance(p.margin + p.fee * 2n + p.execFee * 3n);
    const tx = await ctx.trade("createLimitOrder", [{ priceId: p.m.id, isLong: p.isLong, margin: p.margin, size: p.size, triggerPrice: p.trigger, takeProfit: p.tp, stopLoss: p.sl }]);
    const orderId = ctx.orderIdFrom(tx.receipt) ?? tx.result;
    const out = { orderId: String(orderId), tx: tx.url, preview: p.preview };
    if (!wait) return { ...out, status: "resting" };
    const r = await ctx.waitForFill(orderId, p.m.id);
    if (r.status === "resting") return { ...out, status: "resting", note: "Not filled yet (keeper or price). Check dp_account; cancel with dp_cancel." };
    if (!r.position) return { ...out, status: "gone", note: "The order left the book without opening a position (cancelled or rejected at fill)." };
    return { ...out, status: "filled", entryPrice: toPx(r.position.entryPrice), sizeUsd: toUsd(r.position.size), marginUsd: toUsd(r.position.margin) };
  }

  tool("dp_open", "Open a position with a keeper-filled market order (waits for the fill). Optional take-profit and stop-loss prices.", {
    market, side, sizeUsd: decimal("sizeUsd"), leverage: z.number().min(1).max(1000),
    takeProfit: decimal("takeProfit").optional(), stopLoss: decimal("stopLoss").optional(), slippageBps, confirmToken,
  }, (a) => placeOrder("dp_open", a, true));

  tool("dp_limit", "Place a resting limit order to open a position when price reaches `price` (long: at or below, short: at or above).", {
    market, side, sizeUsd: decimal("sizeUsd"), leverage: z.number().min(1).max(1000), price: decimal("price"),
    takeProfit: decimal("takeProfit").optional(), stopLoss: decimal("stopLoss").optional(), confirmToken,
  }, (a) => placeOrder("dp_limit", a, false));

  tool("dp_close", "Close the position in a market with a keeper-executed close order (waits for it).", { market, slippageBps, confirmToken }, async (args) => {
    ctx.requireTrading();
    const m = await ctx.market(args.market);
    const pos = await engineRead("getPosition", [ctx.trader, m.id]);
    if (pos.trader === ZERO) throw new ToolError("NO_POSITION", `no ${m.symbol} position`);
    let bound = 0n;
    if (!m.settled) {
      const bps = BigInt(args.slippageBps ?? ctx.config.defaultSlippageBps);
      ctx.guard.checkSlippage(Number(bps));
      const ref = ctx.refPrice(m);
      bound = pos.isLong ? (ref.bid * (BPS - bps)) / BPS : (ref.ask * (BPS + bps)) / BPS;
    }
    const preview = { market: m.symbol, side: pos.isLong ? "long" : "short", sizeUsd: toUsd(pos.size), worstPrice: bound ? toPx(bound) : "settlement price" };
    const fp = fingerprint(args);
    if (ctx.config.requireConfirm && !args.confirmToken) {
      const { token, expiresAt } = ctx.confirm.issue("dp_close", fp, null);
      return { preview, confirmToken: token, expiresAt: new Date(expiresAt).toISOString() };
    }
    if (ctx.config.requireConfirm) ctx.confirm.consume(args.confirmToken, "dp_close", fp);
    const before = (await ctx.balances()).usdc;
    const tx = await ctx.trade("setTriggerOrder", [m.id, 3, bound]);
    const until = Date.now() + ctx.config.fillTimeoutMs;
    while (Date.now() < until) {
      const p = await engineRead("getPosition", [ctx.trader, m.id]);
      if (p.trader === ZERO) {
        const after = (await ctx.balances()).usdc;
        return { status: "closed", tx: tx.url, returnedUsd: toUsd(after - before), note: "returnedUsd is margin plus PnL minus fees, as credited back" };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { status: "pending", tx: tx.url, note: "Close order placed; the keeper fills it at the next price within the bound." };
  });

  tool("dp_set_tpsl", "Set or move the take-profit and/or stop-loss of an open position (keeper-executed).", {
    market, takeProfit: decimal("takeProfit").optional(), stopLoss: decimal("stopLoss").optional(),
  }, async ({ market: sym, takeProfit, stopLoss }) => {
    ctx.requireTrading();
    if (!takeProfit && !stopLoss) throw new ToolError("NOTHING_TO_SET", "pass takeProfit and/or stopLoss");
    const m = await ctx.market(sym);
    const out = {};
    if (takeProfit) out.takeProfit = (await ctx.trade("setTriggerOrder", [m.id, 1, fromPx(takeProfit)])).url;
    if (stopLoss) out.stopLoss = (await ctx.trade("setTriggerOrder", [m.id, 2, fromPx(stopLoss)])).url;
    return { market: m.symbol, ...out };
  });

  tool("dp_cancel", "Cancel an open order by id (escrow is refunded to the trader).", { orderId: z.string().regex(/^\d+$/) }, async ({ orderId }) => {
    const tx = await ctx.trade("cancelOrder", [BigInt(orderId)]);
    return { cancelled: orderId, tx: tx.url };
  });

  tool("dp_faucet", "Testnet only: mint test collateral (tUSDC) to the trader. Gas is native USDC from https://faucet.circle.com.", {
    amountUsd: decimal("amountUsd").optional(),
  }, async ({ amountUsd }) => {
    ctx.requireTrading();
    if (!ctx.d.collateralIsTest) throw new ToolError("NOT_TESTNET", "this deployment uses real USDC collateral");
    const amount = fromUsd(amountUsd ?? "10000");
    const hash = await ctx.wallet.writeContract({ address: ctx.d.usdc, abi: testUSDCAbi, functionName: "mint", args: [ctx.trader, amount] });
    await ctx.pub.waitForTransactionReceipt({ hash });
    return { minted: toUsd(amount), to: ctx.trader, tx: `${ctx.d.explorer}/tx/${hash}` };
  });

  return server;
}
