// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Base} from "./Base.t.sol";
import {AgentAccount, AgentAccountFactory} from "../src/AgentAccount.sol";
import {TrailingStops} from "../src/TrailingStops.sol";
import {Order, OrderType, Position} from "../src/Types.sol";

contract TrailingStopsTest is Base {
    AgentAccountFactory internal factory;
    TrailingStops internal trails;
    AgentAccount internal acct;
    address internal agentKey = makeAddr("agentKey");
    address internal stranger = makeAddr("stranger");

    event StopTrailed(address indexed account, bytes32 indexed marketId, uint256 best, uint256 stop);
    event TrailRefused(address indexed account, bytes32 indexed marketId, uint256 stop);
    event TrailCleared(address indexed account, bytes32 indexed marketId);

    function setUp() public override {
        super.setUp();
        factory = new AgentAccountFactory(IERC20(address(usdc)), engine);
        trails = new TrailingStops(engine, factory);
        acct = _account(alice, true);
        // A 10x long of 5,000 at 100,000.
        vm.prank(agentKey);
        acct.openPosition(_params(BTC, true, 500e6, 5_000e6), _noBytes());
        _setBtc(100_000);
    }

    /// @dev An account for `who` with 10,000 of collateral, the agent key approved, and (if `approveTrails`) this
    ///      suite's TrailingStops approved with the smallest policy an account allows.
    function _account(address who, bool approveTrails) internal returns (AgentAccount a) {
        a = AgentAccount(factory.createAccount(who));
        vm.startPrank(who);
        usdc.transfer(address(a), 10_000e6);
        a.setAgent(agentKey, uint64(block.timestamp + 30 days), 20, 1_000e6);
        if (approveTrails) a.setAgent(address(trails), type(uint64).max, 1, 1);
        vm.stopPrank();
    }

    function _poke(address account) internal {
        address[] memory accounts = new address[](1);
        bytes32[] memory markets = new bytes32[](1);
        accounts[0] = account;
        markets[0] = BTC;
        trails.poke(accounts, markets);
    }

    function _stop(address account) internal view returns (Order memory) {
        Position memory p = engine.getPosition(account, BTC);
        return engine.getOrder(p.slOrderId);
    }

    function test_long_stopFollowsTheHighAndNeverLoosens() public {
        vm.prank(agentKey);
        trails.setTrail(acct, BTC, 200, 0, 0); // 2%
        assertEq(trails.pending(address(acct), BTC), 98_000e18);

        vm.expectEmit(address(trails));
        emit StopTrailed(address(acct), BTC, 100_000e18, 98_000e18);
        _poke(address(acct));
        assertEq(_stop(address(acct)).triggerPrice, 98_000e18, "first stop: 2% under the mid");
        assertEq(_stop(address(acct)).size, 0, "closes the whole position");

        _setBtc(105_000);
        _poke(address(acct));
        assertEq(_stop(address(acct)).triggerPrice, 102_900e18, "follows the new high");

        _setBtc(103_500);
        assertEq(trails.pending(address(acct), BTC), 0, "nothing to move");
        _poke(address(acct));
        assertEq(_stop(address(acct)).triggerPrice, 102_900e18, "a pull-back does not loosen it");
        assertEq(trails.getTrail(address(acct), BTC).best, 105_000e18);

        // The pull-back reaches the stop: an ordinary keeper executes it, at a profit.
        _setBtc(102_800);
        uint256 before = usdc.balanceOf(address(acct));
        _exec(engine.getPosition(address(acct), BTC).slOrderId);
        assertEq(engine.getPosition(address(acct), BTC).trader, address(0), "closed by the trailed stop");
        assertGt(usdc.balanceOf(address(acct)), before + 500e6, "margin back plus the profit locked in");

        // The trail ends with its position.
        vm.expectEmit(address(trails));
        emit TrailCleared(address(acct), BTC);
        _poke(address(acct));
        assertEq(trails.trailCount(), 0);
    }

    function test_short_stopFollowsTheLow() public {
        AgentAccount b = _account(bob, true);
        vm.prank(agentKey);
        b.openPosition(_params(BTC, false, 500e6, 5_000e6), _noBytes());
        _setBtc(100_000);
        vm.prank(bob);
        trails.setTrail(b, BTC, 100, 0, 0); // 1%
        _poke(address(b));
        assertEq(_stop(address(b)).triggerPrice, 101_000e18);
        _setBtc(96_000);
        _poke(address(b));
        assertEq(_stop(address(b)).triggerPrice, 96_960e18);
        _setBtc(98_000);
        _poke(address(b));
        assertEq(_stop(address(b)).triggerPrice, 96_960e18, "never loosened upwards");
    }

    function test_activation_waitsForThePrice() public {
        vm.prank(alice);
        trails.setTrail(acct, BTC, 200, 0, 103_000e18);
        _poke(address(acct));
        assertEq(engine.getPosition(address(acct), BTC).slOrderId, 0, "not active below the activation price");
        assertEq(trails.getTrail(address(acct), BTC).best, 0);
        _setBtc(103_500);
        _poke(address(acct));
        assertEq(_stop(address(acct)).triggerPrice, 101_430e18, "starts trailing from the first mid at or above it");
    }

    function test_sizedTrail_closesThatMuch() public {
        vm.prank(agentKey);
        trails.setTrail(acct, BTC, 300, 2_500e6, 0);
        _poke(address(acct));
        assertEq(_stop(address(acct)).size, 2_500e6);
    }

    function test_aTighterStopInPlaceIsKept() public {
        vm.prank(agentKey);
        acct.setTriggerOrder(BTC, OrderType.StopLoss, 99_500e18, 0);
        vm.prank(agentKey);
        trails.setTrail(acct, BTC, 200, 0, 0);
        assertEq(trails.pending(address(acct), BTC), 0);
        _poke(address(acct));
        assertEq(_stop(address(acct)).triggerPrice, 99_500e18, "98,000 would loosen it");
        _setBtc(102_000);
        _poke(address(acct));
        assertEq(_stop(address(acct)).triggerPrice, 99_960e18, "moves once the trail is tighter");
    }

    function test_onlyTheOwnerOrAnAgent_andOnlyFactoryAccounts() public {
        vm.prank(stranger);
        vm.expectRevert(TrailingStops.NotAllowed.selector);
        trails.setTrail(acct, BTC, 200, 0, 0);

        // A contract that claims alice as its owner is not her account.
        FakeAccount fake = new FakeAccount(alice);
        vm.prank(alice);
        vm.expectRevert(TrailingStops.NotAllowed.selector);
        trails.setTrail(AgentAccount(address(fake)), BTC, 200, 0, 0);

        vm.prank(alice);
        vm.expectRevert(TrailingStops.InvalidDistance.selector);
        trails.setTrail(acct, BTC, 5, 0, 0);
        vm.prank(alice);
        vm.expectRevert(TrailingStops.NoPosition.selector);
        trails.setTrail(acct, ETH, 200, 0, 0);

        vm.prank(alice);
        trails.setTrail(acct, BTC, 200, 0, 0);
        vm.prank(stranger);
        vm.expectRevert(TrailingStops.NotAllowed.selector);
        trails.clearTrail(acct, BTC);
        vm.prank(alice);
        trails.clearTrail(acct, BTC);
        assertEq(trails.trailCount(), 0);
    }

    function test_anAccountThatRefuses_doesNotStopTheBatch() public {
        AgentAccount b = _account(bob, false); // never approved the trailing contract
        vm.prank(agentKey);
        b.openPosition(_params(BTC, true, 500e6, 5_000e6), _noBytes());
        _setBtc(100_000);
        vm.prank(bob);
        trails.setTrail(b, BTC, 200, 0, 0);
        vm.prank(alice);
        trails.setTrail(acct, BTC, 200, 0, 0);

        address[] memory accounts = new address[](2);
        bytes32[] memory markets = new bytes32[](2);
        accounts[0] = address(b);
        accounts[1] = address(acct);
        markets[0] = BTC;
        markets[1] = BTC;
        vm.expectEmit(address(trails));
        emit TrailRefused(address(b), BTC, 98_000e18);
        trails.poke(accounts, markets);
        assertEq(engine.getPosition(address(b), BTC).slOrderId, 0);
        assertEq(_stop(address(acct)).triggerPrice, 98_000e18, "the other trail still moved");
    }

    function test_aStalePriceIsSkipped_andTheOtherSideClears() public {
        vm.prank(alice);
        trails.setTrail(acct, BTC, 200, 0, 0);
        skip(1 hours); // no fresh price
        _poke(address(acct));
        assertEq(engine.getPosition(address(acct), BTC).slOrderId, 0, "no stop from a stale price");
        assertEq(trails.trailCount(), 1);

        // The long closes and a short opens in its place: the long's trail does not carry over.
        _setBtc(100_000);
        vm.prank(agentKey);
        acct.closePosition(BTC, 0, 0, _noBytes());
        vm.prank(agentKey);
        acct.openPosition(_params(BTC, false, 500e6, 5_000e6), _noBytes());
        _setBtc(100_000);
        _poke(address(acct));
        assertEq(trails.trailCount(), 0);
        assertEq(engine.getPosition(address(acct), BTC).slOrderId, 0);
    }

    function test_aPokeShortOfGasIsRefusedWhole_notTakenForTheAccountsRefusal() public {
        vm.prank(alice);
        trails.setTrail(acct, BTC, 200, 0, 0);
        address[] memory accounts = new address[](1);
        bytes32[] memory markets = new bytes32[](1);
        accounts[0] = address(acct);
        markets[0] = BTC;
        // Enough for the reads and the catch, not for the account's call into the engine: refused whole.
        vm.expectRevert(TrailingStops.InsufficientGas.selector);
        trails.poke{gas: 120_000}(accounts, markets);

        assertEq(engine.getPosition(address(acct), BTC).slOrderId, 0);
        // With the gas a normal estimate gives, it moves.
        trails.poke(accounts, markets);
        assertEq(_stop(address(acct)).triggerPrice, 98_000e18);
    }

    function test_trailsArePagedForKeepers() public {
        AgentAccount b = _account(bob, true);
        vm.prank(agentKey);
        b.openPosition(_params(BTC, true, 500e6, 5_000e6), _noBytes());
        _setBtc(100_000);
        vm.prank(alice);
        trails.setTrail(acct, BTC, 200, 0, 0);
        vm.prank(bob);
        trails.setTrail(b, BTC, 300, 1_000e6, 0);
        (address[] memory accounts, bytes32[] memory markets, TrailingStops.Trail[] memory list) =
            trails.getTrails(1, 10);
        assertEq(accounts.length, 1);
        assertEq(accounts[0], address(b));
        assertEq(markets[0], BTC);
        assertEq(list[0].distanceBps, 300);
        assertEq(list[0].size, 1_000e6);
        (accounts,,) = trails.getTrails(5, 10);
        assertEq(accounts.length, 0);
    }
}

/// @dev Pretends to be an AgentAccount owned by `owner`.
contract FakeAccount {
    address public immutable owner;

    constructor(address owner_) {
        owner = owner_;
    }

    function agents(address) external pure returns (uint64, uint16, uint128) {
        return (type(uint64).max, 1, 1);
    }
}
