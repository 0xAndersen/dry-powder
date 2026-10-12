// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";

import {HouseVault} from "../src/HouseVault.sol";
import {Base} from "./Base.t.sol";

contract HouseVaultTest is Base {
    function test_metadata() public view {
        assertEq(vault.name(), "Arc House USDC");
        assertEq(vault.symbol(), "rcUSDC");
        assertEq(vault.decimals(), 18);
        assertEq(vault.asset(), address(usdc));
        assertEq(vault.engine(), address(engine));
        assertEq(address(vault.rewardToken()), address(house));
        assertEq(vault.withdrawLockPeriod(), LOCK);
        assertEq(vault.deployedAt(), 1_760_000_000);
        assertEq(vault.STAKER_SHARE_BPS(), 1_500);
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(HouseVault.ZeroAddress.selector);
        new HouseVault(IERC20(address(usdc)), address(0), address(house), LOCK);
        vm.expectRevert(HouseVault.ZeroAddress.selector);
        new HouseVault(IERC20(address(usdc)), address(engine), address(0), LOCK);
    }

    function test_deposit_mints18DecimalSharesAtPar() public view {
        // 1 USDC (1e6) -> 1 rcUSDC (1e18)
        assertEq(vault.balanceOf(lp), LP_SEED * 1e12);
        assertEq(vault.totalAssets(), LP_SEED);
        assertEq(vault.totalHouseBalance(), LP_SEED);
        assertEq(vault.sharePrice(), 1e6);
        assertEq(vault.withdrawUnlockTime(lp), 1_760_000_000 + LOCK);
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
    }

    function test_donation_doesNotMoveSharePrice() public {
        usdc.mint(address(vault), 500_000e6);
        assertEq(vault.totalAssets(), LP_SEED);
        assertEq(vault.sharePrice(), 1e6);
    }

    function test_inflationAttack_isUneconomic() public {
        // Fresh vault: attacker seeds 1 wei, "donates" a fortune, victim deposits afterwards.
        HouseVault v = new HouseVault(IERC20(address(usdc)), address(engine), address(house), 0);
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
        vm.expectRevert(abi.encodeWithSelector(HouseVault.SharesLocked.selector, 1_760_000_000 + LOCK));
        vault.transfer(alice, 1e18);
        vm.stopPrank();
    }

    function test_lock_expires() public {
        skip(LOCK);
        assertEq(vault.maxWithdraw(lp), LP_SEED);
        assertEq(vault.maxRedeem(lp), LP_SEED * 1e12);

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
        assertEq(vault.withdrawUnlockTime(lp), block.timestamp + LOCK);
    }

    // ───────────────────────────── Open-interest reserve ─────────────────────────────

    function test_withdrawals_cannotBreachOpenInterestReserve() public {
        skip(LOCK);
        _refreshAll();
        // 1.5m of OI at a 3x cap reserves 500k of the 1m NAV (plus the open fee that just arrived).
        _open(alice, BTC, true, 150_000e6, 1_500_000e6);
        uint256 nav = vault.totalHouseBalance();
        assertEq(engine.reservedLiquidity(), 500_000e6);
        assertEq(vault.freeLiquidity(), nav - 500_000e6);
        assertEq(vault.maxWithdraw(lp), nav - 500_000e6);
        assertEq(vault.maxRedeem(lp), vault.convertToShares(nav - 500_000e6));

        vm.startPrank(lp);
        vm.expectRevert();
        vault.withdraw(nav - 500_000e6 + 1, lp, lp);
        vault.withdraw(nav - 500_000e6, lp, lp);
        vm.stopPrank();
        assertEq(vault.freeLiquidity(), 0);
        assertEq(vault.maxWithdraw(lp), 0);
    }

    function test_freeLiquidity_isZeroWhenReserveExceedsNav() public {
        _open(alice, BTC, true, 150_000e6, 1_500_000e6);
        // A large payout takes NAV below the reserve.
        vm.prank(address(engine));
        vault.payoutTraderProfit(bob, 800_000e6);
        assertLt(vault.totalHouseBalance(), engine.reservedLiquidity());
        assertEq(vault.freeLiquidity(), 0);
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

    function test_receiveTraderLoss_allToHouseWithoutStakers() public {
        usdc.mint(address(engine), 1_000e6);
        vm.expectEmit(address(vault));
        emit HouseVault.TraderLossReceived(alice, 1_000e6, 1_000e6, 0);
        vm.prank(address(engine));
        vault.receiveTraderLoss(alice, 1_000e6);

        assertEq(vault.totalHouseBalance(), LP_SEED + 1_000e6);
        assertEq(vault.pendingStakerYield(), 0);
        assertEq(vault.totalTraderLosses(), 1_000e6);
        assertEq(vault.totalStakerYieldAllocated(), 0);
    }

    function test_receiveTraderLoss_splits85_15WithStakers() public {
        _stake(bob, 1_000e18);
        usdc.mint(address(engine), 1_000e6);
        vm.expectEmit(address(vault));
        emit HouseVault.TraderLossReceived(alice, 1_000e6, 850e6, 150e6);
        vm.prank(address(engine));
        vault.receiveTraderLoss(alice, 1_000e6);

        assertEq(vault.totalHouseBalance(), LP_SEED + 850e6);
        assertEq(vault.pendingStakerYield(), 150e6);
        assertEq(vault.totalStakerYieldAllocated(), 150e6);
        assertEq(house.earned(bob), 150e6);
        // NAV per share rose by exactly the 85%.
        assertEq(vault.convertToAssets(vault.balanceOf(lp)), LP_SEED + 850e6 - 1);
    }

    function test_receiveFees_splitsLikeLosses() public {
        _stake(bob, 1_000e18);
        usdc.mint(address(engine), 200e6);
        vm.expectEmit(address(vault));
        emit HouseVault.FeesReceived(200e6, 170e6, 30e6);
        vm.prank(address(engine));
        vault.receiveFees(200e6);
        assertEq(vault.totalFeesCollected(), 200e6);
        assertEq(vault.totalHouseBalance(), LP_SEED + 170e6);
        assertEq(vault.pendingStakerYield(), 30e6);
    }

    function test_split_roundsStakerCutDown() public {
        _stake(bob, 1_000e18);
        usdc.mint(address(engine), 7);
        vm.prank(address(engine));
        vault.receiveFees(7); // 15% of 7 = 1.05 -> 1
        assertEq(vault.pendingStakerYield(), 1);
        assertEq(vault.totalHouseBalance(), LP_SEED + 6);
    }

    function test_payoutTraderProfit_paysFromHouseBalance() public {
        uint256 before = usdc.balanceOf(alice);
        vm.expectEmit(address(vault));
        emit HouseVault.TraderProfitPaid(alice, 400e6, 400e6);
        vm.prank(address(engine));
        uint256 paid = vault.payoutTraderProfit(alice, 400e6);
        assertEq(paid, 400e6);
        assertEq(usdc.balanceOf(alice), before + 400e6);
        assertEq(vault.totalHouseBalance(), LP_SEED - 400e6);
        assertEq(vault.totalTraderProfits(), 400e6);
        assertEq(vault.totalShortfall(), 0);
    }

    function test_payoutTraderProfit_recordsShortfallInsteadOfReverting() public {
        uint256 before = usdc.balanceOf(alice);
        vm.expectEmit(address(vault));
        emit HouseVault.PayoutShortfall(alice, 250e6);
        vm.prank(address(engine));
        uint256 paid = vault.payoutTraderProfit(alice, LP_SEED + 250e6);
        assertEq(paid, LP_SEED);
        assertEq(usdc.balanceOf(alice), before + LP_SEED);
        assertEq(vault.totalHouseBalance(), 0);
        assertEq(vault.totalShortfall(), 250e6);

        // With nothing left the next payout transfers nothing and still does not revert.
        vm.prank(address(engine));
        assertEq(vault.payoutTraderProfit(alice, 10e6), 0);
        assertEq(vault.totalShortfall(), 260e6);
    }

    function test_stakerYield_isNotPartOfNavAndIsPaidOnClaim() public {
        _stake(bob, 1_000e18);
        usdc.mint(address(engine), 1_000e6);
        vm.prank(address(engine));
        vault.receiveTraderLoss(alice, 1_000e6);

        uint256 before = usdc.balanceOf(bob);
        vm.expectEmit(address(vault));
        emit HouseVault.StakerYieldPaid(bob, 150e6);
        vm.prank(bob);
        house.claimYield();
        assertEq(usdc.balanceOf(bob), before + 150e6);
        assertEq(vault.pendingStakerYield(), 0);
        assertEq(vault.totalHouseBalance(), LP_SEED + 850e6);
    }

    // ───────────────────────────── Fuzz ─────────────────────────────

    /// @dev A depositor can never withdraw more than they put in when nothing else happened.
    function testFuzz_depositRedeemRoundTrip_neverProfits(uint256 assets, uint256 gain) public {
        assets = bound(assets, 1, 1_000_000e6);
        gain = bound(gain, 0, 10_000_000e6);
        // Arbitrary pre-existing share price.
        usdc.mint(address(engine), gain);
        vm.prank(address(engine));
        vault.receiveFees(gain);

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

    function testFuzz_split_conservesFunds(uint256 amount, bool withStakers) public {
        amount = bound(amount, 0, 1e15);
        if (withStakers) _stake(bob, 1e18);
        usdc.mint(address(engine), amount);
        vm.prank(address(engine));
        vault.receiveTraderLoss(alice, amount);
        uint256 toStakers = withStakers ? (amount * 1_500) / 10_000 : 0;
        assertEq(vault.pendingStakerYield(), toStakers);
        assertEq(vault.totalHouseBalance(), LP_SEED + amount - toStakers);
        assertEq(usdc.balanceOf(address(vault)), LP_SEED + amount);
    }
}
