# Examples

Built on [`@dry-powder/sdk`](../sdk). Testnet only: use throwaway keys.

```bash
cd ../sdk && npm ci && npm run build && cd ../examples && npm install
```

| Script | What it does |
| --- | --- |
| `quickstart.mjs` | Read-only. Lists every market and its fee model, and shows what 10 USDC of margin risks at 5x to 1000x on BTC-USD, up to 1000x on BTC-USD-TURBO and up to 5000x on EUR-USD-TURBO: size, the move that liquidates it, the most it can lose and make. No key. |
| `turbo-stop.mjs` | One Turbo trade (no fee unless you win, mid-price fills): quotes the worst case, refuses a stop past liquidation, places a keeper order good for 30 s with the stop attached, holds it, closes. `KEY=0x… node turbo-stop.mjs`; `MARKET`, `SIDE`, `LEVERAGE`, `STOP_BPS`, `TP_BPS`, `HOLD_SECONDS`, `AGENT_ACCOUNT`, `REFERRER`. |
| `strategy-launcher.mjs` | Launches an on-chain trend (12/26 EMA) or copy strategy for the owner's agent account: approves the Strategies contract with per-order caps and a daily margin budget, starts it (owner, or `AGENT_KEY` inside its own caps), optionally lists the account in the agent registry, and watches it. `OWNER_KEY=0x… node strategy-launcher.mjs`; `KIND=copy LEADER=0x…`, `MARKET`, `MARGIN`, `LEVERAGE`, `DAILY_BUDGET`, `REGISTER=1`, `POKE=1`, `STOP_ON_EXIT=1`. |
| `risk-capped-agent.mjs` | A trend agent that sizes every trade from a risk budget and a stop (`RISK_PER_TRADE` of balance lost if the stop fills). Leverage is an output of the stop, never an input. `KEY=0x… node risk-capped-agent.mjs`, or add `AGENT_ACCOUNT=0x…` to trade from an agent account it can't withdraw from. |
| `swarm.mjs` | Runs N of those agents in parallel, each with its own wallet and parameters (market, stop distance, risk per trade, lookback), then prints a leaderboard. `FUNDER_KEY=0x… AGENTS=8 node swarm.mjs` |

Each agent applies the venue's own risk rules before it trades: it refuses a trade whose stop sits past the
liquidation price, and above 100x and in the Turbo markets it goes through keeper-filled orders (the SDK does
this for you).

For agents that speak MCP rather than code, see [`../mcp`](../mcp).
