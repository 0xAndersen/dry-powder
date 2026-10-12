# House Money: brand ("Cashier's Cage")

A neon sign over the cage at 2 a.m. Coral glow for the brand, mint for wins.

| Token | Value | Use |
| --- | --- | --- |
| night | `#111014` | page background |
| panel | `#1A181F` | cards and panels |
| neon | `#FF6B57` | brand, primary action, selection, focus |
| win | `#7DF2C0` | long, profit, positive |
| short | `#FF4D94` | short, loss, liquidation (pink, so it is never confused with brand coral) |
| warn | `#F5C15C` | warnings |

- Type: Bricolage Grotesque (variable). Heavy (800) for display, medium for text, tabular figures for numbers.
- Mark: a house outline in neon with a mint chip inside (`frontend/public/favicon.svg`, `Wordmark` in `frontend/src/components/header.tsx`).
- Glow is reserved for the wordmark and the one primary action on screen.
- Voice: short, plain, a little wry. "Up 42 USDC. That's house money now."
- Tokens: `HOUSE` (loss-rebate token, name "House Money"), `hmUSDC` (vault share, name "House Money USDC").
- All colour tokens live in `frontend/src/app/globals.css` (`@theme`); chart colours in `frontend/src/components/trade/price-chart.tsx`.

## Name check (2026-10-12, web searches only; not legal advice)

- US registration 4401067 HOUSE MONEY (SG Gaming, class 41: games of chance and side bets, online or in casinos) is live.
  Different class from a derivatives venue, but the casino styling narrows the gap. Get counsel's view before mainnet.
- The ticker HOUSE is used by Housecoin on Solana (listed on major exchanges). Consider a different ticker before mainnet.
