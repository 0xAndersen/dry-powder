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
        acct.closePosition(BTC, 0, 0, _noBytes());
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
        acct.setTriggerOrder(BTC, OrderType.TakeProfit, 104_000e18, 0);
        uint256 slId = acct.setTriggerOrder(BTC, OrderType.StopLoss, 95_000e18, 0);
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
        acct.closePosition(BTC, 0, 0, _noBytes());
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

    // ───────────────────────────── v3.1: batching, adding margin, one-transaction set-up ─────────────────────────────

    function test_multicall_placesALadderAtomically() public {
        bytes[] memory calls = new bytes[](3);
        for (uint256 i; i < 3; ++i) {
            calls[i] = abi.encodeCall(AgentAccount.createLimitOrder, (_limit(BTC, true, 100e6, 1_000e6, (99_000 - i * 500) * 1e18)));
        }
        vm.prank(agent);
        bytes[] memory out = acct.multicall(calls);
        assertEq(out.length, 3);
        (uint256[] memory ids,) = lens.getTraderOrders(address(acct));
        assertEq(ids.length, 3);
        assertEq(abi.decode(out[2], (uint256)), ids[2]);
        _assertEngineSolvent();
    }

    function test_multicall_isAtomic_oneCallOutsideThePolicyRevertsTheBatch() public {
        bytes[] memory calls = new bytes[](2);
        calls[0] = abi.encodeCall(AgentAccount.createLimitOrder, (_limit(BTC, true, 100e6, 1_000e6, 99_000e18)));
        calls[1] = abi.encodeCall(AgentAccount.createLimitOrder, (_limit(BTC, true, 1_000e6 + 1, 2_000e6, 99_000e18)));
        vm.prank(agent);
        vm.expectRevert(AgentAccount.MarginCapExceeded.selector);
        acct.multicall(calls);
        assertEq(engine.orderCount(), 0);
    }

    function test_multicall_agentCannotReachOwnerFunctions_strangerCannotBatch() public {
        bytes[] memory calls = new bytes[](1);
        calls[0] = abi.encodeCall(AgentAccount.withdraw, (IERC20(address(usdc)), agent, 1));
        vm.prank(agent);
        vm.expectRevert(AgentAccount.NotOwner.selector);
        acct.multicall(calls);

        calls[0] = abi.encodeCall(AgentAccount.setAgent, (stranger, expiry, 10, 1_000e6));
        vm.prank(agent);
        vm.expectRevert(AgentAccount.NotOwner.selector);
        acct.multicall(calls);

        calls[0] = abi.encodeCall(AgentAccount.initAgent, (stranger, expiry, 10, 1_000e6));
        vm.prank(agent);
        vm.expectRevert(AgentAccount.NotOwner.selector);
        acct.multicall(calls);

        calls[0] = abi.encodeCall(AgentAccount.cancelOrder, (1));
        vm.prank(stranger);
        vm.expectRevert(AgentAccount.NotAuthorized.selector);
        acct.multicall(calls);
    }

    function test_multicall_ownerFlattensTheAccountInOneTransaction() public {
        vm.startPrank(alice);
        acct.openPosition(_params(BTC, true, 500e6, 5_000e6), _noBytes());
        acct.openPosition(_params(ETH, false, 500e6, 5_000e6), _noBytes());
        uint256 orderId = acct.createLimitOrder(_limit(EUR, true, 100e6, 1_000e6, 1e18));
        vm.stopPrank();
        _refreshAll();
        bytes[] memory calls = new bytes[](3);
        calls[0] = abi.encodeCall(AgentAccount.closePosition, (BTC, 0, 0, _noBytes()));
        calls[1] = abi.encodeCall(AgentAccount.closePosition, (ETH, 0, 0, _noBytes()));
        calls[2] = abi.encodeCall(AgentAccount.cancelOrder, (orderId));
        vm.prank(alice);
        acct.multicall(calls);
        assertEq(engine.positionCount(), 0);
        assertEq(engine.orderCount(), 0);
        _assertEngineSolvent();
    }

    function test_agentAddsMarginWithinItsCap_andClosesPart() public {
        vm.prank(agent);
        acct.openPosition(_params(BTC, true, 500e6, 5_000e6), _noBytes());
        _setBtc(99_900);
        vm.prank(agent);
        vm.expectRevert(AgentAccount.MarginCapExceeded.selector);
        acct.addMargin(BTC, 1_000e6 + 1);
        vm.prank(agent);
        acct.addMargin(BTC, 500e6);
        assertEq(engine.getPosition(address(acct), BTC).margin, 1_000e6);

        _setBtc(99_900);
        vm.prank(agent);
        acct.closePosition(BTC, 2_000e6, 0, _noBytes());
        assertEq(engine.getPosition(address(acct), BTC).size, 3_000e6);
        _assertEngineSolvent();
    }

    function test_factory_accountWithAgentAndGas_inOneTransaction() public {
        address key = makeAddr("session");
        vm.deal(bob, 1 ether);
        vm.prank(bob);
        address created = factory.createAccountWithAgent{value: 0.25 ether}(key, expiry, 50, 500e6);
        assertEq(created, factory.predictAccount(bob));
        assertEq(factory.accountOf(bob), created);
        assertEq(AgentAccount(created).owner(), bob);
        (uint64 e, uint16 lev, uint128 maxM) = AgentAccount(created).agents(key);
        assertEq(e, expiry);
        assertEq(lev, 50);
        assertEq(maxM, 500e6);
        assertEq(key.balance, 0.25 ether, "gas forwarded to the session key");
        assertEq(created.balance, 0);
        assertEq(usdc.allowance(created, address(engine)), type(uint256).max);

        // The set-up hook is single use, and only the deploying factory may use it.
        vm.prank(address(factory));
        vm.expectRevert(AgentAccount.NotOwner.selector);
        AgentAccount(created).initAgent(stranger, expiry, 5, 1e6);
        vm.prank(bob);
        vm.expectRevert(AgentAccount.NotOwner.selector);
        AgentAccount(created).initAgent(stranger, expiry, 5, 1e6);

        vm.prank(bob);
        vm.expectRevert(AgentAccountFactory.AccountExists.selector);
        factory.createAccountWithAgent(key, expiry, 50, 500e6);
    }

    function test_factory_accountWithAgent_validatesThePolicy() public {
        vm.prank(bob);
        vm.expectRevert(AgentAccount.InvalidPolicy.selector);
        factory.createAccountWithAgent(bob, expiry, 50, 500e6); // the owner as its own agent
        vm.prank(bob);
        vm.expectRevert(AgentAccount.InvalidPolicy.selector);
        factory.createAccountWithAgent(stranger, uint64(block.timestamp), 50, 500e6);
    }

    function test_setAgent_forwardsGas_andRevertsIfTheKeyRefusesIt() public {
        address key = makeAddr("session2");
        vm.deal(alice, 1 ether);
        vm.prank(alice);
        acct.setAgent{value: 0.1 ether}(key, expiry, 5, 100e6);
        assertEq(key.balance, 0.1 ether);
        assertEq(address(acct).balance, 0);

        vm.prank(alice);
        vm.expectRevert(AgentAccount.GasTopUpFailed.selector);
        acct.setAgent{value: 1}(address(usdc), expiry, 5, 100e6); // a contract with no way to take native value
    }
}
