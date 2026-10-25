# @dry-powder/sdk

TypeScript SDK for [Dry Powder](https://0xandersen.github.io/dry-powder/trade/), the open, risk-first perps venue
on Arc (USDC gas). Markets, worst-case quotes, keeper-filled orders up to 5000x on the Turbo markets (no fee
unless you win), stops, good-til-time orders, on-chain strategies, and agent accounts that let a bot trade but
never withdraw. Built on [viem](https://viem.sh). Version 0.4 targets protocol v3.2 deployments.

```bash
npm install @dry-powder/sdk viem      # or, from this repo: cd sdk && npm ci && npm run build
```

## Worst case first

```ts
import { DryPowder, usd, price, pct, fromUsd } from "@dry-powder/sdk";
import { privateKeyToAccount } from "viem/accounts";

const dp = await DryPowder.connect({ account: privateKeyToAccount(process.env.KEY as `0x${string}`) });

const q = await dp.quote({ market: "BTC", side: "long", margin: usd(10), leverage: 1000 });
console.log(`most you can lose ${fromUsd(q.risk.maxLoss)} USDC`);        // margin + fees, never more
console.log(`liquidated after a ${pct(q.risk.liquidationMove)} move`);  // 0.09% at 1000x
console.log(q.risk.level, q.risk.keeperOrdersOnly, q.feeNote);          // "extreme", true, the fees in a line

const { orderId } = await dp.open({ market: "BTC", side: "long", margin: usd(10), leverage: 1000, stopLoss: price(99_960) });
await dp.waitForFill(orderId);
await dp.close("BTC"); // above 100x this is a keeper Close order
```

## Turbo: up to 5000x, no fee unless you win

`BTC-USD-TURBO`, `ETH-USD-TURBO`, `EUR-USD-TURBO` (5000x) and `XAU-USD-TURBO` (2500x) charge nothing to open or
close and fill at the oracle mid. A winning close pays the house a share of its profit (`profitShareBps`, 20%;
19% with a referrer); a loss costs the margin and nothing more. They trade through keeper orders only, which
`open()` and `close()` place.

```ts
const q = await dp.quote({ market: "BTC-TURBO", side: "long", margin: usd(10), leverage: 5000 });
q.feeModel;          // "upside"
q.openFee;           // 0n; q.required is margin + keeper fees
q.risk.maxLoss;      // margin + keeper fees
q.risk.maxProfit;    // 10x margin less the share (q.risk.shareAtCap)
q.risk.liquidationMove; // 0.018%: same liquidation and profit-cap prices as any market at this leverage

// A stop inside the liquidation distance, and an order that cannot fill after 30 s.
const stop = (q.entry * 99_990n) / 100_000n;
const o = await dp.open({ market: "BTC-TURBO", side: "long", margin: usd(10), leverage: 5000, stopLoss: stop, expiresIn: 30 });
```

`settle({ pnl, margin, feeModel })` is the engine's settlement as a pure function (close fee or profit share,
profit cap, referral discount and split).

## Manage a position

```ts
// Add to it: an open on the side you hold merges (entry blended, rounded against you).
const q = await dp.quote({ market: "ETH", side: "long", margin: usd(50), leverage: 20 });
console.log(q.afterFill);                     // size, margin, entry and liquidation price after the addition

await dp.close("ETH", { fraction: 0.5 });     // close half; or { size: usd(400) } for an exact notional
await dp.setStops("ETH", { takeProfit: price(4_200), size: usd(200) }); // scale out: this TP closes 200 only
await dp.addMargin("ETH", usd(25));           // lower leverage; refused while the position is in profit
await dp.maxRemovableMargin("ETH");           // what can come out now (never unrealised profit)
await dp.removeMargin("ETH", usd(10));        // higher leverage, up to min(market max, 100x)

// A ladder of five limit buys from 3,800 down to 3,600 for a day, one transaction from an agent account.
await dp.scale({ market: "ETH", side: "long", totalMargin: usd(100), leverage: 10, from: price(3_800), to: price(3_600), count: 5, expiresIn: 86_400 });
await dp.cancelAll("ETH");
await dp.closeAll();
```

`open()` with `stopEntryPrice` places a breakout order (long: fills once the market is at or above it). Pure
helpers for the same maths: `mergedPosition`, `partialClose`, `ladderPrices`, `removableMargin`.

**Expiry.** `expiresIn` (seconds, chain time) or `expiresAt` on `open()` and `scale()` make an order
good-til-time; `setOrderExpiry(id, at | null)` sets or clears it on any order. An expired order cannot fill:
`expiredOrders()` lists them and `cancelExpired()` cancels them with a full refund. `sweepExpired(ids)` removes
anyone's expired orders and pays the signer their keeper fees.

`market.price` is the oracle price when it is fresh enough to trade on directly; `market.lastPrice` is the last
price on-chain even when older. Quotes and keeper orders use the fresh one if there is one, else the last one
(the keeper always fills at a newer price), or `referencePrice` if you pass your own.

`connect()` with no `deployment` loads the live Arc Testnet deployment from this repository and fails over across
Arc's public RPCs. Pass `deployment` (an object, a path or a URL) for any other one.

## Referrals, claims and DRY rebates

```ts
await dp.setReferrer("0xFriend…");  // once: 5% off every fee (the Turbo share too); they earn 10% of them
await dp.referral();                // { referrer, discountBps, referrerShareBps, claimable }
await dp.claim();                   // referral earnings and any payout the engine could not deliver
await dp.rebates();                 // DRY minted on net losses only: { dry, net, low, lossBeforeRebates, ratePerUsdc }
```

`rebateFor`, `rebateRate`, `rebateBase` and `recordResult` are the token's rebate maths: a close reports at most
1% of its notional, and only a new low in the running result mints DRY.

## The rules the SDK follows (and the engine enforces)

| Rule | Value |
| --- | --- |
| Leverage | BTC, ETH 1000x; SOL, EUR, gold 500x; BTC future 250x; JPY, ETH-BTC 100x; Turbo BTC, ETH, EUR 5000x, gold 2500x |
| Keeper orders | Above 100x and in every Turbo market; they always fill at a price published after the order |
| Liquidation | When losses plus funding reach 90% of margin. You can never lose more than margin plus fees |
| Fees | Standard: 5 bp of size plus a skew surcharge, capped at 10% of margin per side. Turbo: none; a share of a win |
| Profit cap | 10x margin per position |
| Margin out | What stays covers the loss at the exit price plus the initial margin at min(market max, 100x) |

`assessRisk`, `liquidationPrice`, `profitCapPrice`, `needsKeeperOrders`, `feeCap`, `riskLevel` and `settle` are
pure functions with the same maths, for use in loops and backtests without a network.

## Agent accounts

An owner creates an account, funds it and approves an agent key with an on-chain policy (expiry, max leverage,
max margin per order, and a daily margin budget). The agent can trade from it; only the owner can withdraw.

```ts
import { parseEther } from "viem"; // gas is native USDC, 18 decimals

const owner = await DryPowder.connect({ account: ownerKey });
// One transaction: the account, the agent's policy and 0.5 USDC of gas for the agent key.
const account = await owner.createAgentAccountWithAgent(agentKey.address, {
  expiresInSeconds: 86_400, maxLeverage: 50, maxMarginPerOrder: usd(100), gas: parseEther("0.5"),
});
await owner.setAgentBudget(account, agentKey.address, usd(300)); // at most 300 of margin per UTC day

const agent = await DryPowder.connect({ account: agentKey, agentAccount: account });
await agent.open({ market: "ETH", side: "short", margin: usd(20), leverage: 25, stopLoss: price(3_900) });
await agent.agentBudget(account, agentKey.address); // { perDay, spentToday, remainingToday }
```

`approveAgent(account, key, policy)` approves more keys or changes a policy (with `dailyBudget`, in the same
transaction); `revokeAgent` removes one at once. The margin cap applies per call and the budget per day; margin
coming back from closes does not refill the budget, so it bounds what an agent can lose in a day.

### Strategies

The Strategies contract runs trend, mean-reversion and copy agents on-chain for an agent account: anyone (the
venue's keeper) pokes it, it samples the engine's price at its interval and places one keeper order at a time
through the account, inside the account's policy for it.

```ts
// Owner: let Strategies trade, at most 10 margin and 100x per order and 50 margin a day across its strategies.
await owner.approveStrategies(account, { expiresInSeconds: 7 * 86_400, maxLeverage: 100, maxMarginPerOrder: usd(10), dailyBudget: usd(50) });

// Owner or agent: a 12/26 EMA trend on BTC Turbo, sampled every 5 minutes, 0.5% stop on each entry.
const { id } = await agent.createStrategy({ kind: "trend", market: "BTC-TURBO", margin: usd(10), leverage: 100, interval: 300, fastPeriod: 12, slowPeriod: 26, stopLossBps: 50 });
// Or copy a trader at half size, at most 2,000 notional:
// { kind: "copy", market: "ETH-USD", leader: "0x…", ratioBps: 5_000, maxSize: usd(2_000), margin: usd(20), leverage: 10, interval: 60 }

await agent.strategies();                     // each with its spec, status, target, holding and pending order
await agent.pauseStrategy(id); await agent.resumeStrategy(id); await agent.stopStrategy(id);
```

`createStrategy` checks every rule the contract does (`validateStrategy`), the account's approval of
Strategies, the caller's own caps and that the market is free, before it sends anything.

### Registry and prizes

```ts
await owner.registerAgent(account, { name: "Turbo trend", kind: "trend", description: "12/26 EMA, BTC Turbo" });
await dp.agentListings();                     // listed agent accounts: a label for the app, not a permission
await dp.prizeSeason(3); await dp.claimPrize(3, account, amount, proof); // proof from the season's results
```

### Trailing stops and TWAPs (add-ons)

Two contracts beside the engine act on an agent account once the owner approves them as agents; the keeper
pokes them. Their addresses are in the deployment file (`trailingStops`, `twapOrders`) and their ABIs are exported.

```ts
import { maxUint64 } from "viem";
import { agentAccountAbi, trailingStopsAbi, twapOrdersAbi } from "@dry-powder/sdk";

// Trailing stop: the smallest policy (it can only move stops), then a 1% trail on the whole position.
await ownerWallet.writeContract({ address: account, abi: agentAccountAbi, functionName: "setAgent", args: [d.trailingStops, maxUint64, 1, 1n] });
await agentWallet.writeContract({ address: d.trailingStops, abi: trailingStopsAbi, functionName: "setTrail", args: [account, marketId, 100, 0n, 0n] });

// TWAP: approve slices up to 50 margin at 10x until tomorrow, then 6 slices of 50 margin / 500 size, one a
// minute, at most 0.5% past the price. An agent key may only start slices inside its own policy.
await ownerWallet.writeContract({ address: account, abi: agentAccountAbi, functionName: "setAgent", args: [d.twapOrders, BigInt(now + 86_400), 10, usd(50)] });
await agentWallet.writeContract({ address: d.twapOrders, abi: twapOrdersAbi, functionName: "setTwap", args: [account, marketId, true, usd(50), usd(500), 6, 60, 50] });
```

## Errors

Every revert, and every check the SDK makes before sending, throws a `DryPowderError` whose `code` is the
contract's error name (`OrdersOnly`, `DailyBudgetExceeded`, `NotApproved`, `InsufficientMargin`, …) or an SDK
code (`UNKNOWN_MARKET`, `READ_ONLY`), with `hint` saying what to do. `ERROR_HINTS` lists them.

```ts
try { await agent.open(intent); } catch (e) {
  if (e instanceof DryPowderError && e.code === "DailyBudgetExceeded") waitUntilTomorrow();
}
```

## Units

Sizes and margins are USDC with 6 decimals (`usd(12.5)`); prices have 18 decimals (`price(100_000)`).
`fromUsd`, `fromPrice` and `pct` convert back for display.

## Also here

- `examples/` in the repository root: a Turbo trade with a stop, a strategy launcher, a risk-capped trend agent
  and a swarm runner.
- The generated contract ABIs are exported (`perpEngineAbi`, `engineLensAbi`, `agentAccountAbi`, `strategiesAbi`,
  `agentRegistryAbi`, `prizeDistributorAbi`, ...).
- `test/*.test.mjs` (unit, no network) and `test/smoke.mjs` (against the local stack in
  `frontend/e2e/with-keeper.sh`).
