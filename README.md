# Dry Powder (v2)

A synthetic derivatives venue for [Arc](https://docs.arc.io) built on a house-vault model: an ERC-4626 USDC
vault is the counterparty to every trade. Traders post USDC margin and take leveraged exposure to oracle-priced
instruments; losses and fees flow into the vault, profits are paid out of it, every USDC a trader loses mints
them KEG, and KEG stakers receive 15% of the vault's profit above its high-water mark.

> **Status.** Complete and tested locally; **not yet deployed to Arc Testnet** and not audited. `REPORT.md` has
> the first 100-trader run and how to go live; `SECURITY.md` has what is fixed and what is still open.

| Path | What it is |
| --- | --- |
| `contracts/` | Foundry project: engine, lens, oracle adapter, vault, KEG token, testnet oracle and test collateral; 314 tests |
| `ops/` | Runtime that deploys the protocol and runs the price publisher, the keeper and 100 trader agents; `run-testnet.mjs` runs it against Arc Testnet |
| `frontend/` | Next.js trading terminal: `/trade`, `/activity`, `/house`, watch mode; server build and static bundle |
| `keeper/` | The always-on publisher + keeper for v2: Kraken prices to the oracle when needed, fills, liquidations, dated-market settlement, vault epochs |
| `mcp/` | MCP server for AI agents: market data and guarded trading from an agent account |
| `AGENTS.md` | How agents and bots trade the venue |
| `MERGE.md` | What was taken from Project Nexus and what was left out |
| `deployments/` | Live addresses (`arc-testnet.json`, written by the deploy workflow) |
| `REPORT.md` | Results of the first 100-agent run, venue metrics, findings |
| `UIUX.md` | UI/UX breakdown and priorities |
| `BRAND.md` | Brand tokens, mark, voice and the name check |
| `SECURITY.md` | Review findings: fixed, open, accepted |
| `V2_SPEC.md` | Map of the v2 design and ABI |
| `media/` | 64 s recording of the UI under a 100-trader load (local chain) and screenshots |

## What v2 added

- **Agent accounts (from Nexus).** `AgentAccount`: a wallet-owned account that approved agent keys can trade
  from, within an on-chain policy (expiry, leverage, margin per order, markets), and never withdraw from. Managed
  on the app's Agents page; used by the MCP server.
- **Instruments.** A market is a price feed plus three switches: a quote feed (crosses such as ETH/BTC),
  inversion (JPY/USD), and an expiry (dated, cash-settled futures). Everything is sized in USDC notional, so
  every instrument is fractional. Launch set: BTC, ETH, SOL, EUR, JPY, gold, ETH-BTC and a dated BTC future.
- **Staker yield from net profit.** Once per epoch, 15% of the vault's gain above its high-water mark is
  streamed to KEG stakers. The old 15%-of-gross-losses split, which a hedged pair could farm, is gone.
- **Mark-to-market share pricing.** Deposits buy in at the higher of realised and marked value, withdrawals
  leave at the lower, so nobody can deposit ahead of a liquidation or exit ahead of a winning trader.
- **Keeper-executed market orders.** A marketable limit order opens and a `Close` order closes against the next
  price, so people using wallets never race a staleness window. Direct open/close remain for bots.
- **Hardening.** Profit capped at 10x margin; payments that USDC refuses are parked for the same address
  instead of blocking a close; the withdrawal reserve is based on net exposure, so matched open interest cannot
  freeze the vault; limit orders are re-validated at fill.
- **Oracle abstraction.** The engine reads prices through `PythOracle`. On Arc Testnet, where Pyth's Hermes
  needs a paid key and nobody pushes Pyth prices, `PublisherOracle` stands in for the Pyth contract with
  publisher-signed prices from Kraken's public tickers. It is testnet infrastructure: whoever holds the
  publisher key sets the price. Moving to real Pyth is configuration plus a Pyth API key.

## Live on Arc Testnet

Three GitHub Actions workflows run the venue where Arc is reachable:

- **Deploy to Arc Testnet** (manual): deploys the contracts and markets, seeds the vault, runs the trader-agent
  cohort, deploys the agent account factory and commits `deployments/arc-testnet.json`. Needs the
  `DEPLOYER_KEY` secret (a throwaway key with testnet USDC for gas); every other key derives from it.
- **Keeper (Arc Testnet)**: the publisher + keeper, restarted every 5 hours so one is always running.
- **App (GitHub Pages)**: the static trading app with `config.json` built from the deployment file.

## Run it

Prerequisites: [Foundry](https://getfoundry.sh), Node.js 22+.

```bash
# 1. Contracts
cd contracts && forge test
forge coverage --ir-minimum --no-match-coverage "(test|script|lib)/"

# 2. The 100-agent acceptance run on a local chain (about 9 minutes)
cd ../ops && npm ci && npx playwright install chromium && npm test

# 3. The same thing on Arc Testnet (needs a deployer with ~40 testnet USDC for gas), then the keeper
DEPLOYER_KEY=0x... HEADLESS=0 node run-testnet.mjs
cd .. && DEPLOYER_KEY=0x... node keeper/scripts/finish-deploy.mjs
cd keeper && npm ci && DEPLOYER_KEY=0x... DEPLOYMENT=../deployments/arc-testnet.json node src/main.mjs

# Whole system locally: chain, keeper, 34-step UI run, MCP server from an agent account
cd frontend && e2e/with-keeper.sh

# 4. The UI, pointed at whatever step 3 deployed (it prints the query string)
cd ../frontend && npm ci && npm run build:static && npx serve out
```

`contracts/script/Deploy.s.sol` is the conventional deployment path (`ORACLE_MODE=pyth|publisher`,
`COLLATERAL=usdc|test`; see `contracts/.env.example`). `docker compose up --build` serves the frontend from
environment variables (`.env.example`).

## Verified and not verified

| Component | Verified | Not verified |
| --- | --- | --- |
| Contracts | 314 tests incl. fuzz and 8 invariants; 100% of lines, branches and functions once three tool mis-attributions under the IR pipeline are discounted (reported 99.5%); engine is 23,229 bytes, 1,347 under the limit | Any real chain; real Pyth |
| Ops runtime | 100 agents, 607 round trips, 32 acceptance checks, resume after reload, fault-injected RPC, no-Multicall3 fallback | Arc's RPC limits and fee market; real Kraken; `collateral: "usdc"` against Arc's native USDC |
| Frontend | type-check, server and static builds, 33-step scripted click-through, 100-trader activity load at 60 fps | real wallets, real network, Pyth mode, Docker image |
| Testnet reachability | from a browser: Arc RPC (chain id 5042002), Multicall3, Kraken, esm.sh reachable; Pyth on Arc is stale and Hermes returns `unauthorized` | everything else on testnet |
