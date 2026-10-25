// One Turbo trade with a stop: quote it worst case first, place a keeper order that cannot fill after 30 s, hold
// it with its stop for a while, then close.
//
//   KEY=0x… node turbo-stop.mjs                              # from its own wallet (testnet)
//   KEY=0x… AGENT_ACCOUNT=0x… node turbo-stop.mjs            # from an agent account it can't withdraw from
//   MARKET=ETH-TURBO SIDE=short LEVERAGE=1000 STOP_BPS=5 HOLD_SECONDS=60 KEY=0x… node turbo-stop.mjs
//
// Turbo markets charge no fee to open or close and fill at the oracle mid; a winning close pays the house a share
// of its profit, a loss costs the margin and nothing more. BTC and ETH Turbo go to 1000x, the euro to 5000x and gold
// to 2500x. At 5000x a 0.018% move liquidates, so the stop has to sit inside that: the script refuses a stop past
// the liquidation price.
import { DryPowder, DryPowderError, fromPrice, fromUsd, pct, usd } from "@dry-powder/sdk";
import { privateKeyToAccount } from "viem/accounts";

const env = process.env;
const MARKET = env.MARKET ?? "BTC-TURBO";
const SIDE = env.SIDE ?? "long";
const MARGIN = usd(env.MARGIN ?? 10);
const LEVERAGE = Number(env.LEVERAGE ?? 250);
const STOP_BPS = BigInt(env.STOP_BPS ?? 20); // 0.2% from the entry
const TP_BPS = env.TP_BPS ? BigInt(env.TP_BPS) : null;
const HOLD_SECONDS = Number(env.HOLD_SECONDS ?? 120);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

const dp = await DryPowder.connect({ deployment: env.DEPLOYMENT, account: privateKeyToAccount(env.KEY), agentAccount: env.AGENT_ACCOUNT });
if (dp.deployment.collateral === "test" && (await dp.balance()) < usd(50)) await dp.faucet(usd(1_000));
if (env.REFERRER && !(await dp.referral()).referrer) await dp.setReferrer(env.REFERRER); // once: 5% off the share

// 1. Worst case first. The stop and take-profit are measured from the mid, where Turbo orders fill.
const preview = await dp.quote({ market: MARKET, side: SIDE, margin: MARGIN, leverage: LEVERAGE });
const isLong = SIDE === "long";
const away = (bps, against) => (preview.entry * (10_000n + ((isLong === against ? -1n : 1n) * bps))) / 10_000n;
const stopLoss = away(STOP_BPS, true);
const takeProfit = TP_BPS ? away(TP_BPS, false) : undefined;
const q = await dp.quote({ market: MARKET, side: SIDE, margin: MARGIN, leverage: LEVERAGE, stopLoss, takeProfit, expiresIn: 30 });
log(`${q.market.symbol} ${SIDE} ${LEVERAGE}x: size ${fromUsd(q.size)} at ~${fromPrice(q.entry)} (${q.feeModel} fees)`);
log(q.feeNote);
log(`liquidated after a ${pct(q.risk.liquidationMove, 3)} move; stop ${fromPrice(stopLoss)} loses ${fromUsd(-(q.risk.lossAtStop ?? 0n)).toFixed(2)}`);
log(`most you can lose ${fromUsd(q.risk.maxLoss).toFixed(2)}; most you can make ${fromUsd(q.risk.maxProfit).toFixed(2)} after the house's ${q.profitShareBps / 100}%`);
if (q.risk.stopPastLiquidation) {
  log(`refusing: the stop is past the liquidation price ${fromPrice(q.risk.liquidationPrice)}; tighten STOP_BPS or lower LEVERAGE`);
  process.exit(1);
}

// 2. A keeper order with the stop attached on fill; it cannot fill after 30 s.
const before = await dp.balance();
const { orderId, url } = await dp.open({ market: MARKET, side: SIDE, margin: MARGIN, leverage: LEVERAGE, stopLoss, takeProfit, expiresIn: 30 });
log(`order ${orderId} placed: ${url}`);
if ((await dp.waitForFill(orderId, 40_000)) === "resting") {
  // Expired, or the price moved through the stop before the fill (the engine leaves such an order resting).
  await dp.cancel(orderId).catch(() => dp.cancelExpired());
  log("not filled; order cancelled and its escrow refunded");
  process.exit(0);
}
const pos = (await dp.positions()).find((p) => p.marketId === q.market.id);
if (!pos) {
  log(`the order left the book without a position (balance ${fromUsd((await dp.balance()) - before).toFixed(2)})`);
  process.exit(0);
}
log(`filled at ${fromPrice(pos.entryPrice)}; liquidation ${fromPrice(pos.liquidationPrice)}; stop order ${pos.stopLossOrderId}`);

// 3. Hold while the stop guards it; then close with a keeper order (Turbo markets close no other way).
const until = Date.now() + HOLD_SECONDS * 1000;
while (Date.now() < until && (await dp.positions()).some((p) => p.marketId === q.market.id)) await new Promise((r) => setTimeout(r, 5_000));
if ((await dp.positions()).some((p) => p.marketId === q.market.id)) {
  try {
    const c = await dp.close(MARKET);
    if (c.orderId) await dp.waitForFill(c.orderId, 60_000);
  } catch (e) {
    if (!(e instanceof DryPowderError && e.code === "PositionNotFound")) throw e; // the stop got there first
  }
} else log("closed before the hold ended (its stop, take-profit or a liquidation)");
const result = (await dp.balance()) - before;
log(`done: ${result >= 0n ? "+" : ""}${fromUsd(result).toFixed(2)} USDC net (keeper fees included; a win's share already taken)`);
