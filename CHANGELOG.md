# Changelog

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
