# Security notes (v3.2)

Not professionally audited. v1 was reviewed adversarially by an independent reviewer; v2 was reviewed again by
the engineer who rebuilt the test-suite, who also fixed two defects found on the way. Every claim below has a
test: fixes in `contracts/test/Regressions.t.sol`, open issues as passing proofs-of-concept in
`contracts/test/KnownIssues.t.sol` (`forge test --match-contract "Regressions|KnownIssues" -vv`).

Custody held on every path tested, including an invariant suite: the engine holds exactly open margins plus
order escrows plus deferred payments, and the vault holds exactly its house balance plus unclaimed staker
yield. The open problems are economic.

## High leverage (v3)

1000x makes small price errors large: at 1000x a 0.09% move is the whole margin. What stops that becoming a way
to drain the vault:

- **No stale-price option.** Above `DIRECT_MAX_LEVERAGE` (100x) a position can only open or close through a
  keeper order, and a keeper order fills only at a price published after it was created (`PriceBeforeOrder`).
  A trader who sees the real price move cannot trade against the older on-chain price.
- **Bounded upside.** Profit per position is capped at 10x margin, so a 1000x position can take at most 10x its
  margin from the vault, the same bound as at 10x.
- **Open-interest caps** per market and side and as a share of vault NAV are unchanged; leverage does not change
  how much notional can be open.
- **Fees capped at 10% of margin per side**, so fees cannot exceed what the position can lose. Without the cap a
  1000x round trip at 5 bp would cost the whole margin.
- **Accepted:** at 1000x, the publisher's price noise (a few bp) decides many outcomes, and a liquidation at 90%
  leaves 10% of margin as the buffer for the keeper's delay. On testnet the publisher is trusted (below).
- Tests: `contracts/test/HighLeverage.t.sol`.

## Position management (v3.1)

v3.1 lets a position change after it opens: add to it, close part of it, add margin, sized take-profit and
stop-loss, stop-entry orders. Each new path keeps the v3 guarantees:

- **The clock restarts on every addition.** An addition (and `addMargin`) sets `openedAt` to now, so the next
  close needs a price published after it, as for a new position. Without this a trader could add at a stale
  on-chain price and close at a fresh one in the same block. `addMargin` needs it too: margin can bring a
  keeper-only position under 100x, where a direct close becomes possible.
- **Rounding goes against the trader.** The merged entry price comes from units (long rounds up, short rounds
  down) so mark-to-market stays exact; the blended funding index keeps funding owed at least what it was. A part
  closed releases margin rounded down, so the rest keeps any remainder.
- **The profit cap cannot be lifted.** The cap is 10x margin, so new margin would raise it. An addition to a
  position already past its cap reverts `ProfitCapReached` (profit beyond the cap is forfeit and stays so), and
  `addMargin` is refused while the position is in profit at the last price (`PositionInProfit`).
- **Caps apply to every increment.** Leverage, the direct-trade limit and open-interest caps are checked on the
  addition as on a new position; each increment is within the market's maximum, so the merged position is too.
- **A part closes like a position of its own**: price PnL and funding on its size, its own profit and fee caps,
  the DRY rebate on a loss. If what would remain is under the minimum margin, everything closes, so no position
  is left too small to be worth liquidating. Open-interest units are released exactly.
- **One bracket per type.** Take-profit and stop-loss on an addition move the existing orders and refund the
  execution fee escrowed for them; no order or escrow is orphaned. Stop-entry orders follow the limit-order rules
  (escrow, cancel, revalidation at fill) and, like limits, do not fill through their own stop.
- **Agent accounts.** `multicall` runs each call by delegatecall with the caller's own checks and is not
  payable, so a batch cannot reuse `msg.value`. `initAgent` works once, for the factory, in the deployment
  transaction. Note the change for policies: an agent's margin cap is per call, and since positions can now be
  added to, an agent can build a position larger than the cap over several calls. Size the cap and the account's
  balance for that.
- **Removed:** `liquidate(address)` and `liquidate(address, bytes[])` (keepers use `liquidateBatch`) and the
  getters of ten owner-bound constants, to stay under the EIP-170 size limit. No check was removed.
- **Trailing stops** (`TrailingStops`, outside the engine). An account approves the contract as an agent; anyone
  may `poke`, which moves the position's stop-loss behind the best mid seen, read from the engine's own
  `getPrice`. It only ever tightens a stop (a poker picks when, never where), works only for accounts from the
  venue's factory, and its only call into an account is `setTriggerOrder(market, StopLoss, …)`: approve it with
  the smallest policy an account allows (1 micro-USDC margin cap, 1x). A refused move (approval revoked) is
  skipped without failing the batch; a move short of gas is not taken for a refusal (a floor of 400k before the
  call, and a check that the call did not run dry), so gas estimates always leave enough. Accepted: a trail only
  sees the prices it is poked at, so between pokes a spike can pass unseen (the stop then trails less tightly,
  never more). Tests: `TrailingStops.t.sol`. Deployed as an add-on (`DeployAddons.s.sol`), so it can be
  replaced without touching the venue.
- **TWAP orders** (`TwapOrders`, outside the engine). An account approves the contract as an agent with a policy
  that covers a slice; anyone may `poke`, which places the next due slice as a keeper-filled market order through
  the account (`createLimitOrder` with a trigger of the engine's ask plus the TWAP's slippage, or bid minus it).
  What bounds it: the account's own policy for the contract caps every slice; an agent key may only start a TWAP
  whose slices fit its own policy (`AgentPolicyExceeded`), so approving the contract never widens what a key can
  open per call; a slice is due no earlier than `interval` after the last, whoever pokes; keeper fills use a
  price published after the order, so a poker picks when a due slice goes, never its price; a slice waits while
  the account holds the other side or the market has no usable price; three refusals in a row end the TWAP; a
  slice short of gas reverts the poke whole (a 500k floor). Accepted: a slice that cannot fill inside its bound
  rests as a limit at that bound until it fills or is cancelled; the owner can always cancel it or revoke the
  approval. Tests: `TwapOrders.t.sol`.
- Tests: `contracts/test/PositionManagement.t.sol` (32), `AgentAccount.t.sol`, and the invariant handler, which
  now adds, closes in part, adds margin and places sized and stop-entry orders while every invariant holds.

## Turbo markets and the rest of v3.2

v3.2 adds Turbo markets (a fee mode called Upside: no fee unless you win, up to 5000x), measures the vault's
risk in exposure rather than notional, and adds order expiry, margin removal, referrals and DRY on net results.
The engine no longer fits in one contract, so it is split in two.

- **The split engine.** `PerpEngine` holds the trading path and forwards every other call by `delegatecall` to
  `PerpEngineExt`, an immutable address checked in the constructor (its own immutables must match the engine's).
  Both inherit one storage layout from `PerpEngineBase`. The extension's functions refuse to run except through
  the engine (`NotDelegated`), so calling the extension directly does nothing. There is no upgrade path: a new
  extension means a new engine. `receive()` reverts.
- **Turbo fills only through keepers, at the mid.** An Upside market charges nothing to open or close, fills both
  ways at the oracle mid and keeps `profitShareBps` (20%) of a winning close's profit, rounded up. A direct trade
  at the mid would hand the trader half the spread and a stale-price option, so Upside markets refuse direct
  opens and closes (`OrdersOnly`): every fill is a keeper order at a price published after the order. The fee
  mode can change only while the market has no open interest, so open positions keep the deal they opened with.
  The v3.1 simulation found that a profit share without this rule loses most of its revenue to latency traders.
- **5000x is bounded by exposure, not notional.** A position can win at most `maxProfitMultiple` (10x) its margin,
  so the vault's real exposure to one side of a market is `min(open interest, side margin x 10)`. The vault cap
  (`maxOiToNavBps`, 3x NAV) applies to the sum of that exposure, and the reserve that holds LP withdrawals back is
  taken on the exposure skew. Notional per side is still capped per market (Turbo markets set it out of the way).
  A liquidation always moves the whole margin to the vault, so at 5000x the risk is on the profit side, which the
  cap and keeper-only fills bound. Accepted: at 5000x the liquidation threshold is a 0.018% move, so the
  publisher's price noise decides most outcomes; on testnet the publisher is trusted (below).
- **Turbo leverage is set by the keeper's tick.** Between two keeper ticks the price can run past a liquidation.
  The liquidated position loses only its margin; a position on the other side keeps the whole move. In Standard
  markets the spread and fees absorb this; Turbo markets have neither. The v3.2 simulation (a ~3 s keeper tick)
  found that a hedged pair on two accounts, one leg liquidated and the other closed past it, takes money from the
  vault on BTC and ETH above about 1000x: at 5000x the pair keeps about 0.12 of a margin per round on an ordinary
  day and 0.57 on a day twice as volatile, which turned the simulated month from +$700k to -$210k when 5% of
  accounts farmed it. EUR at 5000x and gold at 2500x stay a loss for the pair even on the volatile day. So the
  launch lists BTC and ETH Turbo at 1000x, where the house keeps 0.16 to 0.18 of a margin per pair (0.06 to 0.11
  on the volatile day); a one-second keeper would allow 2000x. Raising any Turbo cap needs the same check, and
  `setMarket` can lower one. Tests: one basis point past the liquidation leaves a pair +0.9 on 20 of margin at
  5000x and -2.3 at 1000x (`test_upside_hedgedPairKeepsTheOvershoot_at5000x`, `..._at1000x`).
- **The mark holds each side between its margin and its capped profit** (fixes N-03). Unrealised losses beyond
  margin no longer offset winners in the vault's marked value, so an LP cannot leave ahead of a gap at an inflated
  price. Regression: `test_N03_markBoundsEachSideSoAnUncollectableLossNoLongerMasksAWinner`.
- **Order expiry.** An order may carry `expiresAt` (`createLimitOrderUntil`, `setOrderExpiry`); after it the order
  cannot execute (`OrderHasExpired`) and anyone may remove it with `cancelExpired`, earning its execution fee
  while the rest of the escrow goes back to the trader. Bracket links are cleared with it.
- **Triggers are checked against a fresh price.** `setTriggerOrder` now refuses a take-profit or stop-loss on the
  wrong side of the current mid (it used to check against nothing).
- **Margin can come out, profit cannot.** `removeMargin` leaves at least `minMargin`, keeps the position at most
  `min(market maximum, 100x)`, and requires the rest to cover any loss at the exit price plus the initial margin at
  that leverage (`InsufficientMargin`); unrealised profit never counts, and the price must be newer than the last
  open, increase or top-up. It reads the on-chain price; the 1% initial-margin buffer at 100x is far wider than how
  far a usable price can lag (10 s at most, and the publisher pushes every 5 bp move).
- **Referrals.** A trader sets a referrer once (`setReferrer`; not themselves). From then on their fees are
  `referralDiscountBps` (5%) lower and the referrer is credited `referralShareBps` (10%) of each fee, collected with
  `claim`. In Upside markets the referrer's part comes out of the house's share, and if the vault cannot pay a
  winner in full the referrer is shorted first. The owner can change both within a floor: the house keeps at least
  15% of a Turbo winner's profit share after discount and referral share. Accepted: anyone can refer themselves
  from a second address and take both the discount and the share, worth about 14.5% of their fees; treat it as a
  fee cut anyone may claim, not as revenue that only goes to real referrers.
- **DRY on net results, capped and decaying** (reduces N-07). Each close or liquidation reports its result to the
  token, capped at 1% of the position's notional; DRY is minted only when an account's running net result makes a
  new low, at 100 per USDC halving as total rebated losses pass 1,000,000 USDC (`RewardToken.rebateFor`). A hedged
  pair on two accounts still mints on the losing account, so farming is now about eight times dearer per DRY but
  not closed (`test_N07_hedgedPairsStillBuyDryAtAProductionCost`).
- **Latency.** Direct trades (Standard markets, 100x and below) accept an on-chain price up to 10 s old (30 s in
  v3.1), and the keeper publishes on any 5 bp move (15 bp in v3.1).
- **A second keeper.** The keeper has an executor-only mode (`KEEPER_MODE=executor`) so someone other than the
  publisher can fill orders and liquidate; fills never depend on one operator's uptime.
- **Prizes.** `PrizeDistributor` holds season prize pools (anyone can fund one) and pays them out from a Merkle
  root of results the owner publishes; each winner claims once, inside a claim window. Nothing can be taken out
  any other way: after the window, what is left rolls into a later season.
- **Governance hand-over.** `script/Governance.s.sol` moves the engine and the oracle to a `TimelockController`
  whose proposer is a Safe. It is built and tested; the testnet deployment stays with its deployer key.
- Tests: `contracts/test/EngineV32.t.sol`, `PrizeDistributor.t.sol`, `Governance.t.sol`, and the earlier suites
  updated for the new fee paths; the invariant suite runs over the split engine.

## Closed in v2

| v1 finding | v1 outcome | v2 outcome (measured) |
| --- | --- | --- |
| H-01 hedged pair drains LPs through the staker share | attacker +9,450 per cycle | attacker -1,700 (fees), LPs +1,700; fuzzed over 4 cycles |
| M-02 hedged open interest freezes withdrawals | < 3,001 of 1M withdrawable | reserve is on net skew: hedged 3M reserves 0 |
| M-03 LP exits before a winner closes | shortfall > 190,000, other LP wiped out | exit is at marked value; trader paid in full |
| M-04 deposit just before a liquidation | newcomer takes > 90% | newcomer buys in at marked value; incumbents keep 90,865 of 98,000 |
| M-05 blocklisted trader's position is immovable | close and stop revert | position closes; payout parked in `claimable` for the same address |
| L-05 stake just before yield arrives | takes 99% of the pot | yield is streamed; a just-in-time staker earns 0 |
| Same-block open/close on two known prices | risk-free profit | a close needs a price published after the open |
| Limit order validated only when placed | 100x fill after a cut to 10x | re-validated at fill |
| Limit fills then stops out on a gap | two sets of fees | order does not fill through its own stop |
| Owner can freeze withdrawals via `maxOiToNavBps` | yes | bounded 0.5x to 10x |

Found and fixed while testing v2:
- A deposit made above the high-water mark was charged the 15% staker share on gains from before it existed
  (a 1,000,000 deposit lost up to 150,015). The mark now blends in the issue price of new shares.
- The lens reported "liquidatable at any price" for positions that were healthy once funding owed exceeded the
  threshold. Liquidation itself was unaffected.

## Open

**Medium**
- **Turbo's margin of safety depends on keeper speed and volatility.** The overshoot a hedged pair keeps grows with
  leverage x volatility x the square root of the keeper's tick. At the launch caps it is a loss for the pair even on
  a day twice as volatile as usual, but a keeper that falls behind or a much larger volatility spike can turn it.
  Watch the keeper's tick, and lower the cap (`setMarket`) or pause before a known event.
- **Hedged pairs can still buy DRY** (N-07, reduced in v3.2). Minting on net results with a 1%-of-notional cap
  and decay makes it about eight times dearer, but a pair on two accounts still mints on its losing account.
  LPs are not harmed; honest stakers are diluted.
- **Staker share is settled at epoch boundaries.** Exiting before `settleEpoch` and re-entering after avoids
  it; entering just before pays part of it on earlier gains.
- **100x straddle on gaps**, now bounded by the 10x profit cap.
- **A market with an unusable oracle is marked at zero**, which mis-states NAV for epoch settlement and exits.

**Low**
- The reserve nets only within a market (a perp long against a future short on the same asset still reserves).
- An expired future is not settled until someone calls, and settles at the first price submitted afterwards.
- A price stamped in the future stays usable for up to twice `maxPriceAge`.
- `maxConfBps` is not tied to leverage; at 100x a 0.5% band costs half the margin on entry.
- Splitting an order across accounts lowers the skew surcharge.
- `setMaxProfitMultiple` applies to positions already open. No timelock on owner parameters until the
  governance hand-over (`script/Governance.s.sol`) is run.
- Self-referral from a second address takes the referral discount and share (about 14.5% of fees).
- Valuing many markets is paid by every open, deposit and withdrawal (about 23k gas per active market).
- `PublisherOracle.updatePriceFeeds` is payable and keeps any value sent. A blocklisted staker cannot claim.

## Trust assumptions

- **Testnet oracle.** `PublisherOracle` trusts its publisher key completely. It must not secure real funds.
- **Owner.** Can list markets, set a market's fee mode while it has no open interest, and change fees, the
  profit share and referral terms within hard-coded bounds; cannot move user funds. Ownership is two-step. Use a
  multisig and a timelock (`script/Governance.s.sol`).
- **Keepers.** Liquidation, order execution and settlement are permissionless but someone has to do them.
- **Arc.** USDC can blocklist addresses; payouts to a blocklisted trader are parked, never redirected. If the
  engine or vault were blocklisted the system would stop; the wiring is immutable.

## Agent accounts (added with the Nexus merge)

`AgentAccount` lets approved agent keys trade for an owner within a policy; only the owner can move tokens out
(fuzzed in `AgentAccount.t.sol`). What a policy does **not** stop, by design:

- An agent can lose the account's money trading, up to its margin cap per position, in any allowed market.
- An agent can execute the account's own triggered orders from its own address and collect the engine's
  execution fee (0.1 USDC per order by default): the same fee any keeper earns.
- Revoking an agent stops new actions at once; its open positions and orders stay for the owner to manage.
- The factory lets anyone create the account for an owner; the owner is fixed at creation and nothing else is.

The MCP server adds off-chain limits on top (notional cap, allowed markets, price band, confirmation) and refuses
to run with the owner's key.

## Testnet operations

The deploy workflow derives every role key (publisher, keeper, agents) from `DEPLOYER_KEY`, so that one GitHub
secret is the whole key set. It is a throwaway testnet key: rotate by redeploying with a new one.
