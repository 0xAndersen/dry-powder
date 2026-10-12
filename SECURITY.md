# Security notes

This protocol has **not** been professionally audited. What follows is the result of an independent adversarial
review of the contracts (by a reviewer that had not seen them being written), what was changed in response, and
what remains open.

Every open finding below has a proof-of-concept in `contracts/test/KnownIssues.t.sol`. Those tests **pass while
the issue exists**; run them with `forge test --match-contract KnownIssuesTest -vv`.

The review found no way to steal funds directly and no custody error: on every path the engine holds exactly
the open margins plus order escrows, and the vault holds exactly its NAV plus unclaimed staker yield (both are
also checked by the invariant suite). The open problems are economic.

## Open findings

### High

**H-01. The 15% staker share is taken from gross trader losses, so offsetting positions drain LPs.**
A loser's X sends 0.85X to the house and 0.15X to stakers, while the winner's X is paid entirely by the house.
Someone who is long and short the same size through two accounts, and who also holds most of the staked
HOUSE, therefore collects 15% of the gross PnL of every price move with no price risk; the losing leg even
mints them the HOUSE to stake. In the PoC one cycle on 1M notional per side and an 8% move takes about 9,450
USDC from LPs. LPs leak this way whenever anyone is staked, attacker or not.
*This is the mechanism the brief specifies.* Fixing it means changing it: fund staker yield from fees only, or
from net house profit above a high-water mark. `test_H01_…`

### Medium

**M-01. Losses are capped at margin but profits are not.** A 100x long plus a 100x short is a free option on
any price gap larger than about 1%: the losing leg loses only its margin, the winning leg collects the whole
move. FX markets gap every weekend reopen. Mitigations: lower maximum leverage (especially FX), cap profit per
position as a multiple of margin, block opens near market close. `test_M01_…`

**M-02. Hedged open interest can freeze LP withdrawals.** The withdrawal reserve is gross notional / 3, so a
matched long and short totalling 3x NAV pins the whole vault for a one-off fee, with no funding cost because
the book is balanced. Mitigation: reserve against net skew or worst-case payout, and/or add a queued
withdrawal path. `test_M02_…`

**M-03. LPs can leave before a winning trader closes.** NAV counts realised PnL only. Once a trader's
unrealised profit exceeds the reserve, an LP can redeem at the stale share price and leave the remaining LPs
and the trader with the shortfall, which is recorded but not owed. Mitigation: mark unrealised PnL into NAV or
at least into the reserve. `test_M03_…`

**M-04. Just-in-time deposits capture pending liquidations.** A large deposit immediately before a liquidation
takes most of the 98% that reaches the vault; the lock only delays the exit. Mitigation: mark-to-market NAV, or
drip realised gains into NAV over longer than the lock. `test_M04_…`

**M-05. A blocklisted trader's healthy position cannot be removed.** Closing pays the trader, and Arc's USDC
refuses transfers to blocklisted addresses, so `closePosition` and TP/SL execution revert. Liquidation never
pays the trader and still works once the position is unhealthy, but until then its open interest and reserve
are stuck. The same applies to a blocklisted staker's unclaimed yield and a blocklisted trader's limit-order
escrow. Mitigation: on transfer failure, credit a claimable balance instead of reverting. `test_M05_…`

### Low

- **L-01.** A price stamped in the future (within `maxPriceAge`) stays usable for up to twice the window.
- **L-02.** `maxConfBps` is not tied to leverage: entries fill at price + confidence while liquidation uses the
  mid, so at 100x a 0.5% confidence band costs about half the margin on entry, and an owner-raised 1% band makes
  a 100x position liquidatable the moment it opens.
- **L-05.** HOUSE can be staked immediately before a large inflow and unstaked after it. Mitigation: a staking
  warm-up or streamed yield.
- **L-06.** Splitting an order across accounts lowers the skew surcharge. Mitigation: charge on the average of
  the skew before and after.
- Keepers earn 2% of margin for a liquidation but 0.10 USDC for a stop-loss, and a stop cannot execute once the
  position is liquidatable, so a keeper is paid more for waiting than for executing a stop near the threshold.
- Funding receivers are paid in full by the vault while payers are capped at their margin. This is safe only
  while liquidations are timely, which they are not while a feed is halted.
- USDC or native value sent directly to any of the three contracts is unrecoverable; there is no sweep.
- If Circle blocklisted the engine or vault address the system would stop, and the immutable wiring leaves no
  migration path.
- There is no timelock on owner parameter changes, and `renounceOwnership` would freeze them permanently.

### Stale-price option (partly mitigated)

Market orders execute in one transaction against a signed Pyth price up to `maxPriceAge` old, and the trader
chooses which price to submit. They can therefore enter on an older, better price when the market has already
moved. Fees (10 bps round trip) and the confidence-band spread on both legs are the only cost.

What was fixed: a position can now only be closed against a price published in a later second than the one it
was opened in (`PriceNotAfterOpen`). That removes the version of this attack that had no risk at all: opening
on the old tick and closing on the new one in the same block. What remains is a statistical edge on entry, and
it grows with `maxPriceAge`. The deploy script sets 10 seconds so that people using browser wallets can trade;
that is a testnet convenience.

For real funds, make market orders keeper-executed like limit orders already are: the order is recorded first
and can only fill against a price published at or after it (`PriceBeforeOrder`). The machinery exists; a market
order is a limit order whose trigger is the slippage bound.

## Fixed after review

| Finding | Fix |
| --- | --- |
| Open and close in the same block on two known prices was a risk-free profit | Closes (manual, TP, SL) require a price published after the open |
| Limit orders were validated only when placed, so a 100x order could fill after the market was cut to 10x | Margin, leverage and market status are re-validated at fill |
| A limit order could fill and be stopped out in the same block on a gap through both levels, costing two sets of fees | An order does not fill while price is beyond its own stop; it stays resting |
| The owner could set `maxOiToNavBps` to 1 and freeze every LP withdrawal | Bounded to 0.5x to 10x of NAV |
| On a chain other than Arc Testnet the deploy script silently wired in the testnet Pyth address | It now requires `PYTH_ADDRESS` off Arc Testnet |

## Checked and found sound

Engine and vault custody on every path; order and position linkage (no double execution, no order outliving its
position, no stranded or double-spent escrow); trigger directions for longs, shorts and the inverted market;
funding sign and accrual order; rounding always against the trader; healthy positions cannot be liquidated at
the mid; self-liquidation is not profitable on its own; a blocklisted trader cannot avoid liquidation; batch
liquidation skips unknown, duplicate and healthy entries; oracle exponent, scale, confidence and inversion
arithmetic; Pyth fee forwarding and refund under the reentrancy guard; ERC-4626 inflation resistance and lock
enforcement through transfer, allowance, mint and third-party deposit; the staking accumulator's rounding and
overflow bounds; no user-growable loop in any state-changing path.

## Operational notes

- Use a multisig as `OWNER_ADDRESS`. Ownership is two-step: the new owner must call `acceptOwnership()`, and
  until then the deployer key remains owner.
- The keeper key is a hot wallet. Fund it with only what it needs.
- Liquidations depend on at least one keeper running. Anyone can run one; the functions are permissionless.
- While a Pyth feed is halted (FX weekends) positions in that market can be neither closed nor liquidated, and
  funding keeps accruing.

## Reporting

Please report vulnerabilities privately to the maintainers rather than opening a public issue.
