# Security notes (v3)

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
