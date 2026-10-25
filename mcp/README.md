# dry-powder-mcp

A [Model Context Protocol](https://modelcontextprotocol.io) server (stdio) that lets AI agents read Dry Powder
markets and trade **for one account, with guardrails**. Ported from Project Nexus's MCP server (caps, allowed
markets, price band, two-step confirmation) onto Dry Powder's on-chain engine; protocol v3.2: Turbo markets (no
fee unless you win, up to 5000x on the euro), good-til-time orders, margin removal, referrals and on-chain strategies.

The safe way to run it is with an **agent account**: an `AgentAccount` contract owned by your wallet, holding the
trading funds, with this server's key approved as an agent. The agent key can open, add to, close (all or part),
set TP/SL, add and take out margin, set order expiries, cancel and start strategies, within an on-chain policy
(expiry, max leverage, max margin per call, a daily margin budget, optional market list). It can never withdraw,
and the server refuses to start if you give it the owner's key. Create and manage agent accounts on the app's
**Agents** page or straight from the contract.

## Tools

Numbers are decimal strings for money and prices (`"2500"`, `"64000.5"`); sizes are USDC notional.

| Tool | What it does | Changes state |
|---|---|---|
| `dp_markets` | Markets: kind, fee model (Turbo: "no fee unless you win" and the share of a win), reference and on-chain price, max leverage, funding/hour, open interest; guardrails in force | no |
| `dp_account {address?}` | Balances (USDC, DRY rebates, claimable), positions with PnL, liquidation price, what closing now returns and the margin that can come out, open orders with expiry, the referrer, the agent's policy and daily budget | no |
| `dp_quote {market, side, sizeUsd, leverage, takeProfit?, stopLoss?}` | Margin, fees (Turbo: no fee to open or close, and the share of a win), estimated entry, liquidation price, most it can lose and make, loss at the stop | no |
| `dp_open {market, side, sizeUsd, leverage, takeProfit?, stopLoss?, slippageBps?, expiresInSeconds?, confirmToken?}` | Keeper-filled market order; waits for the fill (unfilled by its expiry: cancelled). On the side already held it adds to the position | **yes** |
| `dp_limit {market, side, sizeUsd, leverage, price, takeProfit?, stopLoss?, stopEntry?, expiresInSeconds?, confirmToken?}` | Resting limit order, or with `stopEntry` a breakout; good-til-time with `expiresInSeconds` | **yes** |
| `dp_close {market, percent?, sizeUsd?, slippageBps?, confirmToken?}` | Keeper-executed close of all or part with a worst-price bound; the preview estimates PnL, fee or house share, and the return | **yes** |
| `dp_set_tpsl {market, takeProfit?, stopLoss?, sizeUsd?}` | Set or move take-profit / stop-loss (each on the right side of the price); with `sizeUsd` they close only that much | **yes** |
| `dp_add_margin {market, amountUsd, confirmToken?}` | Add collateral: lower leverage, liquidation further away (not while in profit) | **yes** |
| `dp_remove_margin {market, amountUsd, confirmToken?}` | Take collateral out: what stays covers the loss at the exit price plus the initial margin; never profit; leverage after within `DP_MAX_LEVERAGE` | **yes** |
| `dp_order_expiry {orderId, expiresInSeconds}` | Make an order good-til-time, or good until cancelled again (`0`) | **yes** |
| `dp_cancel {orderId?, expired?}` | Cancel an order, or every expired one (escrow refunded to the trader) | **yes** |
| `dp_referral {address?}` | The referrer (set once), the discount it gives, what a referrer earns, the claimable USDC | no |
| `dp_set_referrer {referrer, confirmToken?}` | Record the referrer, once. From an agent account: returns the owner's transaction | **yes** |
| `dp_claim` | Collect referral earnings and undelivered payouts (into the account) | **yes** |
| `dp_strategies {account?}` | The account's strategies (config, status, signal, working order) and the Strategies approval and daily budget | no |
| `dp_strategy_create {kind, market, marginUsd, leverage, intervalSeconds, …, confirmToken?}` | Start a trend (`fastPeriod`, `slowPeriod`, `bandBps`), mean-reversion (`period`, `bandBps`, `exitBps`) or copy (`leader`, `ratioBps`, `maxSizeUsd`) strategy; every rule the contract checks and every guardrail is checked first | **yes** |
| `dp_strategy_control {id, action, confirmToken?}` | `pause` (at once), `resume` or `stop` a strategy | **yes** |
| `dp_agents {account?, offset?, limit?}` | Listings in the agent registry | no |
| `dp_prepare_owner_tx {action, …}` | An unsigned transaction for the owner to sign: `approve_strategies`, `revoke_strategies`, `set_agent_budget`, `set_referrer`, `register_agent`, `update_agent`, `unregister_agent` | no |
| `dp_faucet {amountUsd?}` | Testnet: mint test collateral to the trader | **yes** |

With `DP_REQUIRE_CONFIRM=true` (default) the first call to `dp_open`, `dp_limit`, `dp_close`, `dp_add_margin`,
`dp_remove_margin`, `dp_set_referrer`, `dp_strategy_create` and `dp_strategy_control` (resume, stop) returns a
preview and a single-use `confirmToken`, valid for 120 s and only for exactly the same arguments. Pausing a
strategy needs no confirmation: it only ever reduces risk.

**Turbo markets** (`BTC-USD-TURBO` and `ETH-USD-TURBO` to 1000x, `EUR-USD-TURBO` to 5000x, `XAU-USD-TURBO` to 2500x) charge
no fee unless you win: nothing to open or close, fills at the mid, and a winning close pays the house a share of
its profit (20%; 19% with a referrer). Every quote and preview states the share. At 5000x a 0.018% move
liquidates; a stop past the liquidation price is refused. `DP_MAX_LEVERAGE` (default 20) still caps them: raise
it deliberately.

**Strategies** run on-chain: the venue's keeper pokes them, and each places one keeper order at a time through the
account, inside the account's policy for the Strategies contract. That policy is the owner's to give, so
`dp_strategy_create` returns `STRATEGIES_NOT_APPROVED` with the owner's transaction in `details.ownerTx` until
it is in place (`dp_prepare_owner_tx approve_strategies` sets other caps or a daily budget). Strategies started
here are held to the same guardrails as orders: allowed markets, leverage, notional per order (and a copy's
position cap) and slippage.

**Owner-only steps** (approving strategies, daily budgets, the account's referrer, registry listings) are never
sent by this server: `dp_prepare_owner_tx` returns `{from, to, data, value, chainId, description}` for the
owner to review and sign in their own wallet.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `DP_DEPLOYMENT` | the published Arc Testnet deployment (`deployments/arc-testnet.json` on GitHub) | URL or path of the deployment JSON |
| `DP_RPC_URL` | from the deployment | Arc RPC |
| `DP_ACCOUNT` | – | Agent account address to trade for |
| `DP_AGENT_KEY` | – | Private key of an agent approved on `DP_ACCOUNT` (never the owner's) |
| `DP_PRIVATE_KEY` | – | Alternative: trade straight from this wallet (it can withdraw: prefer an agent account). Strategies then use the wallet's own agent account |
| `DP_MAX_NOTIONAL_USD` | `10000` | Per-order size cap (also a strategy's order size and a copy's position cap) |
| `DP_MAX_LEVERAGE` | `20` | Leverage cap (the market's own max also applies; Turbo goes to 5000x only if you raise this) |
| `DP_ALLOWED_MARKETS` | all | e.g. `BTC-USD,BTC-TURBO` (`BTC` means `BTC-USD`, `BTC-TURBO` means `BTC-USD-TURBO`) |
| `DP_MAX_SLIPPAGE_BPS` | `300` | Largest slippage an agent may request, and the price band for every order |
| `DP_DEFAULT_SLIPPAGE_BPS` | `50` | Market order / close bound when none is given |
| `DP_REQUIRE_CONFIRM` | `true` | Two-step confirmation |
| `DP_FILL_TIMEOUT_SECONDS` | `30` | How long `dp_open` / `dp_close` wait for the keeper (and `dp_remove_margin` for a fresh price) |
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
        "DP_ALLOWED_MARKETS": "BTC-USD,ETH-USD,BTC-TURBO"
      }
    }
  }
}
```

Claude Code: `claude mcp add dry-powder --env DP_ACCOUNT=0x… --env DP_AGENT_KEY=0x… -- node /abs/path/mcp/src/index.mjs`

Gas is native USDC on Arc (faucet: https://faucet.circle.com); the agent key needs a little for its transactions.

## Tests

`npm test`: guardrails, confirmation, config, the v3.2 maths (Turbo settlement, margin removal, strategy rules),
and the tools through a real MCP client against a stubbed chain (Turbo quotes, guardrails, strategy checks,
owner transactions). `node test/smoke.mjs` drives the tools against the local stack (see
`frontend/e2e/with-keeper.sh`): it creates an agent account, trades from it (Standard and Turbo, with expiry,
margin in and out), runs a strategy, and checks that the owner key and withdrawals are refused.
