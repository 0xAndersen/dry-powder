# dry-powder-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server (stdio) that lets AI agents read Dry Powder
markets and trade **for one account, with guardrails**. Ported from Project Nexus's MCP server (caps, allowed
markets, price band, two-step confirmation) onto Dry Powder's on-chain engine.

The safe way to run it is with an **agent account**: an `AgentAccount` contract owned by your wallet, holding the
trading funds, with this server's key approved as an agent. The agent key can open, add to, close (all or part),
set TP/SL, add margin and cancel, within an on-chain policy (expiry, max leverage, max margin per call, optional
market list). It can never withdraw, and the server refuses to start if you give it the owner's key. Create and
manage agent accounts on the app's **Agents** page or straight from the contract.

## Tools

Numbers are decimal strings for money and prices (`"2500"`, `"64000.5"`); sizes are USDC notional.

| Tool | What it does | Changes state |
|---|---|---|
| `dp_markets` | Markets: kind (perp, cross, inverted, dated), reference and on-chain price, max leverage, funding/hour, open interest; guardrails in force | no |
| `dp_account {address?}` | Balances (USDC, DRY rebates, claimable), positions with PnL and liquidation price, open orders, the agent's policy | no |
| `dp_quote {market, side, sizeUsd, leverage}` | Margin, fees, estimated entry and liquidation price | no |
| `dp_open {market, side, sizeUsd, leverage, takeProfit?, stopLoss?, slippageBps?, confirmToken?}` | Keeper-filled market order; waits for the fill. On the side already held it adds to the position | **yes** |
| `dp_limit {market, side, sizeUsd, leverage, price, takeProfit?, stopLoss?, stopEntry?, confirmToken?}` | Resting limit order, or with `stopEntry` a breakout (long fills once the market is at or above `price`) | **yes** |
| `dp_close {market, percent?, sizeUsd?, slippageBps?, confirmToken?}` | Keeper-executed close of all or part (`percent` 1-100 or `sizeUsd`) with a worst-price bound; waits for it | **yes** |
| `dp_set_tpsl {market, takeProfit?, stopLoss?, sizeUsd?}` | Set or move take-profit / stop-loss; with `sizeUsd` they close only that much | **yes** |
| `dp_add_margin {market, amountUsd, confirmToken?}` | Add collateral: lower leverage, liquidation further away (not while in profit) | **yes** |
| `dp_cancel {orderId}` | Cancel an order (escrow refunded to the trader) | **yes** |
| `dp_faucet {amountUsd?}` | Testnet: mint test collateral to the trader | **yes** |

With `DP_REQUIRE_CONFIRM=true` (default) the first call to `dp_open`, `dp_limit`, `dp_close` or `dp_add_margin`
returns a preview and a single-use `confirmToken`, valid for 120 s and only for exactly the same arguments.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DP_DEPLOYMENT` | the published Arc Testnet deployment (`deployments/arc-testnet.json` on GitHub) | URL or path of the deployment JSON |
| `DP_RPC_URL` | from the deployment | Arc RPC |
| `DP_ACCOUNT` | – | Agent account address to trade for |
| `DP_AGENT_KEY` | – | Private key of an agent approved on `DP_ACCOUNT` (never the owner's) |
| `DP_PRIVATE_KEY` | – | Alternative: trade straight from this wallet (it can withdraw: prefer an agent account) |
| `DP_MAX_NOTIONAL_USD` | `10000` | Per-order size cap |
| `DP_MAX_LEVERAGE` | `20` | Leverage cap (the market's own max also applies) |
| `DP_ALLOWED_MARKETS` | all | e.g. `BTC-USD,ETH-USD` (`BTC` means `BTC-USD`) |
| `DP_MAX_SLIPPAGE_BPS` | `300` | Largest slippage an agent may request, and the price band for every order |
| `DP_DEFAULT_SLIPPAGE_BPS` | `50` | Market order / close bound when none is given |
| `DP_REQUIRE_CONFIRM` | `true` | Two-step confirmation |
| `DP_FILL_TIMEOUT_SECONDS` | `30` | How long `dp_open` / `dp_close` wait for the keeper |
| `DP_KRAKEN_URL` | `https://api.kraken.com` | Reference prices (what the publisher signs next) |

No key: read-only.

## Run

```bash
cd mcp && npm ci
DP_ACCOUNT=0xYourAgentAccount DP_AGENT_KEY=0xAgentKey node src/index.mjs
```

Claude Desktop (`claude_desktop_config.json`) or any MCP client:

```json
{
  "mcpServers": {
    "dry-powder": {
      "command": "node",
      "args": ["/absolute/path/to/dry-powder/mcp/src/index.mjs"],
      "env": {
        "DP_ACCOUNT": "0xYourAgentAccount",
        "DP_AGENT_KEY": "0xAgentPrivateKey",
        "DP_MAX_NOTIONAL_USD": "2500",
        "DP_ALLOWED_MARKETS": "BTC-USD,ETH-USD"
      }
    }
  }
}
```

Claude Code: `claude mcp add dry-powder --env DP_ACCOUNT=0x… --env DP_AGENT_KEY=0x… -- node /abs/path/mcp/src/index.mjs`

Gas is native USDC on Arc (faucet: https://faucet.circle.com); the agent key needs a little for its transactions.

## Tests

`npm test` (guardrails, confirmation, config). `node test/smoke.mjs` drives every tool through a real MCP client
against the local stack (see `frontend/e2e/with-keeper.sh`): it creates an agent account, trades from it and checks
that the owner key and withdrawals are refused.
