// Dry Powder MCP server: market data, account risk and guarded trading for AI agents.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { encodeFunctionData } from "viem";
import { z } from "zod";
import { agentAccountAbi, agentRegistryAbi, strategiesAbi, testUSDCAbi } from "./abi.mjs";
import { Context, ZERO, fromPx, fromUsd, loadConfig, toPx, toUsd } from "./context.mjs";
import { ToolError, fingerprint } from "./guard.mjs";
import { ERROR_HINTS, describeStrategy, effectiveShareBps, liquidationPrice, marginFor, pricePnl, removableMargin, settle, strategyConfig, validateStrategy } from "./math.mjs";

export const SERVER_NAME = "dry-powder";
export const SERVER_VERSION = "0.2.0";
const BPS = 10_000n;

const INSTRUCTIONS = `Dry Powder is a perpetuals venue on Arc (USDC-margined, USDC gas). A house vault takes the other side of
every trade at the oracle price, so there is no order book: any size up to the market's open-interest cap fills.

- Sizes are USDC notional ("sizeUsd": "2500" = $2,500 of exposure); margin = size / leverage. Prices are USD.
- One position per market per trader. Orders are filled by a keeper at the next oracle price, usually within a
  few seconds; dp_open waits for the fill and reports it. With expiresInSeconds an order cannot fill after that.
- Two fee models. Standard markets charge a fee on notional at open and at close (each capped at 10% of margin)
  and fill at the bid/ask. Turbo markets (BTC-USD-TURBO, ETH-USD-TURBO, EUR-USD-TURBO up to 5000x, XAU-USD-TURBO
  2500x) charge no fee unless you win: nothing to open or close, fills at the mid, and a winning close pays the
  house a share of its profit (20%, 19% with a referrer). Always tell the user that share.
- Positions are liquidated once losses reach 90% of margin (a 0.09% move at 1000x, 0.018% at 5000x). Profit per
  position is capped at 10x margin. The most a trade can lose is its margin plus fees.
- Guardrails: per-order notional cap, max leverage, allowed markets, slippage cap and a price band. Strategies
  started here are held to them too.
- When confirmation is required, state-changing tools first return a preview and a confirmToken. Show the
  preview to the user and call again with the same arguments plus the token only after approval.
- With an agent account (DP_ACCOUNT + DP_AGENT_KEY) this server can trade and run strategies within the
  account's on-chain limits (including a daily margin budget) but can never withdraw. Steps only the owner can
  take (approving strategies, budgets, the referrer, registry listings) come back from dp_prepare_owner_tx as an
  unsigned transaction for the owner to sign in their own wallet.`;

const json = (o) => JSON.stringify(o, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2);
const ok = (o) => ({ content: [{ type: "text", text: json(o) }] });
const errorName = (e) => {
  for (let x = e, i = 0; x && i < 10; x = x.cause, i++) if (typeof x.data?.errorName === "string") return x.data.errorName;
  return null;
};
const err = (e) => {
  const code = e instanceof ToolError ? e.code : e?.name === "ContractFunctionExecutionError" ? "REVERTED" : "INTERNAL_ERROR";
  const message = String(e?.shortMessage ?? e?.message ?? e);
  const name = errorName(e);
  const error = { code, message: name ? `${name}: ${message}` : message };
  if (name) {
    error.revert = name;
    if (ERROR_HINTS[name]) error.hint = ERROR_HINTS[name];
  }
  if (e instanceof ToolError && e.details !== undefined) error.details = e.details;
  return { isError: true, content: [{ type: "text", text: json({ error }) }] };
};

const decimal = (what) => z.string().regex(/^\d+(\.\d+)?$/, `${what} must be a positive decimal string, e.g. "2500"`);
const address = z.string().regex(/^0x[0-9a-fA-F]{40}$/, "an 0x address");
const market = z.string().min(1).describe('Market symbol, e.g. "BTC-USD", "BTC-USD-TURBO", "ETH-BTC" (a bare "BTC" means BTC-USD, "BTC-TURBO" BTC-USD-TURBO)');
const side = z.enum(["long", "short"]);
const leverage = z.number().min(1).max(5000);
const slippageBps = z.number().int().min(0).max(5000).optional().describe("Worst fill distance from the reference price, basis points");
const expiresInSeconds = z.number().int().min(5).max(30 * 86_400).optional().describe("Good-til-time: the order cannot fill after this many seconds");
const confirmToken = z.string().optional().describe("Token from a preview of exactly the same request");

const pctOf = (bps) => Number(bps) / 100;
const iso = (t) => (t ? new Date(Number(t) * 1000).toISOString() : null);
const round = (x, dp = 2) => Math.round(x * 10 ** dp) / 10 ** dp;
const minB = (a, b) => (a < b ? a : b);
const maxB = (a, b) => (a > b ? a : b);
const feeText = (m, shareBps) =>
  m.feeModel === "upside"
    ? `No fee unless you win: no fee to open or close, fills at the mid price; a winning close pays ${pctOf(shareBps)}% of its profit to the house. A loss costs the margin and nothing more.`
    : "A fee on notional at open (base plus a skew surcharge) and at close, each capped at 10% of margin; fills at the bid/ask.";

const fmtMarket = (m, fp) => ({
  symbol: m.symbol,
  kind: m.kind,
  feeModel: m.feeModel,
  fees: feeText(m, effectiveShareBps(fp.profitShareBps, fp.referred, fp.discountBps)),
  maxLeverage: m.maxLeverage,
  keeperOrdersOnly: m.feeModel === "upside" ? "always" : m.maxLeverage > 100 ? "above 100x" : "never",
  enabled: m.enabled,
  referencePrice: m.reference ? toPx(m.reference.mid) : null,
  onchainPrice: m.onchain ? { bid: toPx(m.onchain.bid), ask: toPx(m.onchain.ask), ageSeconds: m.onchain.ageSeconds } : null,
  fundingPerHourPct: (Number(m.fundingRatePerSecond) / 1e18) * 3600 * 100,
  openInterestUsd: { long: toUsd(m.longOi), short: toUsd(m.shortOi), capPerSide: toUsd(m.maxOiPerSide) },
  ...(m.expiry ? { expiry: iso(m.expiry), settled: m.settled, settlementPrice: m.settled ? toPx(m.settlementPrice) : null } : {}),
});

const TYPES = ["limit open", "take-profit", "stop-loss", "close", "stop-entry open"];

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

  const engineRead = (functionName, args = []) => ctx.engineRead(functionName, args);
  const strategiesRead = (functionName, args = []) => ctx.pub.readContract({ address: ctx.requireAddress("strategies", "Strategies contract"), abi: strategiesAbi, functionName, args });
  const symbolOf = (markets, id) => markets.find((x) => x.id.toLowerCase() === id.toLowerCase())?.symbol ?? id;

  /** Two-step confirmation: a preview with a token first, the action only with the token for the same arguments. */
  const confirmed = (name, args, preview, extra = {}) => {
    if (!ctx.config.requireConfirm) return null;
    const fp = fingerprint(args);
    if (!args.confirmToken) {
      const { token, expiresAt } = ctx.confirm.issue(name, fp, null);
      return { preview, confirmToken: token, expiresAt: new Date(expiresAt).toISOString(), next: "Show this to the user; call again with the same arguments and confirmToken to go ahead.", ...extra };
    }
    ctx.confirm.consume(args.confirmToken, name, fp);
    return null;
  };

  /** An unsigned transaction for the agent account's owner to sign in their own wallet. */
  const ownerTx = (owner, to, abi, functionName, args, description) => ({
    from: owner, to, data: encodeFunctionData({ abi, functionName, args }), value: "0", chainId: ctx.d.chainId, description,
    note: "Only the owner can send this. Review it, then sign it with the owner's wallet (the app's Agents page, or any wallet that can send calldata). This server never holds the owner key.",
  });
  const approveStrategiesTx = async (account, owner, { maxLeverage: lev, maxMargin, days = 30, dailyBudget }) => {
    const strategies = ctx.requireAddress("strategies", "Strategies contract");
    const expiry = BigInt((await ctx.now()) + days * 86_400);
    const setAgent = encodeFunctionData({ abi: agentAccountAbi, functionName: "setAgent", args: [strategies, expiry, lev, maxMargin] });
    const what = `Let the Strategies contract (${strategies}) trade agent account ${account} for ${days} days: each order at most ${toUsd(maxMargin)} USDC of margin at ${lev}x${dailyBudget !== undefined ? `, at most ${toUsd(dailyBudget)} USDC of margin per UTC day across its strategies` : ""}. It cannot withdraw.`;
    if (dailyBudget === undefined) return ownerTx(owner, account, agentAccountAbi, "setAgent", [strategies, expiry, lev, maxMargin], what);
    const budget = encodeFunctionData({ abi: agentAccountAbi, functionName: "setAgentBudget", args: [strategies, dailyBudget] });
    return ownerTx(owner, account, agentAccountAbi, "multicall", [[setAgent, budget]], what);
  };

  // ───────────────────────────── Read ─────────────────────────────

  tool("dp_markets", "All markets: kind, fee model (Turbo: no fee unless you win, and the share of a win the house keeps), reference (Kraken) and on-chain oracle price, max leverage, funding per hour, open interest; plus the active guardrails.", {}, async () => {
    const [ms, fp] = await Promise.all([ctx.markets(), ctx.feeParams()]);
    return {
      markets: ms.map((m) => fmtMarket(m, fp)),
      guardrails: { allowedMarkets: ctx.config.guard.allowedMarkets ?? "all", maxNotionalUsd: toUsd(ctx.config.guard.maxNotional), maxLeverage: ctx.config.guard.maxLeverage, maxSlippageBps: ctx.config.guard.maxSlippageBps, requireConfirm: ctx.config.requireConfirm },
      mode: ctx.mode, trader: ctx.trader, app: ctx.d.app,
    };
  }, true);

  tool("dp_account", "Balances, open positions (PnL, liquidation price, what closing now would return, margin that can come out), open orders with their expiry, the referrer and, for an agent account, this agent's policy and daily budget. Defaults to the configured trader.", {
    address: address.optional(),
  }, async ({ address: who }) => {
    const trader = who ?? ctx.trader;
    if (!trader) throw new ToolError("NO_ADDRESS", "pass an address or configure a trading key");
    const agentMode = !who && ctx.mode === "agent-account";
    const [markets, positions, orders, bal, fp, minMargin, baseFeeBps, multiple, now, policy] = await Promise.all([
      ctx.markets(), ctx.positions(trader), ctx.orders(trader), ctx.balances(trader), ctx.feeParams(trader), engineRead("minMargin"), engineRead("baseFeeBps"), engineRead("maxProfitMultiple"), ctx.now(),
      agentMode ? ctx.agentPolicy(ctx.config.account, ctx.wallet.account.address) : null,
    ]);
    const out = {
      trader, mode: who ? "read" : ctx.mode,
      balances: { usdc: toUsd(bal.usdc), dry: Number(bal.keg) / 1e18, claimableUsdc: toUsd(bal.claimable) },
      referral: { referrer: fp.referred ? fp.referrer : null, discountPct: fp.referred ? pctOf(fp.discountBps) : 0 },
      positions: positions.map((v) => fmtPosition(v, markets, { fp, minMargin, baseFeeBps, multiple, agentMaxLeverage: policy?.maxLeverage })),
      orders: orders.map((o) => ({
        id: String(o.id), market: symbolOf(markets, o.priceId), type: TYPES[o.orderType],
        side: o.isLong ? "long" : "short", triggerPrice: o.triggerPrice === 0n ? null : toPx(o.triggerPrice),
        ...(o.orderType === 0 || o.orderType === 4 ? { sizeUsd: toUsd(o.size), marginUsd: toUsd(o.margin) } : o.size > 0n ? { closesSizeUsd: toUsd(o.size) } : {}),
        createdAt: iso(o.createdAt), expiresAt: iso(o.expiresAt), ...(Number(o.expiresAt) && now > Number(o.expiresAt) ? { expired: true } : {}),
      })),
    };
    if (policy) {
      out.agentPolicy = {
        agent: ctx.wallet.account.address, expires: iso(policy.expiry), maxLeverage: policy.maxLeverage, maxMarginUsd: toUsd(policy.maxMargin),
        dailyBudgetUsd: policy.perDay === 0n ? "none" : toUsd(policy.perDay), spentTodayUsd: toUsd(policy.spentToday), remainingTodayUsd: policy.remainingToday === null ? "no daily cap" : toUsd(policy.remainingToday),
      };
    }
    return out;
  }, true);

  function fmtPosition(v, markets, { fp, minMargin, baseFeeBps, multiple, agentMaxLeverage }) {
    const p = v.position;
    const m = markets.find((x) => x.id.toLowerCase() === p.priceId.toLowerCase());
    const px = m?.settled ? { mid: m.settlementPrice, bid: m.settlementPrice, ask: m.settlementPrice } : m?.onchain ?? m?.reference;
    const upside = m?.feeModel === "upside";
    let pnl = null;
    let ifClosedNow = null;
    if (px) {
      const diff = Number(px.mid - p.entryPrice) / Number(p.entryPrice);
      pnl = (p.isLong ? diff : -diff) * toUsd(p.size) - Number(v.fundingOwed) / 1e6;
      const exit = upside ? px.mid : p.isLong ? px.bid : px.ask;
      const closeFee = minB((p.size * baseFeeBps + BPS - 1n) / BPS, p.margin / 10n);
      const s = settle({ pnl: pricePnl(p.size, p.entryPrice, exit, p.isLong) - v.fundingOwed, margin: p.margin, upside, closeFee, profitShareBps: fp.profitShareBps, multiple, referred: fp.referred, discountBps: fp.discountBps });
      ifClosedNow = { pnlUsd: toUsd(s.pnl), [upside ? "houseShareUsd" : "closeFeeUsd"]: toUsd(s.fee), returnsUsd: toUsd(s.payout) };
    }
    const exitOnchain = m?.onchain ? (p.isLong ? m.onchain.bid : m.onchain.ask) : null;
    const removable = exitOnchain && m ? removableMargin({ size: p.size, margin: p.margin, entry: p.entryPrice, isLong: p.isLong, exitPrice: exitOnchain, fundingOwed: v.fundingOwed, marketMaxLeverage: m.maxLeverage, minMargin, agentMaxLeverage }) : null;
    return {
      market: m?.symbol ?? p.priceId, feeModel: m?.feeModel, side: p.isLong ? "long" : "short", sizeUsd: toUsd(p.size), marginUsd: toUsd(p.margin),
      leverage: round(Number(p.size) / Number(p.margin)), entryPrice: toPx(p.entryPrice),
      markPrice: px ? toPx(px.mid) : null, unrealizedPnlUsd: pnl === null ? null : round(pnl),
      ifClosedNow, maxRemovableMarginUsd: removable === null ? null : toUsd(removable),
      fundingOwedUsd: Number(v.fundingOwed) / 1e6, liquidationPrice: v.liquidationPrice === 0n ? (p.isLong ? "none" : "now") : toPx(v.liquidationPrice),
      takeProfitOrderId: p.tpOrderId ? String(p.tpOrderId) : null, stopLossOrderId: p.slOrderId ? String(p.slOrderId) : null,
      openedAt: iso(p.openedAt),
    };
  }

  async function plan({ market: sym, side: s, sizeUsd, leverage: lev, price, takeProfit, stopLoss, slippageBps: slip, stopEntry, expiresInSeconds: ttl }) {
    const m = await ctx.market(sym);
    ctx.guard.checkMarket(m);
    const isLong = s === "long";
    const size = fromUsd(sizeUsd);
    ctx.guard.checkNotional(size);
    ctx.guard.checkLeverage(m, lev);
    const margin = marginFor(size, lev);
    const upside = m.feeModel === "upside";
    const [minMargin, fp, execFee, baseFeeBps, maxSkewFeeBps, multiple, now] = await Promise.all([
      engineRead("minMargin"), ctx.feeParams(), engineRead("executionFee"), engineRead("baseFeeBps"), engineRead("maxSkewFeeBps"), engineRead("maxProfitMultiple"), ctx.now(),
    ]);
    if (margin < minMargin) throw new ToolError("MARGIN_TOO_LOW", `margin $${toUsd(margin)} is below the minimum $${toUsd(minMargin)}: raise sizeUsd or lower leverage`);
    const ref = ctx.refPrice(m);
    let trigger;
    if (price !== undefined) trigger = fromPx(price);
    else {
      const bps = BigInt(slip ?? ctx.config.defaultSlippageBps);
      ctx.guard.checkSlippage(Number(bps));
      // From the adverse side of the band, which the keeper checks; a Turbo order still fills at the mid.
      trigger = isLong ? (ref.ask * (BPS + bps)) / BPS : (ref.bid * (BPS - bps)) / BPS;
    }
    ctx.guard.checkBand(m, isLong, trigger, ref.mid);
    const tp = takeProfit ? fromPx(takeProfit) : 0n;
    const sl = stopLoss ? fromPx(stopLoss) : 0n;
    const entry = price !== undefined ? trigger : upside ? ref.mid : isLong ? ref.ask : ref.bid;
    // The engine checks brackets against the order's trigger when it is placed and against the fill when it fills.
    const hi = maxB(entry, trigger);
    const lo = minB(entry, trigger);
    if (tp && (isLong ? tp <= hi : tp >= lo)) throw new ToolError("INVALID_TAKE_PROFIT", `take-profit must be ${isLong ? `above ${toPx(hi)}` : `below ${toPx(lo)}`} (the entry and the order's worst price)`);
    if (sl && (isLong ? sl >= lo : sl <= hi)) throw new ToolError("INVALID_STOP_LOSS", `stop-loss must be ${isLong ? `below ${toPx(lo)}` : `above ${toPx(hi)}`} (the estimated entry)`);
    let adds = null;
    if (ctx.trader) {
      const p = await engineRead("getPosition", [ctx.trader, m.id]);
      // One position per market: an order on the side held adds to it; the engine refuses the other side.
      if (p.trader !== ZERO && p.isLong !== isLong) throw new ToolError("POSITION_EXISTS", `there is a ${p.isLong ? "long" : "short"} ${m.symbol} position; close it (or part of it with dp_close percent) first`);
      if (p.trader !== ZERO) adds = { sizeUsd: toUsd(p.size), marginUsd: toUsd(p.margin), entryPrice: toPx(p.entryPrice) };
    }
    if (stopEntry && price === undefined) throw new ToolError("STOP_PRICE_REQUIRED", "a stop-entry order needs `price`, the breakout level");
    const quoted = await engineRead("quoteOpenFee", [m.id, size, isLong, margin]);
    const disc = (fee) => (fp.referred && fee ? fee - (fee * fp.discountBps) / BPS : fee);
    const openFee = upside ? 0n : disc(quoted);
    const closeFee = upside ? 0n : disc(minB((size * baseFeeBps + BPS - 1n) / BPS, margin / 10n));
    const feeBudget = upside ? 0n : minB((size * (baseFeeBps + maxSkewFeeBps) + BPS - 1n) / BPS, margin / 10n);
    const brackets = (tp ? 1n : 0n) + (sl ? 1n : 0n);
    const keeperFees = execFee * (1n + brackets);
    const shareBps = upside ? effectiveShareBps(fp.profitShareBps, fp.referred, fp.discountBps) : 0n;
    const atCap = settle({ pnl: margin * multiple, margin, upside, closeFee: 0n, profitShareBps: fp.profitShareBps, multiple, referred: fp.referred, discountBps: fp.discountBps });
    const liq = liquidationPrice(entry, margin, size, isLong);
    const liqMove = liq === null ? 0 : liq === 0n ? null : Number(isLong ? entry - liq : liq - entry) / Number(entry);
    const stopPastLiquidation = !!(sl && liq && (isLong ? sl <= liq : sl >= liq));
    const expiresAt = ttl ? now + ttl : 0;
    return {
      m, isLong, size, margin, trigger, tp, sl, execFee, expiresAt, stopEntry: !!stopEntry,
      required: margin + feeBudget + keeperFees,
      preview: {
        market: m.symbol, side: s, sizeUsd: toUsd(size), leverage: lev, marginUsd: toUsd(margin),
        feeModel: m.feeModel, fees: feeText(m, shareBps),
        estimatedEntry: toPx(entry), [price !== undefined ? "limitPrice" : "worstFillPrice"]: toPx(trigger),
        openFeeUsd: toUsd(openFee), closeFeeUsd: toUsd(closeFee),
        ...(upside ? { profitSharePct: pctOf(shareBps), houseShareAtProfitCapUsd: toUsd(atCap.fee) } : {}),
        keeperFeesUsd: toUsd(keeperFees + execFee),
        approxLiquidationPrice: liq ? toPx(liq) : liq === 0n ? "none" : "now", liquidationMovePct: liqMove === null ? null : round(liqMove * 100, 4),
        maxLossUsd: toUsd(margin + openFee + closeFee + keeperFees + execFee),
        maxProfitUsd: toUsd(atCap.payout - margin),
        requiredUsd: toUsd(margin + feeBudget + keeperFees),
        takeProfit: tp ? toPx(tp) : null, stopLoss: sl ? toPx(sl) : null,
        ...(sl ? { lossAtStopUsd: round(Number(-pricePnl(size, entry, sl, isLong)) / 1e6), stopPastLiquidation } : {}),
        expiresAt: iso(expiresAt),
        ...(adds ? { addsToPosition: adds } : {}),
        notes: [
          stopEntry ? `Rests until the market breaks ${isLong ? "up through" : "down through"} the price; a keeper fills it.` : price !== undefined ? "Rests until the price is reached; a keeper fills it." : "Keeper-filled market order at the next oracle price.",
          ...(stopPastLiquidation ? ["The stop-loss is past the liquidation price: liquidation would come first. Move the stop closer or lower the leverage."] : []),
          ...(expiresAt ? [`It cannot fill after ${iso(expiresAt)}.`] : []),
        ].join(" "),
      },
    };
  }

  tool("dp_quote", "Preview a trade without placing it: margin, fees (Turbo: no fee unless you win, and the share of a win the house keeps), estimated entry, liquidation price, most it can lose and make, and a stop's loss.", {
    market, side, sizeUsd: decimal("sizeUsd"), leverage, takeProfit: decimal("takeProfit").optional(), stopLoss: decimal("stopLoss").optional(),
  }, async (a) => (await plan(a)).preview, true);

  async function placeOrder(name, args, wait) {
    ctx.requireTrading();
    const p = await plan(args);
    if (p.preview.stopPastLiquidation) throw new ToolError("STOP_PAST_LIQUIDATION", `the stop-loss is past the liquidation price (~${p.preview.approxLiquidationPrice}): liquidation would come first; move the stop closer or lower the leverage`);
    const pending = confirmed(name, args, p.preview);
    if (pending) return pending;
    await ctx.ensureAllowance(p.required);
    const params = { priceId: p.m.id, isLong: p.isLong, margin: p.margin, size: p.size, triggerPrice: p.trigger, takeProfit: p.tp, stopLoss: p.sl, stopEntry: p.stopEntry };
    const tx = p.expiresAt ? await ctx.trade("createLimitOrderUntil", [params, BigInt(p.expiresAt)]) : await ctx.trade("createLimitOrder", [params]);
    const orderId = ctx.orderIdFrom(tx.receipt) ?? tx.result;
    const out = { orderId: String(orderId), tx: tx.url, preview: p.preview };
    if (!wait) return { ...out, status: "resting" };
    const r = await ctx.waitForFill(orderId, p.m.id, p.expiresAt);
    if (r.status === "resting") {
      if (p.expiresAt && (await ctx.now()) > p.expiresAt) {
        const c = await ctx.trade("cancelOrder", [orderId]);
        return { ...out, status: "expired", cancelTx: c.url, note: "Not filled before its expiry; cancelled and the escrow refunded." };
      }
      return { ...out, status: "resting", note: "Not filled yet (keeper or price). Check dp_account; cancel with dp_cancel." };
    }
    if (!r.position) return { ...out, status: "gone", note: "The order left the book without opening a position (cancelled or rejected at fill)." };
    return { ...out, status: "filled", entryPrice: toPx(r.position.entryPrice), sizeUsd: toUsd(r.position.size), marginUsd: toUsd(r.position.margin) };
  }

  tool("dp_open", "Open a position, or add to the one held on the same side, with a keeper-filled market order (waits for the fill). Optional take-profit and stop-loss prices (on an addition they move the existing ones) and expiresInSeconds (unfilled by then: cancelled). Turbo markets: no fee unless you win.", {
    market, side, sizeUsd: decimal("sizeUsd"), leverage,
    takeProfit: decimal("takeProfit").optional(), stopLoss: decimal("stopLoss").optional(), slippageBps, expiresInSeconds, confirmToken,
  }, (a) => placeOrder("dp_open", a, true));

  tool("dp_limit", "Place a resting order to open (or add to) a position: a limit fills when price reaches `price` (long: at or below, short: at or above); with stopEntry it is a breakout order (long: once the market is at or above `price`, short: at or below). expiresInSeconds makes it good-til-time.", {
    market, side, sizeUsd: decimal("sizeUsd"), leverage, price: decimal("price"),
    takeProfit: decimal("takeProfit").optional(), stopLoss: decimal("stopLoss").optional(), stopEntry: z.boolean().optional(), expiresInSeconds, confirmToken,
  }, (a) => placeOrder("dp_limit", a, false));

  tool("dp_close", "Close the position in a market, or part of it (`percent` 1-100 or `sizeUsd` of notional), with a keeper-executed close order (waits for it). The preview estimates the PnL, the fee (Turbo: the house's share, only on a win) and what comes back. If what would remain is under the minimum margin, everything closes.", {
    market, slippageBps, percent: z.number().gt(0).max(100).optional(), sizeUsd: decimal("sizeUsd").optional(), confirmToken,
  }, async (args) => {
    ctx.requireTrading();
    const m = await ctx.market(args.market);
    const v = (await ctx.positions()).find((x) => x.position.priceId.toLowerCase() === m.id.toLowerCase());
    if (!v) throw new ToolError("NO_POSITION", `no ${m.symbol} position`);
    const pos = v.position;
    if (args.percent !== undefined && args.sizeUsd !== undefined) throw new ToolError("BAD_ARGUMENTS", "pass percent or sizeUsd, not both");
    let closeSize = 0n;
    if (args.sizeUsd !== undefined) closeSize = fromUsd(args.sizeUsd);
    else if (args.percent !== undefined) closeSize = (pos.size * BigInt(Math.round(args.percent * 10_000))) / 1_000_000n;
    if (closeSize >= pos.size) closeSize = 0n;
    const upside = m.feeModel === "upside";
    let bound = 0n;
    let estimate = {};
    if (!m.settled) {
      const bps = BigInt(args.slippageBps ?? ctx.config.defaultSlippageBps);
      ctx.guard.checkSlippage(Number(bps));
      const ref = ctx.refPrice(m);
      bound = pos.isLong ? (ref.bid * (BPS - bps)) / BPS : (ref.ask * (BPS + bps)) / BPS;
      const [fp, baseFeeBps, multiple] = await Promise.all([ctx.feeParams(), engineRead("baseFeeBps"), engineRead("maxProfitMultiple")]);
      const part = closeSize === 0n ? pos.size : closeSize;
      const margin = closeSize === 0n ? pos.margin : (pos.margin * part) / pos.size;
      const exit = upside ? ref.mid : pos.isLong ? ref.bid : ref.ask;
      const s = settle({
        pnl: pricePnl(part, pos.entryPrice, exit, pos.isLong) - (v.fundingOwed * part) / pos.size, margin, upside,
        closeFee: minB((part * baseFeeBps + BPS - 1n) / BPS, margin / 10n), profitShareBps: fp.profitShareBps, multiple, referred: fp.referred, discountBps: fp.discountBps,
      });
      estimate = { estimatedPnlUsd: toUsd(s.pnl), [upside ? "houseShareUsd" : "closeFeeUsd"]: toUsd(s.fee), estimatedReturnUsd: toUsd(s.payout), ...(upside ? { fees: feeText(m, effectiveShareBps(fp.profitShareBps, fp.referred, fp.discountBps)) } : {}) };
    }
    const preview = { market: m.symbol, side: pos.isLong ? "long" : "short", sizeUsd: toUsd(pos.size), closingSizeUsd: closeSize === 0n ? toUsd(pos.size) : toUsd(closeSize), worstPrice: bound ? toPx(bound) : "settlement price", ...estimate };
    const pending = confirmed("dp_close", args, preview);
    if (pending) return pending;
    const before = (await ctx.balances()).usdc;
    const tx = await ctx.trade("setTriggerOrder", [m.id, 3, bound, closeSize]);
    const until = Date.now() + ctx.config.fillTimeoutMs;
    while (Date.now() < until) {
      const p = await engineRead("getPosition", [ctx.trader, m.id]);
      if (p.trader === ZERO || p.size < pos.size) {
        const after = (await ctx.balances()).usdc;
        return {
          status: p.trader === ZERO ? "closed" : "partly closed",
          tx: tx.url,
          returnedUsd: toUsd(after - before),
          ...(p.trader === ZERO ? {} : { remainingSizeUsd: toUsd(p.size), remainingMarginUsd: toUsd(p.margin) }),
          note: "returnedUsd is margin released plus PnL minus fees (Turbo: minus the house's share of a win), as credited back",
        };
      }
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { status: "pending", tx: tx.url, note: "Close order placed; the keeper fills it at the next price within the bound." };
  });

  tool("dp_set_tpsl", "Set or move the take-profit and/or stop-loss of an open position (keeper-executed). With sizeUsd they close only that much notional when they fire. A take-profit must be on the profit side of the current price and a stop on the loss side.", {
    market, takeProfit: decimal("takeProfit").optional(), stopLoss: decimal("stopLoss").optional(), sizeUsd: decimal("sizeUsd").optional(),
  }, async ({ market: sym, takeProfit, stopLoss, sizeUsd }) => {
    ctx.requireTrading();
    if (!takeProfit && !stopLoss) throw new ToolError("NOTHING_TO_SET", "pass takeProfit and/or stopLoss");
    const m = await ctx.market(sym);
    const v = (await ctx.positions()).find((x) => x.position.priceId.toLowerCase() === m.id.toLowerCase());
    if (!v) throw new ToolError("NO_POSITION", `no ${m.symbol} position`);
    const isLong = v.position.isLong;
    // The engine refuses one already through the fresh on-chain mid; the reference price is the next one.
    const mid = (m.onchain ?? ctx.refPrice(m)).mid;
    const tp = takeProfit ? fromPx(takeProfit) : 0n;
    const sl = stopLoss ? fromPx(stopLoss) : 0n;
    if (tp && (isLong ? tp <= mid : tp >= mid)) throw new ToolError("INVALID_TAKE_PROFIT", `a take-profit on a ${isLong ? "long must be above" : "short must be below"} the current price (~${toPx(mid)})`);
    if (sl && (isLong ? sl >= mid : sl <= mid)) throw new ToolError("INVALID_STOP_LOSS", `a stop-loss on a ${isLong ? "long must be below" : "short must be above"} the current price (~${toPx(mid)})`);
    const size = sizeUsd ? fromUsd(sizeUsd) : 0n;
    const out = {};
    if (tp) out.takeProfit = (await ctx.trade("setTriggerOrder", [m.id, 1, tp, size])).url;
    if (sl) out.stopLoss = (await ctx.trade("setTriggerOrder", [m.id, 2, sl, size])).url;
    const liq = v.liquidationPrice;
    if (sl && liq && (isLong ? sl <= liq : sl >= liq)) out.warning = `the stop is past the liquidation price (~${toPx(liq)}): liquidation would come first`;
    return { market: m.symbol, ...(size ? { closesSizeUsd: toUsd(size) } : {}), ...out };
  });

  tool("dp_add_margin", "Add collateral to an open position: lower leverage, liquidation price further away. Refused while the position is in profit (it would lift the profit cap) or below 1x.", {
    market, amountUsd: decimal("amountUsd"), confirmToken,
  }, async (args) => {
    ctx.requireTrading();
    const m = await ctx.market(args.market);
    const pos = await engineRead("getPosition", [ctx.trader, m.id]);
    if (pos.trader === ZERO) throw new ToolError("NO_POSITION", `no ${m.symbol} position`);
    const amount = fromUsd(args.amountUsd);
    ctx.guard.checkNotional(amount);
    const margin = pos.margin + amount;
    if (margin > pos.size) throw new ToolError("LEVERAGE_OUT_OF_RANGE", `that would bring leverage below 1x: at most $${toUsd(pos.size - pos.margin)} can be added`);
    const preview = { market: m.symbol, side: pos.isLong ? "long" : "short", addUsd: toUsd(amount), marginUsd: toUsd(margin), leverageAfter: round(Number(pos.size) / Number(margin)) };
    const pending = confirmed("dp_add_margin", args, preview);
    if (pending) return pending;
    await ctx.ensureAllowance(amount);
    const tx = await ctx.trade("addMargin", [m.id, amount]);
    return { status: "added", tx: tx.url, ...preview };
  });

  tool("dp_remove_margin", "Take collateral out of an open position: higher leverage, liquidation price closer. What stays must cover any loss at the exit price plus the initial margin at min(market max, 100x); unrealised profit never comes out. The leverage after must be within DP_MAX_LEVERAGE (and the agent's own cap).", {
    market, amountUsd: decimal("amountUsd"), confirmToken,
  }, async (args) => {
    ctx.requireTrading();
    const m = await ctx.market(args.market);
    const v = (await ctx.positions()).find((x) => x.position.priceId.toLowerCase() === m.id.toLowerCase());
    if (!v) throw new ToolError("NO_POSITION", `no ${m.symbol} position`);
    const pos = v.position;
    const amount = fromUsd(args.amountUsd);
    if (amount <= 0n || amount >= pos.margin) throw new ToolError("BAD_ARGUMENTS", `amountUsd must be above 0 and below the margin ($${toUsd(pos.margin)})`);
    const after = pos.margin - amount;
    const levAfter = Number(pos.size) / Number(after);
    const cap = Math.min(ctx.config.guard.maxLeverage, m.maxLeverage, 100);
    if (levAfter > cap) throw new ToolError("LEVERAGE_OUT_OF_RANGE", `that leaves ${round(levAfter)}x; at most ${cap}x (DP_MAX_LEVERAGE ${ctx.config.guard.maxLeverage}, market ${m.maxLeverage}x, margin removal stops at 100x)`);
    const [minMargin, policy] = await Promise.all([engineRead("minMargin"), ctx.mode === "agent-account" ? ctx.agentPolicy(ctx.config.account, ctx.wallet.account.address) : null]);
    const px = m.onchain ?? m.reference;
    const max = px ? removableMargin({ size: pos.size, margin: pos.margin, entry: pos.entryPrice, isLong: pos.isLong, exitPrice: pos.isLong ? px.bid : px.ask, fundingOwed: v.fundingOwed, marketMaxLeverage: m.maxLeverage, minMargin, agentMaxLeverage: policy?.maxLeverage }) : null;
    if (max !== null && amount > max) throw new ToolError("REMOVE_TOO_MUCH", `at most $${toUsd(max)} can come out of ${m.symbol} now (the loss at the exit price plus the initial margin stay)`);
    const liq = liquidationPrice(pos.entryPrice, after, pos.size, pos.isLong, v.fundingOwed);
    const preview = { market: m.symbol, side: pos.isLong ? "long" : "short", removeUsd: toUsd(amount), marginUsd: toUsd(after), leverageAfter: round(levAfter), approxLiquidationPriceAfter: liq ? toPx(liq) : liq === 0n ? "none" : "now", maxRemovableUsd: max === null ? null : toUsd(max) };
    const pending = confirmed("dp_remove_margin", args, preview);
    if (pending) return pending;
    // The engine trades on the on-chain price: fresh, and newer than the position's last open or top-up.
    const until = Date.now() + ctx.config.fillTimeoutMs;
    for (let mm = m; !(mm.onchain && mm.onchain.publishTime > Number(pos.openedAt)); mm = await ctx.market(m.id)) {
      if (Date.now() > until) throw new ToolError("PRICE_NOT_READY", "no fresh on-chain price newer than the position's last open yet (the keeper pushes one on a move or within a minute): try again shortly");
      await new Promise((r) => setTimeout(r, 2000));
    }
    const tx = await ctx.trade("removeMargin", [m.id, amount, []]);
    return { status: "removed", tx: tx.url, ...preview };
  });

  tool("dp_order_expiry", "Make one of the trader's orders good-til-time (expiresInSeconds from now), or good until cancelled again (0). After its expiry an order cannot fill; dp_cancel with expired: true refunds every expired order.", {
    orderId: z.string().regex(/^\d+$/), expiresInSeconds: z.number().int().min(0).max(365 * 86_400),
  }, async ({ orderId, expiresInSeconds: ttl }) => {
    ctx.requireTrading();
    const id = BigInt(orderId);
    const owner = await engineRead("orderTrader", [id]);
    if (owner === ZERO) throw new ToolError("ORDER_NOT_FOUND", `no open order ${orderId}`);
    if (owner.toLowerCase() !== ctx.trader.toLowerCase()) throw new ToolError("NOT_YOUR_ORDER", `order ${orderId} belongs to ${owner}`);
    const at = ttl === 0 ? 0 : (await ctx.now()) + ttl;
    const tx = await ctx.trade("setOrderExpiry", [id, BigInt(at)]);
    return { orderId, expiresAt: iso(at) ?? "never", tx: tx.url };
  });

  tool("dp_cancel", "Cancel an open order by id, or with expired: true every order of the trader past its expiry (one transaction from an agent account). Escrow is refunded to the trader.", {
    orderId: z.string().regex(/^\d+$/).optional(), expired: z.boolean().optional(),
  }, async ({ orderId, expired }) => {
    if (!orderId && !expired) throw new ToolError("BAD_ARGUMENTS", "pass orderId, or expired: true");
    if (orderId) {
      const tx = await ctx.trade("cancelOrder", [BigInt(orderId)]);
      return { cancelled: orderId, tx: tx.url };
    }
    const now = await ctx.now();
    const ids = (await ctx.orders()).filter((o) => Number(o.expiresAt) && now > Number(o.expiresAt)).map((o) => o.id);
    if (ids.length === 0) return { cancelled: [], note: "no expired orders" };
    const txs = await ctx.tradeMany(ids.map((id) => ["cancelOrder", [id]]));
    return { cancelled: ids.map(String), tx: txs.map((t) => t.url) };
  });

  // ───────────────────────────── Referrals and claims ─────────────────────────────

  tool("dp_referral", "Referral standing: the trader's referrer (set once with dp_set_referrer), the discount it gives, what a referrer earns, and the USDC the engine holds for the trader (referral earnings plus any undelivered payout), collected with dp_claim.", {
    address: address.optional(),
  }, async ({ address: who }) => {
    const trader = who ?? ctx.trader;
    if (!trader) throw new ToolError("NO_ADDRESS", "pass an address or configure a trading key");
    const [fp, claimable] = await Promise.all([ctx.feeParams(trader), engineRead("claimable", [trader])]);
    return {
      trader, referrer: fp.referred ? fp.referrer : null,
      withReferrer: { feeDiscountPct: pctOf(fp.discountBps), turboProfitSharePct: pctOf(effectiveShareBps(fp.profitShareBps, true, fp.discountBps)), referrerEarnsPctOfFees: pctOf(fp.referralShareBps) },
      claimableUsd: toUsd(claimable),
      note: "claimableUsd holds what this address earned as a referrer (and any payout the engine could not deliver); dp_claim collects it.",
    };
  }, true);

  tool("dp_set_referrer", "Record who referred the trader. Once only, it cannot be changed: from then on every fee, the Turbo profit share included, is 5% lower and the referrer earns 10% of it. For an agent account only its owner can set it; this then returns the owner's transaction to sign.", {
    referrer: address, confirmToken,
  }, async (args) => {
    ctx.requireTrading();
    if (args.referrer.toLowerCase() === ctx.trader.toLowerCase() || args.referrer === ZERO) throw new ToolError("BAD_REFERRER", "the referrer must be another address");
    const fp = await ctx.feeParams();
    if (fp.referred) throw new ToolError("REFERRER_ALREADY_SET", `the referrer is already ${fp.referrer}; it can be set once`);
    if (ctx.mode === "agent-account") {
      return { status: "needs-owner", ownerTx: ownerTx(ctx.owner, ctx.config.account, agentAccountAbi, "setReferrer", [args.referrer], `Record ${args.referrer} as the referrer of agent account ${ctx.config.account} (once; it cannot be changed).`) };
    }
    const preview = { trader: ctx.trader, referrer: args.referrer, effect: `every fee ${pctOf(fp.discountBps)}% lower (Turbo share ${pctOf(effectiveShareBps(fp.profitShareBps, true, fp.discountBps))}%); the referrer earns ${pctOf(fp.referralShareBps)}% of them`, permanent: true };
    const pending = confirmed("dp_set_referrer", args, preview);
    if (pending) return pending;
    const tx = await ctx.trade("setReferrer", [args.referrer]);
    return { status: "set", tx: tx.url, ...preview };
  });

  tool("dp_claim", "Collect the USDC the engine holds for the trader: referral earnings and any payout it could not deliver earlier. From an agent account it lands in the account.", {}, async () => {
    ctx.requireTrading();
    const amount = await engineRead("claimable", [ctx.trader]);
    if (amount === 0n) throw new ToolError("NOTHING_TO_CLAIM", "nothing to claim");
    const tx = await ctx.trade("claim", []);
    return { claimedUsd: toUsd(amount), to: ctx.trader, tx: tx.url };
  });

  // ───────────────────────────── Strategies and the registry ─────────────────────────────

  tool("dp_strategies", "The agent account's strategies (on-chain trend, mean-reversion and copy agents the venue's keeper runs): config, status, signal and working order; plus whether the account lets the Strategies contract trade, its caps and today's budget.", {
    account: address.optional(),
  }, async ({ account: which }) => {
    const strategies = ctx.requireAddress("strategies", "Strategies contract");
    const account = which ?? (await ctx.strategyAccount()).account;
    const [ids, markets, approval] = await Promise.all([strategiesRead("strategiesOf", [account]), ctx.markets(), ctx.agentPolicy(account, strategies)]);
    const list = await Promise.all(ids.map((id) => strategiesRead("getStrategy", [id])));
    return {
      account,
      approval: {
        approved: approval.active, expires: iso(approval.expiry), maxLeveragePerOrder: approval.maxLeverage, maxMarginPerOrderUsd: toUsd(approval.maxMargin),
        dailyBudgetUsd: approval.perDay === 0n ? "none" : toUsd(approval.perDay), spentTodayUsd: toUsd(approval.spentToday), remainingTodayUsd: approval.remainingToday === null ? "no daily cap" : toUsd(approval.remainingToday),
      },
      strategies: list.map((s, i) => describeStrategy(ids[i], s, symbolOf(markets, s.marketId))),
    };
  }, true);

  tool("dp_strategy_create", "Start an on-chain strategy on the agent account in one market: trend (fastPeriod/slowPeriod EMAs, bandBps hysteresis), meanRevert (period EMA, bandBps entry band, exitBps exit band) or copy (leader's position scaled by ratioBps, capped at maxSizeUsd). Each order is marginUsd at leverage, a keeper order through the account; the guardrails apply to every order. The account's owner must have approved the Strategies contract (dp_prepare_owner_tx approve_strategies).", {
    kind: z.enum(["trend", "meanRevert", "copy"]), market,
    marginUsd: decimal("marginUsd").describe("Margin of each entry (trend, meanRevert) or the most margin per order (copy)"),
    leverage: z.number().int().min(1).max(5000), intervalSeconds: z.number().int().min(60).max(86_400).describe("Seconds between samples; also how long an order may wait for its fill"),
    maxSlippageBps: z.number().int().min(1).max(500).optional(), allowShort: z.boolean().optional().describe("false: long only (default true)"),
    stopLossBps: z.number().int().min(0).max(5000).optional(), takeProfitBps: z.number().int().min(0).max(5000).optional(),
    fastPeriod: z.number().int().optional(), slowPeriod: z.number().int().optional(), bandBps: z.number().int().optional(),
    period: z.number().int().optional(), exitBps: z.number().int().optional(),
    leader: address.optional(), ratioBps: z.number().int().optional().describe("Copy size as a share of the leader's: 10000 = the same size"), maxSizeUsd: decimal("maxSizeUsd").optional(),
    confirmToken,
  }, async (a) => {
    ctx.requireTrading();
    const strategies = ctx.requireAddress("strategies", "Strategies contract");
    const { account, owner } = await ctx.strategyAccount();
    const m = await ctx.market(a.market);
    ctx.guard.checkMarket(m);
    ctx.guard.checkLeverage(m, a.leverage);
    const margin = fromUsd(a.marginUsd);
    ctx.guard.checkNotional(margin * BigInt(a.leverage));
    const slip = a.maxSlippageBps ?? ctx.config.defaultSlippageBps;
    ctx.guard.checkSlippage(slip);
    const maxSize = a.maxSizeUsd ? fromUsd(a.maxSizeUsd) : 0n;
    if (a.kind === "copy") ctx.guard.checkNotional(maxSize);
    const config = strategyConfig({ ...a, interval: a.intervalSeconds, margin, maxSlippageBps: slip, maxSize });
    const [minMargin, now, fp] = await Promise.all([engineRead("minMargin"), ctx.now(), ctx.feeParams(account)]);
    const problems = validateStrategy(config, m, minMargin, account, now);
    if (problems.length) throw new ToolError("INVALID_STRATEGY", problems.join("; "));
    // On-chain permissions first: this key's own caps, the account's approval of Strategies, the market free.
    const me = ctx.wallet.account.address;
    if (me.toLowerCase() !== owner.toLowerCase()) {
      const mine = await ctx.agentPolicy(account, me);
      if (!mine.active) throw new ToolError("NOT_AUTHORIZED", "this key is not an active agent of the account");
      if (margin > mine.maxMargin || a.leverage > mine.maxLeverage) throw new ToolError("AGENT_POLICY_EXCEEDED", `this agent's caps are ${mine.maxLeverage}x and $${toUsd(mine.maxMargin)} per order`);
    }
    const acct = { address: account, abi: agentAccountAbi };
    const [approval, restricted, allowed, taken] = await Promise.all([
      ctx.agentPolicy(account, strategies),
      ctx.pub.readContract({ ...acct, functionName: "restrictMarkets" }),
      ctx.pub.readContract({ ...acct, functionName: "marketAllowed", args: [m.id] }),
      strategiesRead("strategyOf", [account, m.id]),
    ]);
    if (!approval.active || margin > approval.maxMargin || a.leverage > approval.maxLeverage) {
      const tx = await approveStrategiesTx(account, owner, { maxLeverage: a.leverage, maxMargin: margin, dailyBudget: margin * 5n });
      throw new ToolError("STRATEGIES_NOT_APPROVED", `the account's owner must first let the Strategies contract trade orders of $${toUsd(margin)} margin at ${a.leverage}x (now: ${approval.active ? `${approval.maxLeverage}x, $${toUsd(approval.maxMargin)} per order` : "not approved"}). Have the owner sign details.ownerTx (adjust with dp_prepare_owner_tx approve_strategies), then call again.`, { ownerTx: tx });
    }
    if (restricted && !allowed) throw new ToolError("MARKET_NOT_ALLOWED", `the account only lets agents trade the markets its owner allowed, and ${m.symbol} is not one of them`);
    if (taken !== 0n) throw new ToolError("MARKET_TAKEN", `strategy ${taken} already runs on ${m.symbol} for this account: stop it first (dp_strategy_control)`);
    if (approval.perDay !== 0n && approval.perDay < margin) throw new ToolError("BUDGET_TOO_SMALL", `the Strategies daily budget ($${toUsd(approval.perDay)}) is below one order's margin`);
    const preview = {
      account, kind: a.kind, market: m.symbol, feeModel: m.feeModel, fees: feeText(m, effectiveShareBps(fp.profitShareBps, fp.referred, fp.discountBps)),
      marginPerOrderUsd: toUsd(margin), leverage: a.leverage, sizePerOrderUsd: toUsd(margin * BigInt(a.leverage)), intervalSeconds: a.intervalSeconds, maxSlippageBps: slip,
      allowShort: config.allowShort, stopLossBps: config.stopLossBps, takeProfitBps: config.takeProfitBps,
      ...(a.kind === "trend" ? { fastPeriod: config.period, slowPeriod: config.slowPeriod, bandBps: config.bandBps } : a.kind === "meanRevert" ? { period: config.period, bandBps: config.bandBps, exitBps: config.exitBps } : { leader: config.leader, ratioBps: config.ratioBps, maxSizeUsd: toUsd(maxSize) }),
      dailyBudget: approval.perDay === 0n ? "no daily cap" : `$${toUsd(approval.perDay)} of margin per UTC day ($${toUsd(approval.remainingToday ?? 0n)} left today)`,
      notes: "The venue's keeper pokes it; it samples the engine's price each interval and places one keeper order at a time through the account, within the account's caps for it. Three refusals in a row pause it.",
    };
    const pending = confirmed("dp_strategy_create", a, preview);
    if (pending) return pending;
    const tx = await ctx.send(strategies, strategiesAbi, "create", [account, m.id, config]);
    return { status: "created", id: String(ctx.strategyIdFrom(tx.receipt) ?? tx.result), tx: tx.url, preview };
  });

  tool("dp_strategy_control", "Pause, resume or stop a strategy of the agent account. pause: no samples, no orders (an open order of its own is cancelled), effective at once; resume: on again (trend and mean reversion warm up first); stop: for good, freeing its market (its position stays on the account: close it with dp_close if wanted).", {
    id: z.string().regex(/^\d+$/), action: z.enum(["pause", "resume", "stop"]), confirmToken,
  }, async (args) => {
    ctx.requireTrading();
    const strategies = ctx.requireAddress("strategies", "Strategies contract");
    const id = BigInt(args.id);
    const s = await strategiesRead("getStrategy", [id]);
    if (s.account === ZERO) throw new ToolError("NO_STRATEGY", `no strategy ${args.id}`);
    const { account } = await ctx.strategyAccount();
    if (s.account.toLowerCase() !== account.toLowerCase()) throw new ToolError("NOT_YOUR_STRATEGY", `strategy ${args.id} runs on ${s.account}`);
    const markets = await ctx.markets();
    const before = describeStrategy(id, s, symbolOf(markets, s.marketId));
    // Pausing only ever reduces risk, so it needs no confirmation; resuming and stopping do.
    if (args.action !== "pause") {
      const pending = confirmed("dp_strategy_control", args, { id: args.id, action: args.action, kind: before.kind, market: before.market, status: before.status, holding: before.holding });
      if (pending) return pending;
    }
    const tx = await ctx.send(strategies, strategiesAbi, args.action, [id]);
    const after = describeStrategy(id, await strategiesRead("getStrategy", [id]), before.market);
    return { id: args.id, status: after.status, holding: after.holding, tx: tx.url, ...(args.action === "stop" && after.holding !== "flat" ? { note: "Its position stays on the account; close it with dp_close if wanted." } : {}) };
  });

  tool("dp_agents", "Agent accounts listed in the agent registry (name, kind, description, URI, owner), or one account's listing. A listing is a label for the app, not a permission.", {
    account: address.optional(), offset: z.number().int().min(0).optional(), limit: z.number().int().min(1).max(200).optional(),
  }, async ({ account, offset, limit }) => {
    const registry = ctx.requireAddress("registry", "agent registry");
    const fmt = (acct, a) => ({ account: acct, owner: a.owner, name: a.name, kind: a.kind, description: a.description, uri: a.uri || null, registeredAt: iso(a.registeredAt), updatedAt: iso(a.updatedAt) });
    if (account) {
      const a = await ctx.pub.readContract({ address: registry, abi: agentRegistryAbi, functionName: "getAgent", args: [account] });
      return a.owner === ZERO ? { account, listed: false } : { listed: true, ...fmt(account, a) };
    }
    const [count, [accounts, list]] = await Promise.all([
      ctx.pub.readContract({ address: registry, abi: agentRegistryAbi, functionName: "agentCount" }),
      ctx.pub.readContract({ address: registry, abi: agentRegistryAbi, functionName: "getAgents", args: [BigInt(offset ?? 0), BigInt(limit ?? 50)] }),
    ]);
    return { total: Number(count), agents: accounts.map((acct, i) => fmt(acct, list[i])) };
  }, true);

  tool("dp_prepare_owner_tx", "Prepare, never send, a transaction only the agent account's owner can make, for the owner to review and sign in their own wallet: approve_strategies (let the Strategies contract trade the account: maxLeverage and maxMarginUsd per order, dailyBudgetUsd per UTC day, for `days`), revoke_strategies, set_agent_budget (an agent's daily margin budget; default this server's key; 0 = no cap), set_referrer, register_agent / update_agent (name, kind, description, uri) and unregister_agent in the agent registry.", {
    action: z.enum(["approve_strategies", "revoke_strategies", "set_agent_budget", "set_referrer", "register_agent", "update_agent", "unregister_agent"]),
    maxLeverage: z.number().int().min(1).max(5000).optional(), maxMarginUsd: decimal("maxMarginUsd").optional(), dailyBudgetUsd: decimal("dailyBudgetUsd").optional(),
    days: z.number().int().min(1).max(365).optional(), agent: address.optional(), referrer: address.optional(),
    name: z.string().optional(), kind: z.string().optional(), description: z.string().optional(), uri: z.string().optional(),
  }, async (a) => {
    const { account, owner } = await ctx.strategyAccount();
    const need = (k) => {
      if (a[k] === undefined || a[k] === "") throw new ToolError("BAD_ARGUMENTS", `${a.action} needs ${k}`);
      return a[k];
    };
    const listing = () => {
      const bytes = (s) => Buffer.byteLength(s ?? "", "utf8");
      const name = need("name");
      const kind = need("kind");
      if (bytes(name) > 48 || bytes(kind) > 32 || bytes(a.description) > 280 || bytes(a.uri) > 256) throw new ToolError("INVALID_AGENT", ERROR_HINTS.InvalidAgent);
      return [account, name, a.description ?? "", kind, a.uri ?? ""];
    };
    switch (a.action) {
      case "approve_strategies":
        return approveStrategiesTx(account, owner, { maxLeverage: need("maxLeverage"), maxMargin: fromUsd(need("maxMarginUsd")), days: a.days, dailyBudget: a.dailyBudgetUsd !== undefined ? fromUsd(a.dailyBudgetUsd) : undefined });
      case "revoke_strategies": {
        const strategies = ctx.requireAddress("strategies", "Strategies contract");
        return ownerTx(owner, account, agentAccountAbi, "revokeAgent", [strategies], `Stop the Strategies contract (${strategies}) from trading agent account ${account} at once (its strategies' orders are refused from then on).`);
      }
      case "set_agent_budget": {
        const agent = a.agent ?? ctx.wallet?.account.address;
        if (!agent) throw new ToolError("BAD_ARGUMENTS", "set_agent_budget needs agent");
        const perDay = fromUsd(need("dailyBudgetUsd"));
        return ownerTx(owner, account, agentAccountAbi, "setAgentBudget", [agent, perDay], `Let agent ${agent} commit ${perDay === 0n ? "any amount of" : `at most ${toUsd(perDay)} USDC of`} margin per UTC day on agent account ${account}.`);
      }
      case "set_referrer":
        return ownerTx(owner, account, agentAccountAbi, "setReferrer", [need("referrer")], `Record ${a.referrer} as the referrer of agent account ${account} (once; it cannot be changed).`);
      case "register_agent":
      case "update_agent": {
        const registry = ctx.requireAddress("registry", "agent registry");
        const args = listing();
        return ownerTx(owner, registry, agentRegistryAbi, a.action === "register_agent" ? "register" : "update", args, `${a.action === "register_agent" ? "List" : "Update the listing of"} agent account ${account} in the agent registry as "${args[1]}" (${args[3]}).`);
      }
      default: {
        const registry = ctx.requireAddress("registry", "agent registry");
        return ownerTx(owner, registry, agentRegistryAbi, "unregister", [account], `Remove agent account ${account} from the agent registry.`);
      }
    }
  }, true);

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
