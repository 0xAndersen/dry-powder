// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Base} from "./Base.t.sol";
import {PerpEngineBase} from "../src/PerpEngineBase.sol";
import {FeeMode, LimitParams, Market, MarketConfig, Order, OrderType, Position} from "../src/Types.sol";

/// @notice v3.2: Upside ("no fee unless you win") markets up to 5000x, exposure-based vault caps, order expiry,
///         margin removal, referrals, and DRY on net results.
contract EngineV32Test is Base {
    bytes32 internal constant TURBO = keccak256("BTC-USD-TURBO");
    uint256 internal constant TURBO_OI = 1_000_000_000e6;

    function setUp() public override {
        super.setUp();
        vm.startPrank(owner);
        engine.addMarket(
            TURBO,
            MarketConfig({
                symbol: "BTC-USD-TURBO",
                feedId: BTC,
                quoteFeedId: bytes32(0),
                invert: false,
                maxLeverage: 5000,
                expiry: 0,
                maxOiPerSide: TURBO_OI,
                skewScale: TURBO_OI
            })
        );
        engine.setMarketFeeMode(TURBO, FeeMode.Upside);
        vm.stopPrank();
    }

    // ───────────────────────────── Helpers ─────────────────────────────

    /// @dev A marketable open order (filled by the keeper at the next price), returned unexecuted.
    function _marketOrder(address who, bytes32 id, bool isLong, uint256 margin, uint256 size)
        internal
        returns (uint256 orderId)
    {
        vm.prank(who);
        orderId = engine.createLimitOrder(_limit(id, isLong, margin, size, isLong ? 1_000_000e18 : 1));
    }

    /// @dev Opens `who`'s Turbo position at a BTC price of `usd` with confidence `conf` (whole dollars).
    function _turbo(address who, bool isLong, uint256 margin, uint256 size, uint256 usd, uint256 conf)
        internal
        returns (bytes32 key)
    {
        uint256 id = _marketOrder(who, TURBO, isLong, margin, size);
        _setPrice(BTC, int64(uint64(usd * 1e8)), uint64(conf * 1e8), -8);
        _exec(id);
        key = engine.positionKey(who, TURBO);
    }

    /// @dev Closes `who`'s position in `id` through a keeper-filled close order at a BTC price of `usd`.
    function _closeVia(address who, bytes32 id, uint256 usd, uint256 conf) internal {
        vm.prank(who);
        uint256 orderId = engine.setTriggerOrder(id, OrderType.Close, 0, 0);
        _setPrice(BTC, int64(uint64(usd * 1e8)), uint64(conf * 1e8), -8);
        _exec(orderId);
    }

    /// @dev `totalExposure` recomputed from every market's counters.
    function _exposureSum() internal view returns (uint256 sum) {
        bytes32[] memory ids = engine.getMarketIds();
        uint256 k = engine.maxProfitMultiple();
        for (uint256 i; i < ids.length; ++i) {
            Market memory m = engine.getMarket(ids[i]);
            sum += _min(m.longOi, m.longMargin * k) + _min(m.shortOi, m.shortMargin * k);
        }
    }

    function _min(uint256 a, uint256 b) internal pure returns (uint256) {
        return a < b ? a : b;
    }

    function _assertExposure() internal view {
        assertEq(engine.totalExposure(), _exposureSum(), "exposure");
    }

    // ───────────────────────────── Upside markets ─────────────────────────────

    function test_upside_modeIsSetByTheOwnerOnAnEmptyBook() public {
        assertEq(uint8(engine.getMarket(TURBO).feeMode), uint8(FeeMode.Upside));
        assertEq(uint8(engine.getMarket(BTC).feeMode), uint8(FeeMode.Standard));

        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        engine.setMarketFeeMode(ETH, FeeMode.Upside);

        vm.startPrank(owner);
        vm.expectRevert(PerpEngineBase.MarketNotFound.selector);
        engine.setMarketFeeMode(keccak256("nope"), FeeMode.Upside);
        vm.expectEmit(address(engine));
        emit PerpEngineBase.MarketFeeModeSet(ETH, FeeMode.Upside);
        engine.setMarketFeeMode(ETH, FeeMode.Upside);
        engine.setMarketFeeMode(ETH, FeeMode.Standard);
        vm.stopPrank();

        // Not with open interest: no position may open under one model and close under the other.
        _open(alice, ETH, true, 1_000e6, 10_000e6);
        vm.prank(owner);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setMarketFeeMode(ETH, FeeMode.Upside);
    }

    function test_upside_directOpensAndClosesAreRefused() public {
        vm.prank(alice);
        vm.expectRevert(PerpEngineBase.OrdersOnly.selector);
        engine.openPosition(_params(TURBO, true, 100e6, 1_000e6), _noBytes()); // even at 10x

        _turbo(alice, true, 10e6, 50_000e6, 100_000, 0);
        _setBtc(100_000);
        vm.prank(alice);
        vm.expectRevert(PerpEngineBase.OrdersOnly.selector);
        engine.closePosition(TURBO, 0, 0, _noBytes());
    }

    /// No fee budget is escrowed, the fill is at the mid (not the ask), and a losing close costs nothing but
    /// the loss.
    function test_upside_fillsAtMid_andALosingCloseHasNoFee() public {
        uint256 before = _bal(alice);
        uint256 orderId = _marketOrder(alice, TURBO, true, 10e6, 50_000e6); // 5000x
        assertEq(before - _bal(alice), 10e6 + EXEC_FEE);
        assertEq(engine.getOrder(orderId).feeBudget, 0);

        _setPrice(BTC, 100_000e8, 10e8, -8); // bid 99,990, ask 100,010
        vm.expectEmit(address(engine));
        emit PerpEngineBase.PositionOpened(
            engine.positionKey(alice, TURBO), alice, TURBO, true, 10e6, 50_000e6, 100_000e18, 0
        );
        _exec(orderId);
        Position memory pos = engine.getPosition(alice, TURBO);
        assertEq(pos.entryPrice, 100_000e18);
        assertEq(_market(TURBO).longMargin, 10e6);
        assertEq(engine.totalOpenInterest(), 50_000e6);
        assertEq(engine.totalExposure(), 100e6); // 10x its margin, not its 50,000 of notional
        _assertExposure();

        // -0.01%: a loss of 5, half the margin, closed at the mid.
        uint256 dry = _rebate(5e6, 50_000e6);
        bytes32 key = engine.positionKey(alice, TURBO);
        before = _bal(alice);
        uint256 feesBefore = vault.totalFeesCollected();
        vm.prank(alice);
        uint256 closeId = engine.setTriggerOrder(TURBO, OrderType.Close, 0, 0);
        _setPrice(BTC, 99_990e8, 10e8, -8);
        vm.expectEmit(address(engine));
        emit PerpEngineBase.PositionClosed(key, alice, TURBO, 99_990e18, -5e6, 0, 5e6);
        _exec(closeId);
        // Margin less the loss; the close order's execution fee went to the keeper.
        assertEq(_bal(alice) + EXEC_FEE - before, 5e6);
        assertEq(vault.totalFeesCollected(), feesBefore);
        assertEq(vault.totalTraderLosses(), 5e6);
        assertEq(house.balanceOf(alice), dry);
        assertEq(engine.totalExposure(), 0);
        _assertEngineSolvent();
    }

    /// A win pays the profit less `profitShareBps` (20%), which the house keeps; nothing else is charged.
    function test_upside_aWinGivesTheHouseAShareOfTheProfit() public {
        bytes32 key = _turbo(alice, true, 10e6, 50_000e6, 100_000, 5);
        uint256 before = _bal(alice);
        vm.prank(alice);
        uint256 closeId = engine.setTriggerOrder(TURBO, OrderType.Close, 0, 0);
        _setPrice(BTC, 100_020e8, 5e8, -8); // +0.02%: 10 of profit, one margin
        vm.expectEmit(address(engine));
        emit PerpEngineBase.PositionClosed(key, alice, TURBO, 100_020e18, 10e6, 2e6, 18e6);
        _exec(closeId);
        assertEq(_bal(alice) + EXEC_FEE - before, 18e6);
        assertEq(vault.totalTraderProfits(), 8e6);
        assertEq(vault.totalFeesCollected(), 0);
        assertEq(house.balanceOf(alice), 0);
        _assertEngineSolvent();
    }

    function test_upside_profitIsCappedAtTenTimesMarginBeforeTheShare() public {
        bytes32 key = _turbo(alice, true, 10e6, 50_000e6, 100_000, 0);
        vm.prank(alice);
        uint256 closeId = engine.setTriggerOrder(TURBO, OrderType.Close, 0, 0);
        _setPrice(BTC, 100_300e8, 0, -8); // +0.3% would be 150; capped at 100
        vm.expectEmit(address(engine));
        emit PerpEngineBase.PositionClosed(key, alice, TURBO, 100_300e18, 100e6, 20e6, 90e6);
        _exec(closeId);
    }

    function test_upside_bracketsFillAtMid() public {
        // Brackets are checked against the trigger at creation, so the marketable limit sits just above the price.
        LimitParams memory p = _limit(TURBO, true, 10e6, 50_000e6, 100_005e18);
        p.takeProfit = 100_010e18;
        p.stopLoss = 99_995e18;
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(p);
        _setPrice(BTC, 100_000e8, 3e8, -8);
        _exec(id);
        Position memory pos = engine.getPosition(alice, TURBO);
        uint256 before = _bal(alice);
        _setPrice(BTC, 100_012e8, 3e8, -8); // through the take-profit: fills at the mid, 100,012
        _exec(pos.tpOrderId);
        // profit 6, share 1.2: 10 + 4.8 back, and the unused stop's escrow
        assertEq(_bal(alice) - before, 14.8e6 + EXEC_FEE);
        assertEq(engine.orderCount(), 0);
        _assertEngineSolvent();
    }

    function test_upside_5000xIsLiquidatedByATinyMove() public {
        bytes32 key = _turbo(alice, true, 10e6, 50_000e6, 100_000, 0);
        _setBtc(99_983); // -0.017%: a loss of 8.5, under 90% of margin
        vm.expectRevert(PerpEngineBase.NothingToLiquidate.selector);
        engine.liquidateBatch(_keys(key), _noBytes());
        _setPrice(BTC, 99_982e8, 0, -8); // -0.018%: 9, the threshold
        vm.prank(keeper);
        engine.liquidateBatch(_keys(key), _noBytes());
        assertEq(usdc.balanceOf(keeper), 0.2e6 + EXEC_FEE); // 2% of margin, and the fee for filling the open
        assertEq(vault.totalTraderLosses(), 9.8e6);
        assertEq(engine.totalExposure(), 0);
        _assertEngineSolvent();
    }

    /// Why BTC and ETH Turbo launch at 1000x. Between two keeper ticks the price can run past a liquidation: the
    /// liquidated leg of a hedged pair loses only its margin while the other leg keeps the whole move, and Turbo has no
    /// spread or fee to absorb it. One basis point past the liquidation price (about what a ~3 s keeper tick adds on
    /// bitcoin) is half a margin at 5000x, so the pair ends ahead even after the 20% share; at 1000x it is a tenth of
    /// a margin and the pair loses.
    function test_upside_hedgedPairKeepsTheOvershoot_at5000x() public {
        assertEq(_hedgedPairResult(5000), 0.9e6); // +14 on the short, less 2.8 of share, less 0.3 of keeper fees
    }

    function test_upside_hedgedPairLosesTheOvershoot_at1000x() public {
        assertEq(_hedgedPairResult(1000), -2.3e6); // +10 on the short, less 2 of share, less 0.3 of keeper fees
    }

    /// @dev Alice long and bob short, 10 of margin each at `lev`; bitcoin falls through alice's liquidation price and
    ///      one basis point beyond; alice is liquidated there and bob closes there. The pair's net, in USDC.
    function _hedgedPairResult(uint256 lev) internal returns (int256 net) {
        uint256 before = _bal(alice) + _bal(bob);
        uint256 size = 10e6 * lev;
        bytes32 longKey = _turbo(alice, true, 10e6, size, 100_000, 0);
        _turbo(bob, false, 10e6, size, 100_000, 0);
        uint256 low = 100_000 - (100_000 * 9) / (lev * 10) - 10; // 90% of margin, then one basis point more
        _setPrice(BTC, int64(uint64(low * 1e8)), 0, -8);
        vm.prank(keeper);
        engine.liquidateBatch(_keys(longKey), _noBytes());
        _closeVia(bob, TURBO, low, 0);
        net = int256(_bal(alice) + _bal(bob)) - int256(before);
        _assertEngineSolvent();
    }

    /// The vault cap is measured in exposure: a 5000x position counts for its capped profit, so 5M of notional
    /// fits a 1M vault whose notional cap would have been 3M.
    function test_exposure_letsHighLeverageFitTheVaultCap() public {
        _flatFees();
        _turbo(alice, true, 1_000e6, 5_000_000e6, 100_000, 0);
        assertEq(engine.totalOpenInterest(), 5_000_000e6); // more than 3x the 1M vault
        assertEq(engine.totalExposure(), 10_000e6);
        assertEq(engine.reservedLiquidity(), 3_333_333_334); // 10,000 / 3, rounded up

        // A 1x position counts in full. NAV is 1M plus the two open fees, so the cap is 3,004,485.
        _fund(bob, 2_000_000e6);
        _open(bob, BTC, true, 2_000_000e6, 2_000_000e6);
        _open(carol, ETH, true, 990_000e6, 990_000e6);
        assertEq(engine.totalExposure(), 3_000_000e6);
        vm.prank(alice);
        vm.expectRevert(PerpEngineBase.VaultOiCapExceeded.selector);
        engine.openPosition(_params(EUR, true, 10_000e6, 10_000e6), _noBytes());
        _open(alice, EUR, true, 1_000e6, 1_000e6);
        _assertExposure();
    }

    /// Every change to a book keeps `totalExposure` the sum of what each side can cost the vault.
    function test_exposure_tracksEveryChange() public {
        _flatFees();
        bytes32 a = _open(alice, BTC, true, 1_000e6, 50_000e6); // 50x: capped at 10,000
        _assertExposure();
        assertEq(engine.totalExposure(), 10_000e6);
        _open(bob, BTC, false, 2_000e6, 10_000e6); // 5x: its notional, 10,000
        assertEq(engine.totalExposure(), 20_000e6);
        _setBtc(100_000);
        vm.prank(alice);
        engine.closePosition(BTC, 25_000e6, 0, _noBytes()); // half
        assertEq(engine.totalExposure(), 15_000e6);
        vm.prank(bob);
        engine.addMargin(BTC, 1_000e6); // a 5x book is limited by notional: unchanged
        assertEq(engine.totalExposure(), 15_000e6);
        vm.prank(alice);
        engine.addMargin(BTC, 500e6); // a 25x book is limited by margin: 1,000 * 10 = 10,000 now
        assertEq(engine.totalExposure(), 20_000e6);
        _setBtc(100_000);
        vm.prank(alice);
        engine.removeMargin(BTC, 750e6, _noBytes()); // 250 * 10
        assertEq(engine.totalExposure(), 12_500e6);
        _assertExposure();
        vm.prank(owner);
        engine.setMaxProfitMultiple(5);
        assertEq(engine.totalExposure(), 1_250e6 + 10_000e6);
        _assertExposure();
        _setBtc(99_100); // alice's 100x remainder is past the threshold
        vm.prank(keeper);
        engine.liquidateBatch(_keys(a), _noBytes());
        assertEq(engine.totalExposure(), 10_000e6);
        _close(bob, BTC);
        assertEq(engine.totalExposure(), 0);
        _assertExposure();
        _assertEngineSolvent();
    }

    /// Each side of the mark is held between losing its margin and winning its capped profit.
    function test_mark_boundsTurboSidesByMarginAndCap() public {
        _turbo(alice, true, 10e6, 50_000e6, 100_000, 0);
        _setBtc(101_000); // +1%: 500 on paper, 100 at most
        assertEq(engine.unrealizedTraderPnl(), 100e6);
        _setBtc(99_000); // -1%: -500 on paper, its 10 of margin at most
        assertEq(engine.unrealizedTraderPnl(), -10e6);
    }

    // ───────────────────────────── Order expiry ─────────────────────────────

    function test_createLimitOrderUntil_recordsTheExpiry() public {
        LimitParams memory p = _limit(BTC, true, 1_000e6, 10_000e6, 90_000e18);
        vm.startPrank(alice);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.createLimitOrderUntil(p, uint64(block.timestamp));
        uint64 until = uint64(block.timestamp + 60);
        vm.expectEmit(address(engine));
        emit PerpEngineBase.OrderExpirySet(1, until);
        uint256 id = engine.createLimitOrderUntil(p, until);
        vm.stopPrank();
        assertEq(engine.getOrder(id).expiresAt, until);
        vm.prank(alice);
        assertEq(engine.getOrder(engine.createLimitOrder(p)).expiresAt, 0);
    }

    function test_expiredOrderCannotExecute_untilTheLastSecondItCan() public {
        LimitParams memory p = _limit(BTC, true, 1_000e6, 10_000e6, 1_000_000e18);
        vm.startPrank(alice);
        uint256 soon = engine.createLimitOrderUntil(p, uint64(block.timestamp + 10));
        uint256 later = engine.createLimitOrderUntil(
            _limit(ETH, true, 1_000e6, 10_000e6, 1_000_000e18), uint64(block.timestamp + 10)
        );
        vm.stopPrank();
        skip(9);
        _setEth(4_000); // t + 10: the last second the ETH order may execute
        _exec(later);
        _setBtc(100_000); // t + 11
        vm.prank(keeper);
        vm.expectRevert(PerpEngineBase.OrderHasExpired.selector);
        engine.executeOrder(soon, _noBytes());
    }

    function test_setOrderExpiry_ownerOnly_anyOrderType() public {
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(_limit(BTC, true, 1_000e6, 10_000e6, 90_000e18));
        vm.prank(bob);
        vm.expectRevert(PerpEngineBase.NotOrderOwner.selector);
        engine.setOrderExpiry(id, uint64(block.timestamp + 1));
        vm.startPrank(alice);
        vm.expectRevert(PerpEngineBase.OrderNotFound.selector);
        engine.setOrderExpiry(999, uint64(block.timestamp + 1));
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setOrderExpiry(id, uint64(block.timestamp));
        vm.expectEmit(address(engine));
        emit PerpEngineBase.OrderExpirySet(id, uint64(block.timestamp + 5));
        engine.setOrderExpiry(id, uint64(block.timestamp + 5));
        engine.setOrderExpiry(id, 0); // good until cancelled again
        assertEq(engine.getOrder(id).expiresAt, 0);
        vm.stopPrank();

        _open(alice, ETH, true, 1_000e6, 10_000e6);
        vm.startPrank(alice);
        uint256 stop = engine.setTriggerOrder(ETH, OrderType.StopLoss, 3_900e18, 0);
        engine.setOrderExpiry(stop, uint64(block.timestamp + 100));
        // Moving the stop keeps its expiry.
        engine.setTriggerOrder(ETH, OrderType.StopLoss, 3_950e18, 0);
        vm.stopPrank();
        assertEq(engine.getOrder(stop).expiresAt, block.timestamp + 100);
    }

    /// Anyone may sweep expired orders: they earn each one's execution fee, the rest of the escrow goes back to
    /// the trader, and a linked trigger is unlinked from its position.
    function test_cancelExpired_refundsTheEscrowAndPaysTheSweeper() public {
        LimitParams memory p = _limit(BTC, true, 1_000e6, 10_000e6, 90_000e18);
        p.takeProfit = 95_000e18;
        p.stopLoss = 85_000e18;
        uint256 before = _bal(alice);
        vm.prank(alice);
        uint256 openId = engine.createLimitOrderUntil(p, uint64(block.timestamp + 60));
        uint256 escrow = before - _bal(alice);
        assertEq(escrow, 1_000e6 + 15e6 + 3 * EXEC_FEE); // margin, fee budget, the order and two brackets

        _open(alice, ETH, true, 1_000e6, 10_000e6);
        vm.startPrank(alice);
        uint256 stop = engine.setTriggerOrder(ETH, OrderType.StopLoss, 3_900e18, 0);
        engine.setOrderExpiry(stop, uint64(block.timestamp + 60));
        vm.stopPrank();
        vm.prank(bob);
        uint256 kept = engine.createLimitOrder(_limit(BTC, true, 1_000e6, 10_000e6, 90_000e18));

        uint256[] memory ids = new uint256[](4);
        (ids[0], ids[1], ids[2], ids[3]) = (openId, stop, kept, 999);
        vm.prank(keeper);
        vm.expectRevert(PerpEngineBase.NothingToCancel.selector);
        engine.cancelExpired(ids);

        skip(61);
        before = _bal(alice);
        vm.expectEmit(address(engine));
        emit PerpEngineBase.OrderCancelled(openId, alice);
        vm.expectEmit(address(engine));
        emit PerpEngineBase.OrderExpired(openId, alice, keeper);
        vm.prank(keeper);
        assertEq(engine.cancelExpired(ids), 2);
        assertEq(_bal(alice) - before, escrow - EXEC_FEE);
        assertEq(_bal(keeper), 2 * EXEC_FEE);
        assertEq(engine.getPosition(alice, ETH).slOrderId, 0);
        assertEq(engine.getOrder(kept).trader, bob);
        assertEq(engine.orderCount(), 1);
        vm.prank(keeper);
        vm.expectRevert(PerpEngineBase.NothingToCancel.selector);
        engine.cancelExpired(ids);
        _assertEngineSolvent();
    }

    // ───────────────────────────── Margin removal ─────────────────────────────

    function test_removeMargin_paysOutAndRaisesLeverage() public {
        _flatFees();
        bytes32 key = _open(alice, BTC, true, 1_000e6, 10_000e6);
        _setBtc(100_000);
        uint256 before = _bal(alice);
        vm.expectEmit(address(engine));
        emit PerpEngineBase.MarginRemoved(key, alice, 500e6, 500e6);
        vm.prank(alice);
        engine.removeMargin(BTC, 500e6, _noBytes());
        assertEq(_bal(alice) - before, 500e6);
        assertEq(engine.getPosition(alice, BTC).margin, 500e6);
        assertEq(_market(BTC).longMargin, 500e6);
        _assertEngineSolvent();
        _assertExposure();
    }

    function test_removeMargin_limits() public {
        _flatFees();
        _open(alice, BTC, true, 1_000e6, 10_000e6); // 10x, market max 100x
        vm.startPrank(alice);
        vm.expectRevert(PerpEngineBase.PriceNotAfterOpen.selector); // same second as the open
        engine.removeMargin(BTC, 100e6, _noBytes());
        vm.stopPrank();
        _setBtc(100_000);
        vm.startPrank(alice);
        vm.expectRevert(PerpEngineBase.PositionNotFound.selector);
        engine.removeMargin(ETH, 100e6, _noBytes());
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.removeMargin(BTC, 0, _noBytes());
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.removeMargin(BTC, 1_000e6, _noBytes());
        vm.expectRevert(PerpEngineBase.LeverageOutOfRange.selector);
        engine.removeMargin(BTC, 901e6, _noBytes()); // 99 left: past 100x
        engine.removeMargin(BTC, 900e6, _noBytes()); // exactly 100x
        vm.stopPrank();

        // Never below the minimum margin.
        _open(bob, ETH, true, 10e6, 50e6);
        _setEth(4_000);
        vm.prank(bob);
        vm.expectRevert(PerpEngineBase.MarginTooLow.selector);
        engine.removeMargin(ETH, 6e6, _noBytes());

        // Keeper-only leverage is never reached directly, whatever the market allows.
        vm.prank(owner);
        engine.setMarket(EUR, true, 1000, MAX_OI_PER_SIDE, SKEW_SCALE);
        _open(carol, EUR, true, 1_000e6, 10_000e6);
        _setPrice(EUR, 110_000, 0, -5);
        vm.prank(carol);
        vm.expectRevert(PerpEngineBase.LeverageOutOfRange.selector);
        engine.removeMargin(EUR, 901e6, _noBytes());

        // Paused: nothing comes out.
        vm.prank(owner);
        engine.pause();
        vm.prank(carol);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        engine.removeMargin(EUR, 100e6, _noBytes());
    }

    /// What stays must cover the loss at the exit price plus the initial margin; profit never counts.
    function test_removeMargin_coversTheLossAndIgnoresProfit() public {
        _flatFees();
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        _setBtc(97_000); // -3%: a loss of 300; initial margin at 100x is 100
        vm.startPrank(alice);
        vm.expectRevert(PerpEngineBase.InsufficientMargin.selector);
        engine.removeMargin(BTC, 601e6, _noBytes());
        engine.removeMargin(BTC, 600e6, _noBytes());
        vm.stopPrank();

        _open(bob, ETH, true, 1_000e6, 10_000e6);
        _setEth(4_400); // +10%: 1,000 of profit, which cannot be taken out as margin
        vm.prank(bob);
        vm.expectRevert(PerpEngineBase.LeverageOutOfRange.selector);
        engine.removeMargin(ETH, 901e6, _noBytes());
        _assertEngineSolvent();
    }

    // ───────────────────────────── Referrals ─────────────────────────────

    function test_setReferrer_onceNotSelfNotZero() public {
        vm.expectEmit(address(engine));
        emit PerpEngineBase.ReferrerSet(alice, bob);
        vm.prank(alice);
        engine.setReferrer(bob);
        assertEq(engine.referrerOf(alice), bob);
        vm.prank(alice);
        vm.expectRevert(PerpEngineBase.ReferrerAlreadySet.selector);
        engine.setReferrer(carol);
        vm.startPrank(carol);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setReferrer(carol);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setReferrer(address(0));
        vm.stopPrank();
    }

    /// A referred trader pays 5% less on every fee, and their referrer collects 10% of what they pay.
    function test_referral_discountAndShareOnStandardFees() public {
        _flatFees();
        vm.prank(alice);
        engine.setReferrer(bob);
        uint256 before = _bal(alice);
        vm.expectEmit(address(engine));
        emit PerpEngineBase.ReferralFeePaid(bob, alice, 0.475e6);
        _open(alice, BTC, true, 1_000e6, 10_000e6); // 5 bp of 10,000 = 5, less 5% = 4.75
        assertEq(before - _bal(alice), 1_000e6 + 4.75e6);
        assertEq(engine.claimable(bob), 0.475e6);
        assertEq(vault.totalFeesCollected(), 4.275e6);
        _assertEngineSolvent();

        _setBtc(100_000);
        _close(alice, BTC);
        assertEq(engine.claimable(bob), 0.95e6);
        assertEq(vault.totalFeesCollected(), 8.55e6);
        _assertEngineSolvent();

        before = _bal(bob);
        vm.prank(bob);
        engine.claim();
        assertEq(_bal(bob) - before, 0.95e6);
        _assertEngineSolvent();
    }

    /// In an Upside market the share of profit is the fee: discounted, and the referrer's part of it is paid out
    /// with the profit.
    function test_referral_inAnUpsideMarket() public {
        vm.prank(alice);
        engine.setReferrer(carol);
        bytes32 key = _turbo(alice, true, 10e6, 50_000e6, 100_000, 0);
        vm.prank(alice);
        uint256 closeId = engine.setTriggerOrder(TURBO, OrderType.Close, 0, 0);
        _setBtc(100_020); // 10 of profit; 20% is 2, less 5% is 1.9, of which carol gets 0.19
        vm.expectEmit(address(engine));
        emit PerpEngineBase.PositionClosed(key, alice, TURBO, 100_020e18, 10e6, 1.9e6, 18.1e6);
        _exec(closeId);
        assertEq(engine.claimable(carol), 0.19e6);
        assertEq(vault.totalTraderProfits(), 8.29e6);
        _assertEngineSolvent();
    }

    /// Each share is at most 50%, and together they must leave the house 15% of a self-referred Upside win.
    function test_feeShares_boundedAndKeepTheHouseFloor() public {
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        engine.setReferralParams(0, 0);
        vm.startPrank(owner);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setReferralParams(5_001, 0);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setReferralParams(0, 5_001);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setReferralParams(2_000, 1_000); // 20% * 90% * 80% = 14.4%
        vm.expectEmit(address(engine));
        emit PerpEngineBase.ReferralParamsSet(1_500, 1_000);
        engine.setReferralParams(1_500, 1_000); // 20% * 90% * 85% = 15.3%
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setProfitShare(1_900); // 19% * 90% * 85% = 14.5%
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setProfitShare(5_001);
        engine.setReferralParams(0, 0);
        vm.expectEmit(address(engine));
        emit PerpEngineBase.ProfitShareSet(1_500);
        engine.setProfitShare(1_500);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setProfitShare(1_499);
        vm.stopPrank();
        assertEq(engine.profitShareBps(), 1_500);
    }

    // ───────────────────────────── DRY on net results ─────────────────────────────

    /// One account hedged across two markets on the same feed mints DRY on its net result once: closing the losing
    /// leg first mints on that low, and the next cycle, which goes no lower, mints nothing.
    function test_rebate_isNetForOneAccountAcrossMarkets() public {
        _flatFees();
        for (uint256 cycle; cycle < 2; ++cycle) {
            _setBtc(100_000);
            _open(alice, BTC, true, 1_000e6, 10_000e6);
            _open(alice, FUT, false, 1_000e6, 10_000e6);
            _setBtc(99_000); // the long loses 100, the future's short wins 100
            _close(alice, BTC);
            _close(alice, FUT);
        }
        assertEq(house.balanceOf(alice), _rebateAfter(100e6, 0));
        (int128 net, int128 low) = house.results(alice);
        assertEq(net, 0);
        assertEq(low, -100e6);
    }
}
