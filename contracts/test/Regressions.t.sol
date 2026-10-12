// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PerpEngine} from "../src/PerpEngine.sol";
import {RewardToken} from "../src/RewardToken.sol";
import {OpenParams} from "../src/Types.sol";
import {Base} from "./Base.t.sol";

/// @notice Regression tests for the findings of the v1 review that v2 fixes. Each test replays the v1
///         proof-of-concept (same actors, same sizes, same price moves) and asserts that the attack no longer
///         pays. The v1 outcome is quoted in each comment for comparison.
contract RegressionsTest is Base {
    /// @dev Gives `who` real HOUSE by realising a small trading loss, then stakes all of it.
    function _bootstrapStaker(address who) internal {
        _open(who, BTC, true, 100e6, 1_000e6);
        _setBtc(99_000);
        _close(who, BTC);
        _setBtc(100_000);
        uint256 h = house.balanceOf(who);
        assertGt(h, 0);
        vm.prank(who);
        house.stake(h);
    }

    // ───────────────────────── H-01 ─────────────────────────
    /// v1: 15% of every gross trader loss went to stakers while winners were paid in full by the house, so a
    /// delta-neutral pair owned by the dominant staker extracted ~9,450 USDC from LPs per 8% move on 1M.
    /// v2: stakers are paid 15% of the house's NET gain per share above a high-water mark, once per epoch. A
    /// matched long and short net to zero for the house, so the pair yields stakers nothing; all the attacker
    /// gets back is 15% of the trading fees he himself paid.
    function test_H01_deltaNeutralPairYieldsNothingToStakers() public {
        _flatFees();
        _bootstrapStaker(alice); // alice is the only staker
        // Flush what the bootstrap itself earned, so the mark is current before the attack starts.
        skip(EPOCH);
        assertEq(vault.settleEpoch(), 1.65e6); // 15% of her 10 loss + 2 * 0.50 fees
        skip(STREAM);
        vm.prank(alice);
        house.claimYield();
        _refreshAll();

        uint256 attackerBefore = _bal(alice) + _bal(bob);
        uint256 navBefore = vault.totalAssets();
        uint256 allocatedBefore = vault.totalStakerYieldAllocated();

        // Delta-neutral: alice long 1M, bob short 1M, both 10x.
        _open(alice, BTC, true, 100_000e6, 1_000_000e6);
        _open(bob, BTC, false, 100_000e6, 1_000_000e6);
        _setBtc(108_000); // +8%: alice +80k, bob -80k

        // Realise the losing leg only and settle an epoch on that 80k inflow: the winning leg's unrealised
        // 80k is marked against the house, so the only profit there is to share is the three 500 USDC fees
        // paid so far. v1 would have handed stakers 15% of the 80k (12,000) at this point.
        _close(bob, BTC);
        assertEq(vault.totalTraderLosses(), 10e6 + 80_000e6);
        skip(EPOCH);
        assertEq(vault.settleEpoch(), 225e6, "only 15% of the fees may reach stakers");

        _setBtc(108_000);
        _close(alice, BTC);
        skip(EPOCH);
        // The winner's close adds one more fee; over the round trip the house netted four fees and no PnL.
        assertEq(vault.settleEpoch(), 75e6);
        skip(STREAM);
        vm.prank(alice);
        assertEq(house.claimYield(), 300e6 - 1); // one unit of streaming dust stays behind

        uint256 attackerAfter = _bal(alice) + _bal(bob);
        uint256 navAfter = vault.totalAssets();
        assertEq(vault.totalStakerYieldAllocated() - allocatedBefore, 300e6);
        // v1: attacker +9,450 and LPs -9,450. v2: attacker -1,700 (2,000 of fees less the 300 back), LPs +1,700.
        assertEq(attackerBefore - attackerAfter, 1_700e6 + 1, "the attack now costs its fees");
        assertEq(navAfter - navBefore, 1_700e6, "LPs gained, not lost");
        _assertEngineSolvent();
    }

    /// @dev The same with funding and the skew surcharge at their defaults and several cycles in both
    ///      directions: whatever the path, LP NAV only goes up and the attacker only pays.
    function testFuzz_H01_deltaNeutralCyclesNeverDrainLps(int256[4] memory moves) public {
        _bootstrapStaker(alice);
        skip(EPOCH);
        vault.settleEpoch();
        _refreshAll();
        uint256 attackerBefore = _bal(alice) + _bal(bob);
        uint256 navBefore = vault.totalAssets();
        uint256 price = 100_000;
        for (uint256 i; i < 4; ++i) {
            _setBtc(price);
            _open(alice, BTC, true, 100_000e6, 1_000_000e6);
            _open(bob, BTC, false, 100_000e6, 1_000_000e6);
            price = uint256(int256(price) + (int256(price) * bound(moves[i], -800, 800)) / 10_000);
            _setBtc(price);
            // Loser first, an epoch settlement in between, then the winner.
            _close(i % 2 == 0 ? bob : alice, BTC);
            skip(EPOCH);
            vault.settleEpoch();
            _setBtc(price);
            _close(i % 2 == 0 ? alice : bob, BTC);
            skip(EPOCH);
            vault.settleEpoch();
        }
        skip(STREAM);
        vm.prank(alice);
        try house.claimYield() {} catch {}
        assertLt(_bal(alice) + _bal(bob), attackerBefore, "attack must not be profitable");
        assertGt(vault.totalAssets(), navBefore, "LP NAV must not fall");
    }

    // ───────────────────────── M-02 ─────────────────────────
    /// v1: the reserve was gross OI / 3, so a hedged 100x pair of 1.5M a side froze 99.7% of a 1M vault for a
    /// one-off 3,000 fee and no funding.
    /// v2: the reserve is on net skew. The same pair reserves nothing.
    function test_M02_hedgedOiNoLongerFreezesWithdrawals() public {
        skip(LOCK);
        _setBtc(100_000);
        assertEq(vault.maxWithdraw(lp), LP_SEED);

        _open(alice, BTC, true, 15_000e6, 1_500_000e6);
        _open(bob, BTC, false, 15_000e6, 1_500_000e6);
        assertEq(engine.totalOpenInterest(), 3_000_000e6);
        assertEq(engine.reservedLiquidity(), 0);

        uint256 nav = vault.totalHouseBalance();
        assertEq(nav, LP_SEED + 3_000e6); // the attack's fees are simply income
        assertEq(vault.freeLiquidity(), nav);
        assertEq(vault.maxWithdraw(lp), nav - 1); // v1: < 3,001 USDC
        vm.prank(lp);
        vault.withdraw(500_000e6, lp, lp);

        skip(30 days);
        assertEq(vault.maxWithdraw(lp), nav - 500_000e6 - 1);
    }

    // ───────────────────────── M-03 ─────────────────────────
    /// v1: NAV counted realised PnL only, so with a trader sitting on a large unrealised profit one LP could
    /// redeem at the stale share price (taking out more than 1M of a 2M vault), leaving a shortfall for the
    /// trader and wiping out the other LP.
    /// v2: redemptions are priced at the marked value. The leaving LP takes his share of the pending payout
    /// with him, the trader is paid in full and the remaining LP is no worse off than the one who left.
    function test_M03_lpCannotExitAheadOfAWinningTrader() public {
        _flatFees();
        vm.prank(carol);
        vault.deposit(1_000_000e6, carol); // two equal LPs, NAV 2M
        _open(alice, BTC, true, 100_000e6, 2_000_000e6);

        skip(LOCK);
        _setBtc(140_000); // alice unrealised +800k

        uint256 realised = 2_001_000e6;
        assertEq(vault.totalHouseBalance(), realised);
        assertEq(vault.totalAssets(), realised - 800_000e6);
        // Each LP's shares are worth half of the MARKED 1,201,000 ...
        assertEq(vault.convertToAssets(vault.balanceOf(lp)), 600_500e6);
        // ... and only what the net-skew reserve (2M / 3) leaves free can leave at all.
        assertEq(vault.maxWithdraw(lp), 1_201_000e6 - 666_666_666_667);

        uint256 lpBefore = _bal(lp);
        vm.startPrank(lp);
        vault.redeem(vault.maxRedeem(lp), lp, lp);
        vm.stopPrank();
        uint256 lpOut = _bal(lp) - lpBefore;
        assertEq(lpOut, 534_333_333_333); // v1: more than 1,000,000

        uint256 aliceBefore = _bal(alice);
        _setBtc(140_000);
        _close(alice, BTC);
        assertEq(_bal(alice) - aliceBefore, 100_000e6 - 1_000e6 + 800_000e6, "trader paid in full");
        assertEq(vault.totalShortfall(), 0); // v1: > 190,000

        // Nobody escaped the loss: what the leaver took plus what he still holds is no more than what the LP
        // who stayed has (she also earned the larger share of the closing fee).
        uint256 lpTotal = lpOut + vault.convertToAssets(vault.balanceOf(lp));
        uint256 carolTotal = vault.convertToAssets(vault.balanceOf(carol));
        assertLe(lpTotal, carolTotal);
        assertGt(carolTotal, 600_500e6); // v1: 0
        assertApproxEqAbs(lpTotal, 600_500e6, 200e6);
        _assertEngineSolvent();
    }

    // ───────────────────────── M-04 ─────────────────────────
    /// v1: a 9M deposit made just before a 100k-margin liquidation took ~90% of the 98k that reached the
    /// vault (newcomer +90k, incumbent LP < +10k).
    /// v2: deposits are priced at the marked value, which already contains the trader's unrealised loss, so
    /// the newcomer buys in after the gain. What he still shares in is the part of a liquidation the mark
    /// cannot see: the liquidation takes the whole margin less the keeper fee (98k) while the mark holds the
    /// price loss at that moment (90k), and that 8k difference is shared pro rata.
    function test_M04_jitDepositNoLongerCapturesPendingLiquidation() public {
        _open(alice, BTC, true, 100_000e6, 1_000_000e6);
        _setBtc(91_000); // -9% at 10x: liquidatable, 100k margin about to become NAV

        usdc.mint(carol, 9_000_000e6);
        uint256 carolBefore = _bal(carol);
        uint256 lpValueBefore = vault.convertToAssets(vault.balanceOf(lp));
        assertEq(vault.entryValue() - vault.exitValue(), 90_000e6); // the pending gain is in the entry price

        vm.startPrank(carol);
        vault.deposit(9_000_000e6, carol);
        engine.liquidate(alice);
        vm.stopPrank();

        skip(LOCK);
        vm.startPrank(carol);
        vault.redeem(vault.balanceOf(carol), carol, carol);
        vm.stopPrank();

        uint256 carolGain = _bal(carol) - carolBefore;
        uint256 lpGain = vault.convertToAssets(vault.balanceOf(lp)) - lpValueBefore;
        // Measured: newcomer 9,134 (2,000 of it the keeper fee for the liquidation he performed, the rest
        // 9/10.09 of the 8k the mark could not see); incumbent 90,865. v1: > 90,000 and < 10,000.
        assertApproxEqAbs(carolGain, 9_134.7e6, 0.1e6);
        assertApproxEqAbs(lpGain, 90_865.3e6, 0.1e6);
        assertEq(carolGain + lpGain, 100_000e6); // the whole margin, between the two of them
    }

    // ───────────────────────── M-05 ─────────────────────────
    /// v1: a blocklisted trader's healthy position could not be closed by anyone (close and TP/SL paid the
    /// trader and reverted), so its open interest pinned LP liquidity for ever.
    /// v2: the payment is deferred to `claimable` and the position is removed.
    function test_M05_blocklistedTraderPositionCanBeRemoved() public {
        _flatFees();
        skip(LOCK);
        _setBtc(100_000);
        // 1x long: can only be liquidated if BTC falls 90%.
        vm.prank(alice);
        engine.openPosition(
            OpenParams({
                priceId: BTC,
                isLong: true,
                margin: 750_000e6,
                size: 750_000e6,
                acceptablePrice: 0,
                takeProfit: 120_000e18,
                stopLoss: 80_000e18
            }),
            _noBytes()
        );
        uint64 slId = engine.getPosition(alice, BTC).slOrderId;
        usdc.setBlocklisted(alice, true);
        assertEq(engine.reservedLiquidity(), 250_000e6);

        _setBtc(79_000); // stop-loss level reached, position far from liquidation
        vm.expectRevert(PerpEngine.NothingToLiquidate.selector);
        engine.liquidate(alice);

        // The keeper executes her stop. v1: reverted with Blocklisted(alice).
        _exec(slId);
        assertEq(engine.positionCount(), 0);
        assertEq(engine.orderCount(), 0);
        assertEq(engine.reservedLiquidity(), 0);
        assertApproxEqAbs(vault.maxWithdraw(lp), vault.totalAssets(), 1);
        // 750k - 21% loss - 5 bps close fee, plus the take-profit's escrow, waits for her.
        assertEq(engine.claimable(alice), 750_000e6 - 157_500e6 - 375e6 + EXEC_FEE);
        _assertEngineSolvent();
    }

    // ───────────────────────── L-05 ─────────────────────────
    /// v1: HOUSE staked in the same transaction as a liquidation took a pro-rata share of that inflow (99% of
    /// the 14.7k staker pot in the PoC) and could be unstaked immediately.
    /// v2: nothing reaches stakers at the moment of an inflow, and what an epoch sets aside is streamed over
    /// `streamPeriod` to whoever is staked while it streams.
    function test_L05_jitStakeNoLongerCapturesYield() public {
        _stake(bob, 1_000e18); // long-term staker
        vm.prank(address(engine));
        house.mintLossRebate(carol, 990e6); // carol holds 99,000 idle HOUSE

        _open(alice, BTC, true, 100_000e6, 1_000_000e6);
        _setBtc(91_000);
        skip(EPOCH); // an epoch settlement is due as well: the best case for the attacker
        _setBtc(91_000);

        uint256 before = _bal(carol);
        vm.startPrank(carol);
        house.stake(99_000e18);
        engine.liquidate(alice);
        uint256 toStakers = vault.settleEpoch();
        vm.expectRevert(RewardToken.NothingToClaim.selector);
        house.claimYield();
        house.unstake(99_000e18);
        vm.stopPrank();

        assertGt(toStakers, 14_700e6); // 15% of the 98k (plus fees) was set aside ...
        assertEq(_bal(carol) - before, 2_000e6); // ... and all carol got is the keeper fee
        assertEq(house.earned(carol), 0);
        skip(STREAM);
        assertEq(house.earned(carol), 0);
        assertApproxEqAbs(house.earned(bob), toStakers, 1); // v1: bob kept < 2% of it
    }
}
