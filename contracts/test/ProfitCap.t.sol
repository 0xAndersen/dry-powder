// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PerpEngine} from "../src/PerpEngine.sol";
import {PerpEngineBase} from "../src/PerpEngineBase.sol";
import {OpenParams, OrderType} from "../src/Types.sol";
import {Base} from "./Base.t.sol";

/// @notice A position's profit is capped at `maxProfitMultiple` times its margin.
contract ProfitCapTest is Base {
    function setUp() public override {
        super.setUp();
        _flatFees();
    }

    function test_cap_longAtDefaultMultiple() public {
        // 100x: margin 100, notional 10,000. The cap of 10x margin = 1,000 is reached at +10%.
        bytes32 key = _open(alice, BTC, true, 100e6, 10_000e6);
        uint256 afterOpen = usdc.balanceOf(alice);
        uint256 navBefore = vault.totalHouseBalance();
        _setBtc(120_000); // +20%: uncapped profit would be 2,000

        // The lens reports the uncapped figure, as documented.
        (int256 pnl,,,) = lens.getPositionState(key, 120_000e18);
        assertEq(pnl, 2_000e6);

        vm.expectEmit(address(engine));
        emit PerpEngineBase.PositionClosed(key, alice, BTC, 120_000e18, 1_000e6, 5e6, 1_095e6);
        _close(alice, BTC);
        assertEq(usdc.balanceOf(alice), afterOpen + 100e6 - 5e6 + 1_000e6);
        assertEq(vault.totalTraderProfits(), 1_000e6);
        assertEq(vault.totalHouseBalance(), navBefore + 5e6 - 1_000e6);
        assertEq(vault.totalShortfall(), 0);
        _assertEngineSolvent();
    }

    function test_cap_exactlyAtAndJustBelowTheCap() public {
        _open(alice, BTC, true, 100e6, 10_000e6);
        _open(bob, BTC, true, 100e6, 10_000e6);
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);
        _setBtc(110_000); // exactly +10% = 1,000
        _close(alice, BTC);
        assertEq(usdc.balanceOf(alice), aliceBefore + 95e6 + 1_000e6);
        _setBtc(109_999); // 999.9
        _close(bob, BTC);
        assertEq(usdc.balanceOf(bob), bobBefore + 95e6 + 999.9e6);
    }

    function test_cap_short() public {
        _open(alice, BTC, false, 100e6, 10_000e6);
        uint256 afterOpen = usdc.balanceOf(alice);
        _setBtc(50_000); // -50%: uncapped 5,000
        _close(alice, BTC);
        assertEq(usdc.balanceOf(alice), afterOpen + 95e6 + 1_000e6);
    }

    function test_cap_doesNotBindAtLowLeverage() public {
        // 2x: a 10x-margin profit would need +500%.
        _open(alice, BTC, true, 1_000e6, 2_000e6);
        uint256 afterOpen = usdc.balanceOf(alice);
        _setBtc(400_000); // +300%: 6,000 profit, under the 10,000 cap
        _close(alice, BTC);
        assertEq(usdc.balanceOf(alice), afterOpen + 1_000e6 - 1e6 + 6_000e6);
    }

    function test_cap_appliesToKeeperClosesAndSettlement() public {
        OpenParams memory p = _params(BTC, true, 100e6, 10_000e6);
        p.takeProfit = 105_000e18;
        vm.prank(alice);
        engine.openPosition(p, _noBytes());
        _open(bob, BTC, true, 100e6, 10_000e6);
        vm.prank(bob);
        uint256 closeId = engine.setTriggerOrder(BTC, OrderType.Close, 0, 0);
        bytes32 carolKey = _open(carol, FUT, true, 100e6, 10_000e6);
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);
        uint256 carolBefore = usdc.balanceOf(carol);

        _setBtc(130_000); // gaps far through the take-profit
        _exec(1);
        _exec(closeId);
        assertEq(usdc.balanceOf(alice), aliceBefore + 95e6 + 1_000e6);
        assertEq(usdc.balanceOf(bob), bobBefore + 95e6 + 1_000e6);

        vm.warp(EXPIRY);
        _publish(BTC, 130_000e8, 0, -8);
        engine.settleMarket(FUT, _noBytes());
        engine.settlePositions(_keys(carolKey));
        assertEq(usdc.balanceOf(carol), carolBefore + 95e6 + 1_000e6);
    }

    function test_setMaxProfitMultiple_bounds() public {
        vm.startPrank(owner);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setMaxProfitMultiple(0);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setMaxProfitMultiple(101);
        engine.setMaxProfitMultiple(1);
        engine.setMaxProfitMultiple(100);
        vm.stopPrank();
        assertEq(engine.maxProfitMultiple(), 100);
    }

    function test_setMaxProfitMultiple_takesEffectOnClose() public {
        _open(alice, BTC, true, 100e6, 10_000e6);
        _open(bob, BTC, true, 100e6, 10_000e6);
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);
        _setBtc(150_000); // +50%: 5,000 uncapped

        vm.prank(owner);
        engine.setMaxProfitMultiple(1); // profit at most the margin
        _close(alice, BTC);
        assertEq(usdc.balanceOf(alice), aliceBefore + 95e6 + 100e6);

        vm.prank(owner);
        engine.setMaxProfitMultiple(100); // 10,000: no longer binding
        _setBtc(150_000);
        _close(bob, BTC);
        assertEq(usdc.balanceOf(bob), bobBefore + 95e6 + 5_000e6);
    }

    /// @dev Funding received counts towards the cap like any other profit.
    function test_cap_includesFundingReceived() public {
        vm.prank(owner);
        engine.setFeeParams(0, 0, 317_097_919_837, EXEC_FEE); // 1000% a year at full skew, no fees
        _open(bob, BTC, false, 100_000e6, 1_000_000e6);
        bytes32 key = _open(alice, BTC, true, 5e6, 500e6); // tiny long on the light side, collects funding
        skip(5 days);
        _setBtc(100_000);
        (int256 pnl, int256 owed,,) = lens.getPositionState(key, 100_000e18);
        assertLt(owed, -50e6);
        assertEq(pnl, -owed);
        uint256 before = usdc.balanceOf(alice);
        _close(alice, BTC);
        assertEq(usdc.balanceOf(alice), before + 5e6 + 50e6); // margin + 10x margin, not the ~68 accrued
    }

    /// @dev The cap bounds what one position can take from the house, whatever the price does.
    function testFuzz_cap_boundsThePayout(uint256 margin, uint256 leverage, uint256 exitPrice, bool isLong) public {
        margin = bound(margin, 5e6, 10_000e6);
        leverage = bound(leverage, 1, 100);
        exitPrice = bound(exitPrice, 1e8, 10_000_000e8);
        bytes32 key = _open(alice, BTC, isLong, margin, margin * leverage);
        uint256 afterOpen = usdc.balanceOf(alice);
        _setPrice(BTC, int64(uint64(exitPrice)), 0, -8);
        (,,, bool liquidatable) = lens.getPositionState(key, exitPrice * 1e10);
        if (liquidatable) return;
        _close(alice, BTC);
        assertLe(usdc.balanceOf(alice) - afterOpen, margin + margin * 10);
        assertLe(vault.totalTraderProfits(), margin * 10);
        _assertEngineSolvent();
    }
}
