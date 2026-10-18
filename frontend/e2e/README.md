# Local end-to-end harness

Everything the frontend talks to, running on one machine with no internet: a local chain with the real compiled
v2 contracts, a bot that plays price publisher and keeper, a mock of Kraken's public API, the static bundle
served under a sub-path, and optional scripted traders.

```
contracts/out  ->  anvil  ->  deploy.mjs      PublisherOracle + TestUSDC + vault/token/engine + lens + 8 markets
                              prices.mjs      one price model ...
                              bot.mjs         ... published on-chain every second (signed updates) + keeper
                              kraken-mock.mjs ... and served as Kraken Ticker / OHLC
                              static-server   out/ under http://127.0.0.1:8648/arc/ with a generated config.json
                              traders.mjs     N unlocked accounts trading at random
```

## Run it

```sh
# once: compile the contracts and build the static bundle
(cd ../contracts && forge build --offline --skip test --skip script)
npm run build:static

# terminal 1: the stack (leave it running; Ctrl-C stops everything, anvil included)
TRADERS=8 RATE=2 node e2e/stack.mjs

# terminal 2: the click-through (33 steps; about 6 minutes, most of it waiting for the dated future to expire)
node e2e/run.mjs                 # or a subset: node e2e/run.mjs trade,house
```

Open http://127.0.0.1:8648/arc/trade/ in a browser to poke at it by hand. There is no wallet there unless your
browser has one pointed at `http://127.0.0.1:8645` (chain id 31337); use watch mode
(`?account=0x70997970C51812dc3A010C7d01b50e0d17dc79C8`) to follow the account the tests trade with.

### Stack options (environment variables)

| Variable | Default | Meaning |
| --- | --- | --- |
| `TRADERS` | `0` | number of scripted traders |
| `RATE` | `3` | their combined actions per second |
| `EXPIRY_SECONDS` | `240` | lifetime of the dated future (`run.mjs` waits for it to expire) |
| `SETTLE_DELAY` | `20` | seconds after expiry before the keeper settles the market (the UI can do it first) |
| `EPOCH_SECONDS` / `LOCK_SECONDS` / `STREAM_SECONDS` | `60` / `20` / `60` | vault epoch, deposit lock, yield stream |
| `VOLATILITY` | `1` | multiplier on price movement; raise it for more liquidations |
| `ANVIL_PORT` / `KRAKEN_PORT` / `WEB_PORT` | `8645` / `8647` / `8648` | ports |
| `ANVIL` | `~/.foundry/bin/anvil` | anvil binary |

`run.mjs` and `record.mjs` read `BASE` (default `http://127.0.0.1:8648/arc`) and `CHROMIUM` (path to a Chromium
binary; by default the one under `PLAYWRIGHT_BROWSERS_PATH` or `/opt/pw-browsers`). Playwright itself is not a
dependency of the frontend: install it (`npm i -D playwright`) or have it resolvable from `NODE_PATH`.

The mock Kraken server has two extra endpoints for tests. `GET /control/freeze?feed=EUR&on=1` stops that feed
from being published on-chain while the tape keeps moving, which is how the "awaiting price" state is produced.
`GET /control/move?feed=SOL&pct=-0.4` shifts a feed's price at once, to push it through a stop-loss or an alert.

## Record a demo video

```sh
TRADERS=100 RATE=4 EXPIRY_SECONDS=3600 node e2e/stack.mjs     # terminal 1
node e2e/record.mjs                                            # terminal 2 -> e2e/out/demo.webm
```

Sixty seconds at 1440 x 900: `/trade` (connect, test funds, a keeper-filled long with brackets, a limit price
picked on the chart), `/activity`, `/house`. `DURATION`, `WIDTH`, `HEIGHT` and `OUT` change the defaults. Edit
the three blocks in `record.mjs` to change the script; each scripted click is wrapped so a miss never loses the
recording.

## How the wallet is faked

`browser.mjs` injects a `window.ethereum` that answers `eth_accounts` with anvil's account #1 and forwards
everything else to anvil, where that account is unlocked. "Confirm in your wallet" therefore resolves at once;
nothing about signing prompts is exercised.

## What the click-through covers

`trade`: sub-path load and chain market discovery, connect, test funds, approve + keeper-filled market long with
TP/SL in %, inline TP edit (and refusal of a wrong-side trigger), limit price by chart click, cancel with refund,
typed alternative to the chart click, keeper Close and history, risk-based sizing with a stop-loss fill that
mints DRY. `instruments`: dated future in contracts, cross market, inverted FX and gold decimals, Reverse,
awaiting-price order. `extras`: shortcuts, indicators, alert toast, CSV. `watch`, `activity` (totals, filter,
frame pacing, trader click-through), `settle` (expiry, Settle market, Settle & close), `house` (deposit, lock,
withdraw, stake, settle epoch, claim), `responsive` (360 / 768 px, no wallet, URL-only config, bad config).
Assertions read the chain directly wherever a number matters.
