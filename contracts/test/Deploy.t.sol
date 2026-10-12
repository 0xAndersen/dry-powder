// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";

import {Deploy} from "../script/Deploy.s.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev Runs the real deployment script against mocks etched at the Arc Testnet addresses it defaults to.
contract DeployTest is Test {
    address internal constant ARC_USDC = 0x3600000000000000000000000000000000000000;
    address internal constant ARC_TESTNET_PYTH = 0x2880aB155794e7179c9eE2e38200202908C17B43;

    function test_deployScript_defaultsThenOwnerOverride() public {
        vm.etch(ARC_USDC, address(new MockUSDC()).code);
        vm.etch(ARC_TESTNET_PYTH, address(new MockPyth(60, 1)).code);

        Deploy script = new Deploy();
        Deploy.Deployment memory d = script.run();

        assertEq(d.vault.asset(), ARC_USDC);
        assertEq(d.vault.engine(), address(d.engine));
        assertEq(address(d.vault.rewardToken()), address(d.rewardToken));
        assertEq(d.vault.withdrawLockPeriod(), 1 hours);
        assertEq(address(d.rewardToken.vault()), address(d.vault));
        assertEq(d.rewardToken.engine(), address(d.engine));
        assertEq(address(d.engine.usdc()), ARC_USDC);
        assertEq(address(d.engine.pyth()), ARC_TESTNET_PYTH);
        assertEq(address(d.engine.vault()), address(d.vault));
        assertEq(address(d.engine.rewardToken()), address(d.rewardToken));
        assertEq(d.engine.owner(), DEFAULT_SENDER);
        assertEq(d.engine.pendingOwner(), address(0));

        assertEq(d.engine.maxPriceAge(), 10);
        assertEq(d.engine.maxConfBps(), 50);
        assertEq(d.engine.maxOiToNavBps(), 30_000);
        assertEq(d.engine.minMargin(), 5e6);

        bytes32[] memory ids = d.engine.getMarketIds();
        assertEq(ids.length, 4);
        for (uint256 i; i < 4; ++i) {
            (bool enabled, bool invert, uint16 maxLeverage,,,,,,) = d.engine.markets(ids[i]);
            assertTrue(enabled);
            assertEq(maxLeverage, 100);
            assertEq(invert, i == 3); // only the JPY market is inverted
        }

        string memory json = vm.readFile(string.concat("./deployments/", vm.toString(block.chainid), ".json"));
        assertEq(vm.parseJsonAddress(json, ".perpEngine"), address(d.engine));
        assertEq(vm.parseJsonAddress(json, ".houseVault"), address(d.vault));
        assertEq(vm.parseJsonAddress(json, ".rewardToken"), address(d.rewardToken));

        // Off Arc Testnet the script refuses to fall back to the testnet oracle address.
        vm.chainId(1);
        vm.expectRevert("Deploy: set PYTH_ADDRESS");
        script.run();
        vm.chainId(31337);

        // With OWNER_ADDRESS set, ownership is offered to it and the lock period override applies.
        address multisig = makeAddr("multisig");
        vm.setEnv("OWNER_ADDRESS", vm.toString(multisig));
        vm.setEnv("WITHDRAW_LOCK_SECONDS", "86400");
        d = script.run();
        vm.setEnv("OWNER_ADDRESS", vm.toString(DEFAULT_SENDER));
        vm.setEnv("WITHDRAW_LOCK_SECONDS", "3600");
        assertEq(d.engine.owner(), DEFAULT_SENDER);
        assertEq(d.engine.pendingOwner(), multisig);
        assertEq(d.vault.withdrawLockPeriod(), 1 days);
    }
}
