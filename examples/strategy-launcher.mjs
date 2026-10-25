// Launch an on-chain trend or copy strategy for an agent account, inside a daily margin budget, and watch it.
//
//   OWNER_KEY=0x… node strategy-launcher.mjs                                  # 12/26 EMA trend on BTC-TURBO
//   OWNER_KEY=0x… KIND=copy LEADER=0x… MARKET=ETH-USD node strategy-launcher.mjs
//   OWNER_KEY=0x… AGENT_KEY=0x… REGISTER=1 POKE=1 node strategy-launcher.mjs  # an agent key starts it; listed
//
// The owner's key does the owner-only parts: the agent account (created once), approving the Strategies contract
// with per-order caps and a daily budget (DAILY_BUDGET of margin per UTC day across its strategies; margin coming
// back from closes does not refill it, so it bounds a day's loss), and with REGISTER=1 a listing in the agent
// registry. The strategy itself is started by the owner or, with AGENT_KEY, by an agent inside its own caps.
// Strategies only ever place keeper orders through the account; nothing here can withdraw from it.
import { DryPowder, fromPrice, fromUsd, usd } from "@dry-powder/sdk";
import { parseEther } from "viem";
import { privateKeyToAccount } from "viem/accounts";

const env = process.env;
const KIND = env.KIND ?? "trend";
const MARKET = env.MARKET ?? "BTC-TURBO";
const MARGIN = usd(env.MARGIN ?? 10); // per order
const LEVERAGE = Number(env.LEVERAGE ?? 50);
const DAILY_BUDGET = usd(env.DAILY_BUDGET ?? 50);
const WATCH_MINUTES = Number(env.WATCH_MINUTES ?? 10);
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
if (KIND === "copy" && !env.LEADER) throw new Error("KIND=copy needs LEADER=0x… (the trader to copy)");

const ownerKey = privateKeyToAccount(env.OWNER_KEY);
const owner = await DryPowder.connect({ deployment: env.DEPLOYMENT, account: ownerKey });
const account = await owner.createAgentAccount();
const asOwner = await DryPowder.connect({ deployment: owner.deployment, account: ownerKey, agentAccount: account });
if (owner.deployment.collateral === "test" && (await asOwner.balance()) < usd(100)) await asOwner.faucet(usd(1_000));
log(`agent account ${account}: ${fromUsd(await asOwner.balance())} USDC`);

// 1. Owner: Strategies may trade the account, each order within MARGIN at LEVERAGE, DAILY_BUDGET of margin a day.
await owner.approveStrategies(account, { expiresInSeconds: 30 * 86_400, maxLeverage: LEVERAGE, maxMarginPerOrder: MARGIN, dailyBudget: DAILY_BUDGET });

// 2. Who starts it: the owner, or an agent key with its own caps and budget (and a little gas).
let starter = asOwner;
if (env.AGENT_KEY) {
  const agentKey = privateKeyToAccount(env.AGENT_KEY);
  await owner.approveAgent(account, agentKey.address, { expiresInSeconds: 7 * 86_400, maxLeverage: LEVERAGE, maxMarginPerOrder: MARGIN, dailyBudget: DAILY_BUDGET, gas: parseEther(env.AGENT_GAS ?? "0.1") });
  starter = await DryPowder.connect({ deployment: owner.deployment, account: agentKey, agentAccount: account });
}

// 3. The strategy (checked against every rule the contract applies before anything is sent).
const spec =
  KIND === "copy"
    ? { kind: "copy", market: MARKET, margin: MARGIN, leverage: LEVERAGE, interval: Number(env.INTERVAL_SECONDS ?? 60), leader: env.LEADER, ratioBps: Number(env.RATIO_BPS ?? 5_000), maxSize: usd(env.MAX_SIZE ?? 2_000) }
    : { kind: "trend", market: MARKET, margin: MARGIN, leverage: LEVERAGE, interval: Number(env.INTERVAL_SECONDS ?? 300), fastPeriod: 12, slowPeriod: 26, bandBps: 10, stopLossBps: Number(env.STOP_BPS ?? 50) };
const m = await starter.market(MARKET);
let live = (await starter.strategies()).find((s) => s.marketId === m.id && s.status !== "stopped");
if (live && env.RESTART) {
  await starter.stopStrategy(live.id);
  live = undefined;
}
const id = live?.id ?? (await starter.createStrategy(spec)).id;
log(`strategy ${id}: ${KIND} on ${m.symbol} (${m.feeModel === "upside" ? "Turbo: no fee unless you win" : "standard fees"}), ${fromUsd(MARGIN)} margin x ${LEVERAGE} per order, ${fromUsd(DAILY_BUDGET)} a day`);

// 4. A listing in the registry: a label for the app, not a permission.
if (env.REGISTER && !(await owner.agentListing(account))) {
  await owner.registerAgent(account, { name: env.NAME ?? `${KIND} ${m.symbol}`.slice(0, 48), kind: KIND, description: KIND === "copy" ? `Copies ${env.LEADER} at ${spec.ratioBps / 100}% of its size` : `12/26 EMA trend${spec.stopLossBps ? `, ${spec.stopLossBps / 100}% stop on each entry` : ""}` });
  log("listed in the agent registry");
}

// 5. Watch it, and poke it when it is due (anyone may; the venue's keeper does too).
const until = Date.now() + WATCH_MINUTES * 60_000;
while (Date.now() < until) {
  const s = await starter.strategy(id);
  const b = await owner.agentBudget(account, owner.deployment.strategies);
  const left = b.remainingToday === null ? "no cap" : `${fromUsd(b.remainingToday)} left today`;
  log(`${s.status}: target ${s.target}, holding ${s.holding}, ${s.samples} samples at ${s.lastPrice ? fromPrice(s.lastPrice) : "-"}, ${s.actions} orders${s.pendingOrder ? `, ${s.pendingAction} #${s.pendingOrder} working` : ""}; budget ${left}`);
  if (s.status !== "active") break; // three refusals in a row (budget used up, caps too small, no collateral) pause it
  if (env.POKE && (await starter.strategyDue(id))) await starter.pokeStrategies([id]);
  await new Promise((r) => setTimeout(r, 30_000));
}
if (env.STOP_ON_EXIT) {
  await starter.stopStrategy(id);
  log("stopped; any position it held stays on the account");
}
