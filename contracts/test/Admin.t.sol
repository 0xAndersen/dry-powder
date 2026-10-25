// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {PerpEngine} from "../src/PerpEngine.sol";
import {PerpEngineBase} from "../src/PerpEngineBase.sol";
import {Market, MarketConfig} from "../src/Types.sol";
import {Base} from "./Base.t.sol";

contract AdminTest is Base {
    bytes32 internal constant SOL = bytes32(uint256(0x501));

    function _sol(bool invert, uint16 maxLeverage, uint256 maxOiPerSide, uint256 skewScale)
        internal
        pure
        returns (MarketConfig memory cfg)
    {
        cfg = _cfg("SOL-USD", SOL, bytes32(0), invert, 0);
        cfg.maxLeverage = maxLeverage;
        cfg.maxOiPerSide = maxOiPerSide;
        cfg.skewScale = skewScale;
    }

    function _unauthorized() internal view returns (bytes memory) {
        return abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice);
    }

    function test_onlyOwner() public {
        vm.startPrank(alice);
        vm.expectRevert(_unauthorized());
        engine.addMarket(SOL, _sol(false, 50, 1e12, 1e12));
        vm.expectRevert(_unauthorized());
        engine.setMarket(BTC, true, 50, 1e12, 1e12);
        vm.expectRevert(_unauthorized());
        engine.setFeeParams(1, 1, 1, 1);
        vm.expectRevert(_unauthorized());
        engine.setRiskParams(1, 1, 1, 1);
        vm.expectRevert(_unauthorized());
        engine.setMaxProfitMultiple(5);
        vm.expectRevert(_unauthorized());
        engine.pause();
        vm.expectRevert(_unauthorized());
        engine.unpause();
        vm.stopPrank();
    }

    function test_addMarket() public {
        vm.expectEmit(address(engine));
        emit PerpEngineBase.MarketListed(SOL, "SOL-USD", SOL, bytes32(0), true, 0);
        vm.expectEmit(address(engine));
        emit PerpEngineBase.MarketConfigured(SOL, true, true, 50, 123e6, 456e6);
        vm.prank(owner);
        engine.addMarket(SOL, _sol(true, 50, 123e6, 456e6));

        Market memory m = engine.getMarket(SOL);
        assertTrue(m.enabled);
        assertTrue(m.invert);
        assertEq(m.maxLeverage, 50);
        assertEq(m.lastFundingTime, vm.getBlockTimestamp());
        assertEq(m.expiry, 0);
        assertEq(m.feedId, SOL);
        assertEq(m.quoteFeedId, bytes32(0));
        assertEq(m.maxOiPerSide, 123e6);
        assertEq(m.skewScale, 456e6);
        assertEq(m.longOi, 0);
        assertEq(m.shortOi, 0);
        assertEq(m.longUnits, 0);
        assertEq(m.shortUnits, 0);
        assertEq(m.fundingIndex, 0);
        assertEq(m.settlementPrice, 0);
        assertEq(m.symbol, "SOL-USD");
        assertEq(engine.getMarketIds().length, 7);
    }

    function test_addMarket_crossAndDated() public {
        bytes32 id = keccak256("SOL-BTC-DATED");
        MarketConfig memory cfg = _cfg("SOL-BTC-DATED", SOL, BTC, true, uint64(vm.getBlockTimestamp() + 1));
        vm.expectEmit(address(engine));
        emit PerpEngineBase.MarketListed(id, "SOL-BTC-DATED", SOL, BTC, true, uint64(vm.getBlockTimestamp() + 1));
        vm.prank(owner);
        engine.addMarket(id, cfg);
        Market memory m = engine.getMarket(id);
        assertEq(m.feedId, SOL);
        assertEq(m.quoteFeedId, BTC);
        assertEq(m.expiry, vm.getBlockTimestamp() + 1);
        assertTrue(m.invert);
        // The fixture's own cross and future.
        assertEq(engine.getMarket(ETHBTC).quoteFeedId, BTC);
        assertEq(engine.getMarket(ETHBTC).feedId, ETH);
        assertEq(engine.getMarket(FUT).expiry, EXPIRY);
        assertEq(engine.getMarket(FUT).symbol, "BTC-USD-FUT");
        // An unknown id reads as an empty market.
        assertEq(engine.getMarket(bytes32(uint256(1))).lastFundingTime, 0);
    }

    function test_addMarket_validations() public {
        vm.startPrank(owner);
        vm.expectRevert(PerpEngineBase.MarketExists.selector);
        engine.addMarket(BTC, _sol(false, 50, 1e12, 1e12));
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.addMarket(bytes32(0), _sol(false, 50, 1e12, 1e12));
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.addMarket(SOL, _sol(false, 0, 1e12, 1e12));
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.addMarket(SOL, _sol(false, 5001, 1e12, 1e12));
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.addMarket(SOL, _sol(false, 50, 1e12, 0));

        // A market needs a feed, and a cross needs two different ones.
        MarketConfig memory cfg = _sol(false, 50, 1e12, 1e12);
        cfg.feedId = bytes32(0);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.addMarket(SOL, cfg);
        cfg.feedId = SOL;
        cfg.quoteFeedId = SOL;
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.addMarket(SOL, cfg);

        // A dated market must expire in the future.
        cfg = _sol(false, 50, 1e12, 1e12);
        cfg.expiry = uint64(vm.getBlockTimestamp());
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.addMarket(SOL, cfg);
        cfg.expiry = uint64(vm.getBlockTimestamp() + 1);
        engine.addMarket(SOL, cfg);
        vm.stopPrank();
    }

    function test_addMarket_capsTheNumberOfMarkets() public {
        vm.startPrank(owner);
        for (uint256 i = engine.getMarketIds().length; i < 64; ++i) {
            engine.addMarket(bytes32(i + 1000), _sol(false, 50, 1e12, 1e12));
        }
        assertEq(engine.getMarketIds().length, 64); // MAX_MARKETS
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.addMarket(SOL, _sol(false, 50, 1e12, 1e12));
        vm.stopPrank();
    }

    /// @dev Every deposit, withdrawal and open values the whole book: one loop over all markets, one oracle
    ///      read per feed of each market that has open interest. With all 64 slots listed and every one of
    ///      them holding a position, that valuation must still be cheap enough to sit inside a trade.
    function test_valuation_gasWithEveryMarketSlotInUse() public {
        vm.startPrank(owner);
        for (uint256 i = engine.getMarketIds().length; i < 64; ++i) {
            // Crosses, so that each costs two feed reads.
            engine.addMarket(bytes32(i + 1000), _cfg("X", ETH, BTC, false, 0));
        }
        vm.stopPrank();
        _refreshAll();
        bytes32[] memory ids = engine.getMarketIds();
        for (uint256 i; i < 64; ++i) {
            if (ids[i] == EUR || ids[i] == JPY) _open(alice, ids[i], true, 5e6, 500e6);
            else _open(alice, ids[i], i % 2 == 0, 5e6, 500e6);
        }
        assertEq(engine.positionCount(), 64);

        uint256 gasBefore = gasleft();
        engine.unrealizedTraderPnl();
        uint256 valuation = gasBefore - gasleft();
        gasBefore = gasleft();
        engine.reservedLiquidity();
        uint256 reserve = gasBefore - gasleft();
        gasBefore = gasleft();
        vm.prank(bob);
        engine.openPosition(_params(BTC, true, 5e6, 500e6), _noBytes());
        uint256 open = gasBefore - gasleft();
        // A keeper's batch over all 64 of the trader's positions; nothing qualifies, so it reverts at the end.
        bytes32[] memory keys = new bytes32[](64);
        for (uint256 i; i < 64; ++i) {
            keys[i] = engine.positionKey(alice, ids[i]);
        }
        gasBefore = gasleft();
        try engine.liquidateBatch(keys, _noBytes()) {} catch {}
        uint256 liquidate = gasBefore - gasleft();
        emit log_named_uint("liquidateBatch gas, 64 positions", liquidate);
        assertLt(liquidate, 10_000_000);
        emit log_named_uint("unrealizedTraderPnl gas, 64 markets with OI", valuation);
        emit log_named_uint("reservedLiquidity gas", reserve);
        emit log_named_uint("openPosition gas", open);
        // Measured with the checked-in settings: ~0.9m, ~0.06m, ~1.1m and ~1.0m gas. The bounds are loose
        // because the same test also runs unoptimised under `forge coverage`.
        assertLt(valuation, 10_000_000);
        assertLt(open, 10_000_000);
    }

    function test_setMarket() public {
        vm.startPrank(owner);
        vm.expectRevert(PerpEngineBase.MarketNotFound.selector);
        engine.setMarket(SOL, true, 50, 1e12, 1e12);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setMarket(BTC, true, 5001, 1e12, 1e12);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setMarket(BTC, true, 0, 1e12, 1e12);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setMarket(BTC, true, 50, 1e12, 0);

        vm.expectEmit(address(engine));
        emit PerpEngineBase.MarketConfigured(JPY, false, true, 25, 7e6, 8e6);
        engine.setMarket(JPY, false, 25, 7e6, 8e6);
        vm.stopPrank();

        Market memory m = engine.getMarket(JPY);
        assertFalse(m.enabled);
        assertTrue(m.invert); // the structure of an instrument (feeds, inversion, expiry) is fixed at listing
        assertEq(m.feedId, JPY);
        assertEq(m.maxLeverage, 25);
        assertEq(m.maxOiPerSide, 7e6);
        assertEq(m.skewScale, 8e6);
    }

    function test_setFeeParams() public {
        vm.startPrank(owner);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setFeeParams(51, 0, 0, 0);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setFeeParams(0, 101, 0, 0);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setFeeParams(0, 0, 317_097_919_838, 0);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setFeeParams(0, 0, 0, 10e6 + 1);

        vm.expectEmit(address(engine));
        emit PerpEngineBase.FeeParamsSet(50, 100, 317_097_919_837, 10e6);
        engine.setFeeParams(50, 100, 317_097_919_837, 10e6);
        vm.stopPrank();
        assertEq(engine.baseFeeBps(), 50);
        assertEq(engine.maxSkewFeeBps(), 100);
        assertEq(engine.maxFundingRatePerSecond(), 317_097_919_837);
        assertEq(engine.executionFee(), 10e6);
    }

    function test_setRiskParams() public {
        vm.startPrank(owner);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setRiskParams(0, 50, 30_000, 5e6);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setRiskParams(61, 50, 30_000, 5e6);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setRiskParams(3, 0, 30_000, 5e6);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setRiskParams(3, 501, 30_000, 5e6);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setRiskParams(3, 50, 5_000 - 1, 5e6);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setRiskParams(3, 50, 100_000 + 1, 5e6);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setRiskParams(3, 50, 30_000, 0);

        vm.expectEmit(address(engine));
        emit PerpEngineBase.RiskParamsSet(60, 500, 10_000, 1e6);
        engine.setRiskParams(60, 500, 10_000, 1e6);
        vm.stopPrank();
        assertEq(engine.maxPriceAge(), 60);
        assertEq(engine.maxConfBps(), 500);
        assertEq(engine.maxOiToNavBps(), 10_000);
        assertEq(engine.minMargin(), 1e6);
    }

    function test_setMaxProfitMultiple() public {
        assertEq(engine.maxProfitMultiple(), 10);
        vm.startPrank(owner);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setMaxProfitMultiple(0);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setMaxProfitMultiple(101);
        vm.expectEmit(address(engine));
        emit PerpEngineBase.MaxProfitMultipleSet(1);
        engine.setMaxProfitMultiple(1);
        assertEq(engine.maxProfitMultiple(), 1);
        engine.setMaxProfitMultiple(100);
        assertEq(engine.maxProfitMultiple(), 100);
        vm.stopPrank();
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
        assertEq(engine.maxProfitMultiple(), 10);
        assertEq(engine.nextOrderId(), 1);
        assertEq(engine.totalClaimable(), 0);
    }

    function test_riskParams_takeEffect() public {
        // Lowering the OI multiple to 1x NAV raises the reserve and tightens the cap.
        _open(alice, BTC, true, 50_000e6, 500_000e6);
        assertEq(engine.reservedLiquidity(), 166_666_666_667); // 500k / 3, rounded up
        vm.prank(owner);
        engine.setRiskParams(3, 50, 10_000, 5e6);
        assertEq(engine.reservedLiquidity(), 500_000e6);
        vm.prank(bob);
        vm.expectRevert(PerpEngineBase.VaultOiCapExceeded.selector);
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
