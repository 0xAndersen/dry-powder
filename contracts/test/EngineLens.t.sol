// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EngineLens} from "../src/EngineLens.sol";
import {PerpEngine} from "../src/PerpEngine.sol";
import {PythOracle} from "../src/PythOracle.sol";
import {
    LimitParams,
    OpenParams,
    OraclePrice,
    Order,
    OrderType,
    Position,
    PositionView,
    PriceStatus
} from "../src/Types.sol";
import {Base} from "./Base.t.sol";

contract EngineLensTest is Base {
    function test_getMarkets() public {
        _open(alice, BTC, true, 50_000e6, 500_000e6);
        EngineLens.MarketView[] memory ms = lens.getMarkets();
        assertEq(ms.length, 6);

        assertEq(ms[0].id, BTC);
        assertEq(ms[0].market.symbol, "BTC-USD");
        assertEq(ms[0].market.feedId, BTC);
        assertEq(ms[0].market.longOi, 500_000e6);
        assertEq(ms[0].market.maxLeverage, 100);
        assertTrue(ms[0].market.enabled);
        assertEq(ms[0].fundingRate, engine.fundingRate(BTC));
        assertEq(ms[0].fundingRate, int256(uint256(15_854_895_991) / 2));
        assertTrue(ms[0].hasPrice);
        assertEq(ms[0].price.mid, 100_000e18);
        assertEq(ms[0].price.bid, 100_000e18);
        assertEq(ms[0].price.ask, 100_000e18);
        assertEq(ms[0].price.publishTime, vm.getBlockTimestamp());

        assertEq(ms[1].id, ETH);
        assertEq(ms[1].price.mid, 4_000e18);
        assertEq(ms[1].fundingRate, 0);
        assertEq(ms[2].id, EUR);
        assertEq(ms[2].price.mid, 1.1e18);
        assertEq(ms[3].id, JPY);
        assertTrue(ms[3].market.invert);
        assertEq(ms[3].price.mid, uint256(1e36) / 150e18);
        assertEq(ms[4].id, ETHBTC);
        assertEq(ms[4].market.quoteFeedId, BTC);
        assertEq(ms[4].price.mid, 0.04e18);
        assertEq(ms[5].id, FUT);
        assertEq(ms[5].market.expiry, EXPIRY);
        assertEq(ms[5].price.mid, 100_000e18);
        for (uint256 i; i < 6; ++i) {
            assertTrue(ms[i].hasPrice);
        }
    }

    function test_getMarkets_hasPriceIsFalseWithoutAUsablePrice() public {
        // Only ETH is refreshed: everything that needs another feed loses its price, and the call still
        // returns every market.
        skip(10);
        _publish(ETH, 4_100e8, 0, -8);
        EngineLens.MarketView[] memory ms = lens.getMarkets();
        assertEq(ms.length, 6);
        assertFalse(ms[0].hasPrice); // BTC: stale, so the last price is reported as a reference only
        assertGt(ms[0].price.mid, 0);
        assertLt(ms[0].price.publishTime, block.timestamp - engine.maxPriceAge());
        assertEq(ms[0].market.symbol, "BTC-USD"); // configuration is still reported
        assertTrue(ms[1].hasPrice); // ETH
        assertEq(ms[1].price.mid, 4_100e18);
        assertFalse(ms[2].hasPrice);
        assertFalse(ms[3].hasPrice);
        assertFalse(ms[4].hasPrice); // ETH/BTC: the quote leg is stale
        assertFalse(ms[5].hasPrice);

        // A feed that was never published, an invalid price, too wide a confidence: all simply "no price".
        vm.prank(owner);
        engine.addMarket(bytes32(uint256(0xfeed)), _cfg("NEW-USD", bytes32(uint256(0xfeed)), bytes32(0), false, 0));
        _setPrice(BTC, 0, 0, -8);
        _publish(ETH, 4_100e8, 400e8, -8);
        ms = lens.getMarkets();
        assertEq(ms.length, 7);
        for (uint256 i; i < 7; ++i) {
            assertFalse(ms[i].hasPrice);
        }
    }

    function test_positions_pagination() public {
        bytes32 k1 = _open(alice, BTC, true, 1_000e6, 10_000e6);
        bytes32 k2 = _open(bob, BTC, false, 1_000e6, 10_000e6);
        bytes32 k3 = _open(bob, ETH, true, 1_000e6, 10_000e6);

        PositionView[] memory all = lens.getPositions(0, type(uint256).max);
        assertEq(all.length, 3);
        assertEq(all[0].key, k1);
        assertEq(all[1].key, k2);
        assertEq(all[2].key, k3);
        assertEq(all[2].position.trader, bob);
        assertEq(all[0].liquidationPrice, 91_000e18);
        assertEq(all[1].liquidationPrice, 109_000e18);
        assertEq(all[0].fundingOwed, 0);

        assertEq(lens.getPositions(0, 2).length, 2);
        assertEq(lens.getPositions(1, 1)[0].key, k2);
        assertEq(lens.getPositions(2, 10).length, 1);
        assertEq(lens.getPositions(3, 10).length, 0);
        assertEq(lens.getPositions(100, 10).length, 0);
        assertEq(lens.getPositions(0, 0).length, 0);

        // The engine's primitive pager underneath.
        assertEq(engine.positionCount(), 3);
        assertEq(engine.positionKeys(0, 10).length, 3);
        assertEq(engine.positionKeys(1, 1)[0], k2);
        assertEq(engine.positionKeys(3, 1).length, 0);
    }

    function test_traderPositions() public {
        _open(bob, BTC, false, 1_000e6, 10_000e6);
        _open(bob, ETH, true, 1_000e6, 10_000e6);
        _open(bob, FUT, true, 1_000e6, 10_000e6);
        _open(alice, ETHBTC, true, 1_000e6, 10_000e6);

        PositionView[] memory bobs = lens.getTraderPositions(bob);
        assertEq(bobs.length, 3);
        assertEq(bobs[0].key, engine.positionKey(bob, BTC));
        assertEq(bobs[1].position.priceId, ETH);
        assertEq(bobs[2].position.priceId, FUT);
        assertEq(lens.getTraderPositions(alice).length, 1);
        assertEq(lens.getTraderPositions(alice)[0].position.priceId, ETHBTC);
        assertEq(lens.getTraderPositions(carol).length, 0);
    }

    function test_orders_paginationAndTraderOrders() public {
        vm.prank(alice);
        engine.createLimitOrder(_limit(BTC, true, 1_000e6, 10_000e6, 99_000e18));
        vm.prank(bob);
        engine.createLimitOrder(_limit(ETH, false, 1_000e6, 10_000e6, 4_100e18));
        _open(alice, ETH, true, 1_000e6, 10_000e6);
        vm.startPrank(alice);
        engine.setTriggerOrder(ETH, OrderType.Close, 0);
        engine.setTriggerOrder(ETH, OrderType.StopLoss, 3_900e18);
        vm.stopPrank();

        (uint256[] memory ids, Order[] memory orders) = lens.getOrders(0, 10);
        assertEq(ids.length, 4);
        assertEq(orders.length, 4);
        assertEq(ids[0], 1);
        assertEq(orders[1].trader, bob);
        assertEq(uint8(orders[2].orderType), uint8(OrderType.Close));
        (ids, orders) = lens.getOrders(1, 2);
        assertEq(ids.length, 2);
        assertEq(ids[0], 2);
        assertEq(ids[1], 3);
        (ids, orders) = lens.getOrders(4, 10);
        assertEq(ids.length, 0);
        assertEq(orders.length, 0);

        (ids, orders) = lens.getTraderOrders(alice);
        assertEq(ids.length, 3);
        assertEq(ids[0], 1);
        assertEq(ids[1], 3);
        assertEq(ids[2], 4);
        assertEq(orders[0].priceId, BTC);
        assertEq(uint8(orders[2].orderType), uint8(OrderType.StopLoss));
        (ids, orders) = lens.getTraderOrders(bob);
        assertEq(ids.length, 1);
        assertEq(ids[0], 2);
        (ids,) = lens.getTraderOrders(carol);
        assertEq(ids.length, 0);

        // The engine's primitive pager underneath.
        assertEq(engine.orderCount(), 4);
        assertEq(engine.orderIds(0, 10).length, 4);
        assertEq(engine.orderIds(3, 5)[0], 4);
        assertEq(engine.orderIds(4, 5).length, 0);
    }

    function test_getPositionState_unknownKeyReverts() public {
        vm.expectRevert(EngineLens.PositionNotFound.selector);
        lens.getPositionState(bytes32(uint256(1)), 1e18);
    }

    /// @dev The reported liquidation price is the exact boundary of the liquidation check.
    function testFuzz_liquidationPrice_isTheBoundary(uint256 margin, uint256 leverage, bool isLong) public {
        _flatFees();
        margin = bound(margin, 5e6, 20_000e6);
        leverage = bound(leverage, 2, 100);
        bytes32 key = _open(alice, BTC, isLong, margin, margin * leverage);
        (,, uint256 liq,) = lens.getPositionState(key, 100_000e18);

        (,,, bool atLiq) = lens.getPositionState(key, liq);
        assertTrue(atLiq, "not liquidatable at the liquidation price");
        // One part per million on the safe side of it the position is healthy.
        uint256 safe = isLong ? liq + liq / 1e6 : liq - liq / 1e6;
        (,,, bool pastLiq) = lens.getPositionState(key, safe);
        assertFalse(pastLiq, "liquidatable on the safe side of the liquidation price");
    }

    /// @dev What the lens reports is what the engine does: with funding running and time passing, the lens's
    ///      `liquidatable` flag predicts exactly whether `liquidate` succeeds, and its `pnl` is exactly what a
    ///      close settles (up to the profit cap).
    function testFuzz_positionState_matchesEngineBehaviour(
        uint256 margin,
        uint256 leverage,
        uint256 exitPrice,
        uint256 wait,
        bool isLong
    ) public {
        vm.prank(owner);
        engine.setFeeParams(5, 10, 317_097_919_837, EXEC_FEE); // 1000% a year at full skew
        margin = bound(margin, 5e6, 10_000e6);
        leverage = bound(leverage, 1, 100);
        exitPrice = bound(exitPrice, 90_000e8, 110_000e8);
        wait = bound(wait, 0, 2 days);

        _open(bob, BTC, true, 30_000e6, 300_000e6); // standing skew, so funding flows either way
        bytes32 key = _open(alice, BTC, isLong, margin, margin * leverage);
        skip(wait);
        _setPrice(BTC, int64(uint64(exitPrice)), 0, -8);

        uint256 price = exitPrice * 1e10;
        (int256 pnl, int256 owed, uint256 liq, bool liquidatable) = lens.getPositionState(key, price);
        PositionView[] memory views = lens.getTraderPositions(alice);
        assertEq(views[0].fundingOwed, owed);
        assertEq(views[0].liquidationPrice, liq);
        // The flag agrees with the reported liquidation price: at or beyond it the position is always
        // liquidatable, and it is never liquidatable more than one micro-USDC of PnL short of it (losses
        // are rounded up to the next micro-USDC, which is worth entryPrice / size in price terms).
        if (isLong ? price <= liq : price >= liq) assertTrue(liquidatable, "healthy beyond the liquidation price");
        if (liquidatable) {
            uint256 tick = views[0].position.entryPrice / (margin * leverage) + 1;
            if (isLong) assertLe(price, liq + tick);
            else assertGe(price + tick, liq);
        }

        uint256 before = usdc.balanceOf(alice);
        if (liquidatable) {
            vm.prank(alice);
            vm.expectRevert(PerpEngine.PositionLiquidatable.selector);
            engine.closePosition(BTC, 0, _noBytes());
            vm.prank(keeper);
            assertEq(engine.liquidateBatch(_keys(key), _noBytes()), 1);
        } else {
            vm.prank(keeper);
            vm.expectRevert(PerpEngine.NothingToLiquidate.selector);
            engine.liquidateBatch(_keys(key), _noBytes());
            _close(alice, BTC);
            int256 cap = int256(margin * 10);
            int256 settled = pnl > cap ? cap : pnl;
            uint256 fee = (margin * leverage * 5 + 9_999) / 10_000;
            int256 expected = int256(margin) + settled;
            if (settled < 0 && uint256(-settled) > margin) expected = 0;
            uint256 left = uint256(expected);
            if (settled < 0) left = left > fee ? left - fee : 0;
            else left = left - (fee > margin ? margin : fee);
            assertEq(usdc.balanceOf(alice) - before, left);
        }
        _assertEngineSolvent();
    }
}
