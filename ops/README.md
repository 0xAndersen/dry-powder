# Dry Powder ops runtime (`ArcOps`)

One JavaScript program that runs inside a browser tab and, by itself, deploys the Dry Powder protocol, publishes
oracle prices, runs a keeper and runs a cohort of 100 autonomous trader agents, then reports on all of it.

It exists because the operator's only route to Arc Testnet is a browser pane that can navigate, evaluate a
JavaScript string, and take screenshots. No Node, no file system, no wallet extension.

- Literal snippets for every step: [`OPERATOR_CHEATSHEET.md`](./OPERATOR_CHEATSHEET.md)
- Source: `src/` (plain ES modules). Build output: `dist/`. Local acceptance harness: `test/`.

## What gets pasted

| file | size | what |
| --- | --- | --- |
| `dist/chunks/01.js` .. `03.js` | <= 24,000 chars each | `(window.__arcSrc = window.__arcSrc \|\| []).push("NN:<base64>"); "ok NN"` |
| `dist/boot.js` | about 820 chars | checks every piece (length + FNV-1a), inflates, evals, returns `"booted ArcOps 1.0.0"` |

`dist/manifest.json` has the exact counts for the current build (3 chunks, about 70,400 characters in total
including boot). The payload is one raw-deflate stream (zopfli) of `[u32 length][minified runtime][7 creation
bytecodes]`, base64-encoded; the tab inflates it with `DecompressionStream("deflate-raw")` (Chromium 103+). viem is NOT in the
payload: it is imported at `init` from `viemUrl` / `viemAccountsUrl` (esm.sh by default). ABIs are
human-readable fragments generated from `contracts/out` and contain only what the runtime calls.

Rebuild after any contract change (the ABI is frozen, the bytecode is not):

```sh
cd contracts && PATH=$HOME/.foundry/bin:$PATH forge build --offline --skip test --skip script
cd ../ops && npm install && npm run build      # prints the manifest
```

`manifest.json` records `bytecodeSha256` and per-contract sizes so a build can be matched to the artifacts.

## Runbook for Arc Testnet

| # | call | sends tx | expected time | result |
| --- | --- | --- | --- | --- |
| 0 | navigate to `https://example.com` | | | neutral origin, no CSP |
| 1 | paste 3 chunks, then `boot.js` | | 4 calls | `"booted ArcOps 1.0.0"` |
| 2 | `ArcOps.init(config)` | no | 2 to 5 s (imports viem) | derived addresses, head block |
| 3 | `ArcOps.preflight()` | no | 1 s | chain id, balance, cost estimate, `sufficient` |
| 4 | `ArcOps.deploy()` | 20 | about 1 min (repeat while `pending`) | address book |
| 5 | `ArcOps.fund()` | 5 | about 15 s | 102 accounts funded |
| 6 | `ArcOps.start()` | | 2 s | first status |
| 7 | `ArcOps.status()` every 30 to 60 s | | `runMinutes` | progress |
| 8 | `ArcOps.sweep()` (automatic by default) | yes | 20 to 60 s | end-of-run checks |
| 9 | `summary()`, `leaderboard()`, `report(0..4)`, `gas()` | no | 1 call each | reports |
| 10 | `ArcOps.sweep({returnGas:true})` | 102 | about 20 s | unspent gas back to the deployer |

Times for steps 4, 5, 8 and 10 are estimates for Arc's 0.5 s blocks; on the local 1 s chain the measured values
were 20 s, 5 s, about 40 s and 3 s. `deploy`, `fund` and `sweep` never block an evaluate call for more than
about 25 s: they return `{pending:true, step}` and continue in the page; calling again waits again.

The dated BTC future expires `params.futureExpirySeconds` after the deploy step that lists it. For a 30 minute
run started right after funding, 900 puts settlement in the middle of the run.

### Config (`init`)

Only `deployerKey` and `seed` are required. Defaults:

```js
{
  rpcUrl: "https://rpc.testnet.arc.network", chainId: 5042002,
  viemUrl: "https://esm.sh/viem@2.21.0", viemAccountsUrl: "https://esm.sh/viem@2.21.0/accounts",
  krakenUrl: "https://api.kraken.com",
  collateral: "test",            // "usdc": use usdcAddress (default 0x3600...0000) and fund agents by transfer
  agents: 100, agentCapital: 10000, vaultSeed: 5000000,
  gasPerAgent: "0.14", keeperGas: "2", publisherGas: "0.5",   // native USDC floats, decimal strings
  topUpAmount: "0.06", lowWater: "0.06", deployerReserve: "0.3", tipGwei: 1, fundBatch: 50,
  gasCache: true, txTimeoutMs: 45000, logRange: 500, ixLag: 1,
  params: { maxPriceAgeSeconds: 30, withdrawLockSeconds: 120, epochSeconds: 300, streamSeconds: 300,
            futureExpirySeconds: 900, maxConfBps: 50, maxOiToNavBps: 30000, minMargin: 5,
            oiCapShare: 0.6, skewScaleShare: 0.1 },         // per-market OI cap / skew scale as a share of vaultSeed
  pace: { tradesPerAgent: [5, 7], runMinutes: 30, slippage: 0.005, tickMs: 2000, stakerShare: 0.3, lpAgents: 5,
          lean: false, mix: null, maxFailStreak: 25, autoSweep: true, grace: 0.3 },
  publisher: { pollMs: 1000, heartbeatMs: 10000, moveBps: 5, minGapMs: 2000, staleFeedMs: 60000,
               maxPollAgeMs: 5000, pushFactor: 1.3 },
  keeper: { refreshMs: 2000, tickMs: 500, batchSize: 20, settleBatch: 25, maxInflight: 6, reuseOnchain: true,
            ageMargin: 3, stuckMs: 20000, lateMs: 10000 },
  rpc: { concurrency: 8, batchMax: 30, batchWaitMs: 10, retries: 6, timeoutMs: 15000 },
  intervals: { headMs: 1000, receiptMs: 600, indexMs: 1000, sampleMs: 5000, topUpMs: 15000 }
}
```

The dials that trade richness for gas:
- `pace.lean: true`: every agent only uses direct `openPosition` / `closePosition` (no brackets, no orders).
  About 25% less gas, and the order paths are not exercised.
- `pace.mix: { <archetype>: weight }`: overrides the cohort weights (defaults: momentum 10, meanrev 10,
  breakout 8, scalper 10, swing 8, pairs 8, carry 8, dated 8, maker 8, degen 8, hedger 7, wallet 7). The
  expensive ones are `maker` and `wallet` (keeper-executed opens) and `scalper` / `meanrev` (two brackets).
- `pace.tradesPerAgent`, `publisher.heartbeatMs` / `moveBps`, `tipGwei`.
`preflight()` recomputes the estimate for whatever is configured.

### Reading `status()`

```
phase            init -> deployed -> funded -> running -> sweeping -> ended
uptimeS / runS   seconds since start() / configured run length
head / indexed   latest block seen / last block whose events are applied (stays 1 to 2 behind)
agents           n, done, active, failed, tripsMin, tripsAvg, marginShort (agents still below their capital in
                 cumulative margin)
trades           opens, closes, liqs, orders, fills by order type (0 limit, 1 TP, 2 SL, 3 close)
volume, oi, nav  collateral units; openPos / openOrd as last read from the lens
publisher        polls, pollErr, pushes, lastOkS (seconds since Kraken answered; > 5 means no fresh prices),
                 closed (feeds whose ticker stopped changing for 60 s)
keeper           liqs, fills, settledMkt, settledPos, epochs, err (non-benign failures by revert name)
reverts          top revert names over all agents; "(revertedOnChain)" counts those that were mined
txs / txErr      transactions included / nonce resyncs, slow or missing inclusions
rpc              req, http, errors, errRate, retries, noBatch (true if the endpoint refused batches)
native           deployer / keeper / publisher native balances (updated every 15 s)
topUps           gas top-ups sent to accounts that ran low
anomalies        kind -> count (details in summary())
jobs, lastErr    state of deploy / fund / sweep and the last internal error text
timers, visible  "worker" timers are immune to background-tab throttling; visible should be "visible"
```

Healthy run: `agents.done` rises steadily after about half the run, `failed` 0, `rpc.errRate` under a few
percent, `publisher.lastOkS` 0 to 2, `native.deployer` falling slowly, `keeper.err` empty.

### Resume after a reload

All page state dies with the page; everything needed is in `localStorage` of the origin, written once per second
and again on `pagehide`: config (including the deployer key and the seed), addresses and deploy plan, funding
flags, per-agent progress and results, the last indexed block, gas statistics, the price-history tail and each
ticker's last-change time. Keys are never stored: publisher, keeper and agent keys are
`keccak256(seed + "/" + role + "/" + index)`.

Go back to the same origin, paste the chunks and boot again, call `ArcOps.resume()`. It rebuilds the accounts,
replays the events mined while the page was away (trade statistics come from events, so nothing is lost),
realigns each agent's positions and orders with the lens, re-reads nonces and restarts the loops if the run was
running. Its `next` field says which call comes next. `deploy()` and `fund()` are idempotent: each step first
checks the chain.

`ArcOps.reset()` (or `init({..., reset:true})`) wipes the stored state. Funds are not lost by that: the same
seed re-derives the same accounts.

The deployer key sits in `localStorage` of `example.com` in that browser profile until `reset()`. This is a
testnet key; treat it accordingly.

## What runs in the page

**RPC layer** (`src/rpc.js`): `fetch` only. Calls made within 10 ms travel as one JSON-RPC batch (falls back to
single requests for good if the endpoint answers a batch with a non-array). Global limiter of 8 concurrent HTTP
requests. Exponential backoff with jitter on 429, 5xx, timeouts and network errors (6 retries), and on
rate-limit JSON-RPC errors. Every error is counted by kind.

**Transactions** (`src/chain.js`): one nonce-managed sender per account; EIP-1559 with
`maxFeePerGas = max(2 * baseFee, 20 gwei) + tip`; gas = estimate * 1.25, or after 8 samples of a call type the
largest estimate seen * 1.6 without a new estimate (agents only; the keeper always simulates through
`eth_estimateGas`; a close with keeper-executable orders attached is always simulated). Receipts are polled in
one batch for all pending hashes. Custom errors of all shipped contracts are decoded by selector; a transaction
that reverted on-chain is replayed with `eth_call` at its block to name the error.

**Publisher** (`src/publisher.js`): polls Kraken's Ticker for the six pairs once per second (exponential
backoff on HTTP or Kraken errors), mid = (bid+ask)/2, conf = max(half spread, 1 bp). Signs one update per feed
per second with the derived publisher key and keeps the latest in memory; agents and the keeper ask for
`fresh(market)`, which re-stamps the newest quote to the current chain second. On-chain it pushes ONE
`updatePriceFeeds` per heartbeat (10 s) or when a feed moved more than 5 bp against what the oracle stores,
never more often than every 2 s, and only for feeds that need it: it tracks what every in-page transaction
already wrote, so feeds that traders just refreshed are skipped. A ticker whose data has not changed at all for
60 s is treated as a closed market: no more signatures for that feed until it changes again
(`feedClosed` / `feedReopened` in the anomalies). If Kraken has not answered for 5 s nothing is signed at all.
Publish times use the chain clock (offset learned from block timestamps), never the local clock.

**Keeper** (`src/keeper.js`): reads the whole book from `EngineLens` every 2 s; every 500 ms compares it with the
in-page prices. Liquidations go first (`liquidateBatch`, sentinel rules as in `keeper/src/math.ts`), then order
execution mirroring the contract (`publishTime >= createdAt`, `> openedAt`, limit orders not filled through
their own stop, Close orders only within their bound), `settleMarket` after expiry with a price published at or
after it, `settlePositions` in batches, `vault.settleEpoch()` when due. If the price already stored on-chain
satisfies an order, it is executed with an empty update (cheaper). Up to 6 keeper transactions are in flight at
once. Expected reverts (lost races) are counted as `benign`, everything else as `errors`.

**Indexer** (`src/indexer.js`): one `eth_getLogs` per second over engine, vault and token. It is the only
writer of per-agent trade statistics and position/order mirrors, which is what makes the report exact and
resumable.

**Agents** (`src/agents.js`): 100 independent async loops with jittered pacing, spread over the run by a
per-agent schedule (cycle = 85% of the run / target trades). Each has a target of 5 to 7 round trips and sizes
its margin so that cumulative margin reaches its capital; it keeps trading past the target until it does, and
until it has used two markets. Archetypes:

| archetype | markets | leverage | entry | exit |
| --- | --- | --- | --- | --- |
| momentum | BTC, ETH, SOL | 5-20 | EMA cross, direct `openPosition` | signal flip / soft stop / time, `closePosition` |
| meanrev | ETH, BTC, XAU, SOL | 5-15 | z-score fade, open with TP+SL brackets | brackets (keeper) or time |
| breakout | SOL, BTC, ETH | 8-25 | channel break, open with SL bracket | stop moved to break-even with `setTriggerOrder` |
| scalper | BTC, ETH, SOL | 20-50 | micro momentum, tight TP+SL brackets | brackets (keeper) or time |
| swing | BTC, XAU, ETH, EUR | 2-5 | trend, direct | `setTriggerOrder` TP and SL after the open |
| pairs | ETH-BTC cross (+ legs) | 5-20 | ratio z-score | reversion / time |
| carry | EUR-USD, JPY-USD (inverted) | 3-12 | side that receives funding | time |
| dated | BTC future, BTC, ETH | 3-15 | future before expiry | held into settlement (`settlePositions`) |
| maker | BTC, ETH, SOL, XAU | 5-15 | two resting limit orders with brackets | other side cancelled (`cancelOrder`) |
| degen | BTC, ETH | 60-100 | chases the last move, no stops | profit target / time / liquidation |
| hedger | BTC, ETH, SOL | 4-12 | long one, short a correlated one | both closed together |
| wallet | BTC, ETH, EUR, XAU, JPY | 2-10 | marketable `createLimitOrder` | `setTriggerOrder(Close)` (keeper) |

About a third of the agents (and every degen) stake the KEG they receive and claim yield after an epoch
settles; five swing/carry agents also deposit into and later redeem from the vault. Before every direct open or
close an agent takes the freshest signed update from the publisher. An unexpected revert is recorded under its
decoded name and the agent carries on; 25 consecutive failures mark it `failed`.

## Reports

- `summary()` (under 8 KB): run, trades and fills by type, volume, open interest and NAV series, vault start/end
  and house PnL (losses + fees - profits), keeper (liquidations, fills, median/p95 delay from trigger condition to
  inclusion, settlement), publisher (pushes, largest gap between on-chain updates, largest staleness sampled
  on-chain), revert taxonomy, RPC error rate, decision-to-inclusion latency percentiles, gas by transaction type,
  PnL by archetype, the end-of-run checks, and the anomaly list.
- `report(page)`: 20 agents per page (about 4.6 KB), columnar (`cols` + `rows`): id, address, strategy (with
  `+lp` / `+stk`), markets traded (`<market index>:<opens>`, indices into `markets`), opens, closes,
  liquidations, settled, orders, fills, round trips, target, cumulative margin, volume, PnL (balance + open
  equity - capital), trade PnL, fees, funding, KEG earned and staked, yield claimed, best/worst trade, win %,
  reverts by name, median/p95 latency, gas spent, tx count, balance, state.
- `leaderboard()`: top and bottom 10 by PnL. `gas()`: count / average / maximum gas per transaction type.
- `agent(i)`: one agent in detail.

Anomaly kinds: `orderNotFilled` (keeper saw the condition hold for 20 s without a fill), `lateFill`,
`marketOrderNotFilled` and `closeOrderNotExecuted` (a wallet-style order was not executed in 25 s; the sample
shows limit/bound against the current price), `limitOnExpiredMarket`, `stuckPriceNotAfterOpen`,
`oracleStaleRevert`, `oracleStaleOnChain`, `feedClosed` / `feedReopened`, `settlementSlow`, `txNotIncluded`,
`paymentDeferred`, `payoutShortfall`, `deployerOutOfGas`, `runOverTime`, `deployTrioRestarted`.

## Gas budget

<!-- GAS-TABLE -->
Measured on the local chain (anvil, cancun, via-IR build of `contracts/src`), full acceptance run: 100 agents, 607 round trips, 7 minute pace, base fee pinned at 20 gwei, tip 1 gwei.

| transaction type | count | avg gas | max gas | USDC at 20 gwei |
| --- | ---: | ---: | ---: | ---: |
| `addMarket` | 8 | 180,516 | 196,096 | 0.0289 |
| `approve` | 106 | 46,269 | 46,269 | 0.0981 |
| `cancelOrder` | 88 | 94,869 | 97,864 | 0.1670 |
| `claimYield` | 86 | 80,782 | 133,628 | 0.1389 |
| `close` | 394 | 222,332 | 323,708 | 1.7520 |
| `deploy:EngineLens` | 1 | 1,480,833 | 1,480,833 | 0.0296 |
| `deploy:HouseVault` | 1 | 1,800,514 | 1,800,514 | 0.0360 |
| `deploy:PerpEngine` | 1 | 5,386,475 | 5,386,475 | 0.1077 |
| `deploy:PublisherOracle` | 1 | 632,328 | 632,328 | 0.0126 |
| `deploy:PythOracle` | 1 | 374,642 | 374,642 | 0.0075 |
| `deploy:RewardToken` | 1 | 1,048,880 | 1,048,880 | 0.0210 |
| `deploy:TestUSDC` | 1 | 483,937 | 483,937 | 0.0097 |
| `exec:close` | 44 | 250,081 | 282,992 | 0.2201 |
| `exec:limit` | 93 | 766,107 | 983,586 | 1.4250 |
| `exec:sl` | 83 | 296,222 | 362,818 | 0.4917 |
| `exec:tp` | 72 | 284,928 | 298,678 | 0.4103 |
| `fund:mint` | 2 | 1,408,806 | 1,408,818 | 0.0564 |
| `fund:native` | 3 | 1,269,570 | 1,856,573 | 0.0762 |
| `fund:topup` | 16 | 108,309 | 173,975 | 0.0347 |
| `limit:marketable` | 44 | 298,582 | 332,005 | 0.2628 |
| `limit:resting` | 132 | 338,208 | 372,115 | 0.8929 |
| `liquidateBatch` | 4 | 238,878 | 354,328 | 0.0191 |
| `lpDeposit` | 5 | 325,843 | 326,034 | 0.0326 |
| `lpRedeem` | 5 | 408,505 | 408,518 | 0.0409 |
| `open` | 342 | 556,989 | 640,000 | 3.8098 |
| `open+brackets` | 172 | 879,075 | 995,990 | 3.0240 |
| `push` | 192 | 95,023 | 354,403 | 0.3649 |
| `seed:deposit` | 1 | 207,993 | 207,993 | 0.0042 |
| `seed:mint` | 1 | 96,941 | 96,941 | 0.0019 |
| `setRiskParams` | 1 | 39,119 | 39,119 | 0.0008 |
| `settleEpoch` | 5 | 301,954 | 434,539 | 0.0302 |
| `settleMarket` | 1 | 105,933 | 105,933 | 0.0021 |
| `settlePositions` | 1 | 651,054 | 651,054 | 0.0130 |
| `stake` | 60 | 86,258 | 128,565 | 0.1035 |
| `trigger:close` | 44 | 245,534 | 256,874 | 0.2161 |
| `trigger:sl` | 67 | 195,159 | 256,871 | 0.2615 |
| `trigger:tp` | 16 | 256,703 | 256,717 | 0.0821 |

| group | gas | USDC at 20 gwei |
| --- | ---: | ---: |
| Deploy (7 contracts) | 11,207,609 | 0.224 |
| Configure: 8 markets, risk params, vault seed, approvals by deployer | 1,788,181 | 0.036 |
| Fund 102 accounts (Multicall3 batches) + top-ups | 8,359,266 | 0.167 |
| Publisher heartbeats | 18,244,416 | 0.365 |
| Keeper: order execution | 127,352,757 | 2.547 |
| Keeper: liquidations, settlement, epochs | 3,222,269 | 0.064 |
| Agents: direct opens and closes | 429,289,946 | 8.586 |
| Agents: orders (limit, trigger, cancel) | 94,115,933 | 1.882 |
| Agents: approvals, staking, yield, LP | 20,698,986 | 0.414 |
| **Total** | **714,279,313** | **14.286** |

Arithmetic: 714,279,313 gas x 20 gwei = 14.286 USDC; with the default 1 gwei tip (21 gwei effective) 15.000 USDC. The deployer's balance, measured, went from 40 to 24.911 after `sweep({returnGas:true})`: **15.089 USDC net** for the whole run (the extra 0.09 is the 102 return transfers at 21,000 gas each, sent after this table was read, and dust left in the accounts). `preflight()` had estimated 717,426,533 gas (15.066 USDC at 21 gwei) before anything was sent.

Cash flow matters more than the total: floats leave the deployer up front (100 x 0.14 + keeper 2 + publisher 0.5 = 16.5 USDC) and are topped up in `topUpAmount` steps as accounts run low (118 top-ups, 8.96 USDC, in this run). An account must hold `gasLimit x maxFeePerGas` (41 gwei) for its next transaction, about 0.06 USDC for a bracketed open, so roughly that much per agent is still in the accounts at the end: 11.01 USDC came back from 102 accounts. `preflight().required` (26.74 USDC here) is that peak, not the spend.

Why an open costs 556,989 gas: the engine's OI cap reads `vault.totalAssets()`, which marks the whole book (`unrealizedTraderPnl` loops every market with open interest, one oracle read each). Measured mid-run with all 8 markets active that read alone is 249,032 gas (62,490 with an empty book). Each bracket adds about 160k (a 10-slot order). For a 30 minute run on Arc add the publisher: 180 heartbeats x about 150k gas = 0.54 USDC (the 7 minute test run had 192 pushes because the mock moves more than 5 bp almost every second).
<!-- /GAS-TABLE -->

## Local acceptance test

```sh
cd ops && npm install
(cd test/mc3 && PATH=$HOME/.foundry/bin:$PATH forge build --offline)      # Multicall3 runtime for anvil_setCode
npm run build
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node test/run.mjs               # 100 agents, about 9 minutes
PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers node test/variants.mjs flaky    # also: nomc3 | usdc | lean
```

`test/harness.mjs` provides: `anvil --block-time 1` with chain id 5042002, the base fee pinned at 20 gwei every
block and Multicall3 installed at its canonical address (compiled from the canonical source in `test/mc3`); a
mock Kraken (random-walk tickers in Kraken's response shape with occasional 0.7 to 1.5% jumps, an optional
frozen pair and an optional outage); a static origin with a blank page and locally bundled ESM builds of viem;
an optional flaky JSON-RPC proxy (429 / 503 / dropped connections / batches refused). `run.mjs` injects the
chunks one `page.evaluate` per file, then boot, drives `init -> preflight -> deploy -> fund -> start`, reloads
the page a third of the way in and resumes, polls `status()`, finishes with `sweep()` and the reports, and
verifies the end state directly from the chain. Outputs of the last passing run are in `test/output/`
(`result.json` lists every check; `summary.json`, `leaderboard.json`, `report-pages.json`, `agents.json`,
`gas.json`, `status.json`, `preflight.json`, `addresses.json`, `run.log`; `variant-*.json` for the scenario runs).

Two small diagnostics are kept because their output is referenced as evidence: `test/diag.mjs` (catches
`EngineLens.getPositions` reverting with Panic 0x11 on anvil and replays it pinned to the block) and
`test/repro-funding-index.mjs` (the one-call reproduction of the cause).

## Limits and things to know

- Liquidations need price moves of about 0.9% against a 100x position within its holding time. The mock
  provides them; real markets in a 30 minute window may not, so a testnet run can legitimately end with zero
  liquidations. Nothing fakes prices to force one.
- Timers run in a Worker so a background tab does not slow the loops, but keep the pane visible anyway.
- `collateral: "usdc"` was only exercised locally against a 6-decimal stand-in token, not against Arc's native
  USDC precompile.
- The runtime has never talked to the real Arc RPC, Kraken or esm.sh from this sandbox (no route). The pieces
  that depend on their behaviour are isolated and configurable: batch support (automatic fallback), `logRange`,
  `ixLag`, `tipGwei`, `rpc.concurrency`, `publisher.pollMs`.
