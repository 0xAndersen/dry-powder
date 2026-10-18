# Changelog

## v3.1 (2026-10-18)

**Manage a position, not just open and close it.** (Contracts; a new deployment.)
- Add to a position: an open on the side you already hold (direct, or a filled order) adds to it. The entry
  price comes from units, rounded against the trader; funding owed is carried over exactly; take-profit and
  stop-loss on the addition move the existing ones and refund their fee. The other side still reverts
  `PositionExists`. An addition to a position already past its profit cap reverts `ProfitCapReached`.
- Close part of a position: `closePosition(market, size, acceptablePrice, update)`. The part is settled like a
  position of its own (margin released in proportion, its own profit and fee caps, DRY rebate on a loss); the
  rest keeps its entry, funding and orders. If what would remain is under the minimum margin, everything closes.
- Sized take-profit and stop-loss: `setTriggerOrder(market, type, trigger, size)` (`size` 0 = all), so you can
  scale out in steps.
- Add margin: `addMargin(market, amount)` lowers leverage and moves liquidation away. Refused while the position
  is in profit at the last price (it would lift the profit cap) or below 1x.
- Stop-entry orders (`OrderType` 4, `LimitParams.stopEntry`): breakout entries that fill once the market reaches
  the trigger. Same escrow, cancel and bracket rules as limits.
- Agent accounts: `multicall` for atomic batches (ladders, close all, cancel all), each call checked against the
  agent's policy; `AgentAccountFactory.createAccountWithAgent` creates an account, approves its first key and
  funds the key's gas in one transaction.
- Trailing stops without an engine change: `TrailingStops`, an add-on beside the venue, moves an agent account's
  stop-loss behind the best price seen (from the engine's own price, only ever tighter) when anyone pokes it;
  optional activation price and size. The keeper pokes when a stop would move by at least 0.1%. A poke short of
  gas is refused whole (a 400k floor before each move), so estimated pokes never pass for refusals.
  `DeployAddons.s.sol` and the "Deploy add-ons" workflow deploy or replace add-ons without touching the venue.
- TWAP orders, also without an engine change: `TwapOrders` splits a size into 2 to 100 equal slices, one every
  30 s to a day, each a keeper-filled market order through the account with its own slippage bound (at most 5%).
  The account's policy for the contract caps every slice, an agent key may only start slices inside its own
  policy, a poke cannot speed a TWAP up, slices wait while the account holds the other side, and three refusals
  in a row end it. Same gas floor as trailing stops (500k per slice).
- Events `PositionIncreased`, `PositionDecreased`, `MarginAdded`.
- **Breaking:** `closePosition` and `setTriggerOrder` take a size. `liquidate(address)` and
  `liquidate(address, bytes[])` are gone (use `liquidateBatch`), as are the getters of ten owner-bound constants.
  Engine runtime 24,289 bytes, 287 under the EIP-170 limit. 399 tests, invariants extended to every new path.

**Prices you can trust, gas you don't think about.** (Keeper; live since 2026-10-18.)
- The publisher signs the median of Kraken, Coinbase and Bitstamp when they agree within 50 bp, with the widest
  agreeing spread as the band. One venue can no longer move the price; venues that disagree pause the market.
- Gas sponsorship: instant-trading keys are topped up from the operator (0.25 USDC at a time, at most 1 USDC per
  key and 25 USDC a day, only for accounts holding collateral).
- A transaction that reverts on-chain after a clean simulation (a trader's transaction landed in between) is
  replayed to name the reason, so lost races count as benign rather than as faults.
- Gas limits carry headroom (a quarter more plus 50k) everywhere a key signs: keeper, instant trading, SDK, MCP.
  A tight estimate ran out when the state moved before inclusion (an addition becoming a new position, funding
  accruing). Estimates go by address: with a local account viem estimated twice, capping the second at the
  first, which failed whenever a second passed in between.
- The indexer keeps hourly buckets per market: 24h volume, fees and trades on the Markets page.

**A trading app for phones and desks.** (Live since 2026-10-18.)
- Phone first: bottom tabs, the ticket as a sheet, positions as cards, a full-screen chart with your fills on
  the candles. Installable (PWA) with an offline shell, an update prompt and system notifications.
- Instant trading: a key in this browser trades through your agent account inside an on-chain policy; no wallet
  pop-up per order. Setup is one confirmation on v3.1 (two before).
- Order ticket: Market, Limit and Stop; "adds to your long" preview with the merged entry and liquidation price;
  scale in with a ladder of 2 to 20 equal limit orders between two prices (one transaction with instant
  trading), with the average entry and liquidation if all fill. Positions: close 25/50/75/100% or any size, add
  margin with a leverage preview, edit TP/SL inline.
- Risk: liquidation warnings at half and three quarters of the buffer, an account risk sheet with a what-if
  slider, a personal leverage cap, a daily loss limit and an optional cool-off after a liquidation (15 minutes to
  4 hours without new positions).
- Trailing stops on positions in the trading account: distance, how much it closes, an optional activation
  price; one wallet confirmation allows the contract once, then no pop-ups.
- TWAP in the ticket (Market, with instant trading): slices and the time between them, with what each slice is,
  how long it runs and the total it draws; running TWAPs in Orders with progress, the next slice and Stop. Start
  over and Cancel all stop TWAPs first. Take-profit and stop-loss edits in
  the positions table take a size (all, 75, 50 or 25%).
- Practice: "Start over" closes every position, cancels entry orders and adds test funds in one step (one
  transaction with instant trading); history and the journal stay. Challenges on the Portfolio page: a goal with
  risk rules (Steady hand: +5% in a week without a 3% drawdown; Evaluation: the prop-firm test, +10% in 30 days
  with 5% drawdown and 2.5% daily limits; Sharpshooter; Survivor), measured from trades opened after the start,
  each rule shown with its budget, a share card when passed.
- Pro: Ctrl/⌘ K command palette, favourites in the market picker, close all and cancel all (one transaction
  with instant trading), links that prefill a trade, Settings, Help and a venue Status sheet (chain, keeper,
  price sources and age per market); horizontal lines drawn on the chart (kept per market in this browser); the
  open fee by size for both sides in the ticket's details, the depth view of a venue without an order book.
- Markets page (24h change and volume, sparklines, funding, open interest, favourites); Portfolio (PnL curve, calendar,
  win rate, profit factor, drawdown) with a trade journal; weekly leaderboard seasons; trader profiles with
  Copy; follows and nicknames in Activity.
- Social: an alert (with a link to the profile) when a trader you follow opens, adds to, closes or is
  liquidated; PnL share cards, drawn in the browser as an image of a trade, an open position or a profile, to
  share, download or copy.
- A serverless indexer: the keeper workflow publishes `stats.json` (per-trader and per-market totals, daily
  buckets) to the `status` branch every 5 minutes; the app continues it with live events.

**Developers.**
- SDK: `close(market, { size | fraction })`, `setStops(..., { size })`, `addMargin`, `scale` (a ladder of limit
  orders), `closeAll`, `cancelAll`, `createAgentAccountWithAgent`, `approveAgent({ gas })`; pure helpers
  `mergedPosition`, `partialClose`, `ladderPrices`; `quote()` shows the position after an addition.
- MCP: `dp_close` takes `percent` or `sizeUsd`, `dp_set_tpsl` takes `sizeUsd`, new `dp_add_margin`, `dp_limit`
  takes `stopEntry`, and `dp_open` adds to a position held on the same side.
- [`docs/ROADMAP.md`](docs/ROADMAP.md): the hundred-item plan and where each item stands.

## v3 (2026-10-17)

**1000x, safely.**
- Markets list up to 1000x (BTC, ETH 1000x; SOL 500x; EUR, gold, the BTC future 250x; JPY, ETH-BTC 100x).
- Above 100x (`DIRECT_MAX_LEVERAGE`), positions open and close only through keeper-filled orders, which always
  fill at a price published after the order: no stale-price option against the vault. Settled dated markets
  still close directly.
- Trading fees are capped at 10% of margin per side (`MARGIN_FEE_CAP_BPS`), so a 1000x round trip costs at most
  20% of margin rather than 100%. `quoteOpenFee` takes the margin.

**Risk first.**
- The order ticket leads with a risk card: most you can lose, the move that liquidates you, loss at your stop,
  most you can make, and a four-step risk level. Margin is the default input ("the most it can lose").
- Above 100x the ticket always confirms and says how small a move liquidates.
- The account bar shows margin at risk and the nearest liquidation across all positions.
- The MCP server's previews add `liquidationMovePct`, `maxLossUsd`, `maxProfitUsd`; leverage up to 1000.

**Brand: "Reserve".** Ink, paper and one signal blue; Inter and IBM Plex Mono; a new mark. The keg and fuse are
gone, and the rebate token is now `DRY` (was `KEG`).

**Developers.**
- `sdk/`: `@dry-powder/sdk`, a TypeScript SDK (markets, worst-case quotes, orders, stops, agent accounts, pure
  risk maths).
- `examples/`: read-only quickstart, a risk-capped agent, a swarm runner.
- Forge deploy workflow: the whole venue in one broadcast, addresses committed straight away.
- Keeper: re-signs prices during long ticks (no more stale-price failures under load); faster receipt polling on
  local chains. `EngineLens.getMarkets` reports the last oracle price when there is no fresh one, as a reference
  for keeper orders. The app recognises a fill from the account state when the event log lags, and shows the
  hosted keeper's health in the header. The whole-system check now also runs the SDK at 1000x.
- RPC failover everywhere (keeper, app, MCP, SDK) across Arc's public RPCs; the old `rpc.testnet.arc.network`
  host is gone.
- LICENSE (MIT), CONTRIBUTING, issue and PR templates, dependabot.

## v2 (2026-10-14, Arc Testnet)

Agent accounts (from Project Nexus), crosses, inverted FX and dated futures, staker yield from net profit,
mark-to-market vault shares, keeper-executed market orders, the publisher oracle with Kraken prices, the MCP
server, the keeper workflow and the GitHub Pages app.

## v1 (2026-10-12)

House-vault perpetuals: ERC-4626 vault as counterparty, loss-rebate token, Pyth oracle adapter, the trading app.
