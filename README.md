# Dry Powder

[![CI](https://github.com/0xAndersen/dry-powder/actions/workflows/ci.yml/badge.svg)](https://github.com/0xAndersen/dry-powder/actions/workflows/ci.yml)
[![Keeper](https://github.com/0xAndersen/dry-powder/actions/workflows/keeper.yml/badge.svg)](https://github.com/0xAndersen/dry-powder/actions/workflows/keeper.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-7ea6ff.svg)](LICENSE)

**Keep your powder dry.** An open, risk-first perpetuals venue on [Arc](https://docs.arc.io), built for people
and AI agents. Up to 1000x, and you always see the worst case before you trade: the most you can lose, the move
that liquidates you, and the most you can make.

**[Trade on Arc Testnet →](https://0xandersen.github.io/dry-powder/trade/)** · [SDK](sdk/) · [Agents](AGENTS.md) ·
[MCP server](mcp/) · [Examples](examples/) · [Architecture](docs/architecture.md)

- **One USDC vault is the counterparty** to every trade, at the oracle price. No order book, no matching, no
  liquidity fragmentation: anyone can be the house by depositing into the vault.
- **Leverage up to 1000x, with guardrails in the contract.** Above 100x, trades fill only through keeper orders
  at a price published after the order. Liquidation at 90% of margin; you can never lose more than margin plus
  fees (capped at 10% of margin per side).
- **Agents are first-class.** Agent accounts let a bot trade inside an on-chain policy (expiry, leverage, margin
  per order) and never withdraw. Use the TypeScript SDK, the MCP server, or the contracts directly.
- **USDC everywhere.** Margin, settlement and gas are all USDC on Arc.

![The trade screen: the risk card leads the ticket, the account bar shows the nearest liquidation](media/brand-trade.png)

Markets: BTC, ETH (1000x) · SOL (500x) · EUR, gold, a dated BTC future (250x) · JPY, ETH-BTC (100x).

## Start here

**Trade.** Open the [app](https://0xandersen.github.io/dry-powder/trade/), connect a wallet on Arc Testnet
(chain 5042002, gas from [faucet.circle.com](https://faucet.circle.com)) and press *Get test funds*.

**Build an agent (TypeScript).**

```ts
import { DryPowder, usd, pct, fromUsd } from "@dry-powder/sdk";

const dp = await DryPowder.connect({ account });           // live testnet deployment, RPC failover built in
const q = await dp.quote({ market: "BTC", side: "long", margin: usd(10), leverage: 1000 });
console.log(fromUsd(q.risk.maxLoss), pct(q.risk.liquidationMove)); // about 12 USDC, "0.09%"
await dp.open({ market: "BTC", side: "long", margin: usd(10), leverage: 1000, stopLoss: q.entry * 9996n / 10000n });
```

See [`sdk/`](sdk/) and [`examples/`](examples/): a read-only quickstart, a risk-capped agent, a swarm runner.

**Give an LLM tools.** [`mcp/`](mcp/) is an MCP server with market data, worst-case previews and guarded trading
from an agent account. **Read the rules** in [`AGENTS.md`](AGENTS.md). **Machine-readable summary:**
[`llms.txt`](https://0xandersen.github.io/dry-powder/llms.txt).

## Repository

| Path | What it is |
| --- | --- |
| `contracts/` | Foundry: engine, lens, vault, DRY token, oracles, agent accounts, test collateral; 340 tests incl. fuzz and invariants |
| `frontend/` | Next.js trading app: trade, activity, house, agents; static build on GitHub Pages |
| `keeper/` | Price publisher + keeper: Kraken prices, fills, liquidations, settlement, vault epochs |
| `sdk/` | `@dry-powder/sdk`: TypeScript client and pure risk maths |
| `mcp/` | MCP server for AI agents |
| `examples/` | Agents built on the SDK |
| `ops/` | Load and acceptance runtime: deploys and runs 100 trader agents |
| `deployments/` | Live addresses (`arc-testnet.json`) and the history of earlier deployments |
| `docs/` | Architecture, Arc notes |
| `BRAND.md` · `SECURITY.md` · `CHANGELOG.md` · `CONTRIBUTING.md` | Brand, known issues, releases, how to help |

## Live on Arc Testnet

GitHub Actions run the venue:

- **Deploy to Arc Testnet (Forge)** (manual): `contracts/script/Deploy.s.sol` in one broadcast, then commits
  `deployments/arc-testnet.json`, publishes the app and starts the keeper. Needs the `DEPLOYER_KEY` secret (a
  throwaway key with testnet USDC for gas); the publisher and keeper keys derive from it.
- **Keeper (Arc Testnet)**: restarted every 5 hours so one always runs; health on the `status` branch.
- **App (GitHub Pages)**: rebuilt on every change to the app or the deployment.
- **Deploy to Arc Testnet** (ops runtime, manual): the slower path that also runs a 100-agent launch cohort.

## Run it locally

Prerequisites: [Foundry](https://getfoundry.sh), Node.js 22+.

```bash
cd contracts && forge test                         # contracts
cd frontend && npm ci && e2e/with-keeper.sh        # whole system: chain, keeper, UI click-through, SDK and MCP smoke tests
cd sdk && npm ci && npm test                       # SDK
cd ops && npm ci && npm test                       # 100-agent acceptance run (about 9 minutes)
```

`docker compose up --build` serves the app from environment variables (`.env.example`).

## Status

Testnet software, not audited. Prices on testnet come from a publisher key (Kraken tickers), so whoever holds it
sets the price; moving to Pyth is configuration. `SECURITY.md` lists what is fixed, open and accepted.
`REPORT.md` has the first 100-agent run.

MIT licensed.
