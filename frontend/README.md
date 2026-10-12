# Dry Powder frontend

Trading terminal, venue activity feed and house (vault + staking) pages for the Dry Powder v2 protocol.
Next.js 15 (App Router), React 19, Tailwind 4, wagmi 2 / viem 2, lightweight-charts 5.

- `/trade` &mdash; markets discovered from the chain, chart with indicators, order ticket, positions / orders /
  history / alerts. `?market=BTC-USD` selects a market, `?account=0x…` watches any account read-only.
- `/activity` &mdash; live venue feed from event logs, totals, open interest, top traders.
- `/house` &mdash; vault NAV and share price, epoch settlement, deposit / withdraw, KEG staking.

Nothing about a deployment is compiled in. The same build serves any set of contracts.

## Two ways to host it

### 1. Node server (Docker)

```sh
npm ci && npm run build        # output: "standalone"
docker build -t dry-powder-frontend .
docker run --env-file .env -p 3000:3000 dry-powder-frontend
```

Configuration is read from the container environment on every request; change it and restart, no rebuild.
See `.env.example`.

### 2. Static bundle (any static host, any sub-path)

```sh
npm ci && npm run build:static   # writes out/
```

Copy `out/` to a bucket, a CDN, GitHub Pages, IPFS, or `python3 -m http.server`. It can live at the site root or
under any sub-path: pages are exported one directory deep (`trade/index.html`, `activity/index.html`,
`house/index.html`) and reference their assets as `../_next/…`, so no base path is baked in.

Put a `config.json` next to `index.html` (start from `out/config.sample.json`):

```json
{
  "perpEngineAddress": "0x…",
  "engineLensAddress": "0x…",
  "houseVaultAddress": "0x…",
  "rewardTokenAddress": "0x…",
  "usdcAddress": "0x…",
  "rpcUrl": "https://rpc.testnet.arc.network",
  "chainId": 5042002,
  "oracleMode": "publisher",
  "collateralSymbol": "USDC",
  "collateralIsTest": false
}
```

It is fetched at page load (`cache: no-store`), so repointing a deployment is editing one file. Every key can
also be overridden per visit with URL query parameters, which carry over as you move between pages:

```
https://host/any/path/trade/?engine=0x…&lens=0x…&vault=0x…&token=0x…&collateral=0x…&rpc=https://…&chain=5042002&mode=publisher
```

With all four addresses in the URL no `config.json` is needed at all. When any override is active the header shows
a **Custom deployment** badge: a link can point the UI at arbitrary contracts, so treat links from strangers the
way you would treat an unknown site.

Hosting notes:

- Serve directories with a trailing slash (`/trade/`). Every common static host redirects `/trade` to `/trade/`.
- `index.html` forwards to `./trade/` keeping the query string. `404.html` is self-contained.
- The server build ignores URL overrides on purpose; only the static bundle reads them.
- `npm run build` and `npm run build:static` share the `.next` working directory. Run one, take its output
  (`.next/standalone` or `out/`), then run the other.

## Configuration reference

| Environment (server build) | `config.json` (static) | URL parameter | Default | Meaning |
| --- | --- | --- | --- | --- |
| `PERP_ENGINE_ADDRESS` | `perpEngineAddress` | `engine` | required | PerpEngine |
| `ENGINE_LENS_ADDRESS` | `engineLensAddress` | `lens` | required | EngineLens (all aggregated reads) |
| `HOUSE_VAULT_ADDRESS` | `houseVaultAddress` | `vault` | required | HouseVault |
| `REWARD_TOKEN_ADDRESS` | `rewardTokenAddress` | `token` | required | RewardToken (KEG) |
| `USDC_ADDRESS` | `usdcAddress` | `collateral` | `0x3600…0000` | collateral token (Arc USDC, or TestUSDC) |
| `RPC_URL` | `rpcUrl` | `rpc` | `https://rpc.testnet.arc.network` | JSON-RPC endpoint (must allow browser origins) |
| `CHAIN_ID` | `chainId` | `chain` | `5042002` | chain id |
| `ORACLE_MODE` | `oracleMode` | `mode` | `publisher` | `publisher` or `pyth`, see below |
| `COLLATERAL_SYMBOL` | `collateralSymbol` | `symbol` | `USDC` | label for the collateral token |
| `COLLATERAL_IS_TEST` | `collateralIsTest` | `test` | `false` | shows **Get test funds** (`TestUSDC.mint(self, 10,000)`) |
| `KRAKEN_URL` | `krakenUrl` | `kraken` | `https://api.kraken.com` | tape prices and candles |
| `HERMES_URL` | `hermesUrl` | `hermes` | `https://hermes.pyth.network` | Pyth mode: price service |
| `PYTH_API_KEY` | `pythApiKey` | &mdash; | empty | Pyth mode: sent as `Authorization: Bearer …` |
| `EXPLORER_URL` | `explorerUrl` | `explorer` | `https://testnet.arcscan.app` | transaction links |

`PYTH_API_KEY` ends up in the browser in both builds (the browser is what calls Hermes). Use a key you are
willing to expose, or put a proxy in front of Hermes and point `HERMES_URL` at it.

The oracle contract address is not configured: it is read from `engine.pyth()`.

## Oracle modes

Both modes sit behind one interface (`useMarketPrice` in `src/hooks/use-market-data.tsx`, actions in
`src/lib/actions.ts`), so the rest of the UI does not know which is active.

**`publisher`** (Arc Testnet today). A publisher pushes signed prices to the on-chain `PublisherOracle`; there
is no service a browser could fetch a signed update from, so the UI never sends one.

- Executable prices: the on-chain oracle, read through `lens.getMarkets()` once a second. The header shows the
  bid/ask and its age. When the on-chain price is older than `maxPriceAge` the market shows *Awaiting on-chain
  price*; orders can still be placed and are filled when prices resume.
- Tape and candles: Kraken public REST (`Ticker` every 2 s, `OHLC` per chart). ETH-BTC is the ratio of the two
  series, JPY-USD the inverse of USDJPY, gold uses PAXGUSD. Display only: nothing executes at these prices.
- Market open = a marketable `createLimitOrder` resting at ask x (1 + slippage) for a long, bid x (1 - slippage)
  for a short, labelled *Market (keeper-filled, ~1-2 s)*. Market close = `setTriggerOrder(market, Close, worst
  price)`. Limit, take-profit and stop-loss are ordinary keeper orders. Orders placed in the session are
  followed live (resting, then filled or cancelled) from the lens and from `OrderExecuted` / `PositionOpened` /
  `PositionClosed` / `PositionLiquidated` logs.

**`pyth`**. Prices stream from Hermes (SSE, falling back to polling; polling only when an API key is set,
because `EventSource` cannot send headers). Market open and close are direct `openPosition` / `closePosition`
calls carrying a fresh update and the Pyth fee. Compiles and is wired end to end, but has not been run against a
live Hermes since the key requirement came in.

## Code map

```
src/lib/config.ts        settings: env / config.json / URL, one table of names
src/lib/feeds.ts         display metadata per Pyth feed id (name, decimals, Kraken pair). Unknown feeds still work.
src/lib/instruments.ts   market -> Instrument, and the instrument-kind registry (perp, cross, fx, dated)
src/lib/oracle.ts        18-decimal quote maths mirroring PythOracle.peek (crosses, inversion)
src/lib/kraken.ts        ticker store, OHLC, cross / inverted candles
src/lib/pyth.ts          Hermes store and signed updates (pyth mode)
src/lib/actions.ts       every transaction the app sends; flows.ts composes them (open, close, reverse)
src/lib/events.ts        bounded-range eth_getLogs reader with live tail; history.ts builds account history
src/lib/math.ts          bigint mirrors of PositionMath / fee maths; position.ts values a position
src/lib/indicators.ts    EMA, SMA, Bollinger, VWAP, RSI, MACD
src/hooks/use-market-data.tsx   markets, prices (both modes), engine params, chain clock
src/hooks/use-account-data.ts   positions, orders, balances for the connected or watched account
src/components/trade/*   market header + picker, chart, order ticket, tables, account bar
src/components/activity/ venue feed
src/components/house/    vault, epoch, staking
e2e/                     local harness: chain, publisher + keeper, mock Kraken, scripted traders, click-through, video
```

`src/lib/abi.ts` is generated from the contracts (`node scripts/export-abis.mjs` at the repository root). Do not
edit it by hand.

### Adding an instrument type

1. Add a key to `InstrumentKindKey` and an entry to `INSTRUMENT_KINDS` in `src/lib/instruments.ts` (`match`
   decides membership from the on-chain market; entries are tried in order).
2. The market selector, strip, activity filters and tables pick it up from there.
3. If it needs its own rules (as dated futures do for expiry and settlement), branch on `instrument.kind` or on
   the underlying fields in `market-header.tsx` and `order-ticket.tsx`.

A new feed only needs a row in `src/lib/feeds.ts` for a name, decimals and a Kraken pair; without one the market
still lists and trades, with a chart built from the oracle prices seen in the session.

## Keyboard shortcuts (trade screen)

`B` / `S` side, `M` / `L` order type, `Q` focus size, `Enter` submit, `X` close the position in this market,
`[` / `]` previous / next market, `/` search markets, `I` show / hide indicators, `T` pick a limit price on the
chart, `?` list of shortcuts, `Esc` close.

## Development

```sh
npm run dev          # needs the environment from .env.example (for example in .env.local)
npm run typecheck
npm run build
npm run build:static
```

End-to-end tests run against a local chain with the real contracts; see `e2e/README.md`.
