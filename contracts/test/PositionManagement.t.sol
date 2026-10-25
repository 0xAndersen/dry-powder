// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {Base} from "./Base.t.sol";
import {PerpEngine} from "../src/PerpEngine.sol";
import {PerpEngineBase} from "../src/PerpEngineBase.sol";
import {PositionMath} from "../src/libraries/PositionMath.sol";
import {LimitParams, Market, OpenParams, Order, OrderType, Position, PositionView} from "../src/Types.sol";

/// @notice v3.1 position management: adding to a position, partial closes (direct and by sized orders), adding
///         margin, and stop-entry orders. Every scenario ends with the engine's books balancing.
contract PositionManagementTest is Base {
    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        engine.setMarket(BTC, true, 1000, MAX_OI_PER_SIDE, SKEW_SCALE);
    }

    function _pos(address who) internal view returns (Position memory) {
        return engine.getPosition(who, BTC);
    }

    function _view(address who) internal view returns (PositionView memory) {
        return lens.getTraderPositions(who)[0];
    }

    /// @dev Opens through a marketable order filled by the keeper at the next price (any leverage).
    function _openByOrder(address who, bool isLong, uint256 margin, uint256 size, uint256 btcUsd) internal {
        vm.prank(who);
        uint256 id = engine.createLimitOrder(_limit(BTC, isLong, margin, size, isLong ? type(uint128).max : 1));
        _setBtc(btcUsd);
        _exec(id);
    }

    // ───────────────────────────── Adding to a position ─────────────────────────────

    function test_increase_sameSide_mergesAtTheUnitWeightedEntry() public {
        _flatFees();
        bytes32 key = _open(alice, BTC, true, 1_000e6, 10_000e6); // at 100,000
        _setBtc(110_000);

        uint256 unitsFirst = PositionMath.units(10_000e6, 100_000e18);
        uint256 unitsAdded = PositionMath.units(10_000e6, 110_000e18);
        uint256 entry = Math.mulDiv(20_000e6, PositionMath.UNIT_PRECISION, unitsFirst + unitsAdded, Math.Rounding.Ceil);
        // The harmonic mean, 20,000 / (10,000/100,000 + 10,000/110,000) = 104,761.90...
        assertApproxEqAbs(entry, 104_761_904_761_904_761_904_762, 1e6);

        uint256 before = _bal(alice);
        vm.expectEmit(true, true, true, true, address(engine));
        emit PerpEngineBase.PositionIncreased(
            key, alice, BTC, true, 1_000e6, 10_000e6, 110_000e18, 5e6, 2_000e6, 20_000e6, entry
        );
        assertEq(_open(alice, BTC, true, 1_000e6, 10_000e6), key);
        assertEq(before - _bal(alice), 1_000e6 + 5e6, "margin + the open fee of the addition");

        Position memory p = _pos(alice);
        assertEq(p.size, 20_000e6);
        assertEq(p.margin, 2_000e6);
        assertEq(p.entryPrice, entry);
        assertTrue(p.isLong);
        assertEq(p.openedAt, block.timestamp);
        assertEq(engine.positionCount(), 1);

        Market memory m = _market(BTC);
        assertEq(m.longOi, 20_000e6);
        assertEq(m.longUnits, PositionMath.units(20_000e6, entry), "unit counter = the merged position's units");
        assertEq(engine.totalOpenInterest(), 20_000e6);

        // Marked at 110,000 the merged position carries exactly the first part's +1,000 (less rounding).
        (int256 pnl,,,) = lens.getPositionState(key, 110_000e18);
        assertApproxEqAbs(pnl, 1_000e6, 2);
        assertLe(pnl, 1_000e6);
        _assertEngineSolvent();
    }

    function test_increase_short_roundsEntryAgainstTheTrader() public {
        _flatFees();
        _open(alice, BTC, false, 1_000e6, 10_000e6); // at 100,000
        _setBtc(90_000);
        _open(alice, BTC, false, 1_000e6, 10_000e6);
        uint256 units = PositionMath.units(10_000e6, 100_000e18) + PositionMath.units(10_000e6, 90_000e18);
        assertEq(_pos(alice).entryPrice, Math.mulDiv(20_000e6, PositionMath.UNIT_PRECISION, units, Math.Rounding.Floor));
        bytes32 key = engine.positionKey(alice, BTC);
        (int256 pnl,,,) = lens.getPositionState(key, 90_000e18);
        assertApproxEqAbs(pnl, 1_000e6, 2); // the first short's 10% gain
        assertLe(pnl, 1_000e6);
        _assertEngineSolvent();
    }

    function test_increase_keepsFundingOwed() public {
        // Funding on (the default fee parameters), a one-sided book so longs pay.
        _open(alice, BTC, true, 10_000e6, 500_000e6);
        skip(10 days);
        _refreshAll();
        int256 index = engine.currentFundingIndex(BTC);
        Position memory p = _pos(alice);
        int256 owedBefore = (int256(p.size) * (index - p.entryFundingIndex)) / 1e18;
        assertGt(owedBefore, 0);

        _open(alice, BTC, true, 1_000e6, 50_000e6);
        p = _pos(alice);
        int256 owedAfter = (int256(p.size) * (engine.currentFundingIndex(BTC) - p.entryFundingIndex)) / 1e18;
        // Unchanged, rounded against the trader by less than a unit of the index.
        assertGe(owedAfter, owedBefore);
        assertLe(owedAfter - owedBefore, 1);
        _assertEngineSolvent();
    }

    function test_increase_otherSideReverts() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        vm.prank(alice);
        vm.expectRevert(PerpEngineBase.PositionExists.selector);
        engine.openPosition(_params(BTC, false, 1_000e6, 10_000e6), _noBytes());

        // An opposite-side order stays resting: the keeper cannot fill it.
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(_limit(BTC, false, 1_000e6, 10_000e6, 1));
        _setBtc(100_000);
        vm.prank(keeper);
        vm.expectRevert(PerpEngineBase.PositionExists.selector);
        engine.executeOrder(id, _noBytes());
    }

    function test_increase_leverageAppliesToTheAddition() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        vm.prank(alice);
        vm.expectRevert(PerpEngineBase.HighLeverageNeedsOrder.selector);
        engine.openPosition(_params(BTC, true, 100e6, 10_001e6), _noBytes()); // the addition alone is > 100x
        // Through an order the addition may go to the market's 1000x.
        _openByOrder(alice, true, 10e6, 10_000e6, 100_000);
        assertEq(_pos(alice).size, 20_000e6);
        _assertEngineSolvent();
    }

    function test_increase_byLimitFill_andByStopEntry() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        vm.startPrank(alice);
        uint256 dip = engine.createLimitOrder(_limit(BTC, true, 500e6, 5_000e6, 99_000e18));
        uint256 breakout = engine.createLimitOrder(_stopEntry(BTC, true, 500e6, 5_000e6, 102_000e18));
        vm.stopPrank();

        _setBtc(99_000);
        vm.prank(keeper);
        vm.expectRevert(PerpEngineBase.TriggerNotMet.selector);
        engine.executeOrder(breakout, _noBytes());
        _exec(dip);
        assertEq(_pos(alice).size, 15_000e6);

        _setBtc(102_500);
        _exec(breakout);
        Position memory p = _pos(alice);
        assertEq(p.size, 20_000e6);
        assertEq(p.margin, 2_000e6);
        assertEq(engine.positionCount(), 1);
        assertEq(engine.orderCount(), 0);
        _assertEngineSolvent();
    }

    function test_increase_movesExistingBracketsAndRefundsTheirFees() public {
        OpenParams memory p = _params(BTC, true, 1_000e6, 10_000e6);
        p.takeProfit = 120_000e18;
        p.stopLoss = 90_000e18;
        vm.prank(alice);
        engine.openPosition(p, _noBytes());
        Position memory pos = _pos(alice);
        uint64 tp = pos.tpOrderId;
        uint64 sl = pos.slOrderId;
        assertEq(engine.orderCount(), 2);

        _setBtc(101_000);
        p.takeProfit = 125_000e18;
        p.stopLoss = 95_000e18;
        uint256 fee = engine.quoteOpenFee(BTC, 10_000e6, true, 1_000e6);
        uint256 before = _bal(alice);
        vm.prank(alice);
        engine.openPosition(p, _noBytes());
        // Margin and fee only: both brackets' execution fees came straight back.
        assertEq(before - _bal(alice), 1_000e6 + fee);
        pos = _pos(alice);
        assertEq(pos.tpOrderId, tp);
        assertEq(pos.slOrderId, sl);
        assertEq(engine.getOrder(tp).triggerPrice, 125_000e18);
        assertEq(engine.getOrder(sl).triggerPrice, 95_000e18);
        assertEq(engine.orderCount(), 2, "no new orders, nothing orphaned");
        _assertEngineSolvent();
    }

    function test_increase_byOrderWithBrackets_refundsTheMovedBracketFees() public {
        OpenParams memory p = _params(BTC, true, 1_000e6, 10_000e6);
        p.stopLoss = 90_000e18;
        vm.prank(alice);
        engine.openPosition(p, _noBytes());

        LimitParams memory l = _limit(BTC, true, 500e6, 5_000e6, 100_500e18); // marketable: worst price 100,500
        l.stopLoss = 95_000e18; // moves the existing stop
        l.takeProfit = 120_000e18; // a new take-profit
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(l);
        _setBtc(100_000);
        uint256 before = _bal(alice);
        _exec(id);
        // Refund: unused fee budget plus the moved stop's execution fee (the new take-profit keeps its fee).
        Order memory o = engine.getOrder(_pos(alice).slOrderId);
        assertEq(o.triggerPrice, 95_000e18);
        assertGe(_bal(alice) - before, EXEC_FEE);
        assertEq(engine.orderCount(), 2);
        _assertEngineSolvent();
    }

    function test_increase_restartsOpenedAt_soNoCloseUsesAnOlderPrice() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        _setBtc(100_000);
        skip(2);
        _open(alice, BTC, true, 1_000e6, 10_000e6); // reads the price published 2 s ago
        vm.prank(alice);
        vm.expectRevert(PerpEngineBase.PriceNotAfterOpen.selector);
        engine.closePosition(BTC, 0, 0, _noBytes());
        _setBtc(100_000);
        _close(alice, BTC);
        assertEq(engine.positionCount(), 0);
        _assertEngineSolvent();
    }

    function test_increase_refusedOncePastTheProfitCap() public {
        _flatFees();
        _open(alice, BTC, true, 100e6, 10_000e6); // 100x: the 10x-margin cap ($1,000) is a 10% move
        _setBtc(111_000);
        vm.prank(alice);
        vm.expectRevert(PerpEngineBase.ProfitCapReached.selector);
        engine.openPosition(_params(BTC, true, 1_000e6, 1_000e6), _noBytes());
        _setBtc(109_000); // below the cap: allowed
        _open(alice, BTC, true, 1_000e6, 1_000e6);
        assertEq(_pos(alice).margin, 1_100e6);
    }

    // ───────────────────────────── Partial closes ─────────────────────────────

    function test_partialClose_releasesMarginInProportion() public {
        _flatFees();
        bytes32 key = _open(alice, BTC, true, 1_000e6, 10_000e6);
        _setBtc(101_000); // +1%

        uint256 before = _bal(alice);
        vm.expectEmit(true, true, true, true, address(engine));
        // 40%: margin 400, PnL +40, fee 2 (5 bp of 4,000), payout 438.
        emit PerpEngineBase.PositionDecreased(key, alice, BTC, 101_000e18, 4_000e6, 400e6, 40e6, 2e6, 438e6);
        vm.prank(alice);
        engine.closePosition(BTC, 4_000e6, 0, _noBytes());
        assertEq(_bal(alice) - before, 438e6);

        Position memory p = _pos(alice);
        assertEq(p.size, 6_000e6);
        assertEq(p.margin, 600e6);
        assertEq(p.entryPrice, 100_000e18, "the rest keeps its entry");
        Market memory m = _market(BTC);
        assertEq(m.longOi, 6_000e6);
        assertEq(m.longUnits, PositionMath.units(6_000e6, 100_000e18));
        assertEq(engine.totalOpenInterest(), 6_000e6);

        // The rest closes like any position: +60, fee 3.
        before = _bal(alice);
        _close(alice, BTC);
        assertEq(_bal(alice) - before, 600e6 + 60e6 - 3e6);
        assertEq(engine.positionCount(), 0);
        _assertEngineSolvent();
    }

    function test_partialClose_lossGoesToTheVaultWithTheRebate() public {
        _flatFees();
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        _setBtc(99_000); // -1%
        uint256 dry = house.balanceOf(alice);
        vm.prank(alice);
        engine.closePosition(BTC, 5_000e6, 0, _noBytes());
        // Half: loss 50 on 5,000 of notional, rebated as DRY like any loss (the 1% cap is exactly 50).
        assertEq(house.balanceOf(alice) - dry, _rebateAfter(50e6, 0));
        assertEq(_pos(alice).margin, 500e6);
        _assertEngineSolvent();
    }

    function test_partialClose_sizeZeroOrAtLeastTheSize_closesEverything() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        _setBtc(100_000);
        vm.prank(alice);
        engine.closePosition(BTC, 10_000e6 + 1, 0, _noBytes());
        assertEq(engine.positionCount(), 0);
    }

    function test_partialClose_restBelowMinMargin_closesEverything() public {
        bytes32 key = _open(alice, BTC, true, 10e6, 1_000e6);
        _setBtc(100_000);
        vm.expectEmit(true, true, true, false, address(engine));
        emit PerpEngineBase.PositionClosed(key, alice, BTC, 0, 0, 0, 0);
        vm.prank(alice);
        engine.closePosition(BTC, 600e6, 0, _noBytes()); // 4 USDC would remain; the minimum is 5
        assertEq(engine.positionCount(), 0);
        _assertEngineSolvent();
    }

    function test_partialClose_keepsLinkedOrders() public {
        OpenParams memory p = _params(BTC, true, 1_000e6, 10_000e6);
        p.takeProfit = 120_000e18;
        p.stopLoss = 90_000e18;
        vm.prank(alice);
        engine.openPosition(p, _noBytes());
        _setBtc(100_000);
        vm.prank(alice);
        engine.closePosition(BTC, 5_000e6, 0, _noBytes());
        Position memory pos = _pos(alice);
        assertTrue(pos.tpOrderId != 0 && pos.slOrderId != 0);
        assertEq(engine.orderCount(), 2);
        _assertEngineSolvent();
    }

    function test_partialClose_profitCapAppliesToEachPart() public {
        _flatFees();
        _open(alice, BTC, true, 100e6, 10_000e6); // cap $1,000
        _setBtc(120_000); // +20%: $2,000 of PnL, twice the cap
        uint256 before = _bal(alice);
        vm.prank(alice);
        engine.closePosition(BTC, 5_000e6, 0, _noBytes()); // half: capped at 500
        _setBtc(120_000);
        _close(alice, BTC); // the other half: capped at 500
        // Margin back, $1,000 of profit in total (the whole-position cap), fees of 2.5 + 2.5 (ceil).
        assertEq(_bal(alice) - before, 100e6 + 1_000e6 - 5e6);
        _assertEngineSolvent();
    }

    function test_partialClose_directAbove100x_refused_sizedOrderWorks_feeCappedPerPart() public {
        _flatFees();
        _openByOrder(alice, true, 20e6, 10_000e6, 100_000); // 500x
        _setBtc(100_000);
        vm.prank(alice);
        vm.expectRevert(PerpEngineBase.HighLeverageNeedsOrder.selector);
        engine.closePosition(BTC, 5_000e6, 0, _noBytes());

        vm.prank(alice);
        uint256 id = engine.setTriggerOrder(BTC, OrderType.Close, 0, 5_000e6);
        assertEq(engine.getOrder(id).size, 5_000e6);
        _setBtc(100_000);
        uint256 before = _bal(alice);
        _exec(id);
        // Half closed flat: margin 10 back less a fee capped at 10% of that margin (1, not 2.5).
        assertEq(_bal(alice) - before, 10e6 - 1e6);
        Position memory p = _pos(alice);
        assertEq(p.size, 5_000e6);
        assertEq(p.margin, 10e6);
        assertEq(p.closeOrderId, 0, "the executed order is consumed");
        _assertEngineSolvent();
    }

    function test_partialClose_bySizedTakeProfitAndStopLoss() public {
        _flatFees();
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        vm.startPrank(alice);
        uint256 tp = engine.setTriggerOrder(BTC, OrderType.TakeProfit, 105_000e18, 2_500e6);
        uint256 sl = engine.setTriggerOrder(BTC, OrderType.StopLoss, 95_000e18, 2_500e6);
        vm.stopPrank();

        _setBtc(105_000);
        _exec(tp);
        Position memory p = _pos(alice);
        assertEq(p.size, 7_500e6);
        assertEq(p.tpOrderId, 0);
        assertEq(p.slOrderId, sl, "the stop stays on the rest");

        _setBtc(95_000);
        _exec(sl);
        p = _pos(alice);
        assertEq(p.size, 5_000e6);
        assertEq(p.margin, 500e6);
        _assertEngineSolvent();
    }

    function test_sizedOrder_largerThanThePosition_closesWhatIsLeft() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        vm.prank(alice);
        uint256 tp = engine.setTriggerOrder(BTC, OrderType.TakeProfit, 101_000e18, 8_000e6);
        _setBtc(100_000);
        vm.prank(alice);
        engine.closePosition(BTC, 5_000e6, 0, _noBytes()); // 5,000 left, below the order's 8,000
        _setBtc(101_000);
        _exec(tp);
        assertEq(engine.positionCount(), 0);
        _assertEngineSolvent();
    }

    function test_movingATriggerOrder_updatesItsSize() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        vm.startPrank(alice);
        uint256 id = engine.setTriggerOrder(BTC, OrderType.TakeProfit, 110_000e18, 2_000e6);
        assertEq(engine.setTriggerOrder(BTC, OrderType.TakeProfit, 112_000e18, 0), id);
        vm.stopPrank();
        Order memory o = engine.getOrder(id);
        assertEq(o.triggerPrice, 112_000e18);
        assertEq(o.size, 0);
    }

    function test_partialClose_refusedWhenLiquidatable() public {
        _open(alice, BTC, true, 100e6, 10_000e6); // 100x: liquidated at a 0.9% drop
        _setBtc(99_000);
        vm.prank(alice);
        vm.expectRevert(PerpEngineBase.PositionLiquidatable.selector);
        engine.closePosition(BTC, 5_000e6, 0, _noBytes());
    }

    // ───────────────────────────── Adding margin ─────────────────────────────

    function test_addMargin_movesTheLiquidationPriceAway() public {
        bytes32 key = _open(alice, BTC, true, 100e6, 10_000e6);
        _setBtc(99_800);
        uint256 liqBefore = _view(alice).liquidationPrice;
        uint256 before = _bal(alice);
        vm.expectEmit(true, true, false, true, address(engine));
        emit PerpEngineBase.MarginAdded(key, alice, 400e6, 500e6);
        vm.prank(alice);
        engine.addMargin(BTC, 400e6);
        assertEq(before - _bal(alice), 400e6);
        assertEq(_pos(alice).margin, 500e6);
        assertLt(_view(alice).liquidationPrice, liqBefore);
        assertEq(_pos(alice).openedAt, block.timestamp);
        _assertEngineSolvent();
    }

    function test_addMargin_savesA1000xPositionFromLiquidation() public {
        _openByOrder(alice, true, 10e6, 10_000e6, 100_000); // liquidated by a 0.09% drop
        _setBtc(99_930); // -0.07%: 70% of the margin gone
        vm.prank(alice);
        engine.addMargin(BTC, 90e6); // now 100x
        _setBtc(99_850); // -0.15%: would have liquidated it
        bytes32[] memory keys = _keys(engine.positionKey(alice, BTC));
        vm.prank(keeper);
        vm.expectRevert(PerpEngineBase.NothingToLiquidate.selector);
        engine.liquidateBatch(keys, _noBytes());
        assertEq(engine.positionCount(), 1);
        _assertEngineSolvent();
    }

    function test_addMargin_refusedInProfit_withoutAPosition_zero_orBelow1x() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        _setBtc(100_100);
        vm.startPrank(alice);
        vm.expectRevert(PerpEngineBase.PositionInProfit.selector);
        engine.addMargin(BTC, 100e6);
        vm.expectRevert(PerpEngineBase.PositionNotFound.selector);
        engine.addMargin(ETH, 100e6);
        vm.stopPrank();

        _setBtc(99_900);
        vm.startPrank(alice);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.addMargin(BTC, 0);
        vm.expectRevert(PerpEngineBase.LeverageOutOfRange.selector);
        engine.addMargin(BTC, 9_000e6 + 1); // margin above size
        engine.addMargin(BTC, 9_000e6); // exactly 1x
        vm.stopPrank();
        assertEq(_pos(alice).margin, 10_000e6);
    }

    function test_addMargin_restartsOpenedAt_soADirectCloseNeedsANewerPrice() public {
        _openByOrder(alice, true, 20e6, 10_000e6, 100_000); // 500x: keeper orders only
        _setBtc(99_990);
        skip(2);
        vm.startPrank(alice);
        engine.addMargin(BTC, 180e6); // 50x: a direct close would now be allowed...
        vm.expectRevert(PerpEngineBase.PriceNotAfterOpen.selector);
        engine.closePosition(BTC, 0, 0, _noBytes()); // ...but not against the price from before the top-up
        vm.stopPrank();
        _setBtc(99_990);
        _close(alice, BTC);
        assertEq(engine.positionCount(), 0);
        _assertEngineSolvent();
    }

    function test_addMargin_worksWhilePaused() public {
        _open(alice, BTC, true, 100e6, 10_000e6);
        vm.prank(owner);
        engine.pause();
        vm.prank(alice);
        engine.addMargin(BTC, 100e6);
        assertEq(_pos(alice).margin, 200e6);
    }

    // ───────────────────────────── Stop-entry orders ─────────────────────────────

    function test_stopEntry_long_fillsOnlyOnTheBreakout() public {
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(_stopEntry(BTC, true, 1_000e6, 10_000e6, 101_000e18));
        assertEq(uint8(engine.getOrder(id).orderType), uint8(OrderType.StopOpen));
        _setBtc(100_900);
        vm.prank(keeper);
        vm.expectRevert(PerpEngineBase.TriggerNotMet.selector);
        engine.executeOrder(id, _noBytes());
        _setBtc(101_200);
        _exec(id);
        Position memory p = _pos(alice);
        assertEq(p.entryPrice, 101_200e18);
        assertTrue(p.isLong);
        _assertEngineSolvent();
    }

    function test_stopEntry_short_fillsOnTheBreakdown() public {
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(_stopEntry(BTC, false, 1_000e6, 10_000e6, 99_000e18));
        _setBtc(99_100);
        vm.prank(keeper);
        vm.expectRevert(PerpEngineBase.TriggerNotMet.selector);
        engine.executeOrder(id, _noBytes());
        _setBtc(99_000); // at the trigger
        _exec(id);
        assertFalse(_pos(alice).isLong);
        _assertEngineSolvent();
    }

    function test_stopEntry_alreadyThrough_fillsAtOnce() public {
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(_stopEntry(BTC, true, 1_000e6, 10_000e6, 99_000e18));
        _setBtc(100_000);
        _exec(id);
        assertEq(engine.positionCount(), 1);
    }

    function test_stopEntry_bracketsAttachOnFill_andCancelRefundsEverything() public {
        LimitParams memory l = _stopEntry(BTC, true, 1_000e6, 10_000e6, 101_000e18);
        l.takeProfit = 110_000e18;
        l.stopLoss = 100_000e18;
        uint256 before = _bal(alice);
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(l);
        vm.prank(alice);
        engine.cancelOrder(id);
        assertEq(_bal(alice), before, "cancel refunds margin, fee budget and all execution fees");

        vm.prank(alice);
        id = engine.createLimitOrder(l);
        _setBtc(101_500);
        _exec(id);
        Position memory p = _pos(alice);
        assertTrue(p.tpOrderId != 0 && p.slOrderId != 0);
        _assertEngineSolvent();
    }

    function test_stopEntry_isNotATriggerOrderType() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        vm.prank(alice);
        vm.expectRevert(PerpEngineBase.NotTriggerOrderType.selector);
        engine.setTriggerOrder(BTC, OrderType.StopOpen, 101_000e18, 0);
    }

    function test_stopEntry_bracketGapLeavesTheOrderResting() public {
        LimitParams memory l = _stopEntry(BTC, true, 1_000e6, 10_000e6, 101_000e18);
        l.takeProfit = 102_000e18;
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(l);
        _setBtc(102_500); // gapped through the take-profit: filling would close it at once
        vm.prank(keeper);
        vm.expectRevert(PerpEngineBase.InvalidTrigger.selector);
        engine.executeOrder(id, _noBytes());
        assertEq(engine.orderCount(), 1);
    }
}
