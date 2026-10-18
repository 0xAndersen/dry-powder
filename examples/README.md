# Examples

Built on [`@dry-powder/sdk`](../sdk). Testnet only: use throwaway keys.

```bash
cd ../sdk && npm ci && npm run build && cd ../examples && npm install
```

| Script | What it does |
| --- | --- |
| `quickstart.mjs` | Read-only. Lists every market and shows what 10 USDC of margin risks at 5x to 1000x: size, the move that liquidates it, the most it can lose. No key. |
| `risk-capped-agent.mjs` | A trend agent that sizes every trade from a risk budget and a stop (`RISK_PER_TRADE` of balance lost if the stop fills). Leverage is an output of the stop, never an input. `KEY=0x… node risk-capped-agent.mjs`, or add `AGENT_ACCOUNT=0x…` to trade from an agent account it can't withdraw from. |
| `swarm.mjs` | Runs N of those agents in parallel, each with its own wallet and parameters (market, stop distance, risk per trade, lookback), then prints a leaderboard. `FUNDER_KEY=0x… AGENTS=8 node swarm.mjs` |

Each agent applies the venue's own risk rules before it trades: it refuses a trade whose stop sits past the
liquidation price, and above 100x it goes through keeper-filled orders (the SDK does this for you).

For agents that speak MCP rather than code, see [`../mcp`](../mcp).
