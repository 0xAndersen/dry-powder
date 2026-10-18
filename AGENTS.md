# Dry Powder for agents

How an AI agent or bot trades Dry Powder on Arc Testnet. The live addresses are in
[`deployments/arc-testnet.json`](deployments/arc-testnet.json) (written by the deploy workflow); the app is
linked from there (`appUrl`).

## The model in six lines

- A USDC vault takes the other side of every trade at the oracle price (bid for sells, ask for buys) plus a
  skew fee. No order book: any size up to a market's open-interest cap fills.
- Positions are sized in USDC notional; margin = size / leverage; one position per market per trader.
- Leverage up to each market's maximum (BTC and ETH 1000x). Above 100x, open and close only through keeper
  orders (`createLimitOrder`, `setTriggerOrder(…, 3, …)`); `openPosition`/`closePosition` revert with
  `HighLeverageNeedsOrder`.
- Liquidation when losses reach 90% of margin (a 0.09% move at 1000x); profit per position capped at 10x margin;
  fees capped at 10% of margin per side. You can never lose more than margin plus fees.
- Prices come from a publisher oracle (Kraken tickers, signed) that the keeper pushes when needed; an order you
  place is filled by the keeper against the next price, usually within a few seconds.
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
3. **Agent account** (`AgentAccount`): the owner creates one on the app's Agents page (or calls
   `AgentAccountFactory.createAccount(owner)`), funds it, and calls `setAgent(agent, expiry, maxLeverage,
   maxMargin)`. The agent then calls the account, which forwards to the engine:
   `openPosition`, `createLimitOrder`, `closePosition`, `setTriggerOrder`, `cancelOrder`, `claim`. The agent can
   never withdraw. Best for swarms: one account per strategy, one key per agent, revocable at once.
4. **Direct**: call `PerpEngine` from any wallet. Approve tUSDC to the engine first.

## Orders an agent should use

| Goal | Call | Notes |
| --- | --- | --- |
| Market open | `createLimitOrder({priceId, isLong, margin, size, triggerPrice, takeProfit, stopLoss})` with `triggerPrice` at or through the market (long: ask × 1.005) | Keeper-filled at the next price, never against a stale one |
| Limit open | same, `triggerPrice` away from the market | Long fills at or below, short at or above |
| Close | `setTriggerOrder(marketId, 3, worstPrice)` | `worstPrice` 0 = any price |
| Take-profit / stop-loss | `setTriggerOrder(marketId, 1 or 2, price)` | Calling again moves it for free |
| Cancel | `cancelOrder(id)` | Escrow refunded |

`openPosition` / `closePosition` (no keeper, 100x and below) need an on-chain price at most 30 s old; the keeper keeps prices
fresh within about a minute, and immediately when an order needs one, so the order path above is the reliable one.
Read everything through `EngineLens`: `getMarkets()`, `getTraderPositions(trader)`, `getTraderOrders(trader)`.
Units: USDC amounts 6 decimals, prices 18 decimals.

## Running the venue's keeper

`keeper/` is the publisher + keeper (fills, liquidations, dated-market settlement, vault epochs). Anyone may run
another keeper: execution fees go to whoever executes an order first. See `keeper/.env.example`.
