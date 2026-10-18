# Dry Powder for agents

How an AI agent or bot trades Dry Powder on Arc Testnet. The live addresses are in
[`deployments/arc-testnet.json`](deployments/arc-testnet.json) (written by the deploy workflow); the app is
linked from there (`appUrl`).

## The model in six lines

- A USDC vault takes the other side of every trade at the oracle price (bid for sells, ask for buys) plus a
  skew fee. No order book: any size up to a market's open-interest cap fills.
- Positions are sized in USDC notional; margin = size / leverage; one position per market per trader. An open
  on the side you hold adds to it (entry blended, rounded against you); the other side reverts `PositionExists`.
- Leverage up to each market's maximum (BTC and ETH 1000x). Above 100x, open and close only through keeper
  orders (`createLimitOrder`, `setTriggerOrder(…, 3, …, size)`); `openPosition`/`closePosition` revert with
  `HighLeverageNeedsOrder`.
- Liquidation when losses reach 90% of margin (a 0.09% move at 1000x); profit per position capped at 10x margin;
  fees capped at 10% of margin per side. You can never lose more than margin plus fees.
- Prices come from a publisher oracle (the median of Kraken, Coinbase and Bitstamp, signed) that the keeper
  pushes when needed; an order you place is filled by the keeper against the next price, usually within a few
  seconds.
- Collateral on testnet is tUSDC (mint it freely); gas is native USDC (https://faucet.circle.com).

## Before every trade

Compute the worst case and refuse trades that fail it. The SDK's `quote()` returns it; the MCP server's
`dp_quote` previews it:

- `maxLoss`: margin plus fees, the most the trade can cost.
- `liquidationMove`: the price move against you that liquidates it. Keep your stop well inside it.
- `stopPastLiquidation`: true means liquidation comes before your stop. Lower the leverage.

Size from risk, not from leverage: pick the loss you accept at the stop, divide by the stop distance to get size,
then choose margin. `examples/risk-capped-agent.mjs` does exactly this.

## Four ways in

1. **SDK** (`sdk/`, `@dry-powder/sdk`): TypeScript, viem-based. `DryPowder.connect()`, `quote()`, `open()`,
   `close()`, `setStops()`, agent accounts, and the risk maths as pure functions. See `sdk/README.md` and
   `examples/`.
2. **MCP server** (`mcp/`): give Claude or any MCP client tools to read markets and trade, with caps and a
   confirmation step. Best for LLM agents. See `mcp/README.md`.
3. **Agent account** (`AgentAccount`): the owner creates one on the app's Agents page, or in one transaction
   with `AgentAccountFactory.createAccountWithAgent(agent, expiry, maxLeverage, maxMargin)` (any `msg.value` is
   forwarded to the agent key as gas), then funds it. `setAgent` approves more keys or changes a policy. The
   agent calls the account, which forwards to the engine: `openPosition`, `createLimitOrder`, `closePosition`,
   `setTriggerOrder`, `addMargin`, `cancelOrder`, `claim`, and `multicall(bytes[])` to batch any of them
   atomically. The agent can never withdraw. Best for swarms: one account per strategy, one key per agent,
   revocable at once. The margin cap is per call: an agent can add to a position over several calls.
4. **Direct**: call `PerpEngine` from any wallet. Approve tUSDC to the engine first.

## Orders an agent should use

| Goal | Call | Notes |
| --- | --- | --- |
| Market open | `createLimitOrder({priceId, isLong, margin, size, triggerPrice, takeProfit, stopLoss, stopEntry: false})` with `triggerPrice` at or through the market (long: ask × 1.005) | Keeper-filled at the next price, never against a stale one |
| Limit open | same, `triggerPrice` away from the market | Long fills at or below, short at or above |
| Stop entry (breakout) | same, `stopEntry: true` | Long fills once the ask is at or above the trigger, short once the bid is at or below |
| Add to a position | any open on the same side | Brackets on the addition move the existing TP/SL |
| Close | `setTriggerOrder(marketId, 3, worstPrice, size)` | `worstPrice` 0 = any price; `size` 0 = all |
| Close part | same with `size` in USDC notional | If what remains is under the minimum margin, all of it closes |
| Take-profit / stop-loss | `setTriggerOrder(marketId, 1 or 2, price, size)` | `size` 0 = all; calling again moves it for free |
| Add margin | `addMargin(marketId, amount)` (approve first) | Not while in profit; not below 1x |
| Cancel | `cancelOrder(id)` | Escrow refunded |
| Several at once | `AgentAccount.multicall([...])` | Atomic: ladders, close all, cancel all |
| Trailing stop | approve `TrailingStops` on the account (`setAgent(trailingStops, maxUint64, 1, 1)`), then `TrailingStops.setTrail(account, marketId, distanceBps, size, activation)` | The keeper pokes it; the stop only ever tightens |
| TWAP | approve `TwapOrders` on the account with a policy that covers a slice (`setAgent(twapOrders, expiry, leverage, sliceMargin)`), then `TwapOrders.setTwap(account, marketId, isLong, sliceMargin, sliceSize, slices, interval, maxSlippageBps)` | 2-100 slices, 30 s to 1 day apart, slippage up to 500 bp; the keeper places each slice when due; `cancelTwap` stops it. An agent may only start slices inside its own policy |

`openPosition` / `closePosition(marketId, size, acceptablePrice, priceUpdate)` (no keeper, 100x and below) need an on-chain price at most 30 s old; the keeper keeps prices
fresh within about a minute, and immediately when an order needs one, so the order path above is the reliable one.
Read everything through `EngineLens`: `getMarkets()`, `getTraderPositions(trader)`, `getTraderOrders(trader)`.
Units: USDC amounts 6 decimals, prices 18 decimals.

## Running the venue's keeper

`keeper/` is the publisher + keeper (fills, liquidations, dated-market settlement, vault epochs, trailing-stop
moves and TWAP slices). Anyone may run another keeper: execution fees go to whoever executes an order first, and
add-on pokes are open to anyone. Liquidate with `liquidateBatch(keys,
priceUpdate)`. See `keeper/.env.example`.

## Venue data without an RPC scan

The keeper workflow publishes per-trader and per-market totals (realised PnL, fees, volume, trades, wins,
liquidations, daily buckets for 60 days) every 5 minutes:
`https://raw.githubusercontent.com/0xAndersen/dry-powder/status/status/stats.json` (built by
`keeper/src/indexer.mjs`; `cursorBlock` says how far it has read). Health of the keeper itself, including its
price sources: `status/keeper.json` on the same branch.
