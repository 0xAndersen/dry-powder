// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PerpEngine} from "../src/PerpEngine.sol";
import {PositionView} from "../src/Types.sol";
import {Base} from "./Base.t.sol";

/// @notice The two engine views the vault prices itself with: `unrealizedTraderPnl` (mark-to-market of the
///         whole book) and `reservedLiquidity` (reserve against net skew).
contract ValuationTest is Base {
    function setUp() public override {
        super.setUp();
        _flatFees();
    }

    function test_unrealizedTraderPnl_emptyBookIsZero() public view {
        assertEq(engine.unrealizedTraderPnl(), 0);
        assertEq(engine.reservedLiquidity(), 0);
    }

    function test_unrealizedTraderPnl_exactForLongsAndShortsAcrossTwoMarkets() public {
        _open(alice, BTC, true, 10_000e6, 100_000e6);
        _open(bob, BTC, false, 10_000e6, 40_000e6);
        _open(carol, ETH, true, 10_000e6, 50_000e6);
        _open(alice, ETH, false, 10_000e6, 20_000e6);
        assertEq(engine.unrealizedTraderPnl(), 0);
        assertEq(_market(BTC).longUnits, 1e24); // 1 BTC
        assertEq(_market(BTC).shortUnits, 0.4e24);
        assertEq(_market(ETH).longUnits, 12.5e24);
        assertEq(_market(ETH).shortUnits, 5e24);

        _setBtc(102_000); // +2%: long +2,000, short -800
        assertEq(engine.unrealizedTraderPnl(), 1_200e6);
        _setEth(3_900); // -2.5%: long -1,250, short +500
        assertEq(engine.unrealizedTraderPnl(), 1_200e6 - 750e6);

        _setBtc(95_000); // -5%: long -5,000, short +2,000
        assertEq(engine.unrealizedTraderPnl(), -3_000e6 - 750e6);

        // It moves as positions are realised.
        _close(bob, BTC);
        assertEq(engine.unrealizedTraderPnl(), -5_000e6 - 750e6);
        _setEth(3_900);
        _close(carol, ETH);
        assertEq(engine.unrealizedTraderPnl(), -5_000e6 + 500e6);
    }

    function test_unrealizedTraderPnl_usesStalePrices() public {
        _open(alice, BTC, true, 10_000e6, 100_000e6);
        _setBtc(103_000);
        skip(7 days);
        vm.expectRevert(PerpEngine.OraclePriceStale.selector);
        engine.getPrice(BTC);
        assertEq(engine.unrealizedTraderPnl(), 3_000e6);
        assertEq(vault.exitValue(), vault.totalHouseBalance() - 3_000e6);
    }

    function test_unrealizedTraderPnl_skipsMarketsWithoutAPrice() public {
        _open(alice, BTC, true, 10_000e6, 100_000e6);
        _open(bob, ETH, true, 10_000e6, 100_000e6);
        _setBtc(102_000);
        _setEth(4_040);
        assertEq(engine.unrealizedTraderPnl(), 2_000e6 + 1_000e6);

        // BTC turns invalid: only ETH counts.
        _setPrice(BTC, 0, 0, -8);
        assertEq(engine.unrealizedTraderPnl(), 1_000e6);
        // ETH's confidence blows out: nothing counts, and nothing reverts.
        _setPrice(ETH, 4_040e8, 400e8, -8);
        assertEq(engine.unrealizedTraderPnl(), 0);
        assertEq(vault.totalAssets(), vault.totalHouseBalance());
        // Both come back.
        _setBtc(102_000);
        _setEth(4_040);
        assertEq(engine.unrealizedTraderPnl(), 3_000e6);
    }

    function test_unrealizedTraderPnl_invertedAndCrossMarkets() public {
        _open(alice, JPY, true, 1_000e6, 50_000e6);
        _open(bob, ETHBTC, false, 1_000e6, 10_000e6);
        // The yen strengthens ~1.0101% (150 -> 148.5), ETH/BTC rises 5%.
        _setPrice(JPY, 148_500, 0, -3);
        _setBtcEth(100_000, 4_200);
        int256 expected = int256(505_050_505) - 500e6;
        assertApproxEqAbs(engine.unrealizedTraderPnl(), expected, 2);
    }

    function test_unrealizedTraderPnl_settledMarketUsesSettlementPrice() public {
        _open(alice, FUT, false, 10_000e6, 100_000e6);
        vm.warp(EXPIRY);
        _publish(BTC, 98_000e8, 0, -8);
        engine.settleMarket(FUT, _noBytes());
        _setBtc(150_000);
        assertEq(engine.unrealizedTraderPnl(), 2_000e6);
    }

    /// @dev The estimate ignores that a loss stops at the margin and that a profit stops at the cap. Both
    ///      make it overstate what the house is owed, i.e. err on the high side for entry and (through the
    ///      cap) on the low side for exit.
    function test_unrealizedTraderPnl_ignoresMarginFloorAndProfitCap() public {
        bytes32 key = _open(alice, BTC, true, 100e6, 10_000e6); // 100x
        _setBtc(90_000);
        assertEq(engine.unrealizedTraderPnl(), -1_000e6); // ten times her margin
        vm.prank(keeper);
        engine.liquidate(alice);
        assertEq(engine.unrealizedTraderPnl(), 0);
        assertEq(engine.getPositionByKey(key).trader, address(0));

        _setBtc(100_000);
        _open(bob, BTC, true, 100e6, 10_000e6);
        _setBtc(200_000);
        assertEq(engine.unrealizedTraderPnl(), 10_000e6); // ten times the 1,000 he can actually be paid
    }

    function test_reservedLiquidity_isOnNetSkewPerMarket() public {
        _open(alice, BTC, true, 30_000e6, 300_000e6);
        assertEq(engine.reservedLiquidity(), 100_000e6);
        _open(bob, BTC, false, 10_000e6, 100_000e6);
        assertEq(engine.reservedLiquidity(), 66_666_666_667); // 200k of skew / 3, rounded up
        // Skew in different markets does not net: a BTC long is not hedged by an ETH short.
        _open(carol, ETH, false, 15_000e6, 150_000e6);
        assertEq(engine.reservedLiquidity(), 116_666_666_667);
        assertEq(engine.totalOpenInterest(), 550_000e6);

        _open(carol, BTC, false, 20_000e6, 200_000e6); // BTC is now flat
        assertEq(engine.reservedLiquidity(), 50_000e6);

        vm.prank(owner);
        engine.setRiskParams(3, 50, 10_000, 5e6); // 1x of NAV: the reserve is the skew itself
        assertEq(engine.reservedLiquidity(), 150_000e6);
    }

    /// @dev The aggregate, computed from two counters per market, matches the sum of per-position price PnL
    ///      to within rounding dust.
    function testFuzz_unrealizedTraderPnl_matchesSumOverPositions(
        uint256[3] memory sizes,
        uint256 btc,
        uint256 eth,
        uint8 sides
    ) public {
        address[3] memory who = [alice, bob, carol];
        for (uint256 i; i < 3; ++i) {
            uint256 size = bound(sizes[i], 5e6, 300_000e6);
            _open(who[i], BTC, sides & (1 << i) != 0, size, size);
            _open(who[i], ETH, sides & (8 << i) != 0, size / 2 + 5e6, size / 2 + 5e6);
        }
        btc = bound(btc, 20_000e8, 500_000e8);
        eth = bound(eth, 500e8, 20_000e8);
        skip(1);
        _publish(BTC, int64(uint64(btc)), 0, -8);
        _publish(ETH, int64(uint64(eth)), 0, -8);

        int256 sum;
        PositionView[] memory ps = lens.getPositions(0, 10);
        assertEq(ps.length, 6);
        for (uint256 i; i < ps.length; ++i) {
            uint256 price = ps[i].position.priceId == BTC ? btc * 1e10 : eth * 1e10;
            (int256 pnl,,,) = lens.getPositionState(ps[i].key, price);
            sum += pnl;
        }
        assertApproxEqAbs(engine.unrealizedTraderPnl(), sum, 12);
    }
}
