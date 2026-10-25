# Roadmap: the next hundred things

The goal: the most used trading app on Arc, for people on phones and at desks and for AI agents. The list
comes from what traders on Hyperliquid, Papertrade and FOMO have, and what they still ask for (sources at the
end), filtered through Dry Powder's rule that the worst case is always on screen.

Status: **Live** on the venue now (v3.2, deployed 2026-10-25) · **Ready** built and tested, waiting on an outside
party (a host, a key, a second operator) · **Mainnet** depends on real funds, a partner or an audit.

All hundred are now Live, Ready or waiting on mainnet. What comes after them is in "Beyond the hundred" at the end.

## What the research said

- **Papertrade** (HyperEVM, live 2026-10-10) runs the same shape of venue as Dry Powder: a USDC pool takes the
  other side of every trade, up to 1000x, and losers are paid in a token (100 PAPER per $1 lost while the pool is
  small, fewer as it grows) that stakers hold for a share of the pool. It reached $118M of deposits in a day.
  The concerns raised: payouts queue when the pool runs short, one venue's price is the oracle, and paired
  long/short positions can farm the token.
- **Hyperliquid** traders compare it with CEXs: web only with no native app, a wallet learning curve, and order
  types that came late (trailing stops arrived on 2026-09-21; iceberg orders and multi-leg brackets are still
  missing).
- **FOMO** wins on the social layer and onboarding: email or Apple ID sign-up with no seed phrase, Apple Pay,
  sponsored gas, a feed of real trades with verified PnL, alerts when someone you follow opens a position,
  leaderboards and referral discounts.

Dry Powder answers the Papertrade concerns in the contracts (winners are paid in full up to a 10x profit cap;
prices are the median of three exchanges; the farming issue is reduced in v3.2 by item 98 and the rest is listed
in `SECURITY.md`), and takes the rest as the list below.

## 1. Prices and the keeper

| # | Item | Status |
| --- | --- | --- |
| 1 | Price from the median of Kraken, Coinbase and Bitstamp; one venue cannot move it | Live |
| 2 | A market pauses when the venues disagree by more than 50 bp, instead of trading on one of them | Live |
| 3 | Gas sponsorship for instant-trading keys (0.25 USDC at a time, capped per key and per day) | Live |
| 4 | Keeper health reports its price sources and sponsorship; shown in the app's Status sheet | Live |
| 5 | System check before every deploy: 45 UI steps on desktop and phone, SDK and MCP smoke tests | Live |
| 6 | Keeper fills stop-entry orders and additions, and leaves a fill resting if it would gap through its own bracket | Live |
| 7 | Serverless indexer: per-trader and per-market totals in `stats.json`, every 5 minutes | Live |
| 8 | 24h volume per market in the indexer, on the Markets page | Live |
| 9 | Funding-rate and open-interest history in the indexer (hourly and 5-minute) | Live |
| 10 | A second keeper run by someone else, so fills never depend on one operator (`KEEPER_MODE=executor`: no publisher key needed) | Ready |

## 2. Protocol

| # | Item | Status |
| --- | --- | --- |
| 11 | Add to a position: entry blended from units and rounded against the trader, funding owed carried over | Live |
| 12 | Close part of a position, settled like a position of its own | Live |
| 13 | Sized take-profit and stop-loss, to scale out in steps | Live |
| 14 | Add margin to move liquidation away (not while in profit, so the profit cap cannot be lifted) | Live |
| 15 | Stop-entry (breakout) orders | Live |
| 16 | Brackets on an addition move the existing take-profit and stop-loss; no orphaned order or escrow | Live |
| 17 | Agent accounts batch calls atomically (`multicall`): ladders, close all, cancel all | Live |
| 18 | One transaction creates an agent account, approves its key and funds the key's gas | Live |
| 19 | Events for additions, partial closes and margin added, so history and stats see them | Live |
| 20 | Trailing stops without an engine change: a contract approved as an agent ratchets the stop from on-chain prices | Live |
| 21 | Order expiry (good-til-time); anyone sweeps expired orders for the execution fee | Live |
| 22 | `setTriggerOrder` checks which side of a fresh price a trigger sits | Live |
| 23 | Take margin out of a position, within the leverage limit (never profit) | Live |
| 24 | TWAP orders without an engine change: a size split into 2-100 slices, one every 30 s to a day, each filled by the keeper inside its own slippage bound | Live |
| 25 | Builder codes: front-ends and agents earn part of the fees they bring (referral links, 10% of fees) | Live |

## 3. The trading screen

| # | Item | Status |
| --- | --- | --- |
| 26 | Order ticket with Market, Limit and Stop | Live |
| 27 | "Adds to your long" preview with the merged size, entry and liquidation price | Live |
| 28 | Close sheet: 25, 50, 75, 100% or any size, with what comes back | Live |
| 29 | Add-margin sheet with leverage presets and the new liquidation price | Live |
| 30 | Close all and cancel all in one transaction with instant trading | Live |
| 31 | Command palette (Ctrl/⌘ K): markets, pages, long, short, close, settings | Live |
| 32 | Favourites in the market picker | Live |
| 33 | Links that prefill a trade (market, side, leverage, margin): copy a trade | Live |
| 34 | Full-screen chart with your entries and exits on the candles | Live |
| 35 | Settings, Help (FAQ, staying safe) and a venue Status sheet | Live |
| 36 | Getting-started checklist | Live |
| 37 | Scale orders in the ticket: a ladder of limits in one step (one transaction with instant trading) | Live |
| 38 | Sized take-profit and stop-loss in the positions table | Live |
| 39 | Chart drawing tools: horizontal lines (trend lines next) | Live |
| 40 | Several charts side by side on wide screens (the chart wall) | Live |
| 41 | A depth view for a vault venue: the open fee at each size, both sides | Live |
| 42 | Funding and open-interest history charts | Live |

## 4. Phone and the installable app

| # | Item | Status |
| --- | --- | --- |
| 43 | Bottom tab bar and a compact header | Live |
| 44 | Long/Short action bar; the ticket opens as a bottom sheet | Live |
| 45 | Positions as cards on phones | Live |
| 46 | Installable app: manifest, icons, Apple touch icon | Live |
| 47 | Offline shell and an update prompt (service worker) | Live |
| 48 | System notifications for fills and liquidation warnings | Live |
| 49 | Haptics and a price ticker in the tab title | Live |
| 50 | Push notifications while the app is closed (relay built; needs a host with TLS and VAPID keys) | Ready |
| 51 | Sign in with a passkey and an embedded wallet: no extension, no seed phrase | Live |

## 5. Risk

| # | Item | Status |
| --- | --- | --- |
| 52 | Liquidation warnings at half and three quarters of the buffer, at any leverage | Live |
| 53 | Account risk sheet: exposure, margin at risk, worst case, a what-if slider | Live |
| 54 | Personal leverage cap | Live |
| 55 | Daily loss limit | Live |
| 56 | Instant trading inside an on-chain policy: expiry, max leverage, max margin per order | Live |
| 57 | The loss limit and leverage cap also cover additions to a position | Live |
| 58 | An optional cool-off after a liquidation | Live |

## 6. Instant trading

| # | Item | Status |
| --- | --- | --- |
| 59 | A key in this browser trades through your agent account: no wallet pop-up per order | Live |
| 60 | Set up with one wallet confirmation (two before v3.1) | Live |
| 61 | Trade with no wallet connected once set up | Live |
| 62 | Deposit, withdraw, top up gas, renew and revoke from one panel | Live |

## 7. Portfolio and analytics

| # | Item | Status |
| --- | --- | --- |
| 63 | Markets page: price, 24h change, sparklines, funding, open interest, search, filters | Live |
| 64 | Venue totals: open interest, long/short, vault cap used, vault value | Live |
| 65 | Portfolio: win rate, profit factor, expectancy, max drawdown, for 24h, 7d, 30d and all | Live |
| 66 | Cumulative PnL curve, open positions at current prices | Live |
| 67 | A 13-week calendar of daily PnL | Live |
| 68 | Results by market and by side | Live |
| 69 | Trade journal: a note and tags per trade, tag filter, CSV export | Live |
| 70 | History back to the deployment | Live |
| 71 | Partial closes and additions in history and stats | Live |

## 8. Social and competition

| # | Item | Status |
| --- | --- | --- |
| 72 | Weekly leaderboard seasons (Monday 00:00 UTC) | Live |
| 73 | Rank by PnL, ROI, win rate, volume or trades | Live |
| 74 | Trader profiles: PnL curve, calendar, open positions, recent trades | Live |
| 75 | Copy a trader's position into your ticket | Live |
| 76 | Follow, private nicknames, a Following filter in Activity | Live |
| 77 | PnL share cards: an image of a trade, an open position or a profile to post | Live |
| 78 | Alerts when someone you follow opens, adds to, closes or is liquidated on a position | Live |
| 79 | Referral links with on-chain attribution and a 5% fee discount | Live |
| 80 | Automatic copy trading: an on-chain copy strategy mirrors a trader you choose, inside your policy | Live |
| 81 | Season prizes: pools anyone can fund, results from the indexer, claims on the Portfolio page | Live |

## 9. Practice trading

| # | Item | Status |
| --- | --- | --- |
| 82 | Practice on live prices from three exchanges with free test funds | Live |
| 83 | Start over: close everything, cancel orders and top up test funds in one step | Live |
| 84 | Practice challenges: reach a target without breaking a drawdown or daily loss limit (four on the Portfolio page) | Live |
| 85 | The same account, tools and history when real money arrives | Mainnet |

## 10. Agents and developers

| # | Item | Status |
| --- | --- | --- |
| 86 | SDK: close all or part, sized stops, add margin, scale, close all, cancel all | Live |
| 87 | SDK quotes show the position after an addition | Live |
| 88 | SDK: one-transaction agent account setup with gas for the key | Live |
| 89 | MCP: partial closes, sized take-profit and stop-loss, add margin, stop entries | Live |
| 90 | Public `stats.json` for builders | Live |
| 91 | Docs: `AGENTS.md`, `llms.txt`, this roadmap | Live |
| 92 | Agents on the leaderboard, marked as agents, with a public agent registry | Live |
| 93 | A stream of venue events for bots (SSE and WebSocket relay built; needs a host) | Ready |

## 11. USDC on Arc

| # | Item | Status |
| --- | --- | --- |
| 94 | Deposit USDC from other chains with CCTP | Live |
| 95 | One USDC balance across chains with Gateway | Live |
| 96 | Card and Apple Pay on-ramp | Mainnet |

## 12. Economics and launch

| # | Item | Status |
| --- | --- | --- |
| 97 | Fee model: no fee unless you win, as Turbo markets beside the Standard ones | Live |
| 98 | DRY emissions that decay as issuance grows, minted on net rather than gross losses | Live |
| 99 | Pyth or Stork prices instead of the publisher key | Mainnet |
| 100 | A professional audit, a timelock and a multisig before real funds (the timelock and Safe hand-over script is built) | Mainnet |

## Beyond the hundred

Shipped in v3.2 on top of the list:

- **Turbo markets**: EUR to 5000x, gold to 2500x, BTC and ETH to 1000x; no fee unless you win, mid-price keeper
  fills.
- **Simple and Advanced**: two apps in one. Simple is a tile per market, up or down, and one sheet with what you
  can win and lose; Advanced is the terminal.
- **Agent Studio**: build, replay on past prices, launch and manage trend, mean-reversion and copy strategies
  that run on-chain; daily spending budgets for agent keys.
- **Exposure-based vault caps**, which let leverage rise without the vault taking more risk, and a mark that no
  longer counts losses it cannot collect.

Next: the twenty improvements in the analysis that accompanies this release, led by breadth (200+ markets with
market hours, weekend markets, baskets), capacity (hedging the vault, LP tranches) and trust (a multi-publisher
oracle, audits, an insurance fund and a public solvency page).

## Sources

- [Bitcoin.com News: Papertrade pulls in $118M in 24 hours with 1000x leverage](https://news.bitcoin.com/papertrade-perp-dex-pulls-in-118m-in-24-hours-with-1000x-leverage/)
- [Bankless: what to know about Papertrade's launch](https://www.bankless.com/read/what-to-know-about-papertrade-s-launch.md)
- [OneKey: order types Hyperliquid still lacks compared with CEXs](https://onekey.so/blog/ecosystem/hyperliquid-order-types/)
- [OneKey: trading interface comparison, Hyperliquid vs CEX](https://onekey.so/blog/ecosystem/hyperliquid-cex-ux-comparison/)
- [crypto.news: Hyperliquid launches trailing stops](https://crypto.news/hyperliquid-launches-trailing-stops-across-perpetual-markets/)
- [Datawallet: FOMO app explained](https://www.datawallet.com/crypto/fomo-app-explained)
