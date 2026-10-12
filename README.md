# Arc House Protocol

A synthetic perpetuals DEX for [Arc](https://docs.arc.io) built on a house-vault model: an ERC-4626 USDC vault
is the counterparty to every trade. Trader losses and fees flow into the vault, winning traders are paid out of
it, and every USDC a trader loses mints them HOUSE, a rebate token whose stakers share 15% of the vault's
inflows.

| Path | What it is |
| --- | --- |
| `contracts/` | Foundry project: `HouseVault`, `RewardToken`, `PerpEngine`, tests, deploy script |
| `keeper/` | TypeScript daemon (viem + Pyth Hermes) that liquidates positions and executes limit / TP / SL orders |
| `frontend/` | Next.js App Router dashboard (`/trade`, `/house`) with wagmi / viem and Lightweight Charts |
| `docker-compose.yml` | Runs the frontend and the keeper together |
| `SECURITY.md` | Independent review findings, what was fixed, and the risks that remain. **Read before putting real money in.** |

> **Status: testnet-ready, not mainnet-ready.** The code is complete and tested, but it has not had a
> professional audit, and the review in `SECURITY.md` found economic weaknesses in the house model itself, one
> of them rated High, that are consequences of the specified mechanics rather than coding errors. They need a
> design decision before any deployment that holds real funds.

## How it works

```
                 margin, fees                     85% of losses and fees
   Trader ───────────────────────▶ PerpEngine ───────────────────────────▶ HouseVault (rcUSDC)
     ▲   profit (from the vault)       │                                       │  ▲
     │                                 │ 100 HOUSE per USDC lost               │  │ deposit / withdraw
     └── HOUSE ◀── RewardToken ◀───────┘                 15% of losses and fees│  │
            │ stake                                                            ▼  LPs
            └────────────── claimYield() in USDC ◀──────────── pendingStakerYield
```

- **PerpEngine** holds trader margin and prices positions with Pyth. One position per trader per market, 1x to
  100x. Markets: BTC/USD, ETH/USD, EUR/USD, JPY/USD (Pyth publishes USD/JPY only, so that market inverts the feed).
- **HouseVault** tracks its NAV internally (`totalHouseBalance`), never by `balanceOf`, because on Arc a native
  USDC transfer also changes the ERC-20 balance. Shares have 18 decimals over 6-decimal USDC.
- **RewardToken** keeps a cumulative yield-per-staked-token ledger; the USDC stays in the vault until claimed.
- **Keeper** watches Pyth prices over Hermes' stream and calls `liquidateBatch` / `executeOrder`. Every action
  is simulated against the contract first.

### Trading rules

| Rule | Value |
| --- | --- |
| Liquidation | when price loss plus funding owed reaches 90% of margin |
| Liquidator fee | 2% of margin to the caller; the other 98% goes to the vault and earns the HOUSE rebate |
| Trading fee | 5 bps of notional on open and on close, plus up to 10 bps on opens that increase the skew |
| Funding | up to 50%/year of notional at full skew; the heavy side pays, the light side receives, the vault keeps the difference |
| Execution price | buys at Pyth price + confidence, sells at price − confidence; liquidations and triggers use the mid |
| Orders | limit, take-profit and stop-loss are stored on-chain and executed by keepers for a 0.10 USDC fee escrowed with the order |
| Open-interest cap | per market and side, and 3x vault NAV in total; LP withdrawals cannot breach the matching reserve |
| Deposit lock | LP deposits are locked for `withdrawLockPeriod` (1 hour by default) |

All of these are owner-settable within hard-coded bounds (`setFeeParams`, `setRiskParams`, `setMarket`). The owner
cannot move user funds. The three contracts reference each other immutably and are not upgradeable.

### Where this differs from the original brief

These were either contradictions in the brief that you resolved, or things the brief left open:

- **Liquidation at 90% margin loss** rather than a 1% maintenance margin on notional, which at 100x would make
  every position liquidatable the moment it opened.
- **The 2% liquidator fee is carved out of the margin**: 98% reaches the vault and the rebate is minted on that.
- **`liquidate(address)` exists as specified** and works on prices already on-chain. Because Pyth is a pull
  oracle, keepers normally call `liquidate(address, bytes[])` or `liquidateBatch(bytes32[], bytes[])`, which
  push a fresh price first.
- **`Position` has extra fields** (`trader`, `openedAt`, `tpOrderId`, `slOrderId`, `entryFundingIndex`) beyond
  the five in the brief.
- **Fees also go through the 85/15 split**, and with nobody staked the vault keeps 100%.
- **Safety additions not in the brief:** the deposit lock, the open-interest reserve on withdrawals, payout
  capped at the vault's balance (with the shortfall recorded), a confidence-interval check, a rule that a
  position can only be closed against a price published after it was opened, pause, and two-step ownership.
- **Pyth SDK:** the `pyth-sdk-solidity` GitHub repository is deprecated, so `contracts/lib/pyth-sdk-solidity`
  is the maintained copy of the same SDK (v4.3.1, from `pyth-crosschain`). Likewise `@pythnetwork/pyth-evm-js`
  v2 no longer contains a price client; the keeper uses it for the Pyth ABI and `@pythnetwork/hermes-client`
  for prices.

## Quick start

Prerequisites: [Foundry](https://getfoundry.sh), Node.js 22.14+, Docker (for compose).

### 1. Test the contracts

```bash
cd contracts
forge test -vvv
forge coverage --no-match-coverage "(test|script|lib)/"
```

Dependencies are vendored in `contracts/lib`, so there is nothing to install.

### 2. Deploy to Arc Testnet

Arc Testnet: chain id `5042002`, RPC `https://rpc.testnet.arc.network`, explorer `https://testnet.arcscan.app`.
USDC is the gas token, so the deployer only needs testnet USDC (Circle faucet).

```bash
cd contracts
cp .env.example .env && source .env
cast wallet import deployer --interactive          # store the key in a Foundry keystore
forge script script/Deploy.s.sol:Deploy --rpc-url arc_testnet --broadcast --account deployer
```

The script deploys the three contracts (predicting their addresses so they can reference each other
immutably), lists the four markets and writes the addresses to `contracts/deployments/5042002.json`.
Do not send any other transaction from the deployer while it runs.

Then seed the vault, since trading is capped at 3x its NAV and an empty vault allows none:

```bash
cast send 0x3600000000000000000000000000000000000000 "approve(address,uint256)" <HOUSE_VAULT> 1000000000 \
  --rpc-url $ARC_TESTNET_RPC_URL --account deployer
cast send <HOUSE_VAULT> "deposit(uint256,address)" 1000000000 <YOUR_ADDRESS> \
  --rpc-url $ARC_TESTNET_RPC_URL --account deployer       # 1,000 USDC
```

### 3. Run the frontend and the keeper

```bash
cp .env.example .env      # paste the three addresses and a keeper private key
docker compose up --build
```

The frontend is at <http://localhost:3000>. The keeper account needs a little USDC on Arc for gas and Pyth
fees; it earns 2% of each liquidated margin and 0.10 USDC per executed order. Set `DRY_RUN=true` to watch what
it would do without sending anything.

Without Docker:

```bash
cd keeper   && cp .env.example .env       && npm ci && npm run build && node --env-file=.env dist/index.js
cd frontend && cp .env.example .env.local && npm ci && npm run dev
```

### After changing a contract

```bash
make abis     # forge build, then regenerate keeper/src/abi.ts and frontend/src/lib/abi.ts
```

## What has been verified

| Component | Verified | Not verified |
| --- | --- | --- |
| Contracts | 161 Foundry tests pass, including fuzz and invariant suites; 100% line, statement, branch and function coverage of `src/`; the deploy script runs in a test against mocks placed at the Arc addresses | A real deployment to Arc Testnet |
| Keeper | Type-checks; unit tests pin its arithmetic to the contract's; run end to end on a local chain with a mock oracle, where it filled a limit order, liquidated a position and executed a stop-loss | Real Hermes and real Pyth update data; Arc's fee market |
| Frontend | Builds and type-checks; exercised in a headless browser against a local chain (open with TP/SL, edit triggers, limit order, cancel, close, deposit, withdraw, stake) | Real wallets, Arc Testnet, live Pyth and Benchmarks data; `claimYield` and `unstake` were not clicked through |
| Docker | — | Neither image nor the compose file has been built or run: the environment this was written in has no Docker |

The Arc Testnet Pyth address (`0x2880aB155794e7179c9eE2e38200202908C17B43`) comes from Pyth's contract
registry and the four feed ids from Hermes; neither has been exercised on-chain here. Expect to shake out
integration issues on the first testnet run.

### A note on price freshness

The engine rejects prices older than `maxPriceAge`. Its built-in default is 3 seconds, which suits a keeper;
the deploy script raises it to 10 (`MAX_PRICE_AGE_SECONDS`) because a person approving a transaction in a
browser wallet routinely takes longer than 3. A wider window is a larger stale-price option for traders; see
`SECURITY.md` before choosing a value for anything but a testnet.

FX feeds stop at the weekend. While a feed is stopped its market cannot be traded, closed or liquidated.
