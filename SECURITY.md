# Security notes (v3.1)

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
- **Rebates are minted on gross losses.** A hedged pair mints DRY for the cost of fees and can then take
  most of the staker stream (98.8% in the PoC). LPs are not harmed; honest stakers are diluted.
- **The mark counts uncollectable losses.** Between a price gap and the liquidation, unrealised losses beyond
  margin inflate the vault's marked value and an LP can exit too high.
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
- Orders never expire; `setTriggerOrder` does not check which side of the price a trigger is on.
- `setMaxProfitMultiple` applies to positions already open. No timelock on owner parameters.
- Valuing many markets is paid by every open, deposit and withdrawal (about 23k gas per active market).
- `PublisherOracle.updatePriceFeeds` is payable and keeps any value sent. A blocklisted staker cannot claim.

## Trust assumptions

- **Testnet oracle.** `PublisherOracle` trusts its publisher key completely. It must not secure real funds.
- **Owner.** Can list markets and change fees and risk limits within hard-coded bounds; cannot move user funds.
  Ownership is two-step. Use a multisig.
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
