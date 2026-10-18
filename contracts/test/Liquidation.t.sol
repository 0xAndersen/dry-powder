// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {HouseVault} from "../src/HouseVault.sol";
import {PerpEngine} from "../src/PerpEngine.sol";
import {Base} from "./Base.t.sol";

contract LiquidationTest is Base {
    function setUp() public override {
        super.setUp();
        _flatFees();
    }

    function test_threshold_isNinetyPercentOfMargin() public {
        bytes32 key = _open(alice, BTC, true, 1_000e6, 100_000e6); // 100x
        (,, uint256 liq,) = lens.getPositionState(key, 100_000e18);
        assertEq(liq, 99_100e18);

        _setBtc(99_101); // loss 899 < 900
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.NothingToLiquidate.selector);
        _liquidate(alice);

        _setBtc(99_100); // loss 900
        vm.expectEmit(address(engine));
        emit PerpEngine.PositionLiquidated(key, alice, keeper, BTC, 99_100e18, 1_000e6, 20e6, 980e6);
        vm.prank(keeper);
        assertEq(_liquidate(alice), 1);
    }

    function test_liquidation_distribution() public {
        _stake(bob, 1_000e18);
        _open(alice, BTC, true, 1_000e6, 100_000e6);
        uint256 navBefore = vault.totalHouseBalance();
        uint256 aliceBefore = usdc.balanceOf(alice);
        _setBtc(99_000);

        vm.prank(keeper);
        _liquidate(alice);

        // 2% of margin to the liquidator.
        assertEq(usdc.balanceOf(keeper), 20e6);
        // The other 98% to the vault, all of it to the house balance: stakers are paid from epoch profit
        // only, never from an individual inflow.
        assertEq(vault.totalTraderLosses(), 980e6);
        assertEq(vault.totalHouseBalance(), navBefore + 980e6);
        assertEq(vault.pendingStakerYield(), 0);
        assertEq(house.earned(bob), 0);
        // 100 DRY per USDC that reached the vault.
        assertEq(house.balanceOf(alice), 98_000e18);
        // The trader gets nothing back.
        assertEq(usdc.balanceOf(alice), aliceBefore);

        assertEq(engine.positionCount(), 0);
        assertEq(engine.totalOpenInterest(), 0);
        assertEq(usdc.balanceOf(address(engine)), 0);
        _assertEngineSolvent();
    }

    function test_liquidate_short() public {
        _open(alice, ETH, false, 1_000e6, 50_000e6); // 50x: liquidates at +1.8%
        _setEth(4_071);
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.NothingToLiquidate.selector);
        _liquidate(alice);
        _setEth(4_072);
        vm.prank(keeper);
        _liquidate(alice);
        assertEq(usdc.balanceOf(keeper), 20e6);
    }

    function test_liquidate_withPriceUpdate_paysPythFeeAndRefundsExcess() public {
        _open(alice, BTC, true, 1_000e6, 100_000e6);
        skip(30); // the on-chain price is stale; the keeper brings its own
        bytes[] memory update = _fresh(BTC, 99_000e8, 0, -8);

        vm.prank(keeper);
        vm.expectRevert(PerpEngine.InsufficientOracleFee.selector);
        engine.liquidateBatch(_traderKeys(alice), update);

        uint256 nativeBefore = keeper.balance;
        vm.prank(keeper);
        assertEq(engine.liquidateBatch{value: 1_000}(_traderKeys(alice), update), 1);
        assertEq(nativeBefore - keeper.balance, PYTH_FEE);
        assertEq(address(engine).balance, 0);
        assertEq(usdc.balanceOf(keeper), 20e6);
    }

    function test_liquidate_stalePriceLiquidatesNothing() public {
        _open(alice, BTC, true, 1_000e6, 100_000e6);
        _setBtc(99_000);
        skip(4);
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.NothingToLiquidate.selector);
        _liquidate(alice);
        assertEq(engine.positionCount(), 1);
    }

    function test_liquidate_allMarketsOfATrader() public {
        _open(alice, BTC, true, 1_000e6, 100_000e6);
        _open(alice, ETH, true, 2_000e6, 200_000e6);
        _open(alice, EUR, true, 1_000e6, 10_000e6); // 10x, stays healthy
        _setBtc(99_000);
        _setEth(3_960);
        _setPrice(EUR, 110_000, 0, -5);

        vm.prank(keeper);
        assertEq(_liquidate(alice), 2);
        assertEq(usdc.balanceOf(keeper), 20e6 + 40e6);
        assertEq(engine.positionCount(), 1);
        assertEq(engine.getPosition(alice, EUR).trader, alice);
    }

    function test_liquidate_skipsMarketsWithoutAUsablePrice() public {
        _open(alice, BTC, true, 1_000e6, 100_000e6);
        _open(alice, ETH, true, 2_000e6, 200_000e6);
        _setEth(3_960);
        skip(3);
        _setBtc(99_000); // ETH's price is now 4 seconds old
        vm.prank(keeper);
        assertEq(_liquidate(alice), 1);
        assertEq(engine.getPosition(alice, ETH).trader, alice);
    }

    function test_cascade_batchLiquidation() public {
        // 30 longs at 40x..98x. A 1.5% drop liquidates everything at 60x and above.
        address[] memory traders = new address[](30);
        bytes32[] memory keys = new bytes32[](32);
        for (uint256 i; i < 30; ++i) {
            traders[i] = makeAddr(string.concat("trader", vm.toString(i)));
            _fund(traders[i], 10_000e6);
            keys[i] = _open(traders[i], BTC, true, 500e6, 500e6 * (40 + 2 * i));
        }
        keys[30] = bytes32(uint256(0xdead)); // unknown key
        keys[31] = keys[0]; // duplicate
        assertEq(engine.positionCount(), 30);
        uint256 oiBefore = engine.totalOpenInterest();

        vm.prank(keeper);
        vm.expectRevert(PerpEngine.NothingToLiquidate.selector);
        engine.liquidateBatch(keys, _noBytes());

        _setBtc(98_500);
        vm.prank(keeper);
        uint256 liquidated = engine.liquidateBatch(keys, _noBytes());
        assertEq(liquidated, 20); // leverage 60x..98x => i = 10..29
        assertEq(engine.positionCount(), 10);
        assertEq(usdc.balanceOf(keeper), 20 * 10e6);
        assertEq(vault.totalTraderLosses(), 20 * 490e6);
        for (uint256 i; i < 30; ++i) {
            bool gone = engine.getPosition(traders[i], BTC).trader == address(0);
            assertEq(gone, i >= 10);
            assertEq(house.balanceOf(traders[i]), i >= 10 ? 49_000e18 : 0);
        }
        _assertEngineSolvent();

        // The second leg of the cascade takes out the rest.
        _setBtc(97_500);
        vm.prank(keeper);
        assertEq(engine.liquidateBatch(keys, _noBytes()), 10);
        assertEq(engine.positionCount(), 0);
        assertEq(engine.totalOpenInterest(), 0);
        assertLt(engine.totalOpenInterest(), oiBefore);
        assertEq(usdc.balanceOf(address(engine)), 0);
        assertEq(_market(BTC).longOi, 0);
        assertEq(_market(BTC).longUnits, 0);
        _assertEngineSolvent();
    }

    function test_liquidateBatch_withPriceUpdate() public {
        bytes32[] memory keys = new bytes32[](1);
        keys[0] = _open(alice, BTC, true, 1_000e6, 100_000e6);
        skip(30);
        bytes[] memory update = _fresh(BTC, 99_000e8, 0, -8);
        vm.prank(keeper);
        assertEq(engine.liquidateBatch{value: PYTH_FEE}(keys, update), 1);
        assertEq(usdc.balanceOf(keeper), 20e6);
    }

    function test_badDebt_gapThroughMargin_vaultNeverPays() public {
        _open(alice, BTC, true, 1_000e6, 100_000e6);
        uint256 navBefore = vault.totalHouseBalance();
        _setBtc(95_000); // -5% at 100x: the loss is 5x the margin
        vm.prank(keeper);
        _liquidate(alice);
        // The house is the counterparty, so the un-collectable part is simply profit it does not book.
        assertEq(vault.totalHouseBalance(), navBefore + 980e6);
        assertEq(vault.totalShortfall(), 0);
        _assertEngineSolvent();
    }

    function test_vaultInsolvency_payoutIsCappedAndRecorded() public {
        vm.prank(owner);
        engine.setRiskParams(3, 50, 30_000, 5e6);
        _open(alice, BTC, true, 200_000e6, 2_000_000e6);
        uint256 nav = vault.totalHouseBalance();
        uint256 aliceBefore = usdc.balanceOf(alice);
        _setBtc(160_000); // +60% on 2m = 1.2m profit against ~1m of NAV

        vm.expectEmit(address(vault));
        emit HouseVault.PayoutShortfall(alice, 1_200_000e6 - (nav + 1_000e6));
        _close(alice, BTC);

        // Margin back less the close fee, plus every last unit the house had (including that fee).
        assertEq(usdc.balanceOf(alice), aliceBefore + 200_000e6 - 1_000e6 + nav + 1_000e6);
        assertEq(vault.totalHouseBalance(), 0);
        assertEq(vault.totalShortfall(), 1_200_000e6 - (nav + 1_000e6));
        assertEq(engine.positionCount(), 0);
        _assertEngineSolvent();

        // LP shares are worthless but the vault still functions.
        skip(LOCK);
        assertEq(vault.maxWithdraw(lp), 0);
        vm.prank(bob);
        vault.deposit(1_000e6, bob);
        assertEq(vault.totalHouseBalance(), 1_000e6);
    }

    function test_fundingAlone_canLiquidate() public {
        vm.prank(owner);
        engine.setFeeParams(5, 0, 317_097_919_837, EXEC_FEE); // 1000% a year at full skew
        bytes32 longKey = _open(alice, BTC, true, 10_000e6, 1_000_000e6);
        bytes32 shortKey = _open(bob, ETH, false, 10_000e6, 1_000_000e6);

        // 0.9% of notional at 1000% a year takes just under 8 hours.
        skip(7 hours);
        _refreshAll();
        (,, uint256 liq, bool liquidatable) = lens.getPositionState(longKey, 100_000e18);
        assertFalse(liquidatable);
        assertGt(liq, 99_100e18); // funding has pulled the liquidation price towards the market
        assertLt(liq, 100_000e18);

        skip(1 hours);
        _refreshAll();
        int256 owed;
        (, owed, liq, liquidatable) = lens.getPositionState(longKey, 100_000e18);
        assertTrue(liquidatable);
        // Funding owed is now 133.05 beyond the 9,000 threshold. The liquidation price has crossed to the
        // profit side of entry: only a price gain of more than that excess would keep the position alive.
        assertEq(owed, 9_133_054_287);
        assertEq(liq, 100_000e18 + (100_000e18 * 133_054_287) / uint256(1_000_000e6));
        assertEq(liq, 100_013.3054287e18);
        (,,, liquidatable) = lens.getPositionState(longKey, liq);
        assertTrue(liquidatable);
        (,,, liquidatable) = lens.getPositionState(longKey, liq + 1e15);
        assertFalse(liquidatable);

        (,, liq, liquidatable) = lens.getPositionState(shortKey, 4_000e18);
        assertTrue(liquidatable);
        assertEq(liq, 4_000e18 - (4_000e18 * 133_054_287) / uint256(1_000_000e6));
        (,,, liquidatable) = lens.getPositionState(shortKey, liq);
        assertTrue(liquidatable);
        (,,, liquidatable) = lens.getPositionState(shortKey, liq - 1e13);
        assertFalse(liquidatable);

        bytes32[] memory keys = new bytes32[](2);
        keys[0] = longKey;
        keys[1] = shortKey;
        vm.prank(keeper);
        assertEq(engine.liquidateBatch(keys, _noBytes()), 2);
        assertEq(usdc.balanceOf(keeper), 400e6);
    }

    function test_liquidationPrice_isZeroWhenFundingIncomeOutweighsAnyLoss() public {
        vm.prank(owner);
        engine.setFeeParams(5, 0, 317_097_919_837, EXEC_FEE);
        _open(bob, BTC, false, 100_000e6, 1_000_000e6);
        bytes32 key = _open(alice, BTC, true, 1_000e6, 1_000e6); // 1x long on the light side
        skip(5 days);
        (, int256 owed, uint256 liq, bool liquidatable) = lens.getPositionState(key, 1);
        assertLt(owed, -100e6);
        assertEq(liq, 0);
        assertFalse(liquidatable);
    }

    function test_selfLiquidation_isNotProfitable() public {
        _open(alice, BTC, true, 1_000e6, 100_000e6);
        uint256 before = usdc.balanceOf(alice);
        _setBtc(99_000);
        vm.prank(alice);
        _liquidate(alice);
        // She recovers only the 2% keeper fee of a margin she has otherwise lost.
        assertEq(usdc.balanceOf(alice), before + 20e6);
    }
}

/// @notice Liquidation-price reporting when funding, not price, is what threatens the position.
contract LiquidationPriceTest is Base {
    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        engine.setFeeParams(5, 0, 317_097_919_837, EXEC_FEE); // 1000% a year at full skew
    }

    /// @dev A short whose funding debt exceeds the threshold by more than its whole notional is liquidatable
    ///      at every price, and only then is 0 reported.
    function test_short_liquidatableAtAnyPrice_reportsZero() public {
        // 1x short on the heavy side of a fully skewed market: pays 1000% a year on its notional.
        vm.prank(owner);
        engine.setMarket(BTC, true, 100, MAX_OI_PER_SIDE, 1e6);
        bytes32 key = _open(alice, BTC, false, 1_000e6, 1_000e6);
        skip(80 days); // owes ~219% of notional: more than threshold (90%) plus the most a short can gain (100%)
        (, int256 owed, uint256 liq, bool liquidatable) = lens.getPositionState(key, 1);
        assertGt(owed, 1_900e6);
        assertEq(liq, 0);
        assertTrue(liquidatable); // even with the price at (almost) zero
        (,,, liquidatable) = lens.getPositionState(key, 100_000e18);
        assertTrue(liquidatable);
    }

    /// @dev A long in the same spot is never beyond rescue by price: there is always a price above which its
    ///      gain covers the funding, and that price is what is reported.
    function test_long_fundingBeyondThreshold_reportsThePriceThatRescuesIt() public {
        vm.prank(owner);
        engine.setMarket(BTC, true, 100, MAX_OI_PER_SIDE, 1e6);
        bytes32 key = _open(alice, BTC, true, 1_000e6, 1_000e6);
        skip(80 days);
        (, int256 owed, uint256 liq, bool liquidatable) = lens.getPositionState(key, 100_000e18);
        assertTrue(liquidatable);
        // It needs a gain of (owed - 900) on a notional of 1,000.
        assertEq(liq, 100_000e18 + (100_000e18 * (uint256(owed) - 900e6)) / 1_000e6);
        assertGt(liq, 170_000e18);
        (,,, liquidatable) = lens.getPositionState(key, liq);
        assertTrue(liquidatable);
        (,,, liquidatable) = lens.getPositionState(key, liq + liq / 1e6);
        assertFalse(liquidatable);

        // The engine agrees on both sides of that price.
        _setPrice(BTC, int64(uint64(liq / 1e10 + 1e8)), 0, -8);
        vm.expectRevert(PerpEngine.NothingToLiquidate.selector);
        _liquidate(alice);
        _setPrice(BTC, int64(uint64(liq / 1e10 - 1e8)), 0, -8);
        vm.prank(keeper);
        assertEq(_liquidate(alice), 1);
    }
}
