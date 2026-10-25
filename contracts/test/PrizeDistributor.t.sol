// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Hashes} from "@openzeppelin/contracts/utils/cryptography/Hashes.sol";
import {PrizeDistributor} from "../src/PrizeDistributor.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

contract PrizeDistributorTest is Test {
    MockUSDC internal usdc;
    PrizeDistributor internal prizes;
    address internal owner = makeAddr("owner");
    address internal sponsor = makeAddr("sponsor");
    address[4] internal winners = [makeAddr("w0"), makeAddr("w1"), makeAddr("w2"), makeAddr("w3")];
    uint256[4] internal amounts = [uint256(500e6), 300e6, 150e6, 50e6];
    bytes32[4] internal leaves;
    bytes32 internal root;

    function setUp() public {
        vm.warp(1_760_000_000);
        usdc = new MockUSDC();
        prizes = new PrizeDistributor(IERC20(address(usdc)), owner);
        usdc.mint(sponsor, 10_000e6);
        vm.prank(sponsor);
        usdc.approve(address(prizes), type(uint256).max);
        for (uint256 i; i < 4; ++i) {
            leaves[i] = keccak256(bytes.concat(keccak256(abi.encode(winners[i], amounts[i]))));
        }
        root = Hashes.commutativeKeccak256(
            Hashes.commutativeKeccak256(leaves[0], leaves[1]), Hashes.commutativeKeccak256(leaves[2], leaves[3])
        );
    }

    function _proof(uint256 i) internal view returns (bytes32[] memory p) {
        p = new bytes32[](2);
        p[0] = leaves[i ^ 1];
        p[1] = i < 2
            ? Hashes.commutativeKeccak256(leaves[2], leaves[3])
            : Hashes.commutativeKeccak256(leaves[0], leaves[1]);
    }

    function _publish(uint256 season, uint256 funded) internal {
        vm.prank(sponsor);
        prizes.fund(season, funded);
        vm.prank(owner);
        prizes.publishResults(season, root, 1_000e6, uint64(block.timestamp + 7 days));
    }

    function test_fund_publish_claim() public {
        vm.expectEmit(address(prizes));
        emit PrizeDistributor.SeasonFunded(1, sponsor, 1_200e6);
        vm.prank(sponsor);
        prizes.fund(1, 1_200e6);
        assertEq(usdc.balanceOf(address(prizes)), 1_200e6);

        vm.prank(owner);
        prizes.publishResults(1, root, 1_000e6, uint64(block.timestamp + 7 days));
        (uint256 funded, uint256 allocated,, bytes32 r,,) = prizes.seasons(1);
        assertEq(funded, 1_200e6);
        assertEq(allocated, 1_000e6);
        assertEq(r, root);

        // Anyone may claim for a winner; the prize goes to the winner.
        assertTrue(prizes.canClaim(1, winners[0], 500e6, _proof(0)));
        vm.expectEmit(address(prizes));
        emit PrizeDistributor.PrizeClaimed(1, winners[0], 500e6);
        prizes.claim(1, winners[0], 500e6, _proof(0));
        assertEq(usdc.balanceOf(winners[0]), 500e6);
        assertFalse(prizes.canClaim(1, winners[0], 500e6, _proof(0)));
        vm.expectRevert(PrizeDistributor.AlreadyClaimed.selector);
        prizes.claim(1, winners[0], 500e6, _proof(0));

        // Wrong amount, wrong account, wrong proof.
        vm.expectRevert(PrizeDistributor.InvalidProof.selector);
        prizes.claim(1, winners[1], 301e6, _proof(1));
        vm.expectRevert(PrizeDistributor.InvalidProof.selector);
        prizes.claim(1, makeAddr("nobody"), 300e6, _proof(1));
        vm.expectRevert(PrizeDistributor.InvalidProof.selector);
        prizes.claim(1, winners[1], 300e6, _proof(2));
        prizes.claim(1, winners[3], 50e6, _proof(3));
        assertEq(usdc.balanceOf(winners[3]), 50e6);
    }

    function test_publishResults_validations() public {
        vm.prank(sponsor);
        prizes.fund(1, 999e6);
        vm.prank(sponsor);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, sponsor));
        prizes.publishResults(1, root, 999e6, uint64(block.timestamp + 1));
        vm.startPrank(owner);
        vm.expectRevert(PrizeDistributor.Underfunded.selector);
        prizes.publishResults(1, root, 1_000e6, uint64(block.timestamp + 1));
        vm.expectRevert(PrizeDistributor.InvalidParam.selector);
        prizes.publishResults(1, bytes32(0), 999e6, uint64(block.timestamp + 1));
        vm.expectRevert(PrizeDistributor.InvalidParam.selector);
        prizes.publishResults(1, root, 999e6, uint64(block.timestamp));
        prizes.publishResults(1, root, 999e6, uint64(block.timestamp + 1));
        vm.expectRevert(PrizeDistributor.ResultsAlreadyPublished.selector);
        prizes.publishResults(1, root, 999e6, uint64(block.timestamp + 1));
        vm.stopPrank();

        vm.expectRevert(PrizeDistributor.ResultsNotPublished.selector);
        prizes.claim(2, winners[0], 500e6, _proof(0));
        vm.expectRevert(PrizeDistributor.InvalidParam.selector);
        prizes.fund(1, 0);
    }

    /// After the deadline nothing more can be claimed, and what is left rolls over to another season.
    function test_closeSeason_rollsTheRemainderOver() public {
        _publish(1, 1_200e6);
        prizes.claim(1, winners[0], 500e6, _proof(0));

        vm.prank(owner);
        vm.expectRevert(PrizeDistributor.ClaimWindowOpen.selector);
        prizes.closeSeason(1, 2);

        skip(7 days + 1);
        vm.expectRevert(PrizeDistributor.ClaimWindowClosed.selector);
        prizes.claim(1, winners[1], 300e6, _proof(1));

        vm.expectEmit(address(prizes));
        emit PrizeDistributor.SeasonClosed(1, 700e6, 2);
        vm.prank(owner);
        prizes.closeSeason(1, 2);
        (uint256 funded2,,,,,) = prizes.seasons(2);
        assertEq(funded2, 700e6);
        assertEq(usdc.balanceOf(address(prizes)), 700e6);
        vm.prank(owner);
        vm.expectRevert(PrizeDistributor.InvalidParam.selector);
        prizes.closeSeason(1, 3);
        vm.prank(sponsor);
        vm.expectRevert(PrizeDistributor.InvalidParam.selector);
        prizes.fund(1, 1e6);

        // A season with no results can be called off at any time.
        vm.prank(sponsor);
        prizes.fund(5, 100e6);
        vm.prank(owner);
        prizes.closeSeason(5, 2);
        (funded2,,,,,) = prizes.seasons(2);
        assertEq(funded2, 800e6);
    }

    /// The contract always holds what its open seasons have left.
    function testFuzz_balanceCoversOpenSeasons(uint8 claims) public {
        _publish(1, 1_000e6);
        uint256 paid;
        for (uint256 i; i < 4; ++i) {
            if (claims & (1 << i) == 0) continue;
            prizes.claim(1, winners[i], amounts[i], _proof(i));
            paid += amounts[i];
        }
        (,, uint256 claimedTotal,,,) = prizes.seasons(1);
        assertEq(claimedTotal, paid);
        assertEq(usdc.balanceOf(address(prizes)), 1_000e6 - paid);
    }
}
