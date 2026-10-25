// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {EngineLens} from "../src/EngineLens.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {PerpEngine} from "../src/PerpEngine.sol";
import {PerpEngineBase} from "../src/PerpEngineBase.sol";
import {LimitParams, MarketConfig, OpenParams, OraclePrice, OrderType, Position} from "../src/Types.sol";
import {Base} from "./Base.t.sol";

/// @notice Cross markets (feed / quoteFeed), inverted crosses and their oracle failure modes.
contract CrossMarketTest is Base {
    /// @dev BTC priced in ETH: the ETH/BTC cross, inverted.
    bytes32 internal constant BTCETH = keccak256("BTC-ETH");
    bytes32 internal constant GHOST = bytes32(uint256(0x6057));

    function setUp() public override {
        super.setUp();
        _flatFees();
        vm.prank(owner);
        engine.addMarket(BTCETH, _cfg("BTC-ETH", ETH, BTC, true, 0));
    }

    function _publishBoth(int64 eth, uint64 ethConf, int64 btc, uint64 btcConf) internal {
        skip(1);
        _publish(ETH, eth, ethConf, -8);
        _publish(BTC, btc, btcConf, -8);
    }

    function test_cross_bandMath() public {
        // ETH 4,000 +- 4, BTC 100,000 +- 50
        _publishBoth(4_000e8, 4e8, 100_000e8, 50e8);
        OraclePrice memory px = engine.getPrice(ETHBTC);

        // Widest consistent band: lowest base over highest quote, highest base over lowest quote.
        assertEq(px.mid, 0.04e18);
        assertEq(px.bid, (uint256(3_996e18) * 1e18) / 100_050e18);
        assertEq(px.ask, Math.ceilDiv(uint256(4_004e18) * 1e18, 99_950e18));
        assertEq(px.bid, 39_940_029_985_007_496); // 0.03994002998..., rounded down
        assertEq(px.ask, 40_060_030_015_007_504); // 0.04006003001..., rounded up
        assertLt(px.bid, px.mid);
        assertLt(px.mid, px.ask);
        assertEq(px.publishTime, vm.getBlockTimestamp());

        // Trades execute on the adverse side of that combined band.
        _open(alice, ETHBTC, true, 1_000e6, 10_000e6);
        _open(bob, ETHBTC, false, 1_000e6, 10_000e6);
        assertEq(engine.getPosition(alice, ETHBTC).entryPrice, px.ask);
        assertEq(engine.getPosition(bob, ETHBTC).entryPrice, px.bid);
    }

    function test_cross_publishTimeIsTheOlderFeed() public {
        skip(1);
        _publish(BTC, 100_000e8, 0, -8);
        uint256 btcTime = vm.getBlockTimestamp();
        skip(2);
        _publish(ETH, 4_000e8, 0, -8);
        assertEq(engine.getPrice(ETHBTC).publishTime, btcTime);
        assertEq(engine.getPrice(ETH).publishTime, btcTime + 2);

        // And the other way round.
        skip(1);
        _publish(BTC, 100_000e8, 0, -8);
        assertEq(engine.getPrice(ETHBTC).publishTime, btcTime + 2);
    }

    function test_cross_staleQuoteOrBaseFeed() public {
        skip(1);
        _publish(BTC, 100_000e8, 0, -8);
        skip(4);
        _publish(ETH, 4_000e8, 0, -8); // base fresh, quote four seconds old
        vm.expectRevert(PerpEngineBase.OraclePriceStale.selector);
        engine.getPrice(ETHBTC);
        vm.prank(alice);
        vm.expectRevert(PerpEngineBase.OraclePriceStale.selector);
        engine.openPosition(_params(ETHBTC, true, 1_000e6, 10_000e6), _noBytes());

        _publish(BTC, 100_000e8, 0, -8); // both fresh
        assertEq(engine.getPrice(ETHBTC).mid, 0.04e18);

        skip(4);
        _publish(BTC, 100_000e8, 0, -8); // quote fresh, base four seconds old
        vm.expectRevert(PerpEngineBase.OraclePriceStale.selector);
        engine.getPrice(ETHBTC);
    }

    function test_cross_unavailableQuoteFeed() public {
        bytes32 id = keccak256("ETH-GHOST");
        vm.prank(owner);
        engine.addMarket(id, _cfg("ETH-GHOST", ETH, GHOST, false, 0));
        vm.expectRevert(PerpEngineBase.OraclePriceUnavailable.selector);
        engine.getPrice(id);
        // ... and an unavailable base.
        bytes32 id2 = keccak256("GHOST-ETH");
        vm.prank(owner);
        engine.addMarket(id2, _cfg("GHOST-ETH", GHOST, ETH, false, 0));
        vm.expectRevert(PerpEngineBase.OraclePriceUnavailable.selector);
        engine.getPrice(id2);
    }

    function test_cross_invalidQuoteFeed() public {
        _publishBoth(4_000e8, 0, 0, 0); // BTC = 0
        vm.expectRevert(PerpEngineBase.OraclePriceInvalid.selector);
        engine.getPrice(ETHBTC);
        _publishBoth(4_000e8, 0, -1, 0);
        vm.expectRevert(PerpEngineBase.OraclePriceInvalid.selector);
        engine.getPrice(ETHBTC);
        // The plain ETH market is unaffected by its neighbour's quote feed.
        assertEq(engine.getPrice(ETH).mid, 4_000e18);
    }

    function test_cross_quoteConfidenceTooWide() public {
        _publishBoth(4_000e8, 0, 100_000e8, 500e8 + 1);
        vm.expectRevert(PerpEngineBase.OracleConfidenceTooWide.selector);
        engine.getPrice(ETHBTC);
        _publishBoth(4_000e8, 20e8 + 1, 100_000e8, 0);
        vm.expectRevert(PerpEngineBase.OracleConfidenceTooWide.selector);
        engine.getPrice(ETHBTC);
    }

    function test_cross_ratioThatRoundsToZeroIsInvalid() public {
        // 1e-18 over 9.2e18: far below one unit of the 18-decimal price.
        skip(1);
        _publish(ETH, 1, 0, -18);
        _publish(BTC, type(int64).max, 0, 0);
        vm.expectRevert(PerpEngineBase.OraclePriceInvalid.selector);
        engine.getPrice(ETHBTC);
        // Its inverse does not fit either: the cross is invalid before the inversion is attempted.
        vm.expectRevert(PerpEngineBase.OraclePriceInvalid.selector);
        engine.getPrice(BTCETH);
    }

    function test_cross_openClosePnl() public {
        bytes32 aliceKey = _open(alice, ETHBTC, true, 1_000e6, 10_000e6);
        bytes32 bobKey = _open(bob, ETHBTC, false, 1_000e6, 10_000e6);
        assertEq(engine.getPosition(alice, ETHBTC).entryPrice, 0.04e18);
        assertEq(_market(ETHBTC).longUnits, 250_000e24); // 10,000 USDC of notional at 0.04 = 250,000 units
        uint256 aliceAfterOpen = usdc.balanceOf(alice);
        uint256 bobAfterOpen = usdc.balanceOf(bob);

        // Both legs rally 10%: the cross has not moved, nobody has gained or lost.
        _setBtcEth(110_000, 4_400);
        assertEq(engine.getPrice(ETHBTC).mid, 0.04e18);
        (int256 pnl,,,) = lens.getPositionState(aliceKey, engine.getPrice(ETHBTC).mid);
        assertEq(pnl, 0);
        assertEq(engine.unrealizedTraderPnl(), 0);

        // ETH outperforms: 4,620 / 110,000 = 0.042, +5% on the cross.
        _setBtcEth(110_000, 4_620);
        assertEq(engine.getPrice(ETHBTC).mid, 0.042e18);
        uint256 dry = _rebate(500e6, 10_000e6);
        vm.expectEmit(address(engine));
        emit PerpEngineBase.PositionClosed(aliceKey, alice, ETHBTC, 0.042e18, 500e6, 5e6, 1_495e6);
        _close(alice, ETHBTC);
        vm.expectEmit(address(engine));
        emit PerpEngineBase.PositionClosed(bobKey, bob, ETHBTC, 0.042e18, -500e6, 5e6, 495e6);
        _close(bob, ETHBTC);

        assertEq(usdc.balanceOf(alice), aliceAfterOpen + 1_495e6);
        assertEq(usdc.balanceOf(bob), bobAfterOpen + 495e6);
        assertEq(house.balanceOf(bob), dry);
        assertEq(_market(ETHBTC).longUnits, 0);
        assertEq(_market(ETHBTC).shortUnits, 0);
        _assertEngineSolvent();
    }

    function test_cross_liquidation() public {
        bytes32 key = _open(alice, ETHBTC, true, 100e6, 10_000e6); // 100x: liquidates at -0.9%
        (,, uint256 liq,) = lens.getPositionState(key, 0.04e18);
        assertEq(liq, 0.03964e18);

        // BTC outruns ETH by a little under 0.9%: still healthy.
        _setBtcEth(100_890, 4_000);
        vm.expectRevert(PerpEngineBase.NothingToLiquidate.selector);
        _liquidate(alice);
        // BTC +1%, ETH flat: the cross falls 0.99%.
        _setBtcEth(101_000, 4_000);
        vm.prank(keeper);
        assertEq(_liquidate(alice), 1);
        assertEq(usdc.balanceOf(keeper), 2e6);
        _assertEngineSolvent();
    }

    function test_invertedCross_bandAndPnl() public {
        // ETH/BTC = 0.04 +- conf -> BTC/ETH = 25
        _publishBoth(4_000e8, 4e8, 100_000e8, 50e8);
        OraclePrice memory cross = engine.getPrice(ETHBTC);
        OraclePrice memory px = engine.getPrice(BTCETH);
        assertEq(px.mid, 25e18);
        assertEq(px.bid, uint256(1e36) / cross.ask);
        assertEq(px.ask, Math.ceilDiv(1e36, cross.bid));
        assertLt(px.bid, px.mid);
        assertLt(px.mid, px.ask);
        assertEq(px.publishTime, cross.publishTime);

        _publishBoth(4_000e8, 0, 100_000e8, 0);
        _open(alice, BTCETH, true, 1_000e6, 10_000e6);
        assertEq(engine.getPosition(alice, BTCETH).entryPrice, 25e18);
        uint256 afterOpen = usdc.balanceOf(alice);
        // ETH falls 20% against BTC: BTC/ETH = 100,000 / 3,200 = 31.25, +25%.
        _setBtcEth(100_000, 3_200);
        assertEq(engine.getPrice(BTCETH).mid, 31.25e18);
        _close(alice, BTCETH);
        assertEq(usdc.balanceOf(alice), afterOpen + 1_000e6 + 2_500e6 - 5e6);
    }
}

/// @notice Dated, cash-settled futures: trading stops at expiry, anyone settles, positions close at the
///         settlement price.
contract DatedFutureTest is Base {
    uint256 internal constant P100K = 100_000e18;

    function setUp() public override {
        super.setUp();
        _flatFees();
    }

    /// @dev Jumps to `secondsAfterExpiry` past expiry and puts a fresh BTC price on-chain.
    function _expire(uint256 secondsAfterExpiry, uint256 btcUsd) internal {
        vm.warp(EXPIRY + secondsAfterExpiry);
        _publish(BTC, int64(uint64(btcUsd * 1e8)), 0, -8);
    }

    function _settle(uint256 btcUsd) internal {
        _expire(0, btcUsd);
        engine.settleMarket(FUT, _noBytes());
    }

    function test_future_tradesLikeAPerpBeforeExpiry() public {
        bytes32 key = _open(alice, FUT, true, 1_000e6, 10_000e6);
        Position memory pos = engine.getPosition(alice, FUT);
        assertEq(pos.entryPrice, P100K);
        assertEq(pos.priceId, FUT);
        assertEq(key, engine.positionKey(alice, FUT));
        // A separate instrument from the perpetual on the same feed.
        assertEq(engine.getPosition(alice, BTC).trader, address(0));
        assertEq(_market(FUT).longOi, 10_000e6);
        assertEq(_market(BTC).longOi, 0);

        uint256 afterOpen = usdc.balanceOf(alice);
        _setBtc(101_000);
        _close(alice, FUT);
        assertEq(usdc.balanceOf(alice), afterOpen + 1_000e6 + 100e6 - 5e6);
    }

    function test_future_noOpenAtOrAfterExpiry() public {
        vm.warp(EXPIRY - 1);
        _publish(BTC, 100_000e8, 0, -8);
        _open(alice, FUT, true, 1_000e6, 10_000e6); // the last second before expiry is fine

        _expire(0, 100_000);
        vm.prank(bob);
        vm.expectRevert(PerpEngineBase.MarketExpired.selector);
        engine.openPosition(_params(FUT, true, 1_000e6, 10_000e6), _noBytes());
        vm.prank(bob);
        vm.expectRevert(PerpEngineBase.MarketExpired.selector);
        engine.createLimitOrder(_limit(FUT, true, 1_000e6, 10_000e6, P100K));

        _expire(1 days, 100_000);
        vm.prank(bob);
        vm.expectRevert(PerpEngineBase.MarketExpired.selector);
        engine.openPosition(_params(FUT, false, 1_000e6, 10_000e6), _noBytes());
        // The perpetual on the same feed keeps trading.
        _open(bob, BTC, true, 1_000e6, 10_000e6);
    }

    function test_future_limitOrderCannotFillAfterExpiry() public {
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(_limit(FUT, true, 1_000e6, 10_000e6, P100K));
        uint256 afterCreate = usdc.balanceOf(alice);

        _expire(0, 99_000);
        vm.prank(keeper);
        vm.expectRevert(PerpEngineBase.MarketExpired.selector);
        engine.executeOrder(id, _noBytes());
        // ... nor after settlement.
        engine.settleMarket(FUT, _noBytes());
        vm.prank(keeper);
        vm.expectRevert(PerpEngineBase.MarketExpired.selector);
        engine.executeOrder(id, _noBytes());

        // The escrow is not stuck: the trader cancels for a full refund.
        vm.prank(alice);
        engine.cancelOrder(id);
        assertEq(usdc.balanceOf(alice), afterCreate + 1_000e6 + 5e6 + EXEC_FEE); // margin, fee budget, keeper fee
        _assertEngineSolvent();
    }

    function test_settleMarket_validations() public {
        vm.expectRevert(PerpEngineBase.MarketNotFound.selector);
        engine.settleMarket(bytes32(uint256(1)), _noBytes());
        // A perpetual never expires.
        vm.expectRevert(PerpEngineBase.MarketNotExpired.selector);
        engine.settleMarket(BTC, _noBytes());
        // Too early, by a day and by a second.
        vm.expectRevert(PerpEngineBase.MarketNotExpired.selector);
        engine.settleMarket(FUT, _noBytes());
        vm.warp(EXPIRY - 1);
        _publish(BTC, 101_000e8, 0, -8);
        vm.expectRevert(PerpEngineBase.MarketNotExpired.selector);
        engine.settleMarket(FUT, _noBytes());

        // At expiry, but the only price on-chain was published a second before it.
        vm.warp(EXPIRY);
        vm.expectRevert(PerpEngineBase.PriceBeforeExpiry.selector);
        engine.settleMarket(FUT, _noBytes());
        // Same when the caller supplies an update that predates expiry.
        vm.warp(EXPIRY + 1);
        bytes[] memory early = _updateData(BTC, 102_000e8, 0, -8, EXPIRY - 1);
        vm.expectRevert(PerpEngineBase.PriceBeforeExpiry.selector);
        engine.settleMarket{value: PYTH_FEE}(FUT, early);

        // No usable price at all.
        vm.warp(EXPIRY + 1 hours);
        vm.expectRevert(PerpEngineBase.OraclePriceStale.selector);
        engine.settleMarket(FUT, _noBytes());
    }

    function test_settleMarket_fixesThePriceOnce() public {
        _open(alice, FUT, true, 1_000e6, 10_000e6);
        vm.warp(EXPIRY + 30);
        bytes[] memory update = _updateData(BTC, 104_000e8, 0, -8, EXPIRY); // published exactly at expiry
        // Stale by the time it is submitted: the staleness window applies to settlement as well.
        vm.expectRevert(PerpEngineBase.OraclePriceStale.selector);
        engine.settleMarket{value: PYTH_FEE}(FUT, update);

        update = _fresh(BTC, 104_000e8, 50e8, -8);
        uint256 nativeBefore = carol.balance;
        vm.expectEmit(address(engine));
        emit PerpEngineBase.MarketSettled(FUT, 104_000e18); // the mid price; the confidence band plays no part
        vm.prank(carol); // anyone
        engine.settleMarket{value: 1_000}(FUT, update);
        assertEq(nativeBefore - carol.balance, PYTH_FEE);
        assertEq(address(engine).balance, 0);
        assertEq(_market(FUT).settlementPrice, 104_000e18);
        assertEq(_market(FUT).lastFundingTime, EXPIRY);

        _setBtc(90_000);
        vm.expectRevert(PerpEngineBase.MarketAlreadySettled.selector);
        engine.settleMarket(FUT, _noBytes());
        assertEq(_market(FUT).settlementPrice, 104_000e18);
    }

    function test_settleMarket_worksWhilePausedAndDisabled() public {
        vm.startPrank(owner);
        engine.pause();
        engine.setMarket(FUT, false, 100, MAX_OI_PER_SIDE, SKEW_SCALE);
        vm.stopPrank();
        _settle(100_000);
        assertEq(_market(FUT).settlementPrice, P100K);
    }

    function test_future_fundingStopsAtExpiry() public {
        vm.prank(owner);
        engine.setFeeParams(5, 0, 15_854_895_991, EXEC_FEE);
        uint256 opened = vm.getBlockTimestamp();
        bytes32 key = _open(alice, FUT, true, 50_000e6, 500_000e6);
        // 500k of skew over the 1m skew scale = half the full-skew rate.
        int256 rate = int256(uint256(15_854_895_991) / 2);
        assertEq(engine.fundingRate(FUT), rate);

        vm.warp(EXPIRY - 1 days);
        int256 dayBefore = rate * int256(EXPIRY - 1 days - opened);
        assertEq(engine.currentFundingIndex(FUT), dayBefore);

        int256 atExpiry = rate * int256(EXPIRY - opened);
        vm.warp(EXPIRY);
        assertEq(engine.currentFundingIndex(FUT), atExpiry);
        vm.warp(EXPIRY + 10 days);
        assertEq(engine.currentFundingIndex(FUT), atExpiry);
        (, int256 owed,,) = lens.getPositionState(key, P100K);
        assertEq(owed, (500_000e6 * atExpiry) / 1e18);

        // Settling, or anything else that accrues funding, stores the index as of expiry and no later.
        _publish(BTC, 100_000e8, 0, -8);
        engine.settleMarket(FUT, _noBytes());
        assertEq(_market(FUT).fundingIndex, atExpiry);
        assertEq(_market(FUT).lastFundingTime, EXPIRY);
        skip(5 days);
        assertEq(engine.currentFundingIndex(FUT), atExpiry);

        uint256 before = usdc.balanceOf(alice);
        _close(alice, FUT);
        // margin - funding owed - close fee (5 bps of 500k), at an unchanged price
        assertEq(usdc.balanceOf(alice), before + 50_000e6 - uint256(owed) - 250e6);
    }

    function test_future_afterSettlement_priceIsTheSettlementPriceForEver() public {
        _settle(104_000);
        OraclePrice memory px = engine.getPrice(FUT);
        assertEq(px.mid, 104_000e18);
        assertEq(px.bid, 104_000e18);
        assertEq(px.ask, 104_000e18);
        assertEq(px.publishTime, vm.getBlockTimestamp());

        // The feed moves on, goes stale, even turns invalid: the settled market does not care.
        _setBtc(50_000);
        assertEq(engine.getPrice(FUT).mid, 104_000e18);
        skip(365 days);
        assertEq(engine.getPrice(FUT).mid, 104_000e18);
        assertEq(engine.getPrice(FUT).publishTime, vm.getBlockTimestamp());
        _setPrice(BTC, 0, 0, -8);
        assertEq(engine.getPrice(FUT).mid, 104_000e18);
        vm.expectRevert(PerpEngineBase.OraclePriceInvalid.selector);
        engine.getPrice(BTC);
    }

    function test_future_closePositionAtSettlementPrice() public {
        bytes32 key = _open(alice, FUT, true, 1_000e6, 10_000e6);
        _open(bob, FUT, false, 1_000e6, 10_000e6);
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);
        _settle(104_000);

        // Long after, with the live feed stale and far away, both close at 104,000 with no price update.
        _setBtc(70_000);
        skip(7 days);
        uint256 dry = _rebate(400e6, 10_000e6);
        vm.expectEmit(address(engine));
        emit PerpEngineBase.PositionClosed(key, alice, FUT, 104_000e18, 400e6, 5e6, 1_395e6);
        _close(alice, FUT);
        _close(bob, FUT);
        assertEq(usdc.balanceOf(alice), aliceBefore + 1_395e6);
        assertEq(usdc.balanceOf(bob), bobBefore + 1_000e6 - 400e6 - 5e6);
        assertEq(house.balanceOf(bob), dry);

        _assertEngineSolvent();
        assertEq(engine.positionCount(), 0);
    }

    function test_future_closeSlippageGuardUsesSettlementPrice() public {
        _open(alice, FUT, true, 1_000e6, 10_000e6);
        _settle(104_000);
        vm.startPrank(alice);
        vm.expectRevert(PerpEngineBase.SlippageExceeded.selector);
        engine.closePosition(FUT, 0, 104_000e18 + 1, _noBytes());
        engine.closePosition(FUT, 0, 104_000e18, _noBytes());
        vm.stopPrank();
    }

    function test_future_betweenExpiryAndSettlement_livePriceStillCloses() public {
        _open(alice, FUT, true, 1_000e6, 10_000e6);
        uint256 before = usdc.balanceOf(alice);
        _expire(1 hours, 102_000);
        _close(alice, FUT);
        assertEq(usdc.balanceOf(alice), before + 1_000e6 + 200e6 - 5e6);
    }

    function test_settlePositions_closesHealthyAndLiquidatesUnhealthy() public {
        bytes32 aliceKey = _open(alice, FUT, true, 1_000e6, 10_000e6); // +400 at 104,000
        bytes32 bobKey = _open(bob, FUT, false, 1_000e6, 10_000e6); // -400: healthy at 10x
        bytes32 carolKey = _open(carol, FUT, false, 100e6, 10_000e6); // -400 on 100 of margin: liquidatable
        bytes32 perpKey = _open(carol, BTC, true, 1_000e6, 10_000e6); // a perpetual: never settles
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);
        uint256 carolBefore = usdc.balanceOf(carol);

        bytes32[] memory keys = new bytes32[](6);
        keys[0] = aliceKey;
        keys[1] = bytes32(uint256(0xdead)); // unknown
        keys[2] = bobKey;
        keys[3] = carolKey;
        keys[4] = perpKey;
        keys[5] = aliceKey; // duplicate

        // Before settlement nothing qualifies, even past expiry.
        _expire(0, 104_000);
        assertEq(engine.settlePositions(keys), 0);
        assertEq(engine.positionCount(), 4);

        engine.settleMarket(FUT, _noBytes());
        skip(1 days); // no fresh price needed from here on

        vm.expectEmit(address(engine));
        emit PerpEngineBase.PositionClosed(aliceKey, alice, FUT, 104_000e18, 400e6, 5e6, 1_395e6);
        vm.expectEmit(address(engine));
        emit PerpEngineBase.PositionClosed(bobKey, bob, FUT, 104_000e18, -400e6, 5e6, 595e6);
        vm.expectEmit(address(engine));
        emit PerpEngineBase.PositionLiquidated(carolKey, carol, keeper, FUT, 104_000e18, 100e6, 2e6, 98e6);
        vm.prank(keeper);
        assertEq(engine.settlePositions(keys), 3);

        assertEq(usdc.balanceOf(alice), aliceBefore + 1_395e6);
        assertEq(usdc.balanceOf(bob), bobBefore + 595e6);
        assertEq(usdc.balanceOf(carol), carolBefore); // liquidated: nothing back
        assertEq(usdc.balanceOf(keeper), 2e6); // the liquidation fee goes to whoever settles
        // bob reports his 400 loss up to 1% of 10,000; carol her 98 after bob's 100.
        assertEq(house.balanceOf(bob), _rebateAfter(100e6, 0));
        assertEq(house.balanceOf(carol), _rebateAfter(98e6, 100e6));
        assertEq(engine.positionCount(), 1);
        assertEq(engine.getPositionByKey(perpKey).trader, carol);
        assertEq(_market(FUT).longOi, 0);
        assertEq(_market(FUT).shortOi, 0);
        assertEq(_market(FUT).longUnits, 0);
        assertEq(_market(FUT).shortUnits, 0);
        _assertEngineSolvent();

        // Nothing left to do: zero, without reverting.
        assertEq(engine.settlePositions(keys), 0);
        assertEq(engine.settlePositions(new bytes32[](0)), 0);
    }

    function test_settlePositions_refundsLinkedOrderEscrowToTheTrader() public {
        OpenParams memory p = _params(FUT, true, 1_000e6, 10_000e6);
        p.takeProfit = 120_000e18;
        p.stopLoss = 95_000e18;
        vm.startPrank(alice);
        bytes32 key = engine.openPosition(p, _noBytes());
        engine.setTriggerOrder(FUT, OrderType.Close, 150_000e18, 0); // a bound that will never be met
        vm.stopPrank();
        uint256 before = usdc.balanceOf(alice);
        assertEq(engine.orderCount(), 3);

        _settle(104_000);
        assertEq(engine.settlePositions(_keys(key)), 1);
        assertEq(usdc.balanceOf(alice), before + 1_395e6 + 3 * EXEC_FEE);
        assertEq(engine.orderCount(), 0);
        _assertEngineSolvent();
    }

    function test_future_triggerOrdersOnASettledMarket() public {
        // alice: take-profit at 103,000 (met at 104,000); bob: take-profit at 105,000 (not met), then a
        // Close order; carol (short): stop-loss at 103,500 (met).
        OpenParams memory p = _params(FUT, true, 1_000e6, 10_000e6);
        p.takeProfit = 103_000e18;
        vm.prank(alice);
        engine.openPosition(p, _noBytes());
        p.takeProfit = 105_000e18;
        vm.prank(bob);
        engine.openPosition(p, _noBytes());
        p = _params(FUT, false, 1_000e6, 10_000e6);
        p.stopLoss = 103_500e18;
        vm.prank(carol);
        engine.openPosition(p, _noBytes());
        uint256 aliceBefore = usdc.balanceOf(alice);
        uint256 bobBefore = usdc.balanceOf(bob);
        uint256 carolBefore = usdc.balanceOf(carol);

        _settle(104_000);
        skip(1 hours);

        vm.expectEmit(address(engine));
        emit PerpEngineBase.OrderExecuted(1, alice, keeper, 104_000e18);
        _exec(1);
        assertEq(usdc.balanceOf(alice), aliceBefore + 1_395e6);

        vm.prank(keeper);
        vm.expectRevert(PerpEngineBase.TriggerNotMet.selector);
        engine.executeOrder(2, _noBytes());

        _exec(3);
        assertEq(usdc.balanceOf(carol), carolBefore + 1_000e6 - 400e6 - 5e6);

        // bob asks a keeper to close: bounded above the settlement price it cannot fill, unbounded it does.
        vm.prank(bob);
        uint256 closeId = engine.setTriggerOrder(FUT, OrderType.Close, 104_000e18 + 1, 0);
        vm.prank(keeper);
        vm.expectRevert(PerpEngineBase.TriggerNotMet.selector);
        engine.executeOrder(closeId, _noBytes());
        vm.prank(bob);
        engine.setTriggerOrder(FUT, OrderType.Close, 104_000e18, 0);
        _exec(closeId);
        // margin - fee + profit, his unfilled take-profit's escrow back, the Close order's fee spent
        assertEq(usdc.balanceOf(bob), bobBefore + 1_395e6 + EXEC_FEE - EXEC_FEE);
        assertEq(usdc.balanceOf(keeper), 3 * EXEC_FEE);
        assertEq(engine.positionCount(), 0);
        assertEq(engine.orderCount(), 0);
        _assertEngineSolvent();
    }

    function test_future_liquidationInASettledMarket() public {
        bytes32 key = _open(alice, FUT, true, 100e6, 10_000e6); // 100x long
        _open(alice, BTC, true, 1_000e6, 10_000e6); // healthy perpetual
        _settle(99_000); // -1%: past the 90% threshold
        skip(30 days); // no live price for a month

        // She cannot walk away through a close ...
        vm.prank(alice);
        vm.expectRevert(PerpEngineBase.PositionLiquidatable.selector);
        engine.closePosition(FUT, 0, 0, _noBytes());
        (,,, bool liquidatable) = lens.getPositionState(key, 99_000e18);
        assertTrue(liquidatable);

        // ... and the plain liquidation entry points work off the settlement price, with nothing fresh
        // on-chain. Her perpetual is skipped because its price is stale.
        vm.prank(keeper);
        assertEq(_liquidate(alice), 1);
        assertEq(usdc.balanceOf(keeper), 2e6);
        assertEq(engine.getPosition(alice, FUT).trader, address(0));
        assertEq(engine.getPosition(alice, BTC).trader, alice);

        _open2(bob);
        _assertEngineSolvent();
    }

    /// @dev liquidateBatch on a settled market, for completeness of the three liquidation entry points.
    function _open2(address who) internal {
        vm.prank(owner);
        engine.addMarket(
            keccak256("FUT2"), _cfg("FUT2", BTC, bytes32(0), false, uint64(vm.getBlockTimestamp() + 1 days))
        );
        _setBtc(100_000);
        bytes32 key = _open(who, keccak256("FUT2"), false, 100e6, 10_000e6);
        vm.warp(vm.getBlockTimestamp() + 1 days);
        _publish(BTC, 101_000e8, 0, -8);
        engine.settleMarket(keccak256("FUT2"), _noBytes());
        skip(1 hours);
        vm.prank(keeper);
        assertEq(engine.liquidateBatch(_keys(key), _noBytes()), 1);
        assertEq(usdc.balanceOf(keeper), 4e6);
    }

    function test_future_lensAndValuationAfterSettlement() public {
        _open(alice, FUT, true, 10_000e6, 100_000e6);
        _settle(104_000);
        _setBtc(120_000); // the live feed runs away after settlement
        skip(1 days);

        // The book is marked at the settlement price, not at the live one.
        assertEq(engine.unrealizedTraderPnl(), 4_000e6);
        assertEq(vault.exitValue(), vault.totalHouseBalance() - 4_000e6);

        EngineLens.MarketView[] memory ms = lens.getMarkets();
        assertEq(ms[5].id, FUT);
        assertTrue(ms[5].hasPrice);
        assertEq(ms[5].price.mid, 104_000e18);
        assertEq(ms[5].market.settlementPrice, 104_000e18);
        assertFalse(ms[0].hasPrice); // the perpetual's price is a day old
    }

    function test_future_crossDatedMarketSettlesOnTheOlderFeedTime() public {
        bytes32 id = keccak256("ETH-BTC-DATED");
        uint64 expiry = uint64(vm.getBlockTimestamp() + 1 days);
        vm.prank(owner);
        engine.addMarket(id, _cfg("ETH-BTC-DATED", ETH, BTC, false, expiry));
        _refreshAll();
        _open(alice, id, true, 1_000e6, 10_000e6);

        // ETH is published at expiry but BTC a second before: the cross is not yet an at-expiry price.
        vm.warp(expiry - 1);
        _publish(BTC, 100_000e8, 0, -8);
        vm.warp(expiry);
        _publish(ETH, 4_200e8, 0, -8);
        vm.expectRevert(PerpEngineBase.PriceBeforeExpiry.selector);
        engine.settleMarket(id, _noBytes());
        _publish(BTC, 100_000e8, 0, -8);
        engine.settleMarket(id, _noBytes());
        assertEq(_market(id).settlementPrice, 0.042e18);

        uint256 before = usdc.balanceOf(alice);
        _close(alice, id);
        assertEq(usdc.balanceOf(alice), before + 1_000e6 + 500e6 - 5e6);
    }
}
