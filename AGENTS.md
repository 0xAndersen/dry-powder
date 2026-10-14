# Dry Powder for agents

How an AI agent or bot trades Dry Powder on Arc Testnet. The live addresses are in
[`deployments/arc-testnet.json`](deployments/arc-testnet.json) (written by the deploy workflow); the app is
linked from there (`appUrl`).

## The model in five lines

- A USDC vault takes the other side of every trade at the oracle price (bid for sells, ask for buys) plus a
  skew fee. No order book: any size up to a market's open-interest cap fills.
- Positions are sized in USDC notional; margin = size / leverage; one position per market per trader.
- Liquidation when losses reach 90% of margin; profit per position capped at 10x margin.
- Prices come from a publisher oracle (Kraken tickers, signed) that the keeper pushes when needed; an order you
  place is filled by the keeper against the next price, usually within a few seconds.
- Collateral on testnet is tUSDC (mint it freely); gas is native USDC (https://faucet.circle.com).

## Three ways in

1. **MCP server** (`mcp/`): give Claude or any MCP client tools to read markets and trade, with caps and a
   confirmation step. Best for LLM agents. See `mcp/README.md`.
2. **Agent account** (`AgentAccount`): the owner creates one on the app's Agents page (or calls
   `AgentAccountFactory.createAccount(owner)`), funds it, and calls `setAgent(agent, expiry, maxLeverage,
   maxMargin)`. The agent then calls the account, which forwards to the engine:
   `openPosition`, `createLimitOrder`, `closePosition`, `setTriggerOrder`, `cancelOrder`, `claim`. The agent can
   never withdraw. Best for swarms: one account per strategy, one key per agent, revocable at once.
3. **Direct**: call `PerpEngine` from any wallet. Approve tUSDC to the engine first.

## Orders an agent should use

| Goal | Call | Notes |
| --- | --- | --- |
| Market open | `createLimitOrder({priceId, isLong, margin, size, triggerPrice, takeProfit, stopLoss})` with `triggerPrice` at or through the market (long: ask × 1.005) | Keeper-filled at the next price, never against a stale one |
| Limit open | same, `triggerPrice` away from the market | Long fills at or below, short at or above |
| Close | `setTriggerOrder(marketId, 3, worstPrice)` | `worstPrice` 0 = any price |
| Take-profit / stop-loss | `setTriggerOrder(marketId, 1 or 2, price)` | Calling again moves it for free |
| Cancel | `cancelOrder(id)` | Escrow refunded |

`openPosition` / `closePosition` (no keeper) need an on-chain price at most 30 s old; the keeper keeps prices
fresh within about a minute, and immediately when an order needs one, so the order path above is the reliable one.
Read everything through `EngineLens`: `getMarkets()`, `getTraderPositions(trader)`, `getTraderOrders(trader)`.
Units: USDC amounts 6 decimals, prices 18 decimals.

## Running the venue's keeper

`keeper/` is the publisher + keeper (fills, liquidations, dated-market settlement, vault epochs). Anyone may run
another keeper: execution fees go to whoever executes an order first. See `keeper/.env.example`.
