// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RewardToken} from "../src/RewardToken.sol";
import {Base} from "./Base.t.sol";

contract RewardTokenTest is Base {
    /// @dev Registers yield directly, as the vault would.
    function _notify(uint256 amount) internal {
        vm.prank(address(vault));
        house.notifyYield(amount);
    }

    function _mint(address to, uint256 usdcLost) internal {
        vm.prank(address(engine));
        house.mintLossRebate(to, usdcLost);
    }

    function test_metadata() public view {
        assertEq(house.name(), "Arc House");
        assertEq(house.symbol(), "HOUSE");
        assertEq(house.decimals(), 18);
        assertEq(house.engine(), address(engine));
        assertEq(address(house.vault()), address(vault));
        assertEq(house.REBATE_RATE(), 100);
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(RewardToken.ZeroAddress.selector);
        new RewardToken(address(0), address(engine));
        vm.expectRevert(RewardToken.ZeroAddress.selector);
        new RewardToken(address(vault), address(0));
    }

    function test_mintLossRebate_onlyEngine() public {
        vm.prank(alice);
        vm.expectRevert(RewardToken.OnlyEngine.selector);
        house.mintLossRebate(alice, 1e6);
    }

    function test_mintLossRebate_mints100HousePerUsdc() public {
        vm.expectEmit(address(house));
        emit RewardToken.LossRebateMinted(alice, 1e6, 100e18);
        vm.prank(address(engine));
        uint256 minted = house.mintLossRebate(alice, 1e6);
        assertEq(minted, 100e18);
        assertEq(house.balanceOf(alice), 100e18);

        _mint(alice, 1); // one micro-USDC
        assertEq(house.balanceOf(alice), 100e18 + 100e12);
        assertEq(house.totalRebatesMinted(), 100e18 + 100e12);
        assertEq(house.totalSupply(), 100e18 + 100e12);
    }

    function test_notifyYield_onlyVault() public {
        vm.prank(alice);
        vm.expectRevert(RewardToken.OnlyVault.selector);
        house.notifyYield(1e6);
    }

    function test_notifyYield_revertsWithoutStakers() public {
        vm.prank(address(vault));
        vm.expectRevert(RewardToken.NoStakers.selector);
        house.notifyYield(1e6);
    }

    function test_stake_and_unstake() public {
        _mint(alice, 10e6); // 1,000 HOUSE
        vm.startPrank(alice);
        vm.expectEmit(address(house));
        emit RewardToken.Staked(alice, 600e18);
        house.stake(600e18);
        assertEq(house.stakedBalance(alice), 600e18);
        assertEq(house.totalStaked(), 600e18);
        assertEq(house.balanceOf(alice), 400e18);
        assertEq(house.balanceOf(address(house)), 600e18);

        vm.expectEmit(address(house));
        emit RewardToken.Unstaked(alice, 250e18);
        house.unstake(250e18);
        assertEq(house.stakedBalance(alice), 350e18);
        assertEq(house.totalStaked(), 350e18);
        assertEq(house.balanceOf(alice), 650e18);
        vm.stopPrank();
    }

    function test_stake_unstake_inputValidation() public {
        _mint(alice, 10e6);
        vm.startPrank(alice);
        vm.expectRevert(RewardToken.ZeroAmount.selector);
        house.stake(0);
        vm.expectRevert(RewardToken.ZeroAmount.selector);
        house.unstake(0);
        vm.expectRevert(RewardToken.InsufficientStake.selector);
        house.unstake(1);
        house.stake(100e18);
        vm.expectRevert(RewardToken.InsufficientStake.selector);
        house.unstake(100e18 + 1);
        vm.expectRevert(); // more than the wallet holds
        house.stake(901e18);
        vm.stopPrank();
    }

    function test_yield_isSharedProRata() public {
        _mint(alice, 30e6);
        _mint(bob, 10e6);
        vm.prank(alice);
        house.stake(3_000e18);
        vm.prank(bob);
        house.stake(1_000e18);

        _notify(400e6);
        assertEq(house.earned(alice), 300e6);
        assertEq(house.earned(bob), 100e6);
        assertEq(house.totalYieldNotified(), 400e6);
    }

    function test_yield_lateStakerEarnsOnlyFromThenOn() public {
        _mint(alice, 10e6);
        _mint(bob, 10e6);
        vm.prank(alice);
        house.stake(1_000e18);
        _notify(100e6);

        vm.prank(bob);
        house.stake(1_000e18);
        assertEq(house.earned(bob), 0);
        _notify(100e6);

        assertEq(house.earned(alice), 150e6);
        assertEq(house.earned(bob), 50e6);
    }

    function test_yield_survivesUnstakeAndStopsAccruing() public {
        _mint(alice, 10e6);
        _mint(bob, 10e6);
        vm.prank(alice);
        house.stake(1_000e18);
        vm.prank(bob);
        house.stake(1_000e18);
        _notify(100e6);

        vm.prank(alice);
        house.unstake(1_000e18);
        _notify(100e6);

        assertEq(house.earned(alice), 50e6);
        assertEq(house.earned(bob), 150e6);
    }

    function test_claimYield_paysUsdcFromVault() public {
        _mint(alice, 10e6);
        vm.prank(alice);
        house.stake(1_000e18);
        // 15% of an 800 USDC fee arriving at the vault.
        usdc.mint(address(engine), 800e6);
        vm.prank(address(engine));
        vault.receiveFees(800e6);

        uint256 before = usdc.balanceOf(alice);
        vm.expectEmit(address(house));
        emit RewardToken.YieldClaimed(alice, 120e6);
        vm.prank(alice);
        uint256 claimed = house.claimYield();

        assertEq(claimed, 120e6);
        assertEq(usdc.balanceOf(alice), before + 120e6);
        assertEq(house.earned(alice), 0);
        assertEq(house.totalYieldClaimed(), 120e6);
        assertEq(vault.pendingStakerYield(), 0);
    }

    function test_claimYield_revertsWhenNothingToClaim() public {
        vm.prank(alice);
        vm.expectRevert(RewardToken.NothingToClaim.selector);
        house.claimYield();
    }

    function test_stakedTokens_cannotBeDoubleCounted() public {
        _mint(alice, 10e6);
        vm.startPrank(alice);
        house.stake(1_000e18);
        // The staked balance left the wallet, so it cannot be transferred or staked again.
        vm.expectRevert();
        house.transfer(bob, 1);
        vm.expectRevert();
        house.stake(1);
        vm.stopPrank();
    }

    function test_precision_dustYieldOverHugeStake() public {
        // 100bn HOUSE staked (1bn USDC of lifetime losses), 1 micro-USDC of yield per notification.
        _mint(alice, 1_000_000_000e6);
        vm.prank(alice);
        house.stake(100_000_000_000e18);
        for (uint256 i; i < 10; ++i) {
            vm.prank(address(vault));
            house.notifyYield(1);
        }
        assertEq(house.earned(alice), 10);
    }

    function test_precision_tinyStakeDoesNotOverflowLargeStaker() public {
        // A 1-wei sole staker inflates the accumulator as far as it can go.
        _mint(alice, 1e6);
        vm.prank(alice);
        house.stake(1);
        _notify(1_000_000_000e6);
        assertEq(house.earned(alice), 1_000_000_000e6);

        _mint(bob, 1_000_000_000e6);
        vm.prank(bob);
        house.stake(100_000_000_000e18);
        _notify(1_000e6);
        assertEq(house.earned(bob), 1_000e6 - 1);
        vm.prank(bob);
        house.unstake(100_000_000_000e18);
    }

    /// @dev However yield and stakes interleave, stakers can never claim more than was set aside for them.
    function testFuzz_claims_neverExceedNotified(uint256[6] memory stakes, uint256[6] memory yields) public {
        address[3] memory who = [alice, bob, carol];
        uint256 notified;
        for (uint256 i; i < 6; ++i) {
            address staker = who[i % 3];
            uint256 usdcLost = bound(stakes[i], 1, 1_000_000e6);
            _mint(staker, usdcLost);
            uint256 amount = bound(stakes[i], 1, usdcLost * 100e12);
            vm.prank(staker);
            house.stake(amount);

            uint256 y = bound(yields[i], 0, 1_000_000e6);
            if (y != 0) {
                usdc.mint(address(vault), y);
                vm.prank(address(vault));
                house.notifyYield(y);
                notified += y;
            }
            if (i % 2 == 1) {
                uint256 staked = house.stakedBalance(staker);
                vm.prank(staker);
                house.unstake(bound(yields[i], 1, staked));
            }
        }
        uint256 totalEarned = house.earned(alice) + house.earned(bob) + house.earned(carol);
        assertLe(totalEarned, notified);
        // Rounding loss is at most one micro-USDC per staker per notification.
        assertGe(totalEarned + 18, notified);
    }
}
