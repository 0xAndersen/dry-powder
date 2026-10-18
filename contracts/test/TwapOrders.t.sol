// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Base} from "./Base.t.sol";
import {AgentAccount, AgentAccountFactory} from "../src/AgentAccount.sol";
import {TwapOrders} from "../src/TwapOrders.sol";
import {Order, Position} from "../src/Types.sol";

contract TwapOrdersTest is Base {
    AgentAccountFactory internal factory;
    TwapOrders internal twaps;
    AgentAccount internal acct;
    address internal agentKey = makeAddr("agentKey");
    address internal stranger = makeAddr("stranger");

    event SlicePlaced(
        address indexed account, bytes32 indexed marketId, uint256 orderId, uint16 slice, uint256 triggerPrice
    );
    event SliceRefused(address indexed account, bytes32 indexed marketId, uint16 slice);
    event TwapEnded(address indexed account, bytes32 indexed marketId, uint16 done, uint16 slices);

    function setUp() public override {
        super.setUp();
        factory = new AgentAccountFactory(IERC20(address(usdc)), engine);
        twaps = new TwapOrders(engine, factory);
        acct = _account(alice, 100e6);
    }

    /// @dev An account for `who` with 10,000 of collateral, the agent key, and the TWAP contract approved with a
    ///      per-slice margin cap of `sliceCap` at up to 10x.
    function _account(address who, uint128 sliceCap) internal returns (AgentAccount a) {
        a = AgentAccount(factory.createAccount(who));
        vm.startPrank(who);
        usdc.transfer(address(a), 10_000e6);
        a.setAgent(agentKey, uint64(block.timestamp + 30 days), 20, 1_000e6);
        if (sliceCap != 0) a.setAgent(address(twaps), type(uint64).max, 10, sliceCap);
        vm.stopPrank();
    }

    function _poke(address account) internal {
        address[] memory accounts = new address[](1);
        bytes32[] memory markets = new bytes32[](1);
        accounts[0] = account;
        markets[0] = BTC;
        twaps.poke(accounts, markets);
    }

    /// @dev The id of the newest order (ids count up from 1; `orderCount` is the number still open).
    function _lastOrder() internal view returns (uint256) {
        return uint256(engine.nextOrderId()) - 1;
    }

    function test_slicesGoOutOnePerInterval_andAddUp() public {
        vm.prank(agentKey);
        twaps.setTwap(acct, BTC, true, 50e6, 500e6, 3, 60, 50);
        assertTrue(twaps.due(address(acct), BTC));

        vm.expectEmit(true, true, false, false, address(twaps));
        emit SlicePlaced(address(acct), BTC, 0, 1, 0);
        _poke(address(acct));
        uint256 first = _lastOrder();
        Order memory o = engine.getOrder(first);
        assertEq(o.trader, address(acct));
        assertEq(o.margin, 50e6);
        assertEq(o.size, 500e6);
        assertEq(o.triggerPrice, 100_500e18, "marketable: the ask plus 0.5%");

        // Not again before the interval.
        assertFalse(twaps.due(address(acct), BTC));
        uint256 count = _lastOrder();
        _poke(address(acct));
        assertEq(_lastOrder(), count, "a poke cannot speed it up");

        // A keeper fills the slice at the next price; the next one goes a minute later and adds to it.
        _setBtc(100_000);
        _exec(first);
        assertEq(
            engine.getPosition(address(acct), BTC).entryPrice,
            engine.getPrice(BTC).ask,
            "fills at the price, not the bound"
        );
        skip(60);
        _setBtc(100_000);
        _poke(address(acct));
        _setBtc(100_000);
        _exec(_lastOrder());
        assertEq(engine.getPosition(address(acct), BTC).size, 1_000e6);

        skip(60);
        _setBtc(100_000);
        vm.expectEmit(true, true, false, true, address(twaps));
        emit TwapEnded(address(acct), BTC, 3, 3);
        _poke(address(acct));
        _setBtc(100_000);
        _exec(_lastOrder());
        assertEq(engine.getPosition(address(acct), BTC).size, 1_500e6);
        assertEq(twaps.twapCount(), 0);
    }

    function test_theAccountsPolicyCapsEverySlice() public {
        AgentAccount b = _account(bob, 40e6); // the TWAP contract may use at most 40 per call
        vm.prank(bob);
        twaps.setTwap(b, BTC, true, 50e6, 500e6, 3, 60, 50);
        uint256 count = _lastOrder();
        vm.expectEmit(true, true, false, true, address(twaps));
        emit SliceRefused(address(b), BTC, 1);
        _poke(address(b));
        assertEq(_lastOrder(), count, "nothing placed beyond the policy");
        assertEq(twaps.getTwap(address(b), BTC).done, 0);
        assertEq(twaps.getTwap(address(b), BTC).refusals, 1);

        // Refused again at each interval; the third refusal in a row ends it, so keepers stop paying for it.
        skip(60);
        _setBtc(100_000);
        _poke(address(b));
        skip(60);
        _setBtc(100_000);
        vm.expectEmit(true, true, false, true, address(twaps));
        emit TwapEnded(address(b), BTC, 0, 3);
        _poke(address(b));
        assertEq(twaps.twapCount(), 0);
        assertEq(_lastOrder(), count);
    }

    function test_aRefusalStreakResetsWhenASliceGoesThrough() public {
        AgentAccount b = _account(bob, 40e6);
        vm.prank(bob);
        twaps.setTwap(b, BTC, true, 50e6, 500e6, 3, 60, 50);
        _poke(address(b));
        skip(60);
        _setBtc(100_000);
        _poke(address(b));
        assertEq(twaps.getTwap(address(b), BTC).refusals, 2);
        // The owner raises the cap: the next slice goes out and the streak starts over.
        vm.prank(bob);
        b.setAgent(address(twaps), type(uint64).max, 10, 50e6);
        skip(60);
        _setBtc(100_000);
        _poke(address(b));
        TwapOrders.Twap memory t = twaps.getTwap(address(b), BTC);
        assertEq(t.done, 1);
        assertEq(t.refusals, 0);
    }

    function test_anAgentCannotStartSlicesBeyondItsOwnPolicy() public {
        // agentKey may use 1,000 per call at up to 20x; the TWAP contract is approved for more.
        vm.prank(alice);
        acct.setAgent(address(twaps), type(uint64).max, 50, 5_000e6);
        vm.startPrank(agentKey);
        vm.expectRevert(TwapOrders.AgentPolicyExceeded.selector);
        twaps.setTwap(acct, BTC, true, 2_000e6, 20_000e6, 3, 60, 50); // margin over its cap
        vm.expectRevert(TwapOrders.AgentPolicyExceeded.selector);
        twaps.setTwap(acct, BTC, true, 100e6, 2_100e6, 3, 60, 50); // 21x
        twaps.setTwap(acct, BTC, true, 1_000e6, 20_000e6, 3, 60, 50); // at its caps
        vm.stopPrank();
        // The owner is not capped by any agent policy.
        vm.prank(alice);
        twaps.setTwap(acct, BTC, true, 4_000e6, 200_000e6, 2, 60, 50);
        assertEq(twaps.getTwap(address(acct), BTC).sliceMargin, 4_000e6);
    }

    function test_waitsWhileHoldingTheOtherSide_andWithoutAPrice() public {
        vm.prank(agentKey);
        acct.openPosition(_params(BTC, false, 100e6, 1_000e6), _noBytes());
        _setBtc(100_000);
        vm.prank(alice);
        twaps.setTwap(acct, BTC, true, 50e6, 500e6, 3, 60, 50);
        assertFalse(twaps.due(address(acct), BTC), "a long slice could not fill against the short");
        uint256 count = _lastOrder();
        _poke(address(acct));
        assertEq(_lastOrder(), count);

        vm.prank(agentKey);
        acct.closePosition(BTC, 0, 0, _noBytes());
        assertTrue(twaps.due(address(acct), BTC));
        skip(1 hours); // stale
        assertFalse(twaps.due(address(acct), BTC));
    }

    function test_aPokeShortOfGasIsRefusedWhole() public {
        vm.prank(alice);
        twaps.setTwap(acct, BTC, true, 50e6, 500e6, 3, 60, 50);
        address[] memory accounts = new address[](1);
        bytes32[] memory markets = new bytes32[](1);
        accounts[0] = address(acct);
        markets[0] = BTC;
        vm.expectRevert(TwapOrders.InsufficientGas.selector);
        twaps.poke{gas: 200_000}(accounts, markets);
        assertTrue(twaps.due(address(acct), BTC), "still due: nothing was used up");
        twaps.poke(accounts, markets);
        assertEq(twaps.getTwap(address(acct), BTC).done, 1);
    }

    function test_onlyTheOwnerOrAnAgent_validParams_andCancel() public {
        vm.prank(stranger);
        vm.expectRevert(TwapOrders.NotAllowed.selector);
        twaps.setTwap(acct, BTC, true, 50e6, 500e6, 3, 60, 50);
        vm.startPrank(alice);
        vm.expectRevert(TwapOrders.InvalidTwap.selector);
        twaps.setTwap(acct, BTC, true, 50e6, 500e6, 1, 60, 50); // one slice is not a TWAP
        vm.expectRevert(TwapOrders.InvalidTwap.selector);
        twaps.setTwap(acct, BTC, true, 50e6, 500e6, 3, 5, 50); // faster than 30 s
        vm.expectRevert(TwapOrders.InvalidTwap.selector);
        twaps.setTwap(acct, BTC, true, 50e6, 40e6, 3, 60, 50); // below 1x
        vm.expectRevert(TwapOrders.InvalidTwap.selector);
        twaps.setTwap(acct, BTC, true, 50e6, 500e6, 3, 60, 900); // slippage over 5%
        twaps.setTwap(acct, BTC, true, 50e6, 500e6, 3, 60, 50);
        vm.stopPrank();
        assertEq(twaps.twapCount(), 1);
        (address[] memory accounts,, TwapOrders.Twap[] memory list) = twaps.getTwaps(0, 10);
        assertEq(accounts[0], address(acct));
        assertEq(list[0].slices, 3);
        vm.prank(stranger);
        vm.expectRevert(TwapOrders.NotAllowed.selector);
        twaps.cancelTwap(acct, BTC);
        vm.prank(agentKey);
        twaps.cancelTwap(acct, BTC);
        assertEq(twaps.twapCount(), 0);
        assertFalse(twaps.due(address(acct), BTC));
    }

    function test_aShortSliceAcceptsDownToTheBidMinusSlippage() public {
        vm.prank(alice);
        twaps.setTwap(acct, BTC, false, 50e6, 500e6, 2, 60, 100);
        _poke(address(acct));
        Order memory o = engine.getOrder(_lastOrder());
        assertFalse(o.isLong);
        assertEq(o.triggerPrice, 99_000e18);
    }
}
