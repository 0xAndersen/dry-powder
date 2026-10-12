# First-run report: 100 trader agents on House Money v2

**Where this ran.** A local chain (anvil, chain id 5042002, 1 s blocks, base fee pinned at Arc's 20 gwei floor)
running the real compiled v2 contracts, with test collateral (tUSDC) and a simulated price feed (random walk
with 0.7 to 1.5% jumps and one 85 s gold-feed outage). **It did not run on Arc Testnet**: see "Going live"
at the end. The harness, agents and checks are the ones that will run on testnet, unchanged.

Raw data: `ops/test/output/` (`summary.json`, `agents.csv` with one row per agent, `report-pages.json`,
`gas.json`, `result.json` with all 32 acceptance checks). Video: `media/demo-local-100-traders.webm`.

## Headline

| | |
| --- | --- |
| Agents | 100 started, 100 finished, 0 failed, in 7 min 28 s |
| Capital | 10,000 tUSDC each; every agent deployed at least 10,044 of cumulative margin |
| Round trips | 607 (minimum 5 per agent, maximum 8) |
| Volume | 36.76M notional; peak open interest 3.33M against a 5M vault |
| Agents' combined result | -14,778 (31 of 100 profitable) |
| House result | +17,050 (trader losses 50,594 + fees 22,338 - profits paid 55,881); vault NAV 5,000,000 -> 5,014,483 |
| Staker yield | 2,557 set aside over 5 epochs (15% of profit above the high-water mark), 2,472 claimed by 32 staking agents |
| Liquidations | 6, all on 100x "degen" agents |
| Dated future | settled 1.9 s after expiry; 8 positions closed at the settlement price |
| End state | 0 positions, 0 orders, engine balance 0, vault balance = house balance + pending yield, all 6,000,000 minted tUSDC accounted for |

The house made money only because of fees: on price alone traders came out about 5,300 ahead (profits paid
55,881 against losses 50,594), and the 22,338 of fees more than covered it. Fees came to 6 bps of volume
(5 bps a side plus the skew surcharge on opens, with liquidated margin not paying a close fee).

## By strategy

| Strategy | Agents | Round trips | Volume | PnL total | PnL avg | Best | Worst | Winners | Liquidations | Fees paid |
|---|---|---|---|---|---|---|---|---|---|---|
| degen (100x, brackets optional) | 8 | 45 | 12.36M | +4,189 | +524 | +7,280 | -3,351 | 4/8 | 6 | 7,891 |
| wallet (keeper-executed paths only) | 7 | 44 | 0.96M | +69 | +10 | +341 | -457 | 5/7 | 0 | 589 |
| swing (low leverage, wide stops) | 8 | 49 | 0.59M | -308 | -38 | +93 | -219 | 4/8 | 0 | 343 |
| carry (FX) | 8 | 47 | 1.23M | -709 | -89 | +36 | -177 | 2/8 | 0 | 632 |
| maker (resting limits with brackets) | 8 | 49 | 1.19M | -711 | -89 | +141 | -418 | 3/8 | 0 | 712 |
| momentum | 10 | 60 | 2.86M | -1,051 | -105 | +318 | -395 | 3/10 | 0 | 1,811 |
| mean reversion | 10 | 60 | 2.12M | -1,083 | -108 | +47 | -332 | 1/10 | 0 | 1,091 |
| hedger (two correlated markets) | 7 | 48 | 1.18M | -1,274 | -182 | +96 | -508 | 1/7 | 0 | 720 |
| dated future (holds into settlement) | 8 | 43 | 1.47M | -1,645 | -206 | +284 | -575 | 2/8 | 0 | 941 |
| pairs (ETH-BTC cross) | 8 | 50 | 2.16M | -2,396 | -300 | +155 | -1,181 | 3/8 | 0 | 1,200 |
| breakout | 8 | 51 | 3.27M | -3,403 | -425 | +167 | -1,422 | 2/8 | 0 | 1,952 |
| scalper (tight brackets, high leverage) | 10 | 61 | 7.36M | -6,456 | -646 | +397 | -1,816 | 1/10 | 0 | 4,484 |

Reading it:
- **Turnover is what costs traders here.** Scalpers and breakout traders did a third of the volume and took
  two thirds of the losses; their fees alone (6,436) nearly equal their loss. Swing traders paid 343 in fees and
  were close to flat.
- **The degen cohort is the house's tail risk.** One agent made +7,280 on 10,000 (a 100x position that ran),
  and the group was the only profitable one, while also supplying all six liquidations. The 10x-margin profit
  cap did not bind in this run.
- **Staking income mattered.** HOUSE rebates turned agent 0's -27 of trading PnL into +302 after yield. With
  only 32 stakers sharing 2,557, early stakers are over-rewarded (see finding 3).
- **The keeper-only "wallet" path works**: 44 round trips, zero reverts, results in line with direct traders.

Top five: degen #92 +7,280; degen #98 +1,163; scalper #70 +397; wallet #24 +341; momentum #52 +318.
Bottom five: degen #41 -3,351; scalper #34 -1,816; scalper #29 -1,573; breakout #76 -1,422; pairs #75 -1,181.

## How the venue handled it

| Area | Result |
| --- | --- |
| Decision-to-inclusion latency (agents) | p50 0.90 s, p95 1.39 s, max 2.43 s (1 s blocks locally; Arc's are ~0.5 s) |
| Keeper: trigger met -> executed | median 1.09 s, p95 1.49 s |
| Keeper fills | 93 limit, 72 take-profit, 83 stop-loss, 44 keeper closes; 0 missed in the final run |
| Oracle | 2,825 signed prices, 192 on-chain heartbeats; longest gap between pushes 36 s; no stale-price revert |
| Reverts | 16 across 2,095 agent transactions (0.8%), all `OrderNotFound` / `PositionNotFound` races where an agent and the keeper acted on the same thing; 5 were mined |
| RPC | 9,556 calls, 0 errors (a separate run with 8.7% injected RPC failures also completed) |
| Resume | the page was reloaded at 35% of the run and continued without losing a trade |
| Feed outage | gold feed frozen for 85 s: the publisher stopped signing it, the market showed closed, trading resumed on recovery |

### Gas (this sets the testnet budget)

714.3M gas over 2,300 transactions = **14.3 USDC at 20 gwei** (15.1 USDC measured including the 1 gwei tip).
The 40 USDC on the deployer covers a run with room to spare; the peak amount tied up in agent gas floats is
about 27 USDC, most of which is swept back at the end.

| Transaction | Gas | Transaction | Gas |
| --- | ---: | --- | ---: |
| open | 557k | keeper fill of a limit order | 766k |
| open with TP + SL | 879k | keeper fill of SL / TP / close | 296k / 285k / 250k |
| close | 222k | liquidation (per tx) | 239k |
| place limit order | 338k | oracle push (3.4 feeds avg) | 95k |
| set TP / SL / close order | 257k / 195k / 246k | settle epoch | 302k |

## Findings to act on

Ordered by how much they should change the next iteration.

1. **Opening a position is expensive, and gets more expensive with every market.** Each open reads the
   vault's NAV for the open-interest cap, which now marks every market with open interest to market: 249k of
   the 557k gas with 8 active markets, about 23k per market. At the 64-market ceiling an open would cost about
   1.5M gas. Fix: cache the marked value per block, or track unrealised PnL incrementally instead of looping.
2. **Keeper "market" orders can strand after a fast move, and orders never expire.** A marketable limit that
   misses its slippage bound simply rests with the trader's margin escrowed; a bounded close order does the
   same. It happened once or twice per run in earlier runs (agents cancel after 25 s). Fix: an expiry on
   orders (auto-cancel and refund), and immediate-or-cancel semantics for market orders.
3. **HOUSE is minted on gross losses, so the staker pool is cheap to capture.** A hedged long+short pair no
   longer drains LPs (that exploit is closed and has a regression test), but it still mints rebate tokens for
   the price of the fees: one cycle minted 8M HOUSE for 2,000 of fees and then took 98.8% of the staker
   stream. Fix: mint on net loss per account over an epoch, or weight rebates by fees paid rather than loss.
4. **The mark counts losses the house cannot collect.** Unrealised trader losses beyond margin are counted in
   full, so in the window between a price gap and the liquidation an LP can redeem at a NAV that is too high
   (measured: 1,000,499 out against 930,800 left for the LP who stayed). Fix: cap each side's unrealised loss
   at its margin in the mark (needs per-market margin totals).
5. **Staker yield is settled at epoch boundaries, not at flows.** An LP who redeems just before `settleEpoch`
   and re-deposits after it avoids the 15%; one who deposits just before pays part of it on gains made earlier.
   Fix: price shares net of the accrued staker share.
6. **100x straddles remain a free option on gaps**, now bounded by the profit cap (1,860 profit on 2,000
   margin for a 3% gap; 8,860 for 30%). Lower leverage on gappy markets is the lever; FX, gold, the cross and
   the future already launch at 50x.
7. **Dated futures settle at "the first price someone submits after expiry", not the price at expiry**, and
   an expired market is not settled until someone calls. The keeper did it in 1.9 s here; a contract-level
   guarantee needs Pyth's price-at-timestamp verification.
8. Smaller: the reserve nets long against short only within one market (a BTC perp long against a BTC future
   short still ties up the vault); a market whose oracle is unusable is marked at zero; `currentFundingIndex`
   panics if the block clock is behind the last funding time (only reachable in simulators); settled futures
   stay listed for ever and there is no delisting.

Open PoCs for 3 to 6 and the smaller items are in `contracts/test/KnownIssues.t.sol` (12 passing tests).
What v2 closed is in `contracts/test/Regressions.t.sol` and summarised in `SECURITY.md`.

## Going live on Arc Testnet

What is ready: contracts (314 tests green), the deploy path, the publisher/keeper/agent runtime (acceptance run
above), the frontend (static bundle that takes addresses from the URL), and a funded deployer
(`0x732E77DBA1623FD77471BDFF9dFEB686Db67C8d7`, 40 USDC of gas).

What stopped me: my workspace cannot reach Arc. I verified from the browser pane on your Mac that the Arc RPC,
Multicall3 and Kraken are reachable and began loading the runtime into that pane, but running an autonomous
trading program with signing keys inside your browser was blocked by a safety control on my side, and I did
not work around it. Running it yourself is one command:

```bash
cd ops && npm ci && npx playwright install chromium
set -a; . ./.env.testnet; set +a          # the throwaway deployer key I generated
HEADLESS=0 node run-testnet.mjs           # deploys, funds 100 agents, trades for 30 min, sweeps, writes reports
```

It prints the frontend link (addresses in the query string) as soon as the contracts are deployed; serve the
static UI with `cd frontend && npm ci && npm run build:static && npx serve out` and open `/trade/?…`, then
`/activity/` to watch the agents live. Reports land in `ops/output-testnet/` in the same format as above.

Two things that differ on testnet and are untested: real Kraken prices move far less than the simulated feed in
30 minutes, so expect few or no liquidations unless the run is longer; and Arc's RPC rate limits are unknown
(the runtime backs off and has a concurrency dial).
