# UI/UX breakdown

Based on the built v2 frontend, a 33-step scripted click-through against a local deployment, a 100-trader load
on the activity view, and screenshots in `media/`. Nothing here has been observed with real users or a real
wallet yet.

## What exists

| Screen | What it does |
| --- | --- |
| `/trade` | Market strip and grouped selector (perpetuals, crosses, FX & metals, dated futures), chart, order ticket, account bar, positions / orders / history / alerts |
| `/activity` | Venue-wide live feed from chain logs, totals, open interest per market, top traders, click-through to any trader |
| `/house` | Vault NAV and share price, deposit / withdraw, epoch settlement, DRY staking and yield stream |
| Watch mode | `?account=0x…` shows any account read-only |

## The core flow: first trade

Connect -> "Get test funds" -> pick a market -> Long/Short -> size -> submit -> filled toast.

- **Works well.** The ticket opens on Market with one field to fill. The summary states entry estimate,
  liquidation price with its distance in %, fees and total required before anything is signed. The trade-map
  strip (liq, entry, TP, SL on one line) makes leverage tangible. A fill arrives in 1 to 2 s with a toast.
- **Friction 1: two signatures the first time** (approve, then order). Approval defaults to unlimited to make
  it a one-off; worth an explicit choice in onboarding rather than a default buried in settings.
- **Friction 2: "Market (keeper-filled, ~1-2 s)" is honest but unfamiliar.** New users expect a market order to
  be instant and to either fill or fail. Today it can rest if price runs past the slippage bound (see order
  expiry in REPORT.md). Until the contract has immediate-or-cancel, the UI should show a countdown and offer
  one-tap cancel on any market order older than a few seconds.
- **Friction 3: "total required" is higher than the real cost**, because keeper orders escrow the maximum
  possible fee and refund the difference on fill. The ticket explains it under a disclosure; it should say
  "up to" next to the number.
- **Friction 4: closing costs 0.10 and an allowance.** A wallet with everything in margin cannot place a
  keeper close. The UI falls back to a direct close; the better fix is taking the fee from the payout.

## Instruments

- Market discovery is from chain, so a new listing appears without a release. Grouping by type with search
  scales to dozens of markets; the top strip will not, and should become favourites.
- **Dated futures** show a countdown, the settlement rule, and "Settle & close" after expiry. Gap: settled
  futures stay listed for ever; they need an "expired" section or to drop off.
- **Crosses**: quantity in "contracts" on ETH-BTC is not units of ETH (PnL is paid in USDC on a ratio), and
  that will confuse people. Recommend hiding the contracts mode on crosses and showing "1% move = X USDC".
- **Inverted FX** (JPY-USD at 0.0066) displays correctly but most traders think in USD/JPY. Offer a display
  toggle.
- One position per market, no adding, reducing or partial close. "Reverse" is two orders, two signatures and
  two fees with price risk between them. This is the largest functional gap versus a standard perp venue.

## Technical trading tools

- Chart: six resolutions, EMA x2, SMA, Bollinger, VWAP, RSI and MACD panes, crosshair OHLC, and lines for
  entry, liquidation, TP, SL, resting orders and alerts. Click-on-chart sets limit, TP, SL or an alert, with a
  typed alternative for keyboard users.
- Ticket: size as notional, margin or contracts; brackets as price, %, ROE or R-multiple; risk-based sizing
  ("risk 10 USDC to my stop" computes size and caps leverage so the stop sits before liquidation).
- Shortcuts with a `?` overlay; price alerts; history with realised PnL and CSV export.
- **Gaps:** indicators recompute every 30 s rather than on each tick; no drawing tools; no depth or tape
  (there is no order book, so show the funding and skew fee curve instead: "your trade moves the fee by X");
  brackets are absolute prices fixed at submission, so with keeper fills a %-based stop drifts from intent (a
  0.12% stop ended 0.37% from the fill in one run). "Relative to fill" brackets need contract support.
- A take-profit placed inside the slippage allowance of a market order is rejected by the contract; the UI
  blocks it with a message, but the rule is not intuitive.

## Positions and risk

- Live PnL, ROE, liquidation distance, funding, share of account, inline TP/SL edit and one-click close.
- The contract accepts a TP beyond the 10x-margin profit cap; the UI warns. The cap deserves a permanent line
  in the ticket at high leverage (at 100x it is reached on a 10% move).
- On liquidation the escrowed TP/SL fees go to the vault, not the trader. Small, but it will read as unfair.
- A market whose on-chain price is stale shows "Awaiting on-chain price" and still takes orders. With
  `maxPriceAge` at 3 s and roughly 1 s publishing, any publisher hiccup flips this state; on testnet it is set
  to 30 s.

## Activity and watch mode

- Stayed at 60 fps with 100 traders producing about 5 events a second. Totals, per-market filters, open
  interest bars and a leaderboard make the venue legible at a glance; clicking a trader opens their book.
- Close and liquidation events on chain carry no size or side, so the feed only knows them when the open is
  inside its window. Adding size, side and margin to `PositionClosed` / `PositionLiquidated` (and market and
  type to `OrderExecuted`) would make history and analytics exact and remove a lot of client work.

## House

- NAV with an explanation of realised, marked, entry and exit value; lock countdown; available liquidity;
  epoch timer with a preview of what settling pays; yield stream rate and end time.
- The entry/exit pricing is correct but novel: a depositor may get fewer shares than the headline share price
  implies when traders are losing. The preview shows the exact shares; add one sentence saying why.
- While little DRY is staked, a tiny stake earns most of the stream. Show "your share of the stream" before
  staking, and expect this to be gamed until rebates are redesigned (REPORT.md, finding 3).

## Issues seen in screenshots

- On `/trade` at 1440 px the account bar renders above the site header and is partly clipped at the top of
  the viewport (`media/04-position-open.png`). It should sit under the header.
- The settings and help controls in the ticket are small text buttons next to the Market/Limit tabs and easy
  to miss; slippage, one-click trading and approval mode live there.

## Priorities for the next iteration

1. Order expiry and true market orders (contract), then drop the "keeper-filled" caveat from the UI.
2. Add / reduce / partial close and a single-transaction reverse (contract).
3. Richer events (contract), then exact history and venue analytics.
4. Favourites and an expired section in the market selector; hide contracts mode on crosses; USD/JPY toggle.
5. Fix the account-bar placement; make ticket settings discoverable; "up to" on total required.
6. Onboarding strip for first-time wallets: add network, get test funds, approve once, first trade.

## Not verified

Real wallets and signing prompts, wrong-network switching, Arc's 20 gwei gas floor through a wallet (the UI
leaves fees to the wallet; if a wallet under-prices, transactions will be dropped silently), real Kraken and
Arc RPC limits, Pyth mode, the Claim button for deferred payments, unstake and partial withdraw.
