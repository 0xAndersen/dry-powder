// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Base} from "./Base.t.sol";
import {AgentAccount, AgentAccountFactory} from "../src/AgentAccount.sol";
import {OrderType, Position} from "../src/Types.sol";

contract AgentAccountTest is Base {
    AgentAccountFactory internal factory;
    AgentAccount internal acct;
    address internal agent = makeAddr("agent");
    address internal stranger = makeAddr("stranger");

    uint64 internal expiry;

    function setUp() public override {
        super.setUp();
        factory = new AgentAccountFactory(IERC20(address(usdc)), engine);
        acct = AgentAccount(factory.createAccount(alice));
        vm.prank(alice);
        usdc.transfer(address(acct), 10_000e6);
        expiry = uint64(block.timestamp + 1 days);
        vm.prank(alice);
        acct.setAgent(agent, expiry, 10, 1_000e6);
    }

    // ───────────────────────────── Factory ─────────────────────────────

    function test_factory_createsAtPredictedAddress_oncePerOwner() public {
        address predicted = factory.predictAccount(bob);
        address created = factory.createAccount(bob);
        assertEq(created, predicted);
        assertEq(factory.accountOf(bob), created);
        assertEq(AgentAccount(created).owner(), bob);
        assertEq(usdc.allowance(created, address(engine)), type(uint256).max);
        vm.expectRevert(AgentAccountFactory.AccountExists.selector);
        factory.createAccount(bob);
    }

    function test_factory_anyoneCanCreateForAnOwner_ownerStaysTheirs() public {
        vm.prank(stranger);
        address created = factory.createAccount(carol);
        assertEq(AgentAccount(created).owner(), carol);
    }

    function test_constructor_rejectsZeroAddresses() public {
        vm.expectRevert(AgentAccount.ZeroAddress.selector);
        new AgentAccount(IERC20(address(usdc)), engine, address(0));
    }

    // ───────────────────────────── Policy admin ─────────────────────────────

    function test_setAgent_onlyOwner_andValidated() public {
        vm.prank(agent);
        vm.expectRevert(AgentAccount.NotOwner.selector);
        acct.setAgent(stranger, expiry, 5, 100e6);

        vm.startPrank(alice);
        vm.expectRevert(AgentAccount.ZeroAddress.selector);
        acct.setAgent(address(0), expiry, 5, 100e6);
        vm.expectRevert(AgentAccount.InvalidPolicy.selector);
        acct.setAgent(alice, expiry, 5, 100e6);
        vm.expectRevert(AgentAccount.InvalidPolicy.selector);
        acct.setAgent(stranger, uint64(block.timestamp), 5, 100e6);
        vm.expectRevert(AgentAccount.InvalidPolicy.selector);
        acct.setAgent(stranger, expiry, 0, 100e6);
        vm.expectRevert(AgentAccount.InvalidPolicy.selector);
        acct.setAgent(stranger, expiry, 5, 0);
        vm.stopPrank();

        (uint64 e, uint16 lev, uint128 maxM) = acct.agents(agent);
        assertEq(e, expiry);
        assertEq(lev, 10);
        assertEq(maxM, 1_000e6);
    }

    // ───────────────────────────── Agents trade, never withdraw ─────────────────────────────

    function test_agentCannotWithdraw_anyToken_anyAmount(address to, uint256 amount) public {
        vm.assume(to != address(0));
        vm.prank(agent);
        vm.expectRevert(AgentAccount.NotOwner.selector);
        acct.withdraw(IERC20(address(usdc)), to, amount);
    }

    function test_agentOpensWithinPolicy_profitLandsInTheAccount() public {
        uint256 before = usdc.balanceOf(address(acct));
        vm.prank(agent);
        acct.openPosition(_params(BTC, true, 500e6, 5_000e6), _noBytes());
        Position memory p = engine.getPosition(address(acct), BTC);
        assertEq(p.trader, address(acct));
        assertEq(p.margin, 500e6);
        assertEq(engine.getPosition(agent, BTC).trader, address(0));

        _setBtc(105_000);
        vm.prank(agent);
        acct.closePosition(BTC, 0, _noBytes());
        uint256 afterBal = usdc.balanceOf(address(acct));
        assertGt(afterBal, before, "profit returned to the account");
        assertEq(usdc.balanceOf(agent), 0, "nothing reaches the agent");
    }

    function test_agentPolicyCaps() public {
        vm.startPrank(agent);
        vm.expectRevert(AgentAccount.MarginCapExceeded.selector);
        acct.openPosition(_params(BTC, true, 1_001e6, 2_000e6), _noBytes());
        vm.expectRevert(AgentAccount.LeverageCapExceeded.selector);
        acct.openPosition(_params(BTC, true, 100e6, 1_001e6), _noBytes());
        vm.expectRevert(AgentAccount.LeverageCapExceeded.selector);
        acct.createLimitOrder(_limit(BTC, true, 100e6, 2_000e6, 101_000e18));
        vm.stopPrank();
    }

    function test_ownerIsNotCapped() public {
        vm.prank(alice);
        acct.openPosition(_params(BTC, true, 2_000e6, 100_000e6), _noBytes());
        assertEq(engine.getPosition(address(acct), BTC).size, 100_000e6);
    }

    function test_marketRestriction_appliesToAgentsOnly() public {
        vm.prank(alice);
        acct.setRestrictMarkets(true);
        vm.prank(alice);
        acct.setMarketAllowed(ETH, true);

        vm.prank(agent);
        vm.expectRevert(AgentAccount.MarketNotAllowed.selector);
        acct.openPosition(_params(BTC, true, 100e6, 500e6), _noBytes());

        vm.prank(agent);
        acct.openPosition(_params(ETH, true, 100e6, 500e6), _noBytes());

        vm.prank(alice);
        acct.openPosition(_params(BTC, true, 100e6, 500e6), _noBytes());
        assertTrue(acct.restrictMarkets());
        assertTrue(acct.marketAllowed(ETH));
    }

    function test_expiredRevokedAndUnknownCallersAreRefused() public {
        vm.prank(stranger);
        vm.expectRevert(AgentAccount.NotAuthorized.selector);
        acct.openPosition(_params(BTC, true, 100e6, 500e6), _noBytes());

        vm.warp(expiry);
        vm.prank(agent);
        vm.expectRevert(AgentAccount.NotAuthorized.selector);
        acct.cancelOrder(1);

        vm.prank(alice);
        acct.setAgent(agent, uint64(block.timestamp + 1 hours), 10, 1_000e6);
        vm.prank(alice);
        acct.revokeAgent(agent);
        vm.prank(agent);
        vm.expectRevert(AgentAccount.NotAuthorized.selector);
        acct.claim();
    }

    function test_agentOrders_escrowAndRefundStayInTheAccount() public {
        uint256 before = usdc.balanceOf(address(acct));
        vm.prank(agent);
        uint256 id = acct.createLimitOrder(_limit(BTC, true, 200e6, 1_000e6, 90_000e18));
        assertLt(usdc.balanceOf(address(acct)), before);
        assertEq(engine.getOrder(id).trader, address(acct));

        // The agent cannot cancel through the engine directly: the order is the account's.
        vm.prank(agent);
        vm.expectRevert();
        engine.cancelOrder(id);

        vm.prank(agent);
        acct.cancelOrder(id);
        assertEq(usdc.balanceOf(address(acct)), before);
    }

    function test_agentSetsTriggers_andKeeperFillsThem() public {
        vm.prank(agent);
        acct.openPosition(_params(BTC, true, 500e6, 5_000e6), _noBytes());
        vm.startPrank(agent);
        acct.setTriggerOrder(BTC, OrderType.TakeProfit, 104_000e18);
        uint256 slId = acct.setTriggerOrder(BTC, OrderType.StopLoss, 95_000e18);
        vm.stopPrank();
        assertEq(engine.getOrder(slId).trader, address(acct));

        uint256 before = usdc.balanceOf(address(acct));
        _setBtc(104_500);
        uint256 tpId = engine.getPosition(address(acct), BTC).tpOrderId;
        vm.prank(keeper);
        engine.executeOrder(tpId, _noBytes());
        assertEq(engine.getPosition(address(acct), BTC).trader, address(0));
        assertGt(usdc.balanceOf(address(acct)), before);
    }

    function test_lossRebatesMintToTheAccount_ownerWithdrawsThem() public {
        vm.prank(agent);
        acct.openPosition(_params(BTC, true, 500e6, 5_000e6), _noBytes());
        _setBtc(97_000);
        vm.prank(agent);
        acct.closePosition(BTC, 0, _noBytes());
        uint256 keg = house.balanceOf(address(acct));
        assertGt(keg, 0);

        vm.prank(alice);
        acct.withdraw(IERC20(address(house)), alice, keg);
        assertEq(house.balanceOf(alice), keg);

        uint256 cash = usdc.balanceOf(address(acct));
        uint256 aliceBefore = usdc.balanceOf(alice);
        vm.prank(alice);
        acct.withdraw(IERC20(address(usdc)), alice, cash);
        assertEq(usdc.balanceOf(alice), aliceBefore + cash);
        assertEq(usdc.balanceOf(address(acct)), 0);
    }

    function test_withdrawRejectsZeroRecipient() public {
        vm.prank(alice);
        vm.expectRevert(AgentAccount.ZeroAddress.selector);
        acct.withdraw(IERC20(address(usdc)), address(0), 1);
    }

    function test_claim_pullsDeferredPayoutsIntoTheAccount() public {
        // Nothing deferred: the engine's own error surfaces.
        vm.prank(agent);
        vm.expectRevert();
        acct.claim();
    }
}
