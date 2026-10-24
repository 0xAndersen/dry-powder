// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {HouseVault} from "../src/HouseVault.sol";
import {Base} from "./Base.t.sol";

contract HouseVaultTest is Base {
    uint256 internal constant SHARES = LP_SEED * 1e12; // the seed LP's shares
    uint256 internal constant OFFSET = 1e12; // virtual shares

    function test_metadata() public view {
        assertEq(vault.name(), "Dry Powder USDC");
        assertEq(vault.symbol(), "dpUSDC");
        assertEq(vault.decimals(), 18);
        assertEq(vault.asset(), address(usdc));
        assertEq(vault.engine(), address(engine));
        assertEq(address(vault.rewardToken()), address(house));
        assertEq(vault.withdrawLockPeriod(), LOCK);
        assertEq(vault.epochLength(), EPOCH);
        assertEq(vault.deployedAt(), T0);
        assertEq(vault.lastEpochTime(), T0);
        assertEq(vault.highWaterMark(), 1e18); // 1 USDC per whole share, at 1e30 per (asset unit / share unit)
        assertEq(vault.STAKER_SHARE_BPS(), 1_500);
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(HouseVault.ZeroAddress.selector);
        new HouseVault(IERC20(address(usdc)), address(0), address(house), LOCK, EPOCH);
        vm.expectRevert(HouseVault.ZeroAddress.selector);
        new HouseVault(IERC20(address(usdc)), address(engine), address(0), LOCK, EPOCH);
    }

    function test_deposit_mints18DecimalSharesAtPar() public view {
        // 1 USDC (1e6) -> 1 dpUSDC (1e18)
        assertEq(vault.balanceOf(lp), SHARES);
        assertEq(vault.totalAssets(), LP_SEED);
        assertEq(vault.totalHouseBalance(), LP_SEED);
        assertEq(vault.sharePrice(), 1e6);
        assertEq(vault.withdrawUnlockTime(lp), T0 + LOCK);
    }

    function test_mint_isEquivalentToDeposit() public {
        vm.prank(alice);
        uint256 assets = vault.mint(250e18, alice);
        assertEq(assets, 250e6);
        assertEq(vault.balanceOf(alice), 250e18);
        assertEq(vault.totalHouseBalance(), LP_SEED + 250e6);
    }

    function test_deposit_forThirdPartyReverts() public {
        vm.prank(alice);
        vm.expectRevert(HouseVault.ReceiverMustBeCaller.selector);
        vault.deposit(100e6, bob);
        vm.prank(alice);
        vm.expectRevert(HouseVault.ReceiverMustBeCaller.selector);
        vault.mint(100e18, bob);
    }

    function test_donation_doesNotMoveSharePrice() public {
        usdc.mint(address(vault), 500_000e6);
        assertEq(vault.totalAssets(), LP_SEED);
        assertEq(vault.sharePrice(), 1e6);
    }

    function test_inflationAttack_isUneconomic() public {
        // Fresh vault: attacker seeds 1 wei, "donates" a fortune, victim deposits afterwards.
        HouseVault v = new HouseVault(IERC20(address(usdc)), address(engine), address(house), 0, EPOCH);
        vm.startPrank(alice);
        usdc.approve(address(v), type(uint256).max);
        v.deposit(1, alice);
        usdc.transfer(address(v), 100_000e6);
        vm.stopPrank();

        vm.startPrank(bob);
        usdc.approve(address(v), type(uint256).max);
        uint256 shares = v.deposit(1_000e6, bob);
        vm.stopPrank();

        assertEq(shares, 1_000e18);
        assertEq(v.maxWithdraw(bob), 1_000e6);
        assertEq(v.maxWithdraw(alice), 1);
    }

    // ───────────────────────────── Lock ─────────────────────────────

    function test_lock_blocksWithdrawRedeemAndTransfer() public {
        assertEq(vault.maxWithdraw(lp), 0);
        assertEq(vault.maxRedeem(lp), 0);

        vm.startPrank(lp);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxWithdraw.selector, lp, 1e6, 0));
        vault.withdraw(1e6, lp, lp);
        vm.expectRevert(abi.encodeWithSelector(ERC4626.ERC4626ExceededMaxRedeem.selector, lp, 1e18, 0));
        vault.redeem(1e18, lp, lp);
        vm.expectRevert(abi.encodeWithSelector(HouseVault.SharesLocked.selector, T0 + LOCK));
        vault.transfer(alice, 1e18);
        vm.stopPrank();
    }

    function test_lock_expires() public {
        skip(LOCK);
        assertEq(vault.maxWithdraw(lp), LP_SEED);
        assertEq(vault.maxRedeem(lp), SHARES);

        vm.startPrank(lp);
        vault.transfer(alice, 10e18);
        vault.withdraw(100e6, lp, lp);
        vault.redeem(50e18, lp, lp);
        vm.stopPrank();

        assertEq(vault.balanceOf(alice), 10e18);
        assertEq(vault.totalHouseBalance(), LP_SEED - 150e6);
        // Shares received by transfer were already unlocked and stay that way.
        vm.prank(alice);
        vault.redeem(10e18, alice, alice);
        assertEq(vault.totalHouseBalance(), LP_SEED - 160e6);
    }

    function test_lock_isResetByANewDeposit() public {
        skip(LOCK);
        vm.prank(lp);
        vault.deposit(1e6, lp);
        assertEq(vault.maxWithdraw(lp), 0);
        assertEq(vault.maxRedeem(lp), 0);
        assertEq(vault.withdrawUnlockTime(lp), vm.getBlockTimestamp() + LOCK);
    }

    // ───────────────────────────── Net-skew reserve ─────────────────────────────

    function test_withdrawals_cannotBreachTheReserve() public {
        skip(LOCK);
        _refreshAll();
        // 1.5m of one-sided OI at a 3x cap reserves 500k of the 1m NAV (plus the open fee that just arrived).
        _open(alice, BTC, true, 150_000e6, 1_500_000e6);
        uint256 nav = vault.totalHouseBalance();
        assertEq(engine.reservedLiquidity(), 500_000e6);
        assertEq(vault.freeLiquidity(), nav - 500_000e6);
        assertEq(vault.maxWithdraw(lp), nav - 500_000e6);
        assertEq(vault.maxRedeem(lp), vault.previewWithdraw(nav - 500_000e6));

        vm.startPrank(lp);
        vm.expectRevert();
        vault.withdraw(nav - 500_000e6 + 1, lp, lp);
        vault.withdraw(nav - 500_000e6, lp, lp);
        vm.stopPrank();
        assertEq(vault.freeLiquidity(), 0);
        assertEq(vault.maxWithdraw(lp), 0);
        assertEq(vault.maxRedeem(lp), 0);
    }

    function test_reserve_isOnNetSkew_soMatchedOiLocksNothing() public {
        _flatFees();
        skip(LOCK);
        _refreshAll();
        _open(alice, BTC, true, 150_000e6, 1_500_000e6);
        _open(bob, BTC, false, 120_000e6, 1_200_000e6);
        uint256 nav = vault.totalHouseBalance();
        assertEq(nav, LP_SEED + 750e6 + 600e6);
        // 2.7m of gross open interest, 300k of skew: only 100k is reserved.
        assertEq(engine.totalOpenInterest(), 2_700_000e6);
        assertEq(engine.reservedLiquidity(), 100_000e6);
        assertEq(vault.maxWithdraw(lp), nav - 100_000e6);
        assertEq(vault.maxRedeem(lp), vault.previewWithdraw(nav - 100_000e6));

        // Redeeming the reported maximum takes out exactly the free liquidity.
        uint256 before = usdc.balanceOf(lp);
        vm.startPrank(lp);
        vault.redeem(vault.maxRedeem(lp), lp, lp);
        vm.stopPrank();
        assertEq(usdc.balanceOf(lp) - before, nav - 100_000e6);
        assertEq(vault.freeLiquidity(), 0);
    }

    function test_freeLiquidity_isZeroWhenReserveExceedsNav() public {
        _open(alice, BTC, true, 150_000e6, 1_500_000e6);
        // A large payout takes NAV below the reserve.
        vm.prank(address(engine));
        vault.payoutTraderProfit(bob, 800_000e6);
        assertLt(vault.totalHouseBalance(), engine.reservedLiquidity());
        assertEq(vault.freeLiquidity(), 0);
    }

    // ───────────────────────────── Mark-to-market share pricing ─────────────────────────────

    function test_valuation_noOpenPositions_allThreeValuesAreTheRealisedBalance() public {
        _feeIncome(123e6);
        assertEq(vault.markedValue(), LP_SEED + 123e6);
        assertEq(vault.exitValue(), LP_SEED + 123e6);
        assertEq(vault.entryValue(), LP_SEED + 123e6);
        assertEq(vault.totalAssets(), LP_SEED + 123e6);
    }

    /// @dev Traders sit on an unrealised loss: the vault is worth more than its realised balance, and a new
    ///      depositor must buy in at that higher (marked) value while withdrawals still use the realised one.
    function test_valuation_tradersLosing_depositBuysInAtMarkedValue() public {
        _flatFees();
        _open(alice, BTC, true, 10_000e6, 100_000e6);
        uint256 realised = LP_SEED + 50e6;
        _setBtc(95_000); // alice is 5,000 down, unrealised

        assertEq(engine.unrealizedTraderPnl(), -5_000e6);
        assertEq(vault.totalHouseBalance(), realised);
        assertEq(vault.markedValue(), realised + 5_000e6);
        assertEq(vault.entryValue(), realised + 5_000e6);
        assertEq(vault.exitValue(), realised);
        assertEq(vault.totalAssets(), realised);
        // sharePrice() is the exit side (rounded down past the dust owned by the virtual shares).
        assertEq(vault.sharePrice(), 1_000_049);

        uint256 expected = Math.mulDiv(100_505e6, SHARES + OFFSET, realised + 5_000e6 + 1);
        assertEq(vault.previewDeposit(100_505e6), expected);
        assertEq(vault.convertToShares(100_505e6), expected);
        // 100,505 buys 10% of the existing supply (to within the virtual-share dust), not the 10.05% it
        // would buy at the realised price.
        assertApproxEqAbs(expected, 0.1e24, 1e12);
        assertLt(expected, Math.mulDiv(100_505e6, SHARES + OFFSET, realised + 1));

        vm.prank(bob);
        assertEq(vault.deposit(100_505e6, bob), expected);
        assertEq(vault.balanceOf(bob), expected);
        assertEq(vault.totalHouseBalance(), realised + 100_505e6);

        // Minting is priced on the same side, rounded up.
        uint256 mintCost = Math.mulDiv(1e23, vault.entryValue() + 1, vault.totalSupply() + OFFSET, Math.Rounding.Ceil);
        assertEq(vault.previewMint(1e23), mintCost);
        vm.prank(carol);
        assertEq(vault.mint(1e23, carol), mintCost);
        assertApproxEqAbs(mintCost, 100_505e6, 2);

        // The loss is then realised (alice closes 5,000 down and pays a 50 fee). Bob and carol own 1/12 of
        // the vault each and paid for the 5,000 up front, so all they earn from it is their share of the fee.
        _setBtc(95_000);
        _close(alice, BTC);
        uint256 finalBalance = realised + 100_505e6 + mintCost + 5_000e6 + 50e6;
        assertEq(vault.totalHouseBalance(), finalBalance);
        assertEq(vault.exitValue(), finalBalance);
        assertEq(vault.entryValue(), finalBalance);
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(bob)), 100_505e6 + uint256(50e6) / 12, 2);
        // The incumbent LP kept the 5,000 that was economically his.
        assertApproxEqAbs(vault.convertToAssets(vault.balanceOf(lp)), realised + 5_000e6 + uint256(500e6) / 12, 2);
    }

    /// @dev Traders sit on an unrealised profit: the vault is worth less than its realised balance, and an LP
    ///      leaving now is paid at that lower (marked) value while deposits still use the realised one.
    function test_valuation_tradersWinning_withdrawExitsAtMarkedValue() public {
        _flatFees();
        _open(alice, BTC, true, 10_000e6, 100_000e6);
        uint256 realised = LP_SEED + 50e6;
        skip(LOCK);
        _setBtc(105_000); // alice is 5,000 up, unrealised

        assertEq(engine.unrealizedTraderPnl(), 5_000e6);
        assertEq(vault.markedValue(), realised - 5_000e6);
        assertEq(vault.exitValue(), realised - 5_000e6);
        assertEq(vault.entryValue(), realised);
        assertEq(vault.totalAssets(), 995_050e6);
        assertEq(vault.sharePrice(), 995_050);

        // 100k of one-sided OI reserves a third of itself.
        assertEq(engine.reservedLiquidity(), 33_333_333_334);
        assertEq(vault.freeLiquidity(), 995_050e6 - 33_333_333_334);
        assertEq(vault.maxWithdraw(lp), 995_050e6 - 33_333_333_334);

        assertEq(vault.previewRedeem(1e23), 99_505e6);
        assertEq(vault.convertToAssets(1e23), 99_505e6);
        uint256 before = usdc.balanceOf(lp);
        vm.prank(lp);
        assertEq(vault.redeem(1e23, lp, lp), 99_505e6); // 10% of the marked 995,050, not of the realised 1,000,050
        assertEq(usdc.balanceOf(lp), before + 99_505e6);
        assertEq(vault.totalHouseBalance(), realised - 99_505e6);

        // withdraw() is priced on the same side, rounded up in shares.
        uint256 sharesBurned =
            Math.mulDiv(1_000e6, vault.totalSupply() + OFFSET, vault.exitValue() + 1, Math.Rounding.Ceil);
        assertEq(vault.previewWithdraw(1_000e6), sharesBurned);
        vm.prank(lp);
        assertEq(vault.withdraw(1_000e6, lp, lp), sharesBurned);
        assertGt(sharesBurned, 1_000e18); // more than one share per USDC

        // A deposit meanwhile is priced at the realised value: no discount for the pending payout.
        uint256 supply = vault.totalSupply();
        uint256 depositShares = Math.mulDiv(50_000e6, supply + OFFSET, vault.totalHouseBalance() + 1);
        vm.prank(bob);
        assertEq(vault.deposit(50_000e6, bob), depositShares);
        assertLt(depositShares, Math.mulDiv(50_000e6, supply + OFFSET, vault.exitValue() - 50_000e6 + 1));
    }

    function test_valuation_markedValueIsFlooredAtZero() public {
        _flatFees();
        _open(alice, BTC, true, 200_000e6, 2_000_000e6);
        skip(LOCK);
        _setBtc(160_000); // +1.2m unrealised against ~1.001m of house balance
        assertEq(engine.unrealizedTraderPnl(), 1_200_000e6);
        assertEq(vault.markedValue(), 0);
        assertEq(vault.exitValue(), 0);
        assertEq(vault.totalAssets(), 0);
        assertEq(vault.entryValue(), LP_SEED + 1_000e6);
        assertEq(vault.sharePrice(), 0);
        assertEq(vault.freeLiquidity(), 0);
        assertEq(vault.maxWithdraw(lp), 0);
        assertEq(vault.maxRedeem(lp), 0);
    }

    /// @dev Depositing and immediately leaving at an unchanged price can never be profitable, whatever the
    ///      book looks like: entry is priced at the higher value and exit at the lower.
    function testFuzz_roundTrip_withOpenPositions_neverProfits(uint256 assets, uint256 btc, bool aliceLong) public {
        assets = bound(assets, 1, 1_000_000e6);
        btc = bound(btc, 91_000, 109_000);
        _open(alice, BTC, aliceLong, 50_000e6, 500_000e6);
        _open(bob, ETH, !aliceLong, 20_000e6, 200_000e6);
        _setBtc(btc);

        // The lock is waited out with the same price still on-chain: the vault values the book at the last
        // known price regardless of its age.
        uint256 before = usdc.balanceOf(carol);
        vm.startPrank(carol);
        uint256 shares = vault.deposit(assets, carol);
        skip(LOCK);
        uint256 out = vault.redeem(Math.min(shares, vault.maxRedeem(carol)), carol, carol);
        vm.stopPrank();
        if (vault.balanceOf(carol) == 0) assertLe(usdc.balanceOf(carol), before);
        assertLe(out, assets);
        assertLe(vault.exitValue(), vault.totalHouseBalance());
        assertGe(vault.entryValue(), vault.totalHouseBalance());
        _assertEngineSolvent();
    }

    // ───────────────────────────── Engine flows ─────────────────────────────

    function test_engineFlows_areAccessControlled() public {
        vm.startPrank(alice);
        vm.expectRevert(HouseVault.OnlyEngine.selector);
        vault.receiveTraderLoss(alice, 1e6);
        vm.expectRevert(HouseVault.OnlyEngine.selector);
        vault.receiveFees(1e6);
        vm.expectRevert(HouseVault.OnlyEngine.selector);
        vault.payoutTraderProfit(alice, 1e6);
        vm.expectRevert(HouseVault.OnlyRewardToken.selector);
        vault.payStakerYield(alice, 1e6);
        vm.stopPrank();
    }

    function test_receiveTraderLoss_goesToTheHouseInFull_withOrWithoutStakers() public {
        usdc.mint(address(engine), 2_000e6);
        vm.expectEmit(address(vault));
        emit HouseVault.TraderLossReceived(alice, 1_000e6);
        vm.prank(address(engine));
        vault.receiveTraderLoss(alice, 1_000e6);
        assertEq(vault.totalHouseBalance(), LP_SEED + 1_000e6);

        // v1 diverted 15% of every inflow to stakers as it arrived. v2 never does: stakers are paid from
        // settled epoch profit only.
        _stake(bob, 1_000e18);
        vm.prank(address(engine));
        vault.receiveTraderLoss(alice, 1_000e6);

        assertEq(vault.totalHouseBalance(), LP_SEED + 2_000e6);
        assertEq(vault.pendingStakerYield(), 0);
        assertEq(vault.totalTraderLosses(), 2_000e6);
        assertEq(vault.totalStakerYieldAllocated(), 0);
        assertEq(house.earned(bob), 0);
        assertEq(vault.convertToAssets(vault.balanceOf(lp)), LP_SEED + 2_000e6 - 1);
    }

    function test_receiveFees_goesToTheHouseInFull() public {
        _stake(bob, 1_000e18);
        usdc.mint(address(engine), 200e6);
        vm.expectEmit(address(vault));
        emit HouseVault.FeesReceived(200e6);
        vm.prank(address(engine));
        vault.receiveFees(200e6);
        assertEq(vault.totalFeesCollected(), 200e6);
        assertEq(vault.totalHouseBalance(), LP_SEED + 200e6);
        assertEq(vault.pendingStakerYield(), 0);
    }

    function test_payoutTraderProfit_paysTheEngineFromHouseBalance() public {
        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.expectEmit(address(vault));
        emit HouseVault.TraderProfitPaid(alice, 400e6, 400e6);
        vm.prank(address(engine));
        uint256 paid = vault.payoutTraderProfit(alice, 400e6);
        assertEq(paid, 400e6);
        // The engine receives it and forwards it to the trader together with the margin, in one payment.
        assertEq(usdc.balanceOf(address(engine)), 400e6);
        assertEq(usdc.balanceOf(alice), aliceBefore);
        assertEq(vault.totalHouseBalance(), LP_SEED - 400e6);
        assertEq(vault.totalTraderProfits(), 400e6);
        assertEq(vault.totalShortfall(), 0);
    }

    function test_payoutTraderProfit_recordsShortfallInsteadOfReverting() public {
        vm.expectEmit(address(vault));
        emit HouseVault.PayoutShortfall(alice, 250e6);
        vm.prank(address(engine));
        uint256 paid = vault.payoutTraderProfit(alice, LP_SEED + 250e6);
        assertEq(paid, LP_SEED);
        assertEq(usdc.balanceOf(address(engine)), LP_SEED);
        assertEq(vault.totalHouseBalance(), 0);
        assertEq(vault.totalShortfall(), 250e6);

        // With nothing left the next payout transfers nothing and still does not revert.
        vm.prank(address(engine));
        assertEq(vault.payoutTraderProfit(alice, 10e6), 0);
        assertEq(vault.totalShortfall(), 260e6);
        assertEq(vault.totalTraderProfits(), LP_SEED);
    }

    // ───────────────────────────── Epoch settlement ─────────────────────────────

    function test_settleEpoch_tooEarlyReverts() public {
        vm.expectRevert(abi.encodeWithSelector(HouseVault.EpochNotOver.selector, T0 + EPOCH));
        vault.settleEpoch();
        vm.warp(T0 + EPOCH - 1);
        vm.expectRevert(abi.encodeWithSelector(HouseVault.EpochNotOver.selector, T0 + EPOCH));
        vault.settleEpoch();
        vm.warp(T0 + EPOCH);
        vm.prank(carol); // anyone may call
        assertEq(vault.settleEpoch(), 0);
        assertEq(vault.lastEpochTime(), T0 + EPOCH);
        // The next one is measured from the settlement, not from a fixed calendar.
        vm.warp(T0 + EPOCH + 500);
        vm.expectRevert(abi.encodeWithSelector(HouseVault.EpochNotOver.selector, T0 + 2 * EPOCH));
        vault.settleEpoch();
    }

    function test_settleEpoch_withNoSharesDoesNothing() public {
        HouseVault v = new HouseVault(IERC20(address(usdc)), address(engine), address(house), LOCK, EPOCH);
        skip(EPOCH);
        vm.recordLogs();
        assertEq(v.settleEpoch(), 0);
        assertEq(vm.getRecordedLogs().length, 0);
        assertEq(v.lastEpochTime(), vm.getBlockTimestamp());
        assertEq(v.highWaterMark(), 1e18);
    }

    function test_settleEpoch_belowTheMarkPaysNothing() public {
        _stake(bob, 1_000e18);
        skip(EPOCH);
        // Flat: per-share value equals the mark exactly.
        vm.expectEmit(address(vault));
        emit HouseVault.EpochSettled(0, 0, 1e18);
        assertEq(vault.settleEpoch(), 0);

        // Below: the house paid out a winner.
        vm.prank(address(engine));
        vault.payoutTraderProfit(alice, 500e6);
        skip(EPOCH);
        vm.expectEmit(address(vault));
        emit HouseVault.EpochSettled(0, 0, 1e18);
        assertEq(vault.settleEpoch(), 0);
        assertEq(vault.highWaterMark(), 1e18); // the mark never moves down
        assertEq(vault.pendingStakerYield(), 0);
    }

    function test_settleEpoch_aboveTheMark_withoutStakers_houseKeepsEverything() public {
        _feeIncome(1_000e6);
        skip(EPOCH);
        vm.expectEmit(address(vault));
        emit HouseVault.EpochSettled(1_000e6, 0, 1.001e18);
        assertEq(vault.settleEpoch(), 0);
        assertEq(vault.highWaterMark(), 1.001e18);
        assertEq(vault.totalHouseBalance(), LP_SEED + 1_000e6);
        assertEq(vault.pendingStakerYield(), 0);
        assertEq(house.totalYieldNotified(), 0);

        // A staker who arrives afterwards cannot claim profit earned before the mark moved.
        _stake(bob, 1_000e18);
        skip(EPOCH);
        assertEq(vault.settleEpoch(), 0);
        assertEq(house.earned(bob), 0);
    }

    function test_settleEpoch_aboveTheMark_withStakers_exactlyFifteenPercent() public {
        _stake(bob, 1_000e18);
        _feeIncome(576_000e6);
        skip(EPOCH);

        // 15% of the 576,000 gain = 86,400, i.e. one USDC a second over the one-day stream.
        vm.expectEmit(address(vault));
        emit HouseVault.EpochSettled(576_000e6, 86_400e6, 1.4896e18);
        assertEq(vault.settleEpoch(), 86_400e6);

        assertEq(vault.totalHouseBalance(), LP_SEED + 489_600e6);
        assertEq(vault.pendingStakerYield(), 86_400e6);
        assertEq(vault.totalStakerYieldAllocated(), 86_400e6);
        assertEq(vault.highWaterMark(), 1.4896e18); // the mark is the per-share value AFTER the distribution
        assertEq(usdc.balanceOf(address(vault)), LP_SEED + 576_000e6);
        assertEq(house.totalYieldNotified(), 86_400e6);
        assertEq(house.yieldRate(), 1e6 * 1e18);
        assertEq(house.periodFinish(), vm.getBlockTimestamp() + STREAM);
        assertEq(house.earned(bob), 0); // streamed, not credited at once

        // Nothing changed by the next epoch: the value per share sits exactly on the mark, so nothing more
        // is taken (the 15% is not charged again on the 85% the house kept).
        skip(EPOCH);
        assertEq(vault.settleEpoch(), 0);
        assertEq(vault.pendingStakerYield(), 86_400e6);
        assertEq(house.earned(bob), 86_400e6);
    }

    function test_settleEpoch_roundsTheStakerShareDown() public {
        _stake(bob, 1_000e18);
        _feeIncome(7);
        skip(EPOCH);
        assertEq(vault.settleEpoch(), 1); // 15% of 7 = 1.05 -> 1
        assertEq(vault.pendingStakerYield(), 1);
        assertEq(vault.totalHouseBalance(), LP_SEED + 6);
    }

    function test_settleEpoch_lossesMustBeRecoveredFirst() public {
        _stake(bob, 1_000e18);
        _feeIncome(1_000e6);
        skip(EPOCH);
        assertEq(vault.settleEpoch(), 150e6);
        assertEq(vault.highWaterMark(), 1.00085e18);

        // The house loses 500, then earns 300: still under water, stakers get nothing.
        vm.prank(address(engine));
        vault.payoutTraderProfit(alice, 500e6);
        _feeIncome(300e6);
        skip(EPOCH);
        assertEq(vault.settleEpoch(), 0);
        assertEq(vault.highWaterMark(), 1.00085e18);

        // Another 400 takes it 200 above the old mark; only those 200 count.
        _feeIncome(400e6);
        skip(EPOCH);
        vm.expectEmit(address(vault));
        emit HouseVault.EpochSettled(200e6, 30e6, 1.00102e18);
        assertEq(vault.settleEpoch(), 30e6);
        assertEq(vault.totalStakerYieldAllocated(), 180e6);
        assertEq(vault.totalHouseBalance(), LP_SEED + 850e6 - 500e6 + 700e6 - 30e6);
    }

    function test_settleEpoch_isPerShare_soDepositsAndWithdrawalsAreNotProfit() public {
        _stake(bob, 1_000e18);
        vm.prank(carol);
        vault.deposit(500_000e6, carol);
        skip(EPOCH);
        assertEq(vault.settleEpoch(), 0); // +50% of assets, but no gain per share

        vm.prank(lp);
        vault.withdraw(900_000e6, lp, lp);
        _feeIncome(600e6); // +0.1% on the remaining 600k
        skip(EPOCH);
        assertEq(vault.settleEpoch(), 90e6); // 15% of 600
    }

    /// @dev Unrealised trader losses are not profit yet, and unrealised trader gains count against the house
    ///      at once: the epoch is settled on the exit (lower) value.
    function test_settleEpoch_usesTheConservativeValue() public {
        _flatFees();
        _stake(carol, 1_000e18);
        _open(alice, BTC, true, 10_000e6, 100_000e6); // 50 fee
        _setBtc(95_000); // alice 5,000 down, unrealised: marked is higher, exit is not
        skip(EPOCH);
        assertEq(vault.settleEpoch(), 7.5e6); // 15% of the 50 fee only
        uint256 mark = vault.highWaterMark();
        assertEq(mark, 1.0000425e18);

        _setBtc(103_000); // now 3,000 up, unrealised: exit value drops below the mark
        skip(EPOCH);
        assertEq(vault.settleEpoch(), 0);
        assertEq(vault.highWaterMark(), mark);
    }

    // ───────────────────────────── High-water mark and new shares ─────────────────────────────

    function _emptyTheVaultAfterAGain() internal {
        _stake(bob, 1_000e18);
        _feeIncome(500_000e6);
        skip(EPOCH);
        assertEq(vault.settleEpoch(), 75_000e6);
        assertEq(vault.highWaterMark(), 1.425e18);
    }

    /// @dev Found in review. When the last LP leaves, one unit of rounding dust stays behind and prices the
    ///      next shares at twice par. Against the old mark of 1.425 that looked like a 29% gain, and 43,125 of
    ///      a 1,000,000 deposit was paid to stakers at the next epoch.
    function test_deposit_intoAnEmptiedVault_isNotChargedAsProfit() public {
        _emptyTheVaultAfterAGain();
        vm.startPrank(lp);
        vault.redeem(vault.balanceOf(lp), lp, lp);
        vm.stopPrank();
        assertEq(vault.totalSupply(), 0);
        assertEq(vault.totalHouseBalance(), 1); // the dust

        vm.prank(carol);
        uint256 shares = vault.deposit(1_000_000e6, carol);
        assertEq(shares, 0.5e24); // priced at (1 + 1) / 1e12 per share unit
        assertEq(vault.highWaterMark(), 2e18); // her shares enter the mark at the price she paid
        skip(EPOCH);
        assertEq(vault.settleEpoch(), 0);
        assertEq(vault.convertToAssets(shares), 1_000_000e6);
        assertEq(vault.pendingStakerYield(), 75_000e6);
    }

    /// @dev The same with a single share unit left behind instead of none, which a `totalSupply() == 0` test
    ///      would miss.
    function test_deposit_intoAVaultHoldingOnlyDust_isNotChargedAsProfit() public {
        _emptyTheVaultAfterAGain();
        vm.startPrank(lp);
        vault.redeem(vault.balanceOf(lp) - 1, lp, lp);
        vm.stopPrank();
        assertEq(vault.totalSupply(), 1);

        vm.prank(carol);
        uint256 shares = vault.deposit(1_000_000e6, carol);
        skip(EPOCH);
        assertEq(vault.settleEpoch(), 0);
        assertEq(vault.convertToAssets(shares), 1_000_000e6);
    }

    /// @dev Income that arrives while nobody holds shares (LPs gone, hedged traders still paying fees) raises
    ///      the price of the next shares in the same way. Before the fix, 15% of the newcomer's deposit went
    ///      to stakers (150,015 here). Now only the orphaned income itself is treated as profit. (That income
    ///      stays with the vault's virtual shares, not with the newcomer, who still carries the 15 USDC staker
    ///      share on it: `settleEpoch` does not count the virtual shares. Bounded by 15% of the orphaned sum.)
    function test_deposit_afterIncomeWithNoShares_depositItselfIsNotProfit() public {
        _stake(bob, 1_000e18);
        skip(LOCK);
        vm.startPrank(lp);
        vault.redeem(vault.balanceOf(lp), lp, lp);
        vm.stopPrank();
        _feeIncome(100e6);
        assertEq(vault.totalSupply(), 0);

        vm.prank(carol);
        uint256 shares = vault.deposit(1_000_000e6, carol);
        skip(EPOCH);
        assertApproxEqAbs(vault.settleEpoch(), 15e6, 1);
        assertApproxEqAbs(vault.convertToAssets(shares), 1_000_000e6 - 15e6, 2_000);
    }

    /// @dev A deposit made after a gain but before the epoch is settled does not enlarge the profit: stakers
    ///      get 15% of what the house earned (15,000), not 15% of that gain re-counted on the new shares as
    ///      well (30,000 before the fix).
    function test_deposit_beforeSettlement_doesNotInflateTheProfit() public {
        _stake(bob, 1_000e18);
        _feeIncome(100_000e6);
        skip(EPOCH);

        usdc.mint(carol, 100_000e6);
        vm.prank(carol);
        uint256 shares = vault.deposit(1_100_000e6, carol);
        assertApproxEqAbs(shares, 1e24, 1e12);
        // Half the shares at the old mark of 1.0, half bought at 1.1.
        assertApproxEqAbs(vault.highWaterMark(), 1.05e18, 1e6);

        assertEq(vault.settleEpoch(), 15_000e6);
        assertApproxEqAbs(vault.highWaterMark(), 1.0925e18, 1e6);
    }

    function test_deposit_belowTheMark_leavesItAlone() public {
        _stake(bob, 1_000e18);
        _feeIncome(100_000e6);
        skip(EPOCH);
        vault.settleEpoch();
        uint256 mark = vault.highWaterMark();
        assertEq(mark, 1.085e18);

        vm.prank(address(engine));
        vault.payoutTraderProfit(alice, 200_000e6); // the house is now under water
        vm.prank(carol);
        vault.deposit(500_000e6, carol);
        assertEq(vault.highWaterMark(), mark);
        // At the mark exactly: also untouched.
        _feeIncome(vault.totalSupply() * mark / 1e30 - vault.totalHouseBalance());
        vm.prank(alice);
        vault.deposit(1e6, alice);
        assertApproxEqAbs(vault.highWaterMark(), mark, 1e6);
    }

    /// @dev Whatever the state of the vault, a deposit leaves the profit that the next settlement will find
    ///      unchanged (to within rounding): it neither creates profit nor hides it.
    function testFuzz_deposit_doesNotChangeTheProfitToSettle(uint256 gain, uint256 loss, uint256 assets, bool mintPath)
        public
    {
        gain = bound(gain, 0, 2_000_000e6);
        loss = bound(loss, 0, LP_SEED);
        assets = bound(assets, 1e6, 900_000e6);
        _stake(bob, 1e18);
        vm.prank(address(engine));
        vault.payoutTraderProfit(alice, loss);
        _feeIncome(gain);
        skip(EPOCH);

        uint256 snapshot = vm.snapshotState();
        uint256 without = vault.settleEpoch();
        vm.revertToState(snapshot);

        vm.startPrank(carol);
        if (mintPath) vault.mint(vault.previewDeposit(assets), carol);
        else vault.deposit(assets, carol);
        vm.stopPrank();
        uint256 with_ = vault.settleEpoch();
        assertApproxEqAbs(with_, without, 2);
        assertEq(usdc.balanceOf(address(vault)), vault.totalHouseBalance() + vault.pendingStakerYield());
    }

    function test_stakerYield_isNotPartOfNavAndIsPaidOnClaim() public {
        _stake(bob, 1_000e18);
        _feeIncome(576_000e6);
        skip(EPOCH);
        vault.settleEpoch();
        assertEq(vault.totalAssets(), LP_SEED + 489_600e6);
        skip(STREAM);

        uint256 before = usdc.balanceOf(bob);
        vm.expectEmit(address(vault));
        emit HouseVault.StakerYieldPaid(bob, 86_400e6);
        vm.prank(bob);
        house.claimYield();
        assertEq(usdc.balanceOf(bob), before + 86_400e6);
        assertEq(vault.pendingStakerYield(), 0);
        assertEq(vault.totalHouseBalance(), LP_SEED + 489_600e6);
        assertEq(usdc.balanceOf(address(vault)), LP_SEED + 489_600e6);
    }

    // ───────────────────────────── Fuzz ─────────────────────────────

    /// @dev A depositor can never withdraw more than they put in when nothing else happened.
    function testFuzz_depositRedeemRoundTrip_neverProfits(uint256 assets, uint256 gain) public {
        assets = bound(assets, 1, 1_000_000e6);
        gain = bound(gain, 0, 10_000_000e6);
        // Arbitrary pre-existing share price.
        _feeIncome(gain);

        uint256 before = usdc.balanceOf(alice);
        vm.startPrank(alice);
        uint256 shares = vault.deposit(assets, alice);
        skip(LOCK);
        vault.redeem(shares, alice, alice);
        vm.stopPrank();
        assertLe(usdc.balanceOf(alice), before);
        assertGe(usdc.balanceOf(alice) + 2, before, "round trip lost more than rounding dust");
        assertEq(usdc.balanceOf(address(vault)), vault.totalHouseBalance() + vault.pendingStakerYield());
    }

    function testFuzz_inflows_conserveFunds(uint256 amount, bool withStakers) public {
        amount = bound(amount, 0, 1e15);
        if (withStakers) _stake(bob, 1e18);
        usdc.mint(address(engine), amount);
        vm.prank(address(engine));
        vault.receiveTraderLoss(alice, amount);
        assertEq(vault.pendingStakerYield(), 0);
        assertEq(vault.totalHouseBalance(), LP_SEED + amount);
        assertEq(usdc.balanceOf(address(vault)), LP_SEED + amount);
    }

    /// @dev Whatever the gain, an epoch moves exactly 15% of it (rounded down) and leaves the books balanced.
    function testFuzz_settleEpoch_conservesFunds(uint256 gain, uint256 loss) public {
        gain = bound(gain, 0, 1e15);
        loss = bound(loss, 0, LP_SEED);
        _stake(bob, 1e18);
        vm.prank(address(engine));
        vault.payoutTraderProfit(alice, loss);
        _feeIncome(gain);
        skip(EPOCH);
        uint256 toStakers = vault.settleEpoch();

        uint256 profit = gain > loss ? gain - loss : 0;
        assertLe(toStakers, (profit * 1_500) / 10_000);
        assertGe(toStakers + 1, (profit * 1_500) / 10_000); // per-share rounding costs at most one unit
        assertEq(vault.pendingStakerYield(), toStakers);
        assertEq(vault.totalHouseBalance(), LP_SEED - loss + gain - toStakers);
        assertEq(usdc.balanceOf(address(vault)), vault.totalHouseBalance() + vault.pendingStakerYield());
        // Settling again right away (next epoch) takes nothing more.
        skip(EPOCH);
        assertEq(vault.settleEpoch(), 0);
    }
}
