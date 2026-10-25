// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Base} from "./Base.t.sol";
import {AgentAccount, AgentAccountFactory} from "../src/AgentAccount.sol";
import {AgentRegistry} from "../src/AgentRegistry.sol";

contract AgentRegistryTest is Base {
    AgentAccountFactory internal factory;
    AgentRegistry internal registry;
    AgentAccount internal acct;
    address internal agentKey = makeAddr("agentKey");

    event AgentRegistered(
        address indexed account, address indexed owner, string name, string description, string kind, string uri
    );
    event AgentUpdated(address indexed account, string name, string description, string kind, string uri);
    event AgentUnregistered(address indexed account);

    function setUp() public override {
        super.setUp();
        factory = new AgentAccountFactory(IERC20(address(usdc)), engine);
        registry = new AgentRegistry(factory);
        acct = AgentAccount(factory.createAccount(alice));
        vm.prank(alice);
        acct.setAgent(agentKey, uint64(block.timestamp + 30 days), 20, 1_000e6);
    }

    function _register(AgentAccount a, address who, string memory name) internal {
        vm.prank(who);
        registry.register(a, name, "Follows the 4h trend on BTC.", "trend", "https://example.org/agent.json");
    }

    function test_theOwnerListsUpdatesAndUnlistsItsAccount() public {
        vm.expectEmit(true, true, false, true, address(registry));
        emit AgentRegistered(
            address(acct),
            alice,
            "Slow Trend",
            "Follows the 4h trend on BTC.",
            "trend",
            "https://example.org/agent.json"
        );
        _register(acct, alice, "Slow Trend");
        assertTrue(registry.isAgent(address(acct)));
        assertEq(registry.agentCount(), 1);
        AgentRegistry.Agent memory a = registry.getAgent(address(acct));
        assertEq(a.owner, alice);
        assertEq(a.name, "Slow Trend");
        assertEq(a.kind, "trend");
        assertEq(a.registeredAt, block.timestamp);

        skip(1 days);
        vm.expectEmit(true, false, false, true, address(registry));
        emit AgentUpdated(address(acct), "Fast Trend", "", "trend", "");
        vm.prank(alice);
        registry.update(acct, "Fast Trend", "", "trend", "");
        a = registry.getAgent(address(acct));
        assertEq(a.name, "Fast Trend");
        assertEq(a.uri, "");
        assertEq(a.updatedAt, block.timestamp);
        assertEq(a.registeredAt, block.timestamp - 1 days);

        vm.expectEmit(true, false, false, false, address(registry));
        emit AgentUnregistered(address(acct));
        vm.prank(alice);
        registry.unregister(acct);
        assertFalse(registry.isAgent(address(acct)));
        assertEq(registry.agentCount(), 0);
        assertEq(registry.getAgent(address(acct)).owner, address(0));
        // Listed again from scratch.
        _register(acct, alice, "Slow Trend");
        assertEq(registry.getAgent(address(acct)).registeredAt, block.timestamp);
    }

    function test_onlyTheOwnerOfAFactoryAccount() public {
        // Not its agent key, not anyone else.
        vm.prank(agentKey);
        vm.expectRevert(AgentRegistry.NotOwner.selector);
        registry.register(acct, "Mine", "", "trend", "");
        vm.prank(bob);
        vm.expectRevert(AgentRegistry.NotOwner.selector);
        registry.register(acct, "Mine", "", "trend", "");
        // Nor an account some other factory made, even by its owner.
        AgentAccountFactory other = new AgentAccountFactory(IERC20(address(usdc)), engine);
        AgentAccount foreign = AgentAccount(other.createAccount(bob));
        vm.prank(bob);
        vm.expectRevert(AgentRegistry.NotOwner.selector);
        registry.register(foreign, "Look-alike", "", "trend", "");

        _register(acct, alice, "Slow Trend");
        vm.prank(bob);
        vm.expectRevert(AgentRegistry.NotOwner.selector);
        registry.update(acct, "Hijacked", "", "trend", "");
        vm.prank(bob);
        vm.expectRevert(AgentRegistry.NotOwner.selector);
        registry.unregister(acct);
        vm.prank(alice);
        vm.expectRevert(AgentRegistry.AlreadyRegistered.selector);
        registry.register(acct, "Twice", "", "trend", "");

        AgentAccount b = AgentAccount(factory.createAccount(bob));
        vm.prank(bob);
        vm.expectRevert(AgentRegistry.NotRegistered.selector);
        registry.update(b, "Nothing", "", "trend", "");
        vm.prank(bob);
        vm.expectRevert(AgentRegistry.NotRegistered.selector);
        registry.unregister(b);
    }

    function test_lengthLimits() public {
        string memory name48 = "abcdefghijklmnopqrstuvwxyzabcdefghijklmnopqrstuv";
        assertEq(bytes(name48).length, 48);
        vm.startPrank(alice);
        vm.expectRevert(AgentRegistry.InvalidAgent.selector);
        registry.register(acct, "", "", "trend", "");
        vm.expectRevert(AgentRegistry.InvalidAgent.selector);
        registry.register(acct, string.concat(name48, "w"), "", "trend", "");
        vm.expectRevert(AgentRegistry.InvalidAgent.selector);
        registry.register(acct, "Name", "", "", "");
        vm.expectRevert(AgentRegistry.InvalidAgent.selector);
        registry.register(acct, "Name", "", "abcdefghijklmnopqrstuvwxyzabcdefg", "");
        vm.expectRevert(AgentRegistry.InvalidAgent.selector);
        registry.register(acct, "Name", string(new bytes(281)), "trend", "");
        vm.expectRevert(AgentRegistry.InvalidAgent.selector);
        registry.register(acct, "Name", "", "trend", string(new bytes(257)));
        registry.register(
            acct, name48, string(new bytes(280)), "abcdefghijklmnopqrstuvwxyzabcdef", string(new bytes(256))
        );
        vm.expectRevert(AgentRegistry.InvalidAgent.selector);
        registry.update(acct, string.concat(name48, "w"), "", "trend", "");
        vm.stopPrank();
        assertEq(registry.getAgent(address(acct)).name, name48);
    }

    function test_pages() public {
        AgentAccount b = AgentAccount(factory.createAccount(bob));
        AgentAccount c = AgentAccount(factory.createAccount(carol));
        _register(acct, alice, "A");
        _register(b, bob, "B");
        _register(c, carol, "C");
        (address[] memory accounts, AgentRegistry.Agent[] memory agents) = registry.getAgents(1, 10);
        assertEq(accounts.length, 2);
        assertEq(accounts[0], address(b));
        assertEq(agents[0].name, "B");
        assertEq(agents[1].owner, carol);
        (accounts,) = registry.getAgents(3, 10);
        assertEq(accounts.length, 0);
        (accounts,) = registry.getAgents(0, 1);
        assertEq(accounts.length, 1);
        assertEq(accounts[0], address(acct));
    }
}
