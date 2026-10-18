# Architecture

How Dry Powder works, in more depth than the README. Addresses: `deployments/arc-testnet.json`.

## Contracts

| Contract | Role |
| --- | --- |
| `PerpEngine` | Positions, orders, fees, funding, liquidations, dated-market settlement. One position per market per trader. |
| `HouseVault` | ERC-4626 USDC vault (`dpUSDC`): the counterparty to every trade. Epochs stream 15% of profit above the high-water mark to DRY stakers. |
| `RewardToken` | `DRY`: 100 DRY minted per 1 USDC a trader loses; stake it for a share of house profit. |
| `EngineLens` | Read-only views: every market with its price and funding, a trader's positions and orders. |
| `PythOracle` | Adapter from Pyth-style feeds to bid/ask/mid, crosses and inversion. |
| `PublisherOracle` | Testnet stand-in for Pyth: prices signed by the publisher key (Kraken tickers). |
| `AgentAccount(Factory)` | A wallet-owned account agents can trade from within an on-chain policy, and never withdraw from. |

## Risk rules

- **Leverage.** 1x up to the market's maximum (at most `MAX_LEVERAGE` = 1000).
- **Above 100x** (`DIRECT_MAX_LEVERAGE`), positions open and close only through keeper-filled orders. A keeper
  order fills at a price published after the order was placed, so nobody can trade against a price they already
  know is stale. At 1000x a 0.1% stale-price edge would be the whole margin; this rule removes it.
- **Liquidation** when losses plus funding reach 90% of margin. Losses are bounded by margin: no negative
  balances, no socialised losses.
- **Fees.** 5 bp of size plus a skew surcharge (up to 10 bp) on the side that makes the market more one-sided,
  each side capped at 10% of margin (`MARGIN_FEE_CAP_BPS`).
- **Profit cap.** 10x margin per position (`maxProfitMultiple`), which bounds what one position can take from the
  vault.
- **Open-interest caps** per market and side, plus a vault-wide cap as a share of NAV; the withdrawal reserve
  is based on net exposure.

## What v2 added (2026-10-14)

- **Agent accounts (from Nexus).** `AgentAccount`: a wallet-owned account that approved agent keys can trade
  from, within an on-chain policy (expiry, leverage, margin per order, markets), and never withdraw from. Managed
  on the app's Agents page; used by the MCP server.
- **Instruments.** A market is a price feed plus three switches: a quote feed (crosses such as ETH/BTC),
  inversion (JPY/USD), and an expiry (dated, cash-settled futures). Everything is sized in USDC notional, so
  every instrument is fractional. Launch set: BTC, ETH, SOL, EUR, JPY, gold, ETH-BTC and a dated BTC future.
- **Staker yield from net profit.** Once per epoch, 15% of the vault's gain above its high-water mark is
  streamed to DRY stakers. The old 15%-of-gross-losses split, which a hedged pair could farm, is gone.
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

