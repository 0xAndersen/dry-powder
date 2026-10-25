# Dry Powder for agents

How an AI agent or bot trades Dry Powder on Arc Testnet (protocol v3.2). The live addresses are in
[`deployments/arc-testnet.json`](deployments/arc-testnet.json) (written by the deploy workflow); the app is
linked from there (`appUrl`). The engine is one address (`engine`); everything else it does runs on it.

## The model in eight lines

- A USDC vault takes the other side of every trade at the oracle price. No order book: any size up to a market's
  open-interest cap and the vault's exposure cap fills.
- Two fee models. Standard markets fill at the bid (sells) or ask (buys) and charge a fee on notional plus a skew
  surcharge at open and at close, each capped at 10% of margin. Turbo markets (`BTC-USD-TURBO`, `ETH-USD-TURBO`,
  `EUR-USD-TURBO` 5000x, `XAU-USD-TURBO` 2500x; `feeMode` 1, Upside) charge no fee unless you win: they fill at
  the mid, nothing to open or close, and a winning close pays the house `profitShareBps` (20%) of its profit.
- Positions are sized in USDC notional; margin = size / leverage; one position per market per trader. An open
  on the side you hold adds to it (entry blended, rounded against you); the other side reverts `PositionExists`.
- Leverage up to each market's maximum (BTC and ETH 1000x, Turbo 5000x). Above 100x, and always in Turbo,
  open and close only through keeper orders (`createLimitOrder`, `setTriggerOrder(…, 3, …, size)`); direct
  `openPosition`/`closePosition` revert `HighLeverageNeedsOrder` (Turbo: `OrdersOnly`).
- Liquidation when losses reach 90% of margin (a 0.09% move at 1000x, 0.018% at 5000x); profit per position
  capped at 10x margin. You can never lose more than margin plus fees.
- Orders can be good-til-time: after `expiresAt` an order cannot fill (`OrderHasExpired`).
- With a referrer every fee (the Turbo share too) is 5% lower and the referrer earns 10% of it. DRY rebates
  pay on net losses only: a close counts for at most 1% of its notional, and only a new low in your running
  result mints DRY.
- Prices come from a publisher oracle (the median of Kraken, Coinbase and Bitstamp, signed) that the keeper
  pushes when needed; a keeper order fills against the next price, usually within a few seconds. Collateral on
  testnet is tUSDC (mint it freely); gas is native USDC (https://faucet.circle.com).

## Before every trade

Compute the worst case and refuse trades that fail it. The SDK's `quote()` returns it; the MCP server's
`dp_quote` previews it:

- `maxLoss`: margin plus fees (Turbo: margin plus keeper fees), the most the trade can cost.
- `liquidationMove`: the price move against you that liquidates it. Keep your stop well inside it.
- `stopPastLiquidation`: true means liquidation comes before your stop. Lower the leverage.
- `maxProfit`: the capped profit, net of the house's share in Turbo; `feeNote` says the fees in a line.

Size from risk, not from leverage: pick the loss you accept at the stop, divide by the stop distance to get size,
then choose margin. `examples/risk-capped-agent.mjs` does exactly this; `examples/turbo-stop.mjs` does it at
Turbo leverage.

## Four ways in

1. **SDK** (`sdk/`, `@dry-powder/sdk`): TypeScript, viem-based. `quote()`, `open()` (with `expiresIn`),
   `close()`, `setStops()`, `removeMargin()`, referrals, agent accounts and budgets, strategies, the registry,
   and the risk and settlement maths as pure functions. Reverts come out as `DryPowderError` with the contract's
   error name as `code`. See `sdk/README.md` and `examples/`.
2. **MCP server** (`mcp/`): tools for Claude or any MCP client to read markets and trade (Turbo, expiry, margin,
   referrals, strategies), with caps and a confirmation step. Owner-only steps come back as unsigned
   transactions for the owner's wallet. Best for LLM agents. See `mcp/README.md`.
3. **Agent account** (`AgentAccount`): the owner creates one on the app's Agents page, or in one transaction
   with `AgentAccountFactory.createAccountWithAgent(agent, expiry, maxLeverage, maxMargin)` (any `msg.value` is
   forwarded to the agent key as gas), then funds it. `setAgent` approves more keys or changes a policy;
   `setAgentBudget(agent, perDay)` caps the margin an agent commits per UTC day (`DailyBudgetExceeded`; closes
   don't refill it). The agent calls the account, which forwards to the engine: `openPosition`,
   `createLimitOrder`, `createLimitOrderUntil`, `setOrderExpiry`, `closePosition`, `setTriggerOrder`,
   `addMargin`, `removeMargin` (within its leverage cap), `cancelOrder`, `claim`, and `multicall(bytes[])` to
   batch any of them atomically. The agent can never withdraw, nor set the account's referrer (owner only).
   Best for swarms: one account per strategy, one key per agent, revocable at once.
4. **Direct**: call the engine from any wallet. Approve tUSDC to it first.

## Orders an agent should use

| Goal | Call | Notes |
| --- | --- | --- |
| Market open | `createLimitOrder({priceId, isLong, margin, size, triggerPrice, takeProfit, stopLoss, stopEntry: false})` with `triggerPrice` through the market (long: ask × 1.005) | Keeper-filled at the next price, never a stale one; Turbo fills at the mid |
| Limit open | same, `triggerPrice` away from the market | Long fills at or below, short at or above |
| Stop entry (breakout) | same, `stopEntry: true` | Long fills once the price is at or above the trigger, short at or below |
| Good-til-time | `createLimitOrderUntil(params, expiresAt)`; `setOrderExpiry(id, expiresAt or 0)` on any order | Cannot fill after `expiresAt`: cancel it for a full refund, or anyone removes it with `cancelExpired(ids)` and earns its keeper fee |
| Add to a position | any open on the same side | Brackets on the addition move the existing TP/SL |
| Close | `setTriggerOrder(marketId, 3, worstPrice, size)` | `worstPrice` 0 = any price; `size` 0 = all |
| Close part | same with `size` in USDC notional | If what remains is under the minimum margin, all of it closes |
| Take-profit / stop-loss | `setTriggerOrder(marketId, 1 or 2, price, size)` | `size` 0 = all; moving it is free; one already through the mid reverts `InvalidTrigger` |
| Add margin | `addMargin(marketId, amount)` (approve first) | Not while in profit; not below 1x |
| Take margin out | `removeMargin(marketId, amount, [])` | What stays covers the loss at the exit price plus the initial margin at min(market max, 100x); profit never comes out; needs a price newer than the last open (`PriceNotAfterOpen`) |
| Cancel | `cancelOrder(id)` | Escrow refunded |
| Several at once | `AgentAccount.multicall([...])` | Atomic: ladders, close all, cancel all |
| Referrer | `setReferrer(referrer)` once; `claim()` collects earnings | 5% off your fees; the referrer earns 10% of them |
| Strategy | approve `Strategies` on the account (`setAgent(strategies, expiry, leverage, margin)`, `setAgentBudget(strategies, perDay)`), then `Strategies.create(account, marketId, config)` | Trend (fast/slow EMA), mean reversion (EMA bands) or copy (a leader's position, scaled, capped); one per account and market; one keeper order at a time; `pause`, `resume`, `stop`. An agent may only start one inside its own caps |
| Trailing stop | approve `TrailingStops` on the account (`setAgent(trailingStops, maxUint64, 1, 1)`), then `TrailingStops.setTrail(account, marketId, distanceBps, size, activation)` | The keeper pokes it; the stop only ever tightens |
| TWAP | approve `TwapOrders` with a policy that covers a slice, then `TwapOrders.setTwap(account, marketId, isLong, sliceMargin, sliceSize, slices, interval, maxSlippageBps)` | 2-100 slices, 30 s to 1 day apart, slippage up to 500 bp; `cancelTwap` stops it |
| List an agent | `AgentRegistry.register(account, name, description, kind, uri)` (owner) | A label for the app, not a permission |

`openPosition` / `closePosition(marketId, size, acceptablePrice, priceUpdate)` (no keeper, Standard markets at
100x and below) need an on-chain price at most 10 s old; the keeper pushes one on a move, on a 60 s heartbeat
and whenever an order needs it, so the order path above is the reliable one. Read everything through `EngineLens`:
`getMarkets()`, `getTraderPositions(trader)`, `getTraderOrders(trader)` (orders carry `expiresAt`).
Units: USDC amounts 6 decimals, prices 18 decimals.

## Running the venue's keeper

`keeper/` is the publisher + keeper (fills, liquidations, dated-market settlement, vault epochs, trailing-stop
moves, TWAP slices and strategy pokes). Anyone may run another keeper: execution fees go to whoever executes an
order first, `cancelExpired` pays the keeper fee of each expired order it removes, and add-on pokes are open to
anyone. Liquidate with `liquidateBatch(keys, priceUpdate)`. See `keeper/.env.example`.

## Venue data without an RPC scan

The keeper workflow publishes per-trader and per-market totals (realised PnL, fees, volume, trades, wins,
liquidations, daily buckets for 60 days) every 5 minutes:
`https://raw.githubusercontent.com/0xAndersen/dry-powder/status/status/stats.json` (built by
`keeper/src/indexer.mjs`; `cursorBlock` says how far it has read). Health of the keeper itself, including its
price sources: `status/keeper.json` on the same branch.
