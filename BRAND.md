# Dry Powder: brand ("Reserve")

**Keep your powder dry.** Dry powder is capital held in reserve, ready for the next trade. The brand is about
the discipline that keeps it there: you see the worst case before you trade, and nothing you can lose is hidden.

The venue offers up to 1000x. The brand does not sell that. It sells knowing exactly what 1000x costs you.

## Principles

1. **Risk is the loudest thing on screen.** The interface is calm (ink, paper, one cool signal colour) so that
   the risk card, liquidation distances and loss figures are what draw the eye. Colour means risk, not decoration.
2. **Worst case first.** Every ticket leads with *most you can lose*, *liquidated after an X% move*, *loss at
   your stop* and *most you can make*, before entry or fees.
3. **Plain numbers.** Percent moves, not just prices. "0.09% move" says more than "liq 99,910".
4. **Same rules for people and agents.** Agents get the same guardrails, enforced on-chain by agent accounts.

## Colour

| Token | Value | Use |
| --- | --- | --- |
| ink | `#0D0F12` | page background |
| panel | `#14171C` | cards and panels |
| raised | `#1B1F26` | menus, tooltips, toasts |
| line | `#262B33` | borders |
| paper | `#E8ECF1` | text, the mark's vessel |
| muted | `#A0A9B6` | secondary text |
| signal | `#7EA6FF` | brand, primary action, focus, selection (the only accent) |
| long | `#3ECF8E` | long, profit, low risk |
| warn | `#E6B450` | moderate risk, warnings |
| hot | `#F59E4B` | high risk, liquidation lines on the chart |
| short | `#F0646F` | short, loss, extreme risk |

Risk bands (order ticket risk card and the account's nearest-liquidation strip), by the move that liquidates:
**Low** ≥ 10% (long), **Moderate** ≥ 3% (warn), **High** ≥ 1% (hot), **Extreme** below 1% (short).
Anything above 100x is Extreme by construction (a 1000x position is liquidated by a 0.09% move).

## Type and shape

- **Inter** (variable) for everything readable; display sizes use weight 650 and -0.02em tracking. No all-caps.
- **IBM Plex Mono** for every number (tabular, lining).
- Corners: 6 px for panels, fields, buttons; 4 px for chips, tags and small controls.

## Mark

A vessel held part full: a rounded square in paper, with a signal-blue reserve in the lower half and a dotted
fill line above it. Capital kept back is what lets you take the next trade.
`frontend/public/favicon.svg`; `Wordmark` in `frontend/src/components/header.tsx`. The wordmark is "Dry Powder"
in Inter 650, sentence case.

## Voice

Dry, short, capital-markets plain. Say the number. Never hype leverage.

- Yes: "Most you can lose: 10.40 USDC." "Liquidated after a 0.09% move." "Above 100x, trades fill through the keeper."
- No: "Go 1000x!" "Moon." "Degen mode."

## Names

- `DRY`: loss-rebate token (ERC-20 name "Dry Powder"); 100 DRY per 1 USDC lost; staked DRY earns 15% of house
  profit above the vault's high-water mark. (Was `KEG` in v1/v2.)
- `dpUSDC`: vault share (name "Dry Powder USDC").

Tokens live in `frontend/src/app/globals.css` (`@theme`); chart colours in
`frontend/src/components/trade/price-chart.tsx`.

## Name check (2026-10-12, web searches only; not legal advice)

- No crypto protocol, exchange or token named Dry Powder was found.
- "Dry powder" is an everyday finance term for uninvested capital. That makes conflicts unlikely and also makes the
  words alone hard to register or defend as a trademark; protection would rest on the logo and the overall look.
- Ticker `DRY` has not been checked against existing tokens. Check before any listing.
- Not checked: trademark registers directly (USPTO, EUIPO, UKIPO) and domains.
