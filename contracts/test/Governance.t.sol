// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Base} from "./Base.t.sol";
import {Governance} from "../script/Governance.s.sol";
import {PublisherOracle} from "../src/testnet/PublisherOracle.sol";
import {IEngine} from "../src/interfaces/IEngine.sol";

/// @dev The governance handover against the fixture's engine and a publisher oracle, with an address standing in
///      for the multisig (the timelock does not care what the proposer is).
contract GovernanceTest is Base {
    address internal safe = makeAddr("safe");
    PublisherOracle internal pubOracle;

    function setUp() public override {
        super.setUp();
        vm.prank(owner);
        engine.transferOwnership(DEFAULT_SENDER);
        vm.prank(DEFAULT_SENDER);
        engine.acceptOwnership();
        pubOracle = new PublisherOracle(DEFAULT_SENDER, DEFAULT_SENDER);
    }

    /// @dev Arguments rather than environment variables: tests run in parallel and the environment is shared.
    function _run() internal returns (TimelockController, address) {
        return new Governance().handOver(address(engine), address(pubOracle), safe, 3600);
    }

    function test_handsTheOwnerKeysToATimelockTheMultisigControls() public {
        (TimelockController timelock, address multisig) = _run();
        assertEq(multisig, safe);
        assertEq(engine.owner(), address(timelock));
        assertEq(engine.pendingOwner(), address(0));
        assertEq(pubOracle.owner(), address(timelock));
        assertEq(timelock.getMinDelay(), 3600);
        assertTrue(timelock.hasRole(timelock.PROPOSER_ROLE(), safe));
        assertTrue(timelock.hasRole(timelock.CANCELLER_ROLE(), safe));
        assertTrue(timelock.hasRole(timelock.EXECUTOR_ROLE(), address(0)));
        assertFalse(timelock.hasRole(timelock.PROPOSER_ROLE(), DEFAULT_SENDER));
        assertFalse(timelock.hasRole(timelock.CANCELLER_ROLE(), DEFAULT_SENDER));
        assertFalse(timelock.hasRole(timelock.DEFAULT_ADMIN_ROLE(), DEFAULT_SENDER));

        // The old owner can change nothing.
        vm.prank(DEFAULT_SENDER);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, DEFAULT_SENDER));
        engine.setFeeParams(10, 10, 0, EXEC_FEE);

        // A change is proposed by the multisig, waits out the delay in public, then anyone may execute it.
        bytes memory call = abi.encodeCall(IEngine.setFeeParams, (10, 10, 0, EXEC_FEE));
        vm.prank(safe);
        timelock.schedule(address(engine), 0, call, bytes32(0), bytes32(0), 3600);
        vm.expectRevert();
        timelock.execute(address(engine), 0, call, bytes32(0), bytes32(0));
        skip(3600);
        vm.prank(alice);
        timelock.execute(address(engine), 0, call, bytes32(0), bytes32(0));
        assertEq(engine.baseFeeBps(), 10);

        // Nobody but the multisig may propose.
        vm.prank(alice);
        vm.expectRevert();
        timelock.schedule(address(engine), 0, call, bytes32(0), bytes32(uint256(1)), 3600);
    }

    function test_refusesWhenTheBroadcasterIsNotTheOwner() public {
        vm.prank(DEFAULT_SENDER);
        engine.transferOwnership(alice);
        vm.prank(alice);
        engine.acceptOwnership();
        Governance script = new Governance();
        vm.expectRevert(bytes("Governance: the broadcaster does not own the engine"));
        script.handOver(address(engine), address(pubOracle), safe, 3600);
    }
}
