// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PerpEngine} from "../src/PerpEngine.sol";
import {LimitParams, OpenParams, Order, OrderType, Position} from "../src/Types.sol";
import {Base} from "./Base.t.sol";

/// @notice `Close` orders: a market close executed by a keeper, optionally bounded by a worst acceptable price.
contract CloseOrdersTest is Base {
    function setUp() public override {
        super.setUp();
        _flatFees();
    }

    function _closeOrder(address who, bytes32 id, uint256 bound_) internal returns (uint256) {
        vm.prank(who);
        return engine.setTriggerOrder(id, OrderType.Close, bound_);
    }

    function test_closeOrder_create() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        uint256 before = usdc.balanceOf(alice);

        vm.expectEmit(address(engine));
        emit PerpEngine.OrderCreated(1, alice, BTC, OrderType.Close, true, 0, 0, 0);
        assertEq(_closeOrder(alice, BTC, 0), 1); // no bound

        assertEq(before - usdc.balanceOf(alice), EXEC_FEE);
        Position memory pos = engine.getPosition(alice, BTC);
        assertEq(pos.closeOrderId, 1);
        assertEq(pos.tpOrderId, 0);
        assertEq(pos.slOrderId, 0);
        Order memory o = engine.getOrder(1);
        assertEq(o.trader, alice);
        assertEq(o.priceId, BTC);
        assertEq(uint8(o.orderType), uint8(OrderType.Close));
        assertEq(uint8(o.orderType), 3);
        assertTrue(o.isLong);
        assertEq(o.createdAt, vm.getBlockTimestamp());
        assertEq(o.margin, 0);
        assertEq(o.size, 0);
        assertEq(o.triggerPrice, 0);
        assertEq(o.feeBudget, 0);
        assertEq(o.executionFee, EXEC_FEE);
        assertEq(engine.orderCount(), 1);
        _assertEngineSolvent();
    }

    function test_closeOrder_requiresAPosition() public {
        vm.prank(alice);
        vm.expectRevert(PerpEngine.PositionNotFound.selector);
        engine.setTriggerOrder(BTC, OrderType.Close, 0);
    }

    function test_closeOrder_moveIsFreeAndKeepsTheOrder() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        uint256 id = _closeOrder(alice, BTC, 0);
        uint256 afterCreate = usdc.balanceOf(alice);

        skip(5);
        vm.expectEmit(address(engine));
        emit PerpEngine.OrderUpdated(id, 99_500e18);
        assertEq(_closeOrder(alice, BTC, 99_500e18), id);
        assertEq(usdc.balanceOf(alice), afterCreate);
        assertEq(engine.getOrder(id).triggerPrice, 99_500e18);
        assertEq(engine.getOrder(id).createdAt, vm.getBlockTimestamp());
        // ... and back to unbounded.
        assertEq(_closeOrder(alice, BTC, 0), id);
        assertEq(engine.getOrder(id).triggerPrice, 0);
        assertEq(engine.orderCount(), 1);
        assertEq(engine.nextOrderId(), 2);
    }

    function test_closeOrder_cancelRefundsAndUnlinks() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        uint256 before = usdc.balanceOf(alice);
        uint256 id = _closeOrder(alice, BTC, 0);

        vm.prank(bob);
        vm.expectRevert(PerpEngine.NotOrderOwner.selector);
        engine.cancelOrder(id);

        vm.expectEmit(address(engine));
        emit PerpEngine.OrderCancelled(id, alice);
        vm.prank(alice);
        engine.cancelOrder(id);
        assertEq(usdc.balanceOf(alice), before);
        assertEq(engine.getPosition(alice, BTC).closeOrderId, 0);
        assertEq(engine.orderCount(), 0);
        // A new one can be placed afterwards and gets a new id.
        assertEq(_closeOrder(alice, BTC, 0), 2);
        assertEq(engine.getPosition(alice, BTC).closeOrderId, 2);
        _assertEngineSolvent();
    }

    function test_closeOrder_executeWithoutBound_long() public {
        bytes32 key = _open(alice, BTC, true, 1_000e6, 10_000e6);
        uint256 id = _closeOrder(alice, BTC, 0);
        uint256 before = usdc.balanceOf(alice);

        _setPrice(BTC, 101_000e8, 100e8, -8); // a sell fills at the bid, 100,900
        vm.expectEmit(address(engine));
        emit PerpEngine.PositionClosed(key, alice, BTC, 100_900e18, 90e6, 5e6, 1_085e6);
        vm.expectEmit(address(engine));
        emit PerpEngine.OrderExecuted(id, alice, keeper, 100_900e18);
        _exec(id);

        assertEq(usdc.balanceOf(alice), before + 1_085e6);
        assertEq(usdc.balanceOf(keeper), EXEC_FEE); // the keeper earns the escrowed fee
        assertEq(engine.positionCount(), 0);
        assertEq(engine.orderCount(), 0);
        assertEq(engine.getOrder(id).trader, address(0));
        assertEq(usdc.balanceOf(address(engine)), 0);
    }

    function test_closeOrder_executeWithoutBound_shortAtALoss() public {
        _open(alice, BTC, false, 1_000e6, 10_000e6);
        uint256 id = _closeOrder(alice, BTC, 0);
        uint256 before = usdc.balanceOf(alice);
        _setPrice(BTC, 101_000e8, 100e8, -8); // a buy fills at the ask, 101,100
        _exec(id);
        assertEq(usdc.balanceOf(alice), before + 1_000e6 - 110e6 - 5e6);
        assertEq(house.balanceOf(alice), 11_000e18);
    }

    function test_closeOrder_boundNotMet_long() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        uint256 id = _closeOrder(alice, BTC, 100_500e18); // sell at 100,500 or better
        uint256 before = usdc.balanceOf(alice);

        _setBtc(100_499);
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.TriggerNotMet.selector);
        engine.executeOrder(id, _noBytes());

        // The bound is on the execution price: mid 100,550 with the bid at 100,450 is not good enough.
        _setPrice(BTC, 100_550e8, 100e8, -8);
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.TriggerNotMet.selector);
        engine.executeOrder(id, _noBytes());

        _setPrice(BTC, 100_600e8, 100e8, -8); // bid exactly 100,500
        _exec(id);
        assertEq(usdc.balanceOf(alice), before + 1_000e6 + 50e6 - 5e6);
    }

    function test_closeOrder_boundNotMet_short() public {
        _open(alice, BTC, false, 1_000e6, 10_000e6);
        uint256 id = _closeOrder(alice, BTC, 99_500e18); // buy back at 99,500 or better
        uint256 before = usdc.balanceOf(alice);

        _setBtc(99_501);
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.TriggerNotMet.selector);
        engine.executeOrder(id, _noBytes());
        _setPrice(BTC, 99_450e8, 100e8, -8); // ask 99,550
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.TriggerNotMet.selector);
        engine.executeOrder(id, _noBytes());

        _setPrice(BTC, 99_400e8, 100e8, -8); // ask exactly 99,500
        _exec(id);
        assertEq(usdc.balanceOf(alice), before + 1_000e6 + 50e6 - 5e6);
    }

    /// @dev Unlike a stop-loss, a bounded Close order can sit on the losing side: it is a limit on the exit.
    function test_closeOrder_boundBelowEntryIsALimitedExitNotAStop() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        uint256 id = _closeOrder(alice, BTC, 99_000e18);
        _setBtc(98_999); // a stop at 99,000 would fire here; the Close order must not
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.TriggerNotMet.selector);
        engine.executeOrder(id, _noBytes());
        _setBtc(99_000);
        _exec(id);
        assertEq(engine.positionCount(), 0);
    }

    function test_closeOrder_needsAPricePublishedAfterTheOpen() public {
        // Open and place the Close order in the same second: the price that opened it cannot close it.
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        uint256 id = _closeOrder(alice, BTC, 0);
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.PriceNotAfterOpen.selector);
        engine.executeOrder(id, _noBytes());

        // A price from the next second can.
        skip(1);
        bytes[] memory newer = _fresh(BTC, 100_400e8, 0, -8);
        vm.prank(keeper);
        engine.executeOrder{value: PYTH_FEE}(id, newer);
        assertEq(engine.positionCount(), 0);
    }

    function test_closeOrder_needsAPriceAtOrAfterItsCreation() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        _setBtc(100_300); // published after the open ...
        skip(2);
        uint256 id = _closeOrder(alice, BTC, 0); // ... but before the order
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.PriceBeforeOrder.selector);
        engine.executeOrder(id, _noBytes());

        // Moving the order re-arms the rule.
        _publish(BTC, 100_300e8, 0, -8); // same second as the order: fine
        skip(1);
        _closeOrder(alice, BTC, 100_000e18);
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.PriceBeforeOrder.selector);
        engine.executeOrder(id, _noBytes());

        _publish(BTC, 100_300e8, 0, -8);
        _exec(id);
        assertEq(engine.positionCount(), 0);
    }

    function test_closeOrder_cancelledOnManualClose_escrowBackToTheTrader() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        uint256 id = _closeOrder(alice, BTC, 150_000e18);
        uint256 before = usdc.balanceOf(alice);
        _setBtc(100_000);
        vm.expectEmit(address(engine));
        emit PerpEngine.OrderCancelled(id, alice);
        _close(alice, BTC);
        assertEq(usdc.balanceOf(alice), before + 995e6 + EXEC_FEE);
        assertEq(engine.orderCount(), 0);
        assertEq(vault.totalFeesCollected(), 5e6 + 5e6);
        assertEq(usdc.balanceOf(address(engine)), 0);
    }

    function test_closeOrder_cancelledOnLiquidation_escrowToTheVault() public {
        _open(alice, BTC, true, 100e6, 10_000e6); // 100x
        uint256 id = _closeOrder(alice, BTC, 150_000e18);
        uint256 before = usdc.balanceOf(alice);
        _setBtc(99_000);

        // Past the threshold the position belongs to liquidators, not to its orders.
        _closeOrder(alice, BTC, 0);
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.PositionLiquidatable.selector);
        engine.executeOrder(id, _noBytes());

        vm.expectEmit(address(engine));
        emit PerpEngine.OrderCancelled(id, alice);
        vm.prank(keeper);
        engine.liquidate(alice);
        assertEq(usdc.balanceOf(alice), before); // nothing back, not even the order's escrow
        assertEq(usdc.balanceOf(keeper), 2e6); // the liquidation fee only
        assertEq(vault.totalFeesCollected(), 5e6 + EXEC_FEE);
        assertEq(vault.totalTraderLosses(), 98e6);
        assertEq(engine.orderCount(), 0);
        assertEq(usdc.balanceOf(address(engine)), 0);
    }

    function test_closeOrder_coexistsWithBrackets_andSiblingsAreCancelledWhenOneFires() public {
        OpenParams memory p = _params(BTC, true, 1_000e6, 10_000e6);
        p.takeProfit = 102_000e18;
        p.stopLoss = 98_000e18;
        vm.prank(alice);
        engine.openPosition(p, _noBytes());
        uint256 id = _closeOrder(alice, BTC, 101_000e18);
        assertEq(id, 3);
        Position memory pos = engine.getPosition(alice, BTC);
        assertEq(pos.tpOrderId, 1);
        assertEq(pos.slOrderId, 2);
        assertEq(pos.closeOrderId, 3);
        (uint256[] memory ids,) = lens.getTraderOrders(alice);
        assertEq(ids.length, 3);
        uint256 before = usdc.balanceOf(alice);

        // The Close order fires first: both brackets are cancelled and their escrow returned.
        _setBtc(101_000);
        _exec(3);
        assertEq(usdc.balanceOf(alice), before + 1_000e6 + 100e6 - 5e6 + 2 * EXEC_FEE);
        assertEq(engine.orderCount(), 0);
        assertEq(usdc.balanceOf(keeper), EXEC_FEE);

        // The other way round: a take-profit firing cancels the Close order and refunds it.
        vm.prank(alice);
        engine.openPosition(p, _noBytes()); // orders 4 (TP) and 5 (SL)
        assertEq(_closeOrder(alice, BTC, 150_000e18), 6);
        before = usdc.balanceOf(alice);
        _setBtc(102_000);
        _exec(4);
        assertEq(usdc.balanceOf(alice), before + 1_000e6 + 99_009_900 - 5e6 + 2 * EXEC_FEE);
        assertEq(engine.orderCount(), 0);
        _assertEngineSolvent();
    }

    function test_closeOrder_worksWhilePausedAndDisabled() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        vm.startPrank(owner);
        engine.pause();
        engine.setMarket(BTC, false, 100, MAX_OI_PER_SIDE, SKEW_SCALE);
        vm.stopPrank();
        uint256 id = _closeOrder(alice, BTC, 0); // exits must never be blocked
        _setBtc(100_000);
        _exec(id);
        assertEq(engine.positionCount(), 0);
    }

    function test_closeOrder_zeroExecutionFee() public {
        vm.prank(owner);
        engine.setFeeParams(5, 0, 0, 0);
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        uint256 before = usdc.balanceOf(alice);
        uint256 id = _closeOrder(alice, BTC, 0);
        assertEq(usdc.balanceOf(alice), before);
        _setBtc(100_000);
        _exec(id);
        assertEq(usdc.balanceOf(keeper), 0);
        assertEq(usdc.balanceOf(alice), before + 995e6);
    }

    /// @dev The fee escrowed is the one in force when the order was created, whatever it is changed to later.
    function test_closeOrder_feeIsFixedAtCreation() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        uint256 id = _closeOrder(alice, BTC, 0);
        vm.prank(owner);
        engine.setFeeParams(5, 0, 0, 5e6);
        _closeOrder(alice, BTC, 1e18); // moving it costs nothing even though the fee went up
        assertEq(engine.getOrder(id).executionFee, EXEC_FEE);
        _setBtc(100_000);
        _exec(id);
        assertEq(usdc.balanceOf(keeper), EXEC_FEE);
        _assertEngineSolvent();
    }

    /// @dev The wallet flow end to end: a marketable limit order is the keeper-executed market open, a Close
    ///      order the keeper-executed market close. The trader never submits a price.
    function test_walletFlow_marketableLimitThenCloseOrder() public {
        uint256 before = usdc.balanceOf(alice);
        // "Buy at market, up to 0.5% slippage": a limit above the current ask. The price the trader saw is
        // a second old by the time the order lands, and the keeper cannot fill against it ...
        skip(1);
        vm.prank(alice);
        uint256 openId = engine.createLimitOrder(_limit(BTC, true, 1_000e6, 10_000e6, 100_500e18));
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.PriceBeforeOrder.selector);
        engine.executeOrder(openId, _noBytes());

        // ... it fills against the next one, at that price.
        skip(1);
        bytes[] memory update = _fresh(BTC, 100_100e8, 0, -8);
        vm.prank(keeper);
        engine.executeOrder{value: PYTH_FEE}(openId, update);
        assertEq(engine.getPosition(alice, BTC).entryPrice, 100_100e18);
        // margin + actual fee (5 bps; the skew surcharge is off) + the keeper's fee; the unused budget came back
        assertEq(before - usdc.balanceOf(alice), 1_000e6 + 5e6 + EXEC_FEE);

        // A price beyond the slippage limit would not have filled.
        vm.prank(bob);
        uint256 bobId = engine.createLimitOrder(_limit(BTC, true, 1_000e6, 10_000e6, 100_500e18));
        _setBtc(100_501);
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.TriggerNotMet.selector);
        engine.executeOrder(bobId, _noBytes());

        // "Sell at market, at least 100,000".
        uint256 closeId = _closeOrder(alice, BTC, 100_000e18);
        skip(1);
        update = _fresh(BTC, 101_101e8, 0, -8);
        vm.prank(keeper);
        engine.executeOrder{value: PYTH_FEE}(closeId, update);
        // +1% on 10,000 = 100, less 5 close fee
        assertEq(usdc.balanceOf(alice), before - 5e6 - EXEC_FEE - EXEC_FEE + 100e6 - 5e6);
        assertEq(usdc.balanceOf(keeper), 2 * EXEC_FEE);
        _assertEngineSolvent();
    }
}
