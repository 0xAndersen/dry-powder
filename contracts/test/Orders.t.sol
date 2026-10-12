// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {PerpEngine} from "../src/PerpEngine.sol";
import {Base} from "./Base.t.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract OrdersTest is Base {
    function _exec(uint256 orderId) internal {
        vm.prank(keeper);
        engine.executeOrder(orderId, _noBytes());
    }

    function _openWithBrackets(address who, bool isLong, uint256 margin, uint256 size, uint256 tp, uint256 sl)
        internal
        returns (bytes32)
    {
        PerpEngine.OpenParams memory p = _params(BTC, isLong, margin, size);
        p.takeProfit = tp;
        p.stopLoss = sl;
        vm.prank(who);
        return engine.openPosition(p, _noBytes());
    }

    // ───────────────────────────── Limit orders ─────────────────────────────

    function test_limit_create_escrowsMarginFeeBudgetAndExecutionFee() public {
        uint256 before = usdc.balanceOf(alice);
        vm.expectEmit(address(engine));
        emit PerpEngine.OrderCreated(1, alice, BTC, PerpEngine.OrderType.LimitOpen, true, 99_000e18, 1_000e6, 10_000e6);
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(_limit(BTC, true, 1_000e6, 10_000e6, 99_000e18));

        assertEq(id, 1);
        // margin 1,000 + worst-case fee (5 + 10 bps of 10k = 15) + execution fee 0.10
        assertEq(before - usdc.balanceOf(alice), 1_000e6 + 15e6 + EXEC_FEE);
        PerpEngine.Order memory o = engine.getOrder(1);
        assertEq(o.trader, alice);
        assertEq(o.priceId, BTC);
        assertEq(uint8(o.orderType), uint8(PerpEngine.OrderType.LimitOpen));
        assertTrue(o.isLong);
        assertEq(o.createdAt, block.timestamp);
        assertEq(o.margin, 1_000e6);
        assertEq(o.size, 10_000e6);
        assertEq(o.triggerPrice, 99_000e18);
        assertEq(o.feeBudget, 15e6);
        assertEq(o.executionFee, EXEC_FEE);
        assertEq(engine.orderCount(), 1);
        assertEq(engine.nextOrderId(), 2);
        // Nothing is open yet, so no open interest is consumed.
        assertEq(engine.totalOpenInterest(), 0);
        _assertEngineSolvent();
    }

    function test_limit_long_fillsAtOrBelowTrigger() public {
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(_limit(BTC, true, 1_000e6, 10_000e6, 99_000e18));
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 keeperBefore = usdc.balanceOf(keeper);

        _setBtc(99_001);
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.TriggerNotMet.selector);
        engine.executeOrder(id, _noBytes());

        _setBtc(98_900);
        vm.expectEmit(address(engine));
        emit PerpEngine.OrderExecuted(id, alice, keeper, 98_900e18);
        _exec(id);

        PerpEngine.Position memory pos = engine.getPosition(alice, BTC);
        assertEq(pos.entryPrice, 98_900e18); // price improvement goes to the trader
        assertEq(pos.margin, 1_000e6);
        assertEq(pos.size, 10_000e6);
        assertEq(usdc.balanceOf(keeper), keeperBefore + EXEC_FEE);
        // Actual fee was 5.10; the unused 9.90 of the budget comes back.
        assertEq(usdc.balanceOf(alice), aliceBefore + 9.9e6);
        assertEq(engine.orderCount(), 0);
        assertEq(engine.getOrder(id).trader, address(0));
        _assertEngineSolvent();
    }

    function test_limit_short_fillsAtOrAboveTrigger() public {
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(_limit(BTC, false, 1_000e6, 10_000e6, 101_000e18));

        _setBtc(100_999);
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.TriggerNotMet.selector);
        engine.executeOrder(id, _noBytes());

        _setBtc(101_000);
        _exec(id);
        PerpEngine.Position memory pos = engine.getPosition(alice, BTC);
        assertFalse(pos.isLong);
        assertEq(pos.entryPrice, 101_000e18);
    }

    function test_limit_triggerIsCheckedAgainstTheExecutionSideOfTheBand() public {
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(_limit(BTC, true, 1_000e6, 10_000e6, 99_000e18));
        // Mid is through the limit but the ask (99,030) is not: the limit price must be honoured.
        _setPrice(BTC, 98_990e8, 40e8, -8);
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.TriggerNotMet.selector);
        engine.executeOrder(id, _noBytes());
        _setPrice(BTC, 98_960e8, 40e8, -8);
        _exec(id);
        assertEq(engine.getPosition(alice, BTC).entryPrice, 99_000e18);
    }

    function test_limit_withBrackets_attachesThemOnFill() public {
        PerpEngine.LimitParams memory p = _limit(BTC, true, 1_000e6, 10_000e6, 99_000e18);
        p.takeProfit = 105_000e18;
        p.stopLoss = 97_000e18;
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(p);
        assertEq(before - usdc.balanceOf(alice), 1_000e6 + 15e6 + 3 * EXEC_FEE);

        _setBtc(99_000);
        _exec(id);
        PerpEngine.Position memory pos = engine.getPosition(alice, BTC);
        assertEq(pos.tpOrderId, 2);
        assertEq(pos.slOrderId, 3);
        assertEq(engine.getOrder(2).triggerPrice, 105_000e18);
        assertEq(uint8(engine.getOrder(2).orderType), uint8(PerpEngine.OrderType.TakeProfit));
        assertEq(engine.getOrder(3).triggerPrice, 97_000e18);
        assertEq(uint8(engine.getOrder(3).orderType), uint8(PerpEngine.OrderType.StopLoss));
        assertEq(engine.orderCount(), 2);
        _assertEngineSolvent();
    }

    function test_limit_cannotFillAgainstAPricePublishedBeforeTheOrder() public {
        skip(1); // the on-chain price is now one second older than the order will be
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(_limit(BTC, true, 1_000e6, 10_000e6, 100_000e18));
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.PriceBeforeOrder.selector);
        engine.executeOrder(id, _noBytes());
        _setBtc(100_000);
        _exec(id);
    }

    function test_limit_create_validations() public {
        vm.startPrank(alice);
        vm.expectRevert(PerpEngine.MarketNotFound.selector);
        engine.createLimitOrder(_limit(bytes32(uint256(7)), true, 1_000e6, 10_000e6, 99_000e18));
        vm.expectRevert(PerpEngine.MarginTooLow.selector);
        engine.createLimitOrder(_limit(BTC, true, 1e6, 10e6, 99_000e18));
        vm.expectRevert(PerpEngine.LeverageOutOfRange.selector);
        engine.createLimitOrder(_limit(BTC, true, 1_000e6, 100_001e6, 99_000e18));
        vm.expectRevert(PerpEngine.InvalidTrigger.selector);
        engine.createLimitOrder(_limit(BTC, true, 1_000e6, 10_000e6, 0));

        // Brackets are validated against the limit price.
        PerpEngine.LimitParams memory p = _limit(BTC, true, 1_000e6, 10_000e6, 99_000e18);
        p.takeProfit = 99_000e18;
        vm.expectRevert(PerpEngine.InvalidTrigger.selector);
        engine.createLimitOrder(p);
        p.takeProfit = 0;
        p.stopLoss = 99_000e18;
        vm.expectRevert(PerpEngine.InvalidTrigger.selector);
        engine.createLimitOrder(p);
        vm.stopPrank();

        vm.prank(owner);
        engine.setMarket(BTC, false, 100, MAX_OI_PER_SIDE, SKEW_SCALE);
        vm.prank(alice);
        vm.expectRevert(PerpEngine.MarketDisabled.selector);
        engine.createLimitOrder(_limit(BTC, true, 1_000e6, 10_000e6, 99_000e18));

        vm.prank(owner);
        engine.pause();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        engine.createLimitOrder(_limit(ETH, true, 1_000e6, 10_000e6, 3_900e18));
    }

    function test_limit_fill_blockedWhilePausedDisabledOrPositionExists() public {
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(_limit(BTC, true, 1_000e6, 10_000e6, 100_000e18));
        _setBtc(100_000);

        vm.prank(owner);
        engine.pause();
        vm.prank(keeper);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        engine.executeOrder(id, _noBytes());
        vm.prank(owner);
        engine.unpause();

        vm.prank(owner);
        engine.setMarket(BTC, false, 100, MAX_OI_PER_SIDE, SKEW_SCALE);
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.MarketDisabled.selector);
        engine.executeOrder(id, _noBytes());
        vm.prank(owner);
        engine.setMarket(BTC, true, 100, MAX_OI_PER_SIDE, SKEW_SCALE);

        _open(alice, BTC, false, 1_000e6, 5_000e6);
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.PositionExists.selector);
        engine.executeOrder(id, _noBytes());

        // The order is still intact and can be cancelled for a full refund.
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        engine.cancelOrder(id);
        assertEq(usdc.balanceOf(alice), before + 1_000e6 + 15e6 + EXEC_FEE);
    }

    function test_limit_fill_feeNeverExceedsTheEscrowedBudget() public {
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(_limit(BTC, true, 1_000e6, 10_000e6, 100_000e18));
        uint256 afterCreate = usdc.balanceOf(alice);
        // Fees are raised after the order was placed: 50 bps of 10k would be 50, the budget is 15.
        vm.prank(owner);
        engine.setFeeParams(50, 100, 0, EXEC_FEE);
        _setBtc(100_000);
        _exec(id);
        assertEq(vault.totalFeesCollected(), 15e6);
        assertEq(usdc.balanceOf(alice), afterCreate);
        assertEq(engine.getPosition(alice, BTC).margin, 1_000e6);
        _assertEngineSolvent();
    }

    function test_executeOrder_unknownOrderReverts() public {
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.OrderNotFound.selector);
        engine.executeOrder(99, _noBytes());
    }

    function test_executeOrder_withZeroExecutionFee() public {
        vm.prank(owner);
        engine.setFeeParams(5, 10, 0, 0);
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(_limit(BTC, true, 1_000e6, 10_000e6, 100_000e18));
        _setBtc(100_000);
        _exec(id);
        assertEq(usdc.balanceOf(keeper), 0);
        assertEq(engine.getPosition(alice, BTC).size, 10_000e6);
    }

    // ───────────────────────────── Cancel ─────────────────────────────

    function test_cancel_limitRefundsEverything() public {
        PerpEngine.LimitParams memory p = _limit(BTC, true, 1_000e6, 10_000e6, 99_000e18);
        p.takeProfit = 105_000e18;
        p.stopLoss = 97_000e18;
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(p);

        vm.prank(bob);
        vm.expectRevert(PerpEngine.NotOrderOwner.selector);
        engine.cancelOrder(id);
        vm.prank(alice);
        vm.expectRevert(PerpEngine.OrderNotFound.selector);
        engine.cancelOrder(id + 1);

        vm.expectEmit(address(engine));
        emit PerpEngine.OrderCancelled(id, alice);
        vm.prank(alice);
        engine.cancelOrder(id);
        assertEq(usdc.balanceOf(alice), before);
        assertEq(engine.orderCount(), 0);
        assertEq(usdc.balanceOf(address(engine)), 0);
    }

    function test_cancel_bracketsUnlinkAndRefund() public {
        _flatFees();
        _openWithBrackets(alice, true, 1_000e6, 10_000e6, 102_000e18, 98_000e18);
        uint256 before = usdc.balanceOf(alice);

        vm.startPrank(alice);
        engine.cancelOrder(1);
        assertEq(engine.getPosition(alice, BTC).tpOrderId, 0);
        assertEq(engine.getPosition(alice, BTC).slOrderId, 2);
        engine.cancelOrder(2);
        assertEq(engine.getPosition(alice, BTC).slOrderId, 0);
        vm.stopPrank();

        assertEq(usdc.balanceOf(alice), before + 2 * EXEC_FEE);
        assertEq(engine.orderCount(), 0);
        _assertEngineSolvent();
    }

    // ───────────────────────────── Take-profit / stop-loss ─────────────────────────────

    function test_open_withBrackets() public {
        _flatFees();
        uint256 before = usdc.balanceOf(alice);
        _openWithBrackets(alice, true, 1_000e6, 10_000e6, 102_000e18, 98_000e18);
        assertEq(before - usdc.balanceOf(alice), 1_000e6 + 5e6 + 2 * EXEC_FEE);
        PerpEngine.Position memory pos = engine.getPosition(alice, BTC);
        assertEq(pos.tpOrderId, 1);
        assertEq(pos.slOrderId, 2);
        assertEq(engine.getOrder(1).trader, alice);
        assertTrue(engine.getOrder(1).isLong);
        assertEq(engine.getOrder(2).executionFee, EXEC_FEE);
        _assertEngineSolvent();
    }

    function test_open_bracketValidation() public {
        PerpEngine.OpenParams memory p = _params(BTC, true, 1_000e6, 10_000e6);
        vm.startPrank(alice);
        p.takeProfit = 100_000e18; // long TP must be above entry
        vm.expectRevert(PerpEngine.InvalidTrigger.selector);
        engine.openPosition(p, _noBytes());
        p.takeProfit = 0;
        p.stopLoss = 100_000e18; // long SL must be below entry
        vm.expectRevert(PerpEngine.InvalidTrigger.selector);
        engine.openPosition(p, _noBytes());

        p = _params(BTC, false, 1_000e6, 10_000e6);
        p.takeProfit = 100_000e18; // short TP must be below entry
        vm.expectRevert(PerpEngine.InvalidTrigger.selector);
        engine.openPosition(p, _noBytes());
        p.takeProfit = 0;
        p.stopLoss = 100_000e18; // short SL must be above entry
        vm.expectRevert(PerpEngine.InvalidTrigger.selector);
        engine.openPosition(p, _noBytes());

        p.takeProfit = 98_000e18;
        p.stopLoss = 102_000e18;
        engine.openPosition(p, _noBytes());
        vm.stopPrank();
    }

    function test_takeProfit_long() public {
        _flatFees();
        bytes32 key = _openWithBrackets(alice, true, 1_000e6, 10_000e6, 102_000e18, 98_000e18);
        uint256 before = usdc.balanceOf(alice);

        _setBtc(101_999);
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.TriggerNotMet.selector);
        engine.executeOrder(1, _noBytes());

        _setBtc(102_000);
        vm.expectEmit(address(engine));
        emit PerpEngine.OrderCancelled(2, alice); // the sibling stop-loss
        vm.expectEmit(address(engine));
        emit PerpEngine.PositionClosed(key, alice, BTC, 102_000e18, 200e6, 5e6, 1_195e6);
        vm.expectEmit(address(engine));
        emit PerpEngine.OrderExecuted(1, alice, keeper, 102_000e18);
        _exec(1);

        // margin - fee + profit, plus the refunded stop-loss execution fee
        assertEq(usdc.balanceOf(alice), before + 1_195e6 + EXEC_FEE);
        assertEq(usdc.balanceOf(keeper), EXEC_FEE);
        assertEq(engine.positionCount(), 0);
        assertEq(engine.orderCount(), 0);
        assertEq(usdc.balanceOf(address(engine)), 0);
    }

    function test_stopLoss_long() public {
        _flatFees();
        _openWithBrackets(alice, true, 1_000e6, 10_000e6, 102_000e18, 98_000e18);
        uint256 before = usdc.balanceOf(alice);

        _setBtc(98_001);
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.TriggerNotMet.selector);
        engine.executeOrder(2, _noBytes());

        _setBtc(98_000);
        _exec(2);
        assertEq(usdc.balanceOf(alice), before + 1_000e6 - 200e6 - 5e6 + EXEC_FEE);
        assertEq(house.balanceOf(alice), 20_000e18);
        assertEq(engine.orderCount(), 0);
    }

    function test_takeProfit_short() public {
        _flatFees();
        _openWithBrackets(alice, false, 1_000e6, 10_000e6, 98_000e18, 102_000e18);
        uint256 before = usdc.balanceOf(alice);
        _setBtc(98_001);
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.TriggerNotMet.selector);
        engine.executeOrder(1, _noBytes());
        _setBtc(97_500); // gaps through the trigger: the trader gets the better price
        _exec(1);
        assertEq(usdc.balanceOf(alice), before + 1_000e6 + 250e6 - 5e6 + EXEC_FEE);
    }

    function test_stopLoss_short() public {
        _flatFees();
        _openWithBrackets(alice, false, 1_000e6, 10_000e6, 98_000e18, 102_000e18);
        uint256 before = usdc.balanceOf(alice);
        _setBtc(101_999);
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.TriggerNotMet.selector);
        engine.executeOrder(2, _noBytes());
        _setBtc(102_000);
        _exec(2);
        assertEq(usdc.balanceOf(alice), before + 1_000e6 - 200e6 - 5e6 + EXEC_FEE);
    }

    function test_trigger_executesAtTheAdverseSideOfTheBand() public {
        _flatFees();
        _openWithBrackets(alice, true, 1_000e6, 10_000e6, 102_000e18, 0);
        uint256 before = usdc.balanceOf(alice);
        _setPrice(BTC, 102_000e8, 100e8, -8); // mid meets the trigger; the sell fills at the bid, 101,900
        _exec(1);
        assertEq(usdc.balanceOf(alice), before + 1_000e6 + 190e6 - 5e6);
    }

    function test_stopLoss_cannotPreEmptLiquidation() public {
        _flatFees();
        _openWithBrackets(alice, true, 100e6, 10_000e6, 0, 99_200e18); // 100x, stop at -0.8%
        _setBtc(99_000); // gaps to -1.0%: past the 90% threshold
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.PositionLiquidatable.selector);
        engine.executeOrder(1, _noBytes());

        vm.prank(keeper);
        engine.liquidate(alice);
        // 2% of margin to the keeper, 98% to the vault as loss, the stop's execution fee to the vault as fee.
        assertEq(usdc.balanceOf(keeper), 2e6);
        assertEq(vault.totalTraderLosses(), 98e6);
        assertEq(vault.totalFeesCollected(), 5e6 + EXEC_FEE);
        assertEq(engine.orderCount(), 0);
        assertEq(usdc.balanceOf(address(engine)), 0);
    }

    function test_setTriggerOrder_createsThenMoves() public {
        _flatFees();
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        uint256 before = usdc.balanceOf(alice);

        vm.startPrank(alice);
        vm.expectEmit(address(engine));
        emit PerpEngine.OrderCreated(1, alice, BTC, PerpEngine.OrderType.TakeProfit, true, 103_000e18, 0, 0);
        assertEq(engine.setTriggerOrder(BTC, PerpEngine.OrderType.TakeProfit, 103_000e18), 1);
        assertEq(engine.setTriggerOrder(BTC, PerpEngine.OrderType.StopLoss, 97_000e18), 2);
        assertEq(before - usdc.balanceOf(alice), 2 * EXEC_FEE);

        // Moving an existing trigger reuses the order and its escrow.
        skip(1);
        vm.expectEmit(address(engine));
        emit PerpEngine.OrderUpdated(2, 100_500e18);
        assertEq(engine.setTriggerOrder(BTC, PerpEngine.OrderType.StopLoss, 100_500e18), 2);
        assertEq(engine.setTriggerOrder(BTC, PerpEngine.OrderType.TakeProfit, 104_000e18), 1);
        vm.stopPrank();

        assertEq(before - usdc.balanceOf(alice), 2 * EXEC_FEE);
        assertEq(engine.getOrder(2).triggerPrice, 100_500e18);
        assertEq(engine.getOrder(2).createdAt, block.timestamp);
        assertEq(engine.getOrder(1).triggerPrice, 104_000e18);
        assertEq(engine.orderCount(), 2);

        // A stop above entry on a long locks in profit: it fires as soon as price is at or below it.
        _setBtc(100_400);
        _exec(2);
        assertEq(engine.positionCount(), 0);
        _assertEngineSolvent();
    }

    function test_setTriggerOrder_movedTriggerNeedsAPriceNewerThanTheMove() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        vm.prank(alice);
        engine.setTriggerOrder(BTC, PerpEngine.OrderType.StopLoss, 97_000e18);
        skip(2);
        vm.prank(alice);
        engine.setTriggerOrder(BTC, PerpEngine.OrderType.StopLoss, 100_000e18);
        // The stored price (100,000, two seconds old) would satisfy the moved stop, but it predates the move.
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.PriceBeforeOrder.selector);
        engine.executeOrder(1, _noBytes());
    }

    function test_setTriggerOrder_validations() public {
        vm.startPrank(alice);
        vm.expectRevert(PerpEngine.NotTriggerOrderType.selector);
        engine.setTriggerOrder(BTC, PerpEngine.OrderType.LimitOpen, 1e18);
        vm.expectRevert(PerpEngine.InvalidTrigger.selector);
        engine.setTriggerOrder(BTC, PerpEngine.OrderType.TakeProfit, 0);
        vm.expectRevert(PerpEngine.PositionNotFound.selector);
        engine.setTriggerOrder(BTC, PerpEngine.OrderType.TakeProfit, 1e18);
        vm.stopPrank();
    }

    function test_manualClose_refundsBracketEscrow() public {
        _flatFees();
        _openWithBrackets(alice, true, 1_000e6, 10_000e6, 102_000e18, 98_000e18);
        uint256 before = usdc.balanceOf(alice);
        _setBtc(100_000);
        _close(alice, BTC);
        assertEq(usdc.balanceOf(alice), before + 995e6 + 2 * EXEC_FEE);
        assertEq(engine.orderCount(), 0);
        assertEq(usdc.balanceOf(address(engine)), 0);
    }

    function test_blocklistedTrader_cannotBeClosedByKeeperButCanBeLiquidated() public {
        _flatFees();
        _openWithBrackets(alice, true, 100e6, 10_000e6, 100_500e18, 99_500e18);
        usdc.setBlocklisted(alice, true);

        // Closing pays the trader, which Arc's USDC refuses; the keeper's call simply reverts.
        _setBtc(100_500);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.Blocklisted.selector, alice));
        engine.executeOrder(1, _noBytes());

        // Liquidation never pays the trader, so the blocklist cannot shield a bad position.
        _setBtc(99_000);
        vm.prank(keeper);
        assertEq(engine.liquidate(alice), 1);
        assertEq(engine.positionCount(), 0);
        assertEq(engine.orderCount(), 0);
        assertEq(vault.totalFeesCollected(), 5e6 + 2 * EXEC_FEE);
        assertEq(house.balanceOf(alice), 9_800e18);
        _assertEngineSolvent();
    }

    function test_limit_fill_revalidatesAgainstCurrentLimits() public {
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(_limit(BTC, true, 1_000e6, 100_000e6, 100_000e18)); // 100x
        vm.prank(owner);
        engine.setMarket(BTC, true, 10, MAX_OI_PER_SIDE, SKEW_SCALE); // leverage cut to 10x afterwards
        _setBtc(100_000);
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.LeverageOutOfRange.selector);
        engine.executeOrder(id, _noBytes());
    }

    function test_limit_doesNotFillThroughItsOwnStop() public {
        PerpEngine.LimitParams memory p = _limit(BTC, true, 1_000e6, 10_000e6, 99_000e18);
        p.stopLoss = 98_000e18;
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(p);

        _setBtc(97_500); // gaps through both the limit and the stop
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.InvalidTrigger.selector);
        engine.executeOrder(id, _noBytes());

        _setBtc(98_500); // back between stop and limit: fills normally
        _exec(id);
        assertEq(engine.getPosition(alice, BTC).entryPrice, 98_500e18);
    }

    function test_close_needsAPricePublishedAfterTheOpen() public {
        _flatFees();
        // Two signed prices from the same staleness window, both known before the first transaction.
        skip(1);
        bytes[] memory older = _fresh(BTC, 100_000e8, 0, -8);
        skip(1);
        bytes[] memory newer = _fresh(BTC, 100_400e8, 0, -8);

        PerpEngine.OpenParams memory p = _params(BTC, true, 10_000e6, 1_000_000e6);
        p.takeProfit = 100_300e18;
        vm.startPrank(alice);
        engine.openPosition{value: PYTH_FEE}(p, older);
        vm.expectRevert(PerpEngine.PriceNotAfterOpen.selector);
        engine.closePosition{value: PYTH_FEE}(BTC, 0, newer);
        vm.stopPrank();
        // The same holds for closing through a trigger order.
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.PriceNotAfterOpen.selector);
        engine.executeOrder{value: PYTH_FEE}(1, newer);

        // A price from the next second is fine.
        _setPrice(BTC, 100_400e8, 0, -8);
        _close(alice, BTC);
    }

    // ───────────────────────────── Views ─────────────────────────────

    function test_views_orders() public {
        vm.prank(alice);
        engine.createLimitOrder(_limit(BTC, true, 1_000e6, 10_000e6, 99_000e18));
        vm.prank(bob);
        engine.createLimitOrder(_limit(ETH, false, 1_000e6, 10_000e6, 4_100e18));
        vm.prank(alice);
        engine.createLimitOrder(_limit(ETH, true, 1_000e6, 10_000e6, 3_900e18));

        (uint256[] memory ids, PerpEngine.Order[] memory orders) = engine.getOrders(0, 10);
        assertEq(ids.length, 3);
        assertEq(orders.length, 3);
        assertEq(ids[0], 1);
        assertEq(orders[1].trader, bob);
        (ids, orders) = engine.getOrders(1, 1);
        assertEq(ids.length, 1);
        assertEq(ids[0], 2);
        (ids, orders) = engine.getOrders(3, 10);
        assertEq(ids.length, 0);
        assertEq(orders.length, 0);

        (ids, orders) = engine.getTraderOrders(alice);
        assertEq(ids.length, 2);
        assertEq(ids[0], 1);
        assertEq(ids[1], 3);
        assertEq(orders[1].priceId, ETH);
        (ids,) = engine.getTraderOrders(carol);
        assertEq(ids.length, 0);
    }
}
