// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";

import {EngineLens} from "../src/EngineLens.sol";
import {PerpEngine} from "../src/PerpEngine.sol";
import {PythOracle} from "../src/PythOracle.sol";
import {OpenParams, Position, PositionView} from "../src/Types.sol";
import {IHouseVault} from "../src/interfaces/IHouseVault.sol";
import {IRewardToken} from "../src/interfaces/IRewardToken.sol";
import {Base} from "./Base.t.sol";

contract PerpEngineTest is Base {
    uint256 internal constant P100K = 100_000e18;

    function test_constructor_wiring() public view {
        assertEq(address(engine.usdc()), address(usdc));
        assertEq(address(engine.pyth()), address(pyth));
        assertEq(address(engine.oracle()), address(oracle));
        assertEq(address(oracle.pyth()), address(pyth));
        assertEq(address(lens.engine()), address(engine));
        assertEq(address(engine.vault()), address(vault));
        assertEq(address(engine.rewardToken()), address(house));
        assertEq(engine.owner(), owner);
        assertEq(usdc.allowance(address(engine), address(vault)), type(uint256).max);
        assertEq(engine.MAX_LEVERAGE(), 1000);
        assertEq(engine.DIRECT_MAX_LEVERAGE(), 100);
        assertEq(engine.LIQUIDATION_THRESHOLD_BPS(), 9_000);
                bytes32[] memory ids = engine.getMarketIds();
        assertEq(ids.length, 6);
        assertEq(ids[0], BTC);
        assertEq(ids[3], JPY);
        assertEq(ids[4], ETHBTC);
        assertEq(ids[5], FUT);
        assertEq(ids.length + 58, 64); // MAX_MARKETS is 64: see test_addMarket_capsTheNumberOfMarkets
    }

    function test_constructor_rejectsZeroAddresses() public {
        IERC20 u = IERC20(address(usdc));
        PythOracle p = oracle;
        IHouseVault v = IHouseVault(address(vault));
        IRewardToken r = IRewardToken(address(house));
        vm.expectRevert(PerpEngine.ZeroAddress.selector);
        new PerpEngine(IERC20(address(0)), p, v, r, owner);
        vm.expectRevert(PerpEngine.ZeroAddress.selector);
        new PerpEngine(u, PythOracle(address(0)), v, r, owner);
        vm.expectRevert(PerpEngine.ZeroAddress.selector);
        new PerpEngine(u, p, IHouseVault(address(0)), r, owner);
        vm.expectRevert(PerpEngine.ZeroAddress.selector);
        new PerpEngine(u, p, v, IRewardToken(address(0)), owner);
    }

    // ───────────────────────────── Open ─────────────────────────────

    function test_open_long() public {
        bytes32 key = engine.positionKey(alice, BTC);
        uint256 aliceBefore = usdc.balanceOf(alice);
        // 5 bps base = 5.00, skew surcharge 10 bps * (10k / 1m skew scale) = 0.10
        uint256 fee = 5.1e6;
        assertEq(engine.quoteOpenFee(BTC, 10_000e6, true, type(uint256).max / 1e5), fee);

        vm.expectEmit(address(engine));
        emit PerpEngine.PositionOpened(key, alice, BTC, true, 1_000e6, 10_000e6, P100K, fee);
        assertEq(_open(alice, BTC, true, 1_000e6, 10_000e6), key);

        Position memory pos = engine.getPosition(alice, BTC);
        assertEq(pos.margin, 1_000e6);
        assertEq(pos.size, 10_000e6);
        assertEq(pos.entryPrice, P100K);
        assertTrue(pos.isLong);
        assertEq(pos.priceId, BTC);
        assertEq(pos.trader, alice);
        assertEq(pos.openedAt, vm.getBlockTimestamp());
        assertEq(pos.tpOrderId, 0);
        assertEq(pos.slOrderId, 0);
        assertEq(pos.closeOrderId, 0);
        assertEq(engine.getPositionByKey(key).margin, 1_000e6);

        assertEq(usdc.balanceOf(alice), aliceBefore - 1_000e6 - fee);
        assertEq(usdc.balanceOf(address(engine)), 1_000e6);
        assertEq(vault.totalHouseBalance(), LP_SEED + fee);
        assertEq(vault.totalFeesCollected(), fee);
        assertEq(_market(BTC).longOi, 10_000e6);
        assertEq(_market(BTC).shortOi, 0);
        // 10,000 USDC of notional at 100,000 is 0.1 BTC, tracked at 1e36 precision for mark-to-market.
        assertEq(_market(BTC).longUnits, 0.1e24);
        assertEq(_market(BTC).shortUnits, 0);
        assertEq(engine.totalOpenInterest(), 10_000e6);
        assertEq(engine.positionCount(), 1);
        _assertEngineSolvent();
    }

    function test_open_short() public {
        _open(alice, ETH, false, 2_000e6, 10_000e6);
        Position memory pos = engine.getPosition(alice, ETH);
        assertFalse(pos.isLong);
        assertEq(pos.entryPrice, 4_000e18);
        assertEq(_market(ETH).longOi, 0);
        assertEq(_market(ETH).shortOi, 10_000e6);
        assertEq(_market(ETH).shortUnits, 2.5e24);
    }

    function test_open_atOneTimesAndAtMaxLeverage() public {
        _open(alice, BTC, true, 1_000e6, 1_000e6);
        _open(bob, BTC, false, 1_000e6, 100_000e6);
        assertEq(engine.positionCount(), 2);
    }

    function test_openFee_skewSurchargeOnlyWhenSkewGrows() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        // Reducing the skew: base fee only.
        assertEq(engine.quoteOpenFee(BTC, 4_000e6, false, type(uint256).max / 1e5), 2e6);
        // Flipping the skew but leaving it smaller than before (10k long -> 8k short): base fee only.
        assertEq(engine.quoteOpenFee(BTC, 18_000e6, false, type(uint256).max / 1e5), 9e6);
        // Flipping it and making it larger (10k long -> 14k short): 12 base + 24k * 10bps * 14k / 1m.
        assertEq(engine.quoteOpenFee(BTC, 24_000e6, false, type(uint256).max / 1e5), 12e6 + 0.336e6);
        // Beyond the skew scale the ratio is taken against actual open interest.
        assertEq(engine.quoteOpenFee(ETH, 1_500_000e6, true, type(uint256).max / 1e5), 750e6 + 1_500e6);

        uint256 before = usdc.balanceOf(bob);
        _open(bob, BTC, false, 1_000e6, 4_000e6);
        assertEq(before - usdc.balanceOf(bob), 1_000e6 + 2e6);
    }

    function test_open_validations() public {
        OpenParams memory p = _params(bytes32(uint256(1)), true, 1_000e6, 10_000e6);
        vm.startPrank(alice);
        vm.expectRevert(PerpEngine.MarketNotFound.selector);
        engine.openPosition(p, _noBytes());

        p = _params(BTC, true, 5e6 - 1, 100e6);
        vm.expectRevert(PerpEngine.MarginTooLow.selector);
        engine.openPosition(p, _noBytes());

        p = _params(BTC, true, 1_000e6, 1_000e6 - 1); // below 1x
        vm.expectRevert(PerpEngine.LeverageOutOfRange.selector);
        engine.openPosition(p, _noBytes());

        p = _params(BTC, true, 1_000e6, 100_000e6 + 1); // above 100x
        vm.expectRevert(PerpEngine.LeverageOutOfRange.selector);
        engine.openPosition(p, _noBytes());

        p = _params(BTC, true, 1_000e6, 10_000e6);
        engine.openPosition(p, _noBytes());
        // The other side of an open position is refused; the same side adds to it (PositionManagement.t.sol).
        p.isLong = false;
        vm.expectRevert(PerpEngine.PositionExists.selector);
        engine.openPosition(p, _noBytes());
        vm.stopPrank();
    }

    function test_open_respectsPerMarketLeverageCap() public {
        vm.prank(owner);
        engine.setMarket(EUR, true, 20, MAX_OI_PER_SIDE, SKEW_SCALE);
        vm.startPrank(alice);
        vm.expectRevert(PerpEngine.LeverageOutOfRange.selector);
        engine.openPosition(_params(EUR, true, 1_000e6, 20_000e6 + 1), _noBytes());
        engine.openPosition(_params(EUR, true, 1_000e6, 20_000e6), _noBytes());
        vm.stopPrank();
    }

    function test_open_disabledMarketReverts() public {
        vm.prank(owner);
        engine.setMarket(BTC, false, 100, MAX_OI_PER_SIDE, SKEW_SCALE);
        vm.prank(alice);
        vm.expectRevert(PerpEngine.MarketDisabled.selector);
        engine.openPosition(_params(BTC, true, 1_000e6, 10_000e6), _noBytes());
    }

    function test_open_pausedReverts() public {
        vm.prank(owner);
        engine.pause();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        engine.openPosition(_params(BTC, true, 1_000e6, 10_000e6), _noBytes());
    }

    function test_open_marketOiCap() public {
        vm.prank(owner);
        engine.setMarket(BTC, true, 100, 50_000e6, SKEW_SCALE);
        _open(alice, BTC, true, 1_000e6, 50_000e6);
        vm.prank(bob);
        vm.expectRevert(PerpEngine.MarketOiCapExceeded.selector);
        engine.openPosition(_params(BTC, true, 1_000e6, 1_000e6), _noBytes());
        // The cap is per side.
        _open(bob, BTC, false, 1_000e6, 50_000e6);
        vm.prank(carol);
        vm.expectRevert(PerpEngine.MarketOiCapExceeded.selector);
        engine.openPosition(_params(BTC, false, 1_000e6, 1_000e6), _noBytes());
    }

    function test_open_vaultOiCap() public {
        // 3x of ~1m NAV across all markets.
        _open(alice, BTC, true, 200_000e6, 2_000_000e6);
        vm.prank(bob);
        vm.expectRevert(PerpEngine.VaultOiCapExceeded.selector);
        engine.openPosition(_params(ETH, false, 200_000e6, 1_100_000e6), _noBytes());
        _open(bob, ETH, false, 200_000e6, 1_000_000e6);
        assertEq(engine.totalOpenInterest(), 3_000_000e6);
    }

    function test_open_slippageGuard() public {
        _setPrice(BTC, 100_000e8, 50e8, -8); // ask 100,050 / bid 99,950
        OpenParams memory p = _params(BTC, true, 1_000e6, 10_000e6);
        p.acceptablePrice = 100_050e18 - 1;
        vm.prank(alice);
        vm.expectRevert(PerpEngine.SlippageExceeded.selector);
        engine.openPosition(p, _noBytes());
        p.acceptablePrice = 100_050e18;
        vm.prank(alice);
        engine.openPosition(p, _noBytes());
        assertEq(engine.getPosition(alice, BTC).entryPrice, 100_050e18);

        p = _params(BTC, false, 1_000e6, 10_000e6);
        p.acceptablePrice = 99_950e18 + 1;
        vm.prank(bob);
        vm.expectRevert(PerpEngine.SlippageExceeded.selector);
        engine.openPosition(p, _noBytes());
        p.acceptablePrice = 99_950e18;
        vm.prank(bob);
        engine.openPosition(p, _noBytes());
        assertEq(engine.getPosition(bob, BTC).entryPrice, 99_950e18);
    }

    // ───────────────────────────── Close ─────────────────────────────

    function test_close_longInProfit() public {
        _flatFees();
        bytes32 key = _open(alice, BTC, true, 1_000e6, 10_000e6);
        uint256 afterOpen = usdc.balanceOf(alice);
        _setBtc(101_000); // +1% on 10k = +100

        vm.expectEmit(address(engine));
        emit PerpEngine.PositionClosed(key, alice, BTC, 101_000e18, 100e6, 5e6, 1_095e6);
        _close(alice, BTC);

        assertEq(usdc.balanceOf(alice), afterOpen + 1_095e6);
        assertEq(vault.totalHouseBalance(), LP_SEED + 5e6 + 5e6 - 100e6);
        assertEq(vault.totalTraderProfits(), 100e6);
        assertEq(house.balanceOf(alice), 0);
        assertEq(engine.getPosition(alice, BTC).trader, address(0));
        assertEq(engine.positionCount(), 0);
        assertEq(engine.totalOpenInterest(), 0);
        assertEq(usdc.balanceOf(address(engine)), 0);
    }

    function test_close_longAtLoss_mintsRebate() public {
        _flatFees();
        bytes32 key = _open(alice, BTC, true, 1_000e6, 10_000e6);
        uint256 afterOpen = usdc.balanceOf(alice);
        _setBtc(99_500); // -0.5% on 10k = -50

        vm.expectEmit(address(engine));
        emit PerpEngine.PositionClosed(key, alice, BTC, 99_500e18, -50e6, 5e6, 945e6);
        _close(alice, BTC);

        assertEq(usdc.balanceOf(alice), afterOpen + 945e6);
        assertEq(vault.totalTraderLosses(), 50e6);
        assertEq(vault.totalHouseBalance(), LP_SEED + 5e6 + 50e6 + 5e6);
        assertEq(house.balanceOf(alice), 5_000e18); // 100 DRY per USDC lost
        _assertEngineSolvent();
    }

    function test_close_shortInProfit() public {
        _flatFees();
        _open(alice, BTC, false, 1_000e6, 10_000e6);
        uint256 afterOpen = usdc.balanceOf(alice);
        _setBtc(99_000);
        _close(alice, BTC);
        assertEq(usdc.balanceOf(alice), afterOpen + 1_000e6 + 100e6 - 5e6);
    }

    function test_close_shortAtLoss() public {
        _flatFees();
        _open(alice, BTC, false, 1_000e6, 10_000e6);
        uint256 afterOpen = usdc.balanceOf(alice);
        _setBtc(100_500);
        _close(alice, BTC);
        assertEq(usdc.balanceOf(alice), afterOpen + 1_000e6 - 50e6 - 5e6);
        assertEq(house.balanceOf(alice), 5_000e18);
    }

    function test_close_flat_paysOnlyTheFee() public {
        _flatFees();
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        uint256 afterOpen = usdc.balanceOf(alice);
        _setBtc(100_000);
        _close(alice, BTC);
        assertEq(usdc.balanceOf(alice), afterOpen + 995e6);
        assertEq(vault.totalTraderProfits(), 0);
        assertEq(vault.totalTraderLosses(), 0);
    }

    function test_close_withZeroFees() public {
        vm.prank(owner);
        engine.setFeeParams(0, 0, 0, EXEC_FEE);
        uint256 before = usdc.balanceOf(alice);
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        assertEq(usdc.balanceOf(alice), before - 1_000e6);
        _setBtc(101_000);
        _close(alice, BTC);
        assertEq(usdc.balanceOf(alice), before + 100e6);
        assertEq(vault.totalFeesCollected(), 0);
    }

    function test_close_roundsAgainstTheTrader() public {
        _flatFees();
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        _open(bob, BTC, false, 1_000e6, 10_000e6);
        // One Pyth tick up: 10k * 1e-8 / 1e5 = 0.001 micro-USDC. The long's gain floors to 0, the short's
        // loss ceils to 1.
        _setPrice(BTC, 100_000e8 + 1, 0, -8);
        (int256 longPnl,,,) = lens.getPositionState(engine.positionKey(alice, BTC), 100_000e18 + 1e10);
        (int256 shortPnl,,,) = lens.getPositionState(engine.positionKey(bob, BTC), 100_000e18 + 1e10);
        assertEq(longPnl, 0);
        assertEq(shortPnl, -1);
        _close(bob, BTC);
        assertEq(house.balanceOf(bob), 100e12);
    }

    function test_close_reverts() public {
        vm.prank(alice);
        vm.expectRevert(PerpEngine.PositionNotFound.selector);
        engine.closePosition(BTC, 0, 0, _noBytes());

        _flatFees();
        _open(alice, BTC, true, 1_000e6, 100_000e6);
        _setBtc(99_100); // -0.9% at 100x = 90% of margin
        vm.prank(alice);
        vm.expectRevert(PerpEngine.PositionLiquidatable.selector);
        engine.closePosition(BTC, 0, 0, _noBytes());
    }

    function test_close_slippageGuard() public {
        _flatFees();
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        _open(bob, BTC, false, 1_000e6, 10_000e6);
        _setPrice(BTC, 100_000e8, 50e8, -8); // bid 99,950 / ask 100,050

        vm.startPrank(alice);
        vm.expectRevert(PerpEngine.SlippageExceeded.selector);
        engine.closePosition(BTC, 0, 99_950e18 + 1, _noBytes());
        engine.closePosition(BTC, 0, 99_950e18, _noBytes());
        vm.stopPrank();

        vm.startPrank(bob);
        vm.expectRevert(PerpEngine.SlippageExceeded.selector);
        engine.closePosition(BTC, 0, 100_050e18 - 1, _noBytes());
        engine.closePosition(BTC, 0, 100_050e18, _noBytes());
        vm.stopPrank();
    }

    function test_close_lossBeyondMarginAtExecutionPrice_isCappedAtMargin() public {
        _flatFees();
        _open(alice, BTC, true, 100e6, 10_000e6); // 100x
        uint256 afterOpen = usdc.balanceOf(alice);
        // Mid -0.89% (loss 89, not liquidatable) but the bid is -1.05% (loss 105 > margin 100).
        _setPrice(BTC, 99_110e8, 160e8, -8);
        _close(alice, BTC);
        assertEq(usdc.balanceOf(alice), afterOpen);
        assertEq(vault.totalTraderLosses(), 100e6);
        assertEq(vault.totalFeesCollected(), 5e6); // the open fee only; nothing was left for a close fee
        assertEq(house.balanceOf(alice), 10_000e18);
        _assertEngineSolvent();
    }

    function test_close_feeIsCappedByWhatIsLeft() public {
        _flatFees();
        _open(alice, BTC, true, 100e6, 10_000e6);
        uint256 afterOpen = usdc.balanceOf(alice);
        // Bid is -0.97%: loss 97 leaves 3, less than the 5 close fee.
        _setPrice(BTC, 99_110e8, 80e8, -8);
        _close(alice, BTC);
        assertEq(usdc.balanceOf(alice), afterOpen);
        assertEq(vault.totalTraderLosses(), 97e6);
        assertEq(vault.totalFeesCollected(), 5e6 + 3e6);
    }

    function test_confidenceSpread_chargesBothLegs() public {
        _flatFees();
        _setPrice(BTC, 100_000e8, 50e8, -8);
        _open(alice, BTC, true, 1_000e6, 10_000e6); // enters at the ask, 100,050
        uint256 afterOpen = usdc.balanceOf(alice);
        _setPrice(BTC, 100_000e8, 50e8, -8);
        _close(alice, BTC); // exits at the bid, 99,950
        // loss = ceil(10,000 * 100 / 100,050) = 9.995003 USDC
        assertEq(usdc.balanceOf(alice), afterOpen + 1_000e6 - 9_995_003 - 5e6);
    }

    function test_closingWorksWhilePausedAndDisabled() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        vm.startPrank(owner);
        engine.pause();
        engine.setMarket(BTC, false, 100, MAX_OI_PER_SIDE, SKEW_SCALE);
        vm.stopPrank();
        _setBtc(100_000);
        _close(alice, BTC);
        assertEq(engine.positionCount(), 0);
    }

    // ───────────────────────────── Funding ─────────────────────────────

    function test_funding_heavySidePaysLightSideReceivesVaultKeepsDifference() public {
        vm.prank(owner);
        engine.setFeeParams(0, 0, 15_854_895_991, EXEC_FEE); // funding on, trading fees off
        assertEq(engine.fundingRate(BTC), 0);

        bytes32 aliceKey = _open(alice, BTC, true, 50_000e6, 500_000e6);
        // 500k skew over the 1m skew scale = 50% of the full-skew rate.
        int256 rate1 = int256(uint256(15_854_895_991) / 2);
        assertEq(engine.fundingRate(BTC), rate1);

        skip(1 days);
        int256 index1 = rate1 * 1 days;
        assertEq(engine.currentFundingIndex(BTC), index1);
        (, int256 owed,,) = lens.getPositionState(aliceKey, P100K);
        assertEq(owed, (500_000e6 * index1) / 1e18);
        assertApproxEqAbs(owed, 342.465753e6, 1e3); // 25% a year on 500k is ~342.47 a day

        // Bob takes the light side; the skew and the rate drop to 40%.
        _setBtc(100_000);
        bytes32 bobKey = _open(bob, BTC, false, 10_000e6, 100_000e6);
        int256 rate2 = int256(uint256(15_854_895_991) * 400_000 / 1_000_000);
        assertEq(engine.fundingRate(BTC), rate2);

        skip(1 days);
        _setBtc(100_000);
        (, int256 bobOwed,,) = lens.getPositionState(bobKey, P100K);
        (, int256 aliceOwed,,) = lens.getPositionState(aliceKey, P100K);
        assertLt(bobOwed, 0);
        assertEq(bobOwed, -((100_000e6 * (rate2 * (1 days + 1))) / 1e18)); // +1s from the price refresh
        assertGt(aliceOwed, -bobOwed);

        uint256 navBefore = vault.totalHouseBalance();
        uint256 bobBefore = usdc.balanceOf(bob);
        _close(bob, BTC);
        (, aliceOwed,,) = lens.getPositionState(aliceKey, P100K);
        uint256 aliceBefore = usdc.balanceOf(alice);
        _close(alice, BTC);

        uint256 bobReceived = usdc.balanceOf(bob) - bobBefore - 10_000e6;
        uint256 alicePaid = 50_000e6 - (usdc.balanceOf(alice) - aliceBefore);
        assertEq(alicePaid, uint256(aliceOwed));
        assertGt(alicePaid, bobReceived);
        assertEq(vault.totalHouseBalance(), navBefore + alicePaid - bobReceived);
        assertEq(house.balanceOf(alice), alicePaid * 100e12); // funding paid is a loss and earns the rebate
    }

    function test_funding_signFollowsSkew() public {
        _open(alice, BTC, false, 10_000e6, 300_000e6);
        assertLt(engine.fundingRate(BTC), 0);
        _open(bob, BTC, true, 10_000e6, 300_000e6);
        assertEq(engine.fundingRate(BTC), 0);
        skip(1 hours);
        // Balanced book: the index does not move.
        assertEq(engine.currentFundingIndex(BTC), _fundingIndex(BTC));
    }

    function test_funding_settlesAtOldRateWhenParamsChange() public {
        _open(alice, BTC, true, 50_000e6, 500_000e6);
        skip(1 days);
        int256 expected = engine.currentFundingIndex(BTC);
        vm.prank(owner);
        engine.setFeeParams(5, 10, 0, EXEC_FEE);
        assertEq(_fundingIndex(BTC), expected);
        skip(1 days);
        assertEq(engine.currentFundingIndex(BTC), expected);

        // Same for a change of skew scale.
        vm.prank(owner);
        engine.setFeeParams(5, 10, 15_854_895_991, EXEC_FEE);
        skip(1 days);
        expected = engine.currentFundingIndex(BTC);
        vm.prank(owner);
        engine.setMarket(BTC, true, 100, MAX_OI_PER_SIDE, 10 * SKEW_SCALE);
        assertEq(_fundingIndex(BTC), expected);
    }

    function _fundingIndex(bytes32 id) internal view returns (int256 index) {
        index = _market(id).fundingIndex;
    }

    // ───────────────────────────── Multi-market ─────────────────────────────

    function test_fxMarkets_eurAndInvertedJpy() public {
        _flatFees();
        _open(alice, EUR, true, 1_000e6, 50_000e6);
        _open(alice, JPY, true, 1_000e6, 50_000e6);
        assertEq(engine.getPosition(alice, EUR).entryPrice, 1.1e18);
        // USD/JPY 150 -> JPY/USD 0.00666..., rounded up because a buy executes at the ask.
        uint256 entry = uint256(1e36) / 150e18 + 1;
        assertEq(engine.getPosition(alice, JPY).entryPrice, entry);
        assertEq(lens.getTraderPositions(alice).length, 2);

        uint256 before = usdc.balanceOf(alice);
        // The yen strengthens: USD/JPY 150 -> 148.5, so JPY/USD rises ~1.0101% and the long gains.
        _setPrice(JPY, 148_500, 0, -3);
        _close(alice, JPY);
        uint256 exit = uint256(1e36) / 148.5e18; // a sell executes at the bid, rounded down
        uint256 profit = (50_000e6 * (exit - entry)) / entry;
        assertEq(usdc.balanceOf(alice), before + 1_000e6 - 25e6 + profit);
        assertApproxEqAbs(profit, 505.05e6, 0.01e6);

        before = usdc.balanceOf(alice);
        _setPrice(EUR, 109_450, 0, -5); // -0.5%
        _close(alice, EUR);
        assertEq(usdc.balanceOf(alice), before + 1_000e6 - 250e6 - 25e6);
    }

    // ───────────────────────────── Views ─────────────────────────────

    function test_views_positionsPagination() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        _open(bob, BTC, false, 1_000e6, 10_000e6);
        _open(bob, ETH, true, 1_000e6, 10_000e6);

        assertEq(lens.getPositions(0, 10).length, 3);
        assertEq(lens.getPositions(1, 1).length, 1);
        assertEq(lens.getPositions(2, 10).length, 1);
        assertEq(lens.getPositions(3, 10).length, 0);
        PositionView[] memory bobs = lens.getTraderPositions(bob);
        assertEq(bobs.length, 2);
        assertEq(bobs[0].key, engine.positionKey(bob, BTC));
        assertEq(bobs[1].position.priceId, ETH);
        assertEq(lens.getTraderPositions(carol).length, 0);
    }

    function test_views_positionStateAndLiquidationPrice() public {
        _flatFees();
        bytes32 longKey = _open(alice, BTC, true, 1_000e6, 10_000e6); // 10x
        bytes32 shortKey = _open(bob, BTC, false, 1_000e6, 10_000e6);

        // 90% of margin = 900 = 9% of notional.
        (int256 pnl, int256 owed, uint256 liq, bool liquidatable) = lens.getPositionState(longKey, 95_000e18);
        assertEq(pnl, -500e6);
        assertEq(owed, 0);
        assertEq(liq, 91_000e18);
        assertFalse(liquidatable);
        (,,, liquidatable) = lens.getPositionState(longKey, 91_000e18);
        assertTrue(liquidatable);
        (,,, liquidatable) = lens.getPositionState(longKey, 91_000e18 + 1e13);
        assertFalse(liquidatable);

        (pnl,, liq, liquidatable) = lens.getPositionState(shortKey, 95_000e18);
        assertEq(pnl, 500e6);
        assertEq(liq, 109_000e18);
        assertFalse(liquidatable);
        (,,, liquidatable) = lens.getPositionState(shortKey, 109_000e18);
        assertTrue(liquidatable);

        vm.expectRevert(EngineLens.PositionNotFound.selector);
        lens.getPositionState(bytes32(0), 1e18);
    }

    function test_views_unknownMarketReverts() public {
        vm.expectRevert(PerpEngine.MarketNotFound.selector);
        engine.quoteOpenFee(bytes32(0), 1e6, true, type(uint256).max / 1e5);
        vm.expectRevert(PerpEngine.MarketNotFound.selector);
        engine.fundingRate(bytes32(0));
        vm.expectRevert(PerpEngine.MarketNotFound.selector);
        engine.currentFundingIndex(bytes32(0));
        vm.expectRevert(PerpEngine.MarketNotFound.selector);
        engine.getPrice(bytes32(0));
    }

    // ───────────────────────────── Fuzz ─────────────────────────────

    /// @dev Round trip at any leverage and any exit price: the engine ends empty, the vault's books match its
    ///      balance, and trader + vault together neither gain nor lose a single unit.
    function testFuzz_roundTrip_conservesUsdc(uint256 margin, uint256 leverage, uint256 exitPrice, bool isLong) public {
        margin = bound(margin, 5e6, 20_000e6);
        leverage = bound(leverage, 1, 100);
        exitPrice = bound(exitPrice, 50_000e8, 200_000e8);

        uint256 total = usdc.balanceOf(alice) + usdc.balanceOf(address(vault));
        bytes32 key = _open(alice, BTC, isLong, margin, margin * leverage);
        _setPrice(BTC, int64(uint64(exitPrice)), 0, -8);

        (,,, bool liquidatable) = lens.getPositionState(key, exitPrice * 1e10);
        if (liquidatable) {
            vm.prank(alice); // self-liquidation keeps the keeper fee inside the two-party total
            _liquidate(alice);
        } else {
            _close(alice, BTC);
        }

        assertEq(usdc.balanceOf(address(engine)), 0);
        assertEq(engine.totalOpenInterest(), 0);
        assertEq(usdc.balanceOf(alice) + usdc.balanceOf(address(vault)), total);
        assertEq(usdc.balanceOf(address(vault)), vault.totalHouseBalance() + vault.pendingStakerYield());
    }

    /// @dev The reported liquidation price is the exact boundary of the liquidation check.
    function testFuzz_liquidationPrice_isTheBoundary(uint256 margin, uint256 leverage, bool isLong) public {
        _flatFees();
        margin = bound(margin, 5e6, 20_000e6);
        leverage = bound(leverage, 2, 100);
        bytes32 key = _open(alice, BTC, isLong, margin, margin * leverage);
        (,, uint256 liq,) = lens.getPositionState(key, P100K);

        (,,, bool atLiq) = lens.getPositionState(key, liq);
        assertTrue(atLiq, "not liquidatable at the liquidation price");
        // One part per million on the safe side of it the position is healthy.
        uint256 safe = isLong ? liq + liq / 1e6 : liq - liq / 1e6;
        (,,, bool pastLiq) = lens.getPositionState(key, safe);
        assertFalse(pastLiq, "liquidatable on the safe side of the liquidation price");
    }
}
