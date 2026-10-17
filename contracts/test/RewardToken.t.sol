// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {RewardToken} from "../src/RewardToken.sol";
import {IHouseVault} from "../src/interfaces/IHouseVault.sol";
import {Base} from "./Base.t.sol";

contract RewardTokenTest is Base {
    /// @dev Registers yield directly, as the vault would after setting it aside.
    function _notify(uint256 amount) internal {
        vm.prank(address(vault));
        house.notifyYield(amount);
    }

    function _mint(address to, uint256 usdcLost) internal {
        vm.prank(address(engine));
        house.mintLossRebate(to, usdcLost);
    }

    function _mintAndStake(address who, uint256 amount) internal {
        _stake(who, amount);
    }

    function test_metadata() public view {
        assertEq(house.name(), "Dry Powder");
        assertEq(house.symbol(), "DRY");
        assertEq(house.decimals(), 18);
        assertEq(house.engine(), address(engine));
        assertEq(address(house.vault()), address(vault));
        assertEq(house.REBATE_RATE(), 100);
        assertEq(house.streamPeriod(), STREAM);
        assertEq(house.yieldRate(), 0);
        assertEq(house.periodFinish(), 0);
        assertEq(house.lastUpdateTime(), 0);
    }

    function test_constructor_validation() public {
        vm.expectRevert(RewardToken.ZeroAddress.selector);
        new RewardToken(address(0), address(engine), STREAM);
        vm.expectRevert(RewardToken.ZeroAddress.selector);
        new RewardToken(address(vault), address(0), STREAM);
        vm.expectRevert(RewardToken.ZeroAmount.selector);
        new RewardToken(address(vault), address(engine), 0);
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

    function test_stake_and_unstake() public {
        _mint(alice, 10e6); // 1,000 DRY
        vm.startPrank(alice);
        vm.expectEmit(address(house));
        emit RewardToken.Staked(alice, 600e18);
        house.stake(600e18);
        assertEq(house.stakedBalance(alice), 600e18);
        assertEq(house.totalStaked(), 600e18);
        assertEq(house.balanceOf(alice), 400e18);
        assertEq(house.balanceOf(address(house)), 600e18);
        assertEq(house.lastUpdateTime(), vm.getBlockTimestamp());

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

    // ───────────────────────────── Streaming ─────────────────────────────

    function test_stream_accruesLinearlyOverTheStreamPeriod() public {
        _mintAndStake(alice, 1_000e18);
        uint256 start = vm.getBlockTimestamp();
        vm.expectEmit(address(house));
        emit RewardToken.YieldNotified(86_400e6, 1e6 * 1e18, start + STREAM);
        _notify(86_400e6); // one USDC a second for a day

        assertEq(house.yieldRate(), 1e6 * 1e18);
        assertEq(house.periodFinish(), start + STREAM);
        assertEq(house.lastUpdateTime(), start);
        assertEq(house.totalYieldNotified(), 86_400e6);
        assertEq(house.earned(alice), 0);

        skip(1);
        assertEq(house.earned(alice), 1e6);
        skip(3_599);
        assertEq(house.earned(alice), 3_600e6);
        skip(STREAM - 3_600);
        assertEq(house.earned(alice), 86_400e6);
        // Nothing accrues past the end of the stream.
        skip(30 days);
        assertEq(house.earned(alice), 86_400e6);
    }

    function test_stream_isSharedProRata() public {
        _mintAndStake(alice, 3_000e18);
        _mintAndStake(bob, 1_000e18);
        _notify(86_400e6);
        skip(STREAM / 2);
        assertEq(house.earned(alice), 32_400e6);
        assertEq(house.earned(bob), 10_800e6);
        skip(STREAM / 2);
        assertEq(house.earned(alice), 64_800e6);
        assertEq(house.earned(bob), 21_600e6);
    }

    function test_stream_lateStakerEarnsOnlyFromThenOn() public {
        _mintAndStake(alice, 1_000e18);
        _notify(86_400e6);
        skip(STREAM / 2);

        _mintAndStake(bob, 1_000e18);
        assertEq(house.earned(bob), 0);
        skip(STREAM / 2);

        assertEq(house.earned(alice), 43_200e6 + 21_600e6);
        assertEq(house.earned(bob), 21_600e6);
    }

    function test_stream_survivesUnstakeAndStopsAccruing() public {
        _mintAndStake(alice, 1_000e18);
        _mintAndStake(bob, 1_000e18);
        _notify(86_400e6);
        skip(STREAM / 2);

        vm.prank(alice);
        house.unstake(1_000e18);
        skip(STREAM / 2);

        assertEq(house.earned(alice), 21_600e6);
        assertEq(house.earned(bob), 21_600e6 + 43_200e6);
    }

    function test_stream_notifyMidStreamMergesTheLeftover() public {
        _mintAndStake(alice, 1_000e18);
        _notify(86_400e6);
        skip(STREAM / 4); // 21,600 streamed, 64,800 left

        uint256 t = vm.getBlockTimestamp();
        // 64,800 left + 108,000 new = 172,800 over a fresh day: two USDC a second.
        vm.expectEmit(address(house));
        emit RewardToken.YieldNotified(108_000e6, 2e6 * 1e18, t + STREAM);
        _notify(108_000e6);
        assertEq(house.earned(alice), 21_600e6);
        assertEq(house.periodFinish(), t + STREAM);

        skip(STREAM / 2);
        assertEq(house.earned(alice), 21_600e6 + 86_400e6);
        skip(STREAM);
        assertEq(house.earned(alice), 86_400e6 + 108_000e6);
        assertEq(house.totalYieldNotified(), 194_400e6);
    }

    function test_stream_notifyAfterTheStreamEnded_startsAFreshOne() public {
        _mintAndStake(alice, 1_000e18);
        _notify(86_400e6);
        skip(3 * STREAM);
        _notify(43_200e6);
        assertEq(house.yieldRate(), 0.5e6 * 1e18);
        skip(STREAM);
        assertEq(house.earned(alice), 86_400e6 + 43_200e6);
    }

    /// @dev Yield that streams while nobody is staked is not lost and not handed to whoever stakes next in
    ///      one lump: it is rolled into the next stream.
    function test_stream_nothingStakedForPartOfTheStream_rollsIntoTheNextNotify() public {
        _notify(86_400e6); // nobody is staked
        skip(STREAM / 4); // 21,600 streams to no one

        _mintAndStake(alice, 1_000e18);
        assertEq(house.earned(alice), 0);
        skip(STREAM); // the remaining three quarters reach alice
        assertEq(house.earned(alice), 64_800e6);

        // The orphaned quarter comes back with the next notification (here an empty one).
        _notify(0);
        assertEq(house.yieldRate(), 0.25e6 * 1e18);
        skip(STREAM);
        assertEq(house.earned(alice), 86_400e6);
        assertEq(house.totalYieldNotified(), 86_400e6);
    }

    function test_stream_everyoneUnstakesMidStream_remainderRollsOver() public {
        _mintAndStake(alice, 1_000e18);
        _notify(86_400e6);
        skip(STREAM / 4);
        vm.prank(alice);
        house.unstake(1_000e18);
        skip(STREAM / 4); // a quarter streams to no one

        vm.prank(alice);
        house.stake(1_000e18);
        skip(STREAM); // the second half reaches alice
        assertEq(house.earned(alice), 21_600e6 + 43_200e6);

        _notify(21_600e6); // + the orphaned quarter = 43,200 over a day
        assertEq(house.yieldRate(), 0.5e6 * 1e18);
        skip(STREAM);
        assertEq(house.earned(alice), 86_400e6 + 21_600e6);
    }

    /// @dev Staking immediately before a settlement and leaving immediately after earns nothing: the amount
    ///      is streamed from the settlement on, not credited to whoever is staked at that instant.
    function test_stream_jitStakeBeforeSettle_earnsNothing() public {
        _mintAndStake(bob, 1_000e18); // long-term staker
        _mint(carol, 990e6); // carol holds 99,000 idle DRY
        _feeIncome(576_000e6);
        skip(EPOCH);

        vm.startPrank(carol);
        house.stake(99_000e18);
        assertEq(vault.settleEpoch(), 86_400e6);
        assertEq(house.earned(carol), 0);
        vm.expectRevert(RewardToken.NothingToClaim.selector);
        house.claimYield();
        house.unstake(99_000e18);
        vm.stopPrank();

        skip(STREAM);
        assertEq(house.earned(carol), 0);
        assertEq(house.earned(bob), 86_400e6);

        // Had she stayed one second she would have earned one second of her pro-rata share: 0.99 USDC.
        _feeIncome(1_000_000e6);
        skip(EPOCH);
        vm.prank(carol);
        house.stake(99_000e18);
        vault.settleEpoch();
        uint256 rate = house.yieldRate();
        skip(1);
        assertApproxEqAbs(house.earned(carol), (rate * 99) / 100 / 1e18, 1);
        assertGt(house.earned(carol), 0);
    }

    function test_claimYield_paysUsdcFromVault() public {
        _mintAndStake(alice, 1_000e18);
        _feeIncome(576_000e6);
        skip(EPOCH);
        vault.settleEpoch();
        skip(STREAM / 2);

        uint256 before = usdc.balanceOf(alice);
        vm.expectEmit(address(house));
        emit RewardToken.YieldClaimed(alice, 43_200e6);
        vm.prank(alice);
        uint256 claimed = house.claimYield();

        assertEq(claimed, 43_200e6);
        assertEq(usdc.balanceOf(alice), before + 43_200e6);
        assertEq(house.earned(alice), 0);
        assertEq(house.totalYieldClaimed(), 43_200e6);
        assertEq(vault.pendingStakerYield(), 43_200e6);

        // The rest keeps streaming and can be claimed after unstaking.
        skip(STREAM);
        vm.startPrank(alice);
        house.unstake(1_000e18);
        assertEq(house.claimYield(), 43_200e6);
        vm.stopPrank();
        assertEq(vault.pendingStakerYield(), 0);
    }

    function test_claimYield_revertsWhenNothingToClaim() public {
        vm.prank(alice);
        vm.expectRevert(RewardToken.NothingToClaim.selector);
        house.claimYield();
    }

    // ───────────────────────────── Precision ─────────────────────────────

    function test_precision_dustYieldOverHugeStake() public {
        // 100bn DRY staked (1bn USDC of lifetime losses), 1 micro-USDC of yield per notification.
        _mintAndStake(alice, 100_000_000_000e18);
        for (uint256 i; i < 10; ++i) {
            _notify(1);
        }
        // The rate is floored to a whole number of 1e-18 micro-USDC per second, so a fraction of the last
        // micro-USDC is still unassigned at the end of the stream ...
        skip(STREAM);
        assertEq(house.earned(alice), 9);
        // ... and is carried into the next one rather than lost.
        _notify(0);
        skip(STREAM);
        assertEq(house.earned(alice), 9);
        _notify(1);
        skip(STREAM);
        assertEq(house.earned(alice), 10);
        assertEq(house.totalYieldNotified(), 11);
    }

    function test_precision_tinyStakeDoesNotOverflowLargeStaker() public {
        // A 1-wei sole staker inflates the accumulator as far as it can go.
        _mint(alice, 1e6);
        vm.prank(alice);
        house.stake(1);
        _notify(1_000_000_000e6);
        skip(STREAM);
        assertEq(house.earned(alice), 1_000_000_000e6 - 1);

        _mint(bob, 1_000_000_000e6);
        vm.prank(bob);
        house.stake(100_000_000_000e18);
        _notify(1_000e6);
        skip(STREAM);
        assertEq(house.earned(bob), 1_000e6 - 1);
        vm.prank(bob);
        house.unstake(100_000_000_000e18);
        assertEq(house.earned(bob), 1_000e6 - 1);
    }

    function test_precision_longStreamPeriodAndTinyAmount() public {
        // One micro-USDC over a year still streams out in full (the rate keeps 18 extra decimals).
        RewardToken t = new RewardToken(address(this), address(this), 365 days);
        t.mintLossRebate(alice, 1e6);
        vm.prank(alice);
        t.stake(100e18);
        t.notifyYield(2);
        skip(365 days / 2);
        assertEq(t.earned(alice), 0);
        skip(365 days / 2 + 1);
        assertEq(t.earned(alice), 1);
    }

    /// @dev However yield, stakes and time interleave, stakers can never claim more than was set aside for
    ///      them, and whatever was streamed while someone was staked is fully accounted for.
    function testFuzz_claims_neverExceedNotified(
        uint256[6] memory stakes,
        uint256[6] memory yields,
        uint256[6] memory waits
    ) public {
        address[3] memory who = [alice, bob, carol];
        uint256 notified;
        uint256 claimed;
        for (uint256 i; i < 6; ++i) {
            address staker = who[i % 3];
            uint256 usdcLost = bound(stakes[i], 1, 1_000_000e6);
            _mint(staker, usdcLost);
            uint256 amount = bound(stakes[i], 1, usdcLost * 100e12);
            vm.prank(staker);
            house.stake(amount);

            uint256 y = bound(yields[i], 0, 1_000_000e6);
            if (y != 0) {
                _notify(y);
                notified += y;
            }
            skip(bound(waits[i], 0, 2 * STREAM));
            if (i % 2 == 1) {
                uint256 staked = house.stakedBalance(staker);
                vm.prank(staker);
                house.unstake(bound(yields[i], 1, staked));
            }
            if (i % 3 == 2 && house.earned(staker) != 0) {
                // Only the ledger is under test here; the vault's side of the payment is stubbed out.
                vm.mockCall(address(vault), abi.encodeWithSelector(IHouseVault.payStakerYield.selector), "");
                vm.prank(staker);
                claimed += house.claimYield();
            }
            uint256 owed = house.earned(alice) + house.earned(bob) + house.earned(carol);
            assertLe(owed + claimed, notified, "stakers are owed more than was notified");
        }
        // Once every stream has run out, everything notified has been earned, bar rounding dust and whatever
        // streamed while nobody was staked (impossible here: someone is always staked).
        skip(STREAM);
        uint256 total = house.earned(alice) + house.earned(bob) + house.earned(carol) + claimed;
        assertLe(total, notified);
        assertGe(total + 40, notified, "more than rounding dust went missing");
    }
}
