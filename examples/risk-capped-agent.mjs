// A small trend-following agent that never risks more than a fixed share of its balance on one trade.
//
//   KEY=0x… node risk-capped-agent.mjs                      # trades from its own wallet (testnet)
//   KEY=0x… AGENT_ACCOUNT=0x… node risk-capped-agent.mjs    # trades from an agent account it can't withdraw from
//
// Every position gets a stop. Size follows from the stop distance and the risk budget, and leverage from size and
// margin, so "1000x" happens only when the stop is very tight. That is the point: leverage is an output of risk,
// not an input.
import { DryPowder, fromPrice, fromUsd, pct, usd } from "@dry-powder/sdk";
import { privateKeyToAccount } from "viem/accounts";

const env = process.env;
const MARKET = env.MARKET ?? "BTC-USD";
const RISK_PER_TRADE = Number(env.RISK_PER_TRADE ?? 0.01); // 1% of balance lost if the stop fills
const STOP_DISTANCE = Number(env.STOP_DISTANCE ?? 0.004); // 0.4% from entry
const MAX_LEVERAGE = Number(env.MAX_LEVERAGE ?? 100);
const LOOKBACK = Number(env.LOOKBACK ?? 20); // samples for the moving average
const INTERVAL_MS = Number(env.INTERVAL_SECONDS ?? 15) * 1000;
const RUN_MINUTES = Number(env.RUN_MINUTES ?? 30);

const dp = await DryPowder.connect({ deployment: env.DEPLOYMENT, account: privateKeyToAccount(env.KEY), agentAccount: env.AGENT_ACCOUNT });
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
if (dp.deployment.collateral === "test" && (await dp.balance()) < usd(50)) await dp.faucet(usd(1_000));

const samples = [];
const until = Date.now() + RUN_MINUTES * 60_000;
while (Date.now() < until) {
  const m = await dp.market(MARKET);
  const px = m.price ?? m.lastPrice; // the keeper refreshes on-chain prices on moves, a heartbeat and every fill
  if (px) samples.push(fromPrice(px.mid));
  if (samples.length > LOOKBACK) samples.shift();
  const open = (await dp.positions()).find((p) => p.marketId === m.id);

  if (!open && px && samples.length === LOOKBACK) {
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    const last = samples.at(-1);
    const side = last > avg ? "long" : "short";
    // Risk budget -> size: losing STOP_DISTANCE of size costs RISK_PER_TRADE of balance.
    const balance = fromUsd(await dp.balance());
    const size = (balance * RISK_PER_TRADE) / STOP_DISTANCE;
    const leverage = Math.min(MAX_LEVERAGE, m.maxLeverage, Math.max(1, Math.floor(size / (balance * 0.2))));
    const margin = usd(size / leverage);
    const ref = side === "long" ? px.ask : px.bid;
    const stop = side === "long" ? (ref * BigInt(Math.round((1 - STOP_DISTANCE) * 1e6))) / 1_000_000n : (ref * BigInt(Math.round((1 + STOP_DISTANCE) * 1e6))) / 1_000_000n;
    const q = await dp.quote({ market: MARKET, side, margin, leverage, stopLoss: stop });
    if (q.risk.stopPastLiquidation) {
      log(`skip: at ${leverage}x the stop is past liquidation (${pct(q.risk.liquidationMove)})`);
    } else {
      log(`${side} ${MARKET} ${leverage}x margin ${fromUsd(margin).toFixed(2)}: loss at stop ${fromUsd(q.risk.lossAtStop ?? 0n).toFixed(2)}, most you can lose ${fromUsd(q.risk.maxLoss).toFixed(2)}, liquidated after ${pct(q.risk.liquidationMove)}`);
      const { orderId } = await dp.open({ market: MARKET, side, margin, leverage, stopLoss: stop, slippageBps: 30 });
      log(`order ${orderId}: ${await dp.waitForFill(orderId)}`);
    }
  } else if (open) {
    const avg = samples.reduce((a, b) => a + b, 0) / samples.length;
    const against = open.isLong ? samples.at(-1) < avg : samples.at(-1) > avg;
    if (against) {
      log(`trend turned: closing ${MARKET}`);
      const r = await dp.close(MARKET);
      if (r.orderId) await dp.waitForFill(r.orderId);
    }
  }
  await new Promise((r) => setTimeout(r, INTERVAL_MS));
}
log("done");
