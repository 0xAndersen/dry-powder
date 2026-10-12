// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PerpEngine} from "../src/PerpEngine.sol";
import {Base} from "./Base.t.sol";

/// @dev A caller that cannot receive native value, to exercise the refund failure path.
contract NoReceive {
    function open(PerpEngine engine, PerpEngine.OpenParams calldata p, bytes[] calldata update) external payable {
        engine.openPosition{value: msg.value}(p, update);
    }
}

contract OracleTest is Base {
    bytes32 internal constant NEW_FEED = bytes32(uint256(0xfeed));

    function _expectOpenRevert(bytes32 id, bytes4 selector) internal {
        vm.prank(alice);
        vm.expectRevert(selector);
        engine.openPosition(_params(id, true, 1_000e6, 10_000e6), _noBytes());
    }

    function test_unavailable_feedNeverPublished() public {
        vm.prank(owner);
        engine.addMarket(NEW_FEED, false, 50, MAX_OI_PER_SIDE, SKEW_SCALE);
        _expectOpenRevert(NEW_FEED, PerpEngine.OraclePriceUnavailable.selector);
        vm.expectRevert(PerpEngine.OraclePriceUnavailable.selector);
        engine.getPrice(NEW_FEED);
    }

    function test_stale_priceOlderThanMaxAge() public {
        skip(3);
        _open(alice, BTC, true, 1_000e6, 10_000e6); // exactly at the limit is fine
        skip(1);
        _expectOpenRevert(ETH, PerpEngine.OraclePriceStale.selector);
        vm.prank(alice);
        vm.expectRevert(PerpEngine.OraclePriceStale.selector);
        engine.closePosition(BTC, 0, _noBytes());

        // A fresh update in the same transaction fixes it.
        bytes[] memory update = _fresh(BTC, 100_000e8, 0, -8);
        vm.prank(alice);
        engine.closePosition{value: PYTH_FEE}(BTC, 0, update);
        assertEq(engine.positionCount(), 0);
    }

    function test_stale_priceTooFarInTheFuture() public {
        bytes[] memory update = _updateData(BTC, 100_000e8, 0, -8, uint64(block.timestamp + 4));
        vm.prank(alice);
        vm.expectRevert(PerpEngine.OraclePriceStale.selector);
        engine.openPosition{value: PYTH_FEE}(_params(BTC, true, 1_000e6, 10_000e6), update);

        // Small clock skew between Pyth and the chain is tolerated.
        update = _updateData(BTC, 100_000e8, 0, -8, uint64(block.timestamp + 3));
        vm.prank(alice);
        engine.openPosition{value: PYTH_FEE}(_params(BTC, true, 1_000e6, 10_000e6), update);
    }

    function test_invalid_nonPositivePrice() public {
        _setPrice(BTC, 0, 0, -8);
        _expectOpenRevert(BTC, PerpEngine.OraclePriceInvalid.selector);
        _setPrice(BTC, -100_000e8, 0, -8);
        _expectOpenRevert(BTC, PerpEngine.OraclePriceInvalid.selector);
    }

    function test_invalid_unsupportedExponent() public {
        _setPrice(BTC, 100_000, 0, 1);
        _expectOpenRevert(BTC, PerpEngine.OraclePriceInvalid.selector);
        _setPrice(BTC, 100_000, 0, -19);
        _expectOpenRevert(BTC, PerpEngine.OraclePriceInvalid.selector);
    }

    function test_exponentRange_zeroAndMinus18() public {
        _setPrice(BTC, 100_000, 0, 0);
        assertEq(engine.getPrice(BTC).mid, 100_000e18);
        _setPrice(BTC, 5e18, 0, -18);
        assertEq(engine.getPrice(BTC).mid, 5e18);
    }

    function test_invalid_invertedPriceUnderflowsToZero() public {
        // 9.2e18 with exponent 0 is 9.2e36 at 18 decimals; its reciprocal rounds to zero.
        _setPrice(JPY, type(int64).max, 0, 0);
        _expectOpenRevert(JPY, PerpEngine.OraclePriceInvalid.selector);
    }

    function test_confidenceTooWide() public {
        _setPrice(BTC, 100_000e8, 500e8, -8); // exactly 0.50%
        PerpEngine.OraclePrice memory px = engine.getPrice(BTC);
        assertEq(px.bid, 99_500e18);
        assertEq(px.ask, 100_500e18);
        assertEq(px.mid, 100_000e18);
        assertEq(px.publishTime, block.timestamp);

        _setPrice(BTC, 100_000e8, 500e8 + 1, -8);
        _expectOpenRevert(BTC, PerpEngine.OracleConfidenceTooWide.selector);
    }

    function test_invertedBand_isOrderedAndRoundedOutwards() public {
        _setPrice(JPY, 150_000, 150, -3); // USD/JPY 150.000 +- 0.150
        PerpEngine.OraclePrice memory px = engine.getPrice(JPY);
        assertEq(px.mid, uint256(1e36) / 150e18);
        assertEq(px.bid, uint256(1e36) / 150.15e18);
        assertEq(px.ask, uint256(1e36) / 149.85e18 + 1);
        assertLt(px.bid, px.mid);
        assertLt(px.mid, px.ask);
    }

    /// @dev "Oracle failure rollback": when the price pushed in a transaction is unusable, everything the
    ///      transaction did, including the Pyth update itself and the fee paid for it, is rolled back.
    function test_rollback_badUpdateLeavesNoTrace() public {
        uint256 usdcBefore = usdc.balanceOf(alice);
        uint256 nativeBefore = alice.balance;
        uint256 navBefore = vault.totalHouseBalance();
        skip(1);
        bytes[] memory update = _fresh(BTC, 100_000e8, 5_000e8, -8); // 5% confidence

        vm.prank(alice);
        vm.expectRevert(PerpEngine.OracleConfidenceTooWide.selector);
        engine.openPosition{value: PYTH_FEE}(_params(BTC, true, 1_000e6, 10_000e6), update);

        assertEq(usdc.balanceOf(alice), usdcBefore);
        assertEq(alice.balance, nativeBefore);
        assertEq(vault.totalHouseBalance(), navBefore);
        assertEq(engine.positionCount(), 0);
        assertEq(engine.totalOpenInterest(), 0);
        assertEq(pyth.getPriceUnsafe(BTC).conf, 0); // Pyth still holds the previous good price
        assertEq(address(engine).balance, 0);
    }

    function test_rollback_staleDuringLiquidationLeavesPositionIntact() public {
        _open(alice, BTC, true, 1_000e6, 100_000e6);
        skip(10);
        // The keeper's update is itself too old.
        bytes[] memory update = _updateData(BTC, 99_000e8, 0, -8, uint64(block.timestamp - 5));
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.NothingToLiquidate.selector);
        engine.liquidate{value: PYTH_FEE}(alice, update);
        assertEq(engine.getPosition(alice, BTC).margin, 1_000e6);
        assertEq(usdc.balanceOf(keeper), 0);
    }

    // ───────────────────────────── Pyth fee handling ─────────────────────────────

    function test_pythFee_isPaidFromMsgValueAndExcessRefunded() public {
        skip(1);
        bytes[] memory update = _fresh(BTC, 100_250e8, 0, -8);
        uint256 nativeBefore = alice.balance;
        vm.prank(alice);
        engine.openPosition{value: 0.5 ether}(_params(BTC, true, 1_000e6, 10_000e6), update);
        assertEq(nativeBefore - alice.balance, PYTH_FEE);
        assertEq(address(engine).balance, 0);
        assertEq(engine.getPosition(alice, BTC).entryPrice, 100_250e18);
    }

    function test_pythFee_insufficientReverts() public {
        skip(1);
        bytes[] memory update = _fresh(BTC, 100_250e8, 0, -8);
        vm.prank(alice);
        vm.expectRevert(PerpEngine.InsufficientOracleFee.selector);
        engine.openPosition(_params(BTC, true, 1_000e6, 10_000e6), update);
    }

    function test_pythFee_valueWithoutUpdateIsRefundedInFull() public {
        uint256 nativeBefore = alice.balance;
        vm.prank(alice);
        engine.openPosition{value: 0.1 ether}(_params(BTC, true, 1_000e6, 10_000e6), _noBytes());
        assertEq(alice.balance, nativeBefore);
        assertEq(address(engine).balance, 0);
    }

    function test_pythFee_refundFailureReverts() public {
        NoReceive caller = new NoReceive();
        vm.deal(address(this), 1 ether);
        vm.expectRevert(PerpEngine.RefundFailed.selector);
        caller.open{value: 1}(engine, _params(BTC, true, 1_000e6, 10_000e6), _noBytes());
    }

    function test_pythFee_allPayableEntryPointsRefund() public {
        skip(1);
        bytes[] memory update = _fresh(BTC, 100_000e8, 0, -8);
        PerpEngine.OpenParams memory p = _params(BTC, true, 1_000e6, 10_000e6);
        p.takeProfit = 101_000e18;

        vm.startPrank(alice);
        uint256 nativeBefore = alice.balance;
        engine.openPosition{value: 7}(p, update);
        skip(1);
        update = _fresh(BTC, 101_000e8, 0, -8);
        vm.stopPrank();

        vm.prank(keeper);
        engine.executeOrder{value: 7}(1, update);
        assertEq(nativeBefore - alice.balance, PYTH_FEE);
        assertEq(keeper.balance, 1 ether - PYTH_FEE);
        assertEq(address(engine).balance, 0);
    }
}
