// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {PerpEngine} from "../src/PerpEngine.sol";
import {Base} from "./Base.t.sol";

contract AdminTest is Base {
    bytes32 internal constant SOL = bytes32(uint256(0x501));

    function _unauthorized() internal view returns (bytes memory) {
        return abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice);
    }

    function test_onlyOwner() public {
        vm.startPrank(alice);
        vm.expectRevert(_unauthorized());
        engine.addMarket(SOL, false, 50, 1e12, 1e12);
        vm.expectRevert(_unauthorized());
        engine.setMarket(BTC, true, 50, 1e12, 1e12);
        vm.expectRevert(_unauthorized());
        engine.setFeeParams(1, 1, 1, 1);
        vm.expectRevert(_unauthorized());
        engine.setRiskParams(1, 1, 1, 1);
        vm.expectRevert(_unauthorized());
        engine.pause();
        vm.expectRevert(_unauthorized());
        engine.unpause();
        vm.stopPrank();
    }

    function test_addMarket() public {
        vm.expectEmit(address(engine));
        emit PerpEngine.MarketConfigured(SOL, true, true, 50, 123e6, 456e6);
        vm.prank(owner);
        engine.addMarket(SOL, true, 50, 123e6, 456e6);

        (
            bool enabled,
            bool invert,
            uint16 maxLeverage,
            uint64 lastFundingTime,
            uint256 maxOiPerSide,
            uint256 skewScale,
            uint256 longOi,
            uint256 shortOi,
            int256 fundingIndex
        ) = engine.markets(SOL);
        assertTrue(enabled);
        assertTrue(invert);
        assertEq(maxLeverage, 50);
        assertEq(lastFundingTime, block.timestamp);
        assertEq(maxOiPerSide, 123e6);
        assertEq(skewScale, 456e6);
        assertEq(longOi, 0);
        assertEq(shortOi, 0);
        assertEq(fundingIndex, 0);
        assertEq(engine.getMarketIds().length, 5);
    }

    function test_addMarket_validations() public {
        vm.startPrank(owner);
        vm.expectRevert(PerpEngine.MarketExists.selector);
        engine.addMarket(BTC, false, 50, 1e12, 1e12);
        vm.expectRevert(PerpEngine.InvalidParam.selector);
        engine.addMarket(bytes32(0), false, 50, 1e12, 1e12);
        vm.expectRevert(PerpEngine.InvalidParam.selector);
        engine.addMarket(SOL, false, 0, 1e12, 1e12);
        vm.expectRevert(PerpEngine.InvalidParam.selector);
        engine.addMarket(SOL, false, 101, 1e12, 1e12);
        vm.expectRevert(PerpEngine.InvalidParam.selector);
        engine.addMarket(SOL, false, 50, 1e12, 0);
        vm.stopPrank();
    }

    function test_setMarket() public {
        vm.startPrank(owner);
        vm.expectRevert(PerpEngine.MarketNotFound.selector);
        engine.setMarket(SOL, true, 50, 1e12, 1e12);
        vm.expectRevert(PerpEngine.InvalidParam.selector);
        engine.setMarket(BTC, true, 101, 1e12, 1e12);

        vm.expectEmit(address(engine));
        emit PerpEngine.MarketConfigured(JPY, false, true, 25, 7e6, 8e6);
        engine.setMarket(JPY, false, 25, 7e6, 8e6);
        vm.stopPrank();

        (bool enabled, bool invert, uint16 maxLeverage,, uint256 maxOiPerSide, uint256 skewScale,,,) =
            engine.markets(JPY);
        assertFalse(enabled);
        assertTrue(invert); // the inversion flag is fixed at listing
        assertEq(maxLeverage, 25);
        assertEq(maxOiPerSide, 7e6);
        assertEq(skewScale, 8e6);
    }

    function test_setFeeParams() public {
        vm.startPrank(owner);
        vm.expectRevert(PerpEngine.InvalidParam.selector);
        engine.setFeeParams(51, 0, 0, 0);
        vm.expectRevert(PerpEngine.InvalidParam.selector);
        engine.setFeeParams(0, 101, 0, 0);
        vm.expectRevert(PerpEngine.InvalidParam.selector);
        engine.setFeeParams(0, 0, 317_097_919_838, 0);
        vm.expectRevert(PerpEngine.InvalidParam.selector);
        engine.setFeeParams(0, 0, 0, 10e6 + 1);

        vm.expectEmit(address(engine));
        emit PerpEngine.FeeParamsSet(50, 100, 317_097_919_837, 10e6);
        engine.setFeeParams(50, 100, 317_097_919_837, 10e6);
        vm.stopPrank();
        assertEq(engine.baseFeeBps(), 50);
        assertEq(engine.maxSkewFeeBps(), 100);
        assertEq(engine.maxFundingRatePerSecond(), 317_097_919_837);
        assertEq(engine.executionFee(), 10e6);
    }

    function test_setRiskParams() public {
        vm.startPrank(owner);
        vm.expectRevert(PerpEngine.InvalidParam.selector);
        engine.setRiskParams(0, 50, 30_000, 5e6);
        vm.expectRevert(PerpEngine.InvalidParam.selector);
        engine.setRiskParams(61, 50, 30_000, 5e6);
        vm.expectRevert(PerpEngine.InvalidParam.selector);
        engine.setRiskParams(3, 0, 30_000, 5e6);
        vm.expectRevert(PerpEngine.InvalidParam.selector);
        engine.setRiskParams(3, 501, 30_000, 5e6);
        vm.expectRevert(PerpEngine.InvalidParam.selector);
        engine.setRiskParams(3, 50, 5_000 - 1, 5e6);
        vm.expectRevert(PerpEngine.InvalidParam.selector);
        engine.setRiskParams(3, 50, 100_000 + 1, 5e6);
        vm.expectRevert(PerpEngine.InvalidParam.selector);
        engine.setRiskParams(3, 50, 30_000, 0);

        vm.expectEmit(address(engine));
        emit PerpEngine.RiskParamsSet(60, 500, 10_000, 1e6);
        engine.setRiskParams(60, 500, 10_000, 1e6);
        vm.stopPrank();
        assertEq(engine.maxPriceAge(), 60);
        assertEq(engine.maxConfBps(), 500);
        assertEq(engine.maxOiToNavBps(), 10_000);
        assertEq(engine.minMargin(), 1e6);
    }

    function test_defaults() public view {
        assertEq(engine.baseFeeBps(), 5);
        assertEq(engine.maxSkewFeeBps(), 10);
        assertEq(engine.maxFundingRatePerSecond(), 15_854_895_991); // 50% a year
        assertEq(engine.executionFee(), 0.1e6);
        assertEq(engine.maxPriceAge(), 3);
        assertEq(engine.maxConfBps(), 50);
        assertEq(engine.maxOiToNavBps(), 30_000);
        assertEq(engine.minMargin(), 5e6);
    }

    function test_riskParams_takeEffect() public {
        // Lowering the OI multiple to 1x NAV raises the reserve and tightens the cap.
        _open(alice, BTC, true, 50_000e6, 500_000e6);
        assertEq(engine.reservedLiquidity(), 166_666_666_667); // 500k / 3, rounded up
        vm.prank(owner);
        engine.setRiskParams(3, 50, 10_000, 5e6);
        assertEq(engine.reservedLiquidity(), 500_000e6);
        vm.prank(bob);
        vm.expectRevert(PerpEngine.VaultOiCapExceeded.selector);
        engine.openPosition(_params(ETH, true, 60_000e6, 600_000e6), _noBytes());
    }

    function test_pause_unpause() public {
        vm.startPrank(owner);
        engine.pause();
        assertTrue(engine.paused());
        vm.expectRevert(Pausable.EnforcedPause.selector);
        engine.pause();
        engine.unpause();
        assertFalse(engine.paused());
        vm.stopPrank();
        _open(alice, BTC, true, 1_000e6, 10_000e6);
    }

    function test_ownership_isTwoStep() public {
        vm.prank(owner);
        engine.transferOwnership(alice);
        assertEq(engine.owner(), owner);
        assertEq(engine.pendingOwner(), alice);
        vm.prank(alice);
        engine.acceptOwnership();
        assertEq(engine.owner(), alice);
    }
}
