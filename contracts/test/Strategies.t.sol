// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Base} from "./Base.t.sol";
import {AgentAccount, AgentAccountFactory} from "../src/AgentAccount.sol";
import {PerpEngine} from "../src/PerpEngine.sol";
import {Strategies} from "../src/Strategies.sol";
import {Order, OrderType, Position} from "../src/Types.sol";

contract StrategiesTest is Base {
    AgentAccountFactory internal factory;
    Strategies internal strats;
    AgentAccount internal acct;
    address internal agentKey = makeAddr("agentKey");
    address internal stranger = makeAddr("stranger");

    event TargetChanged(uint256 indexed id, Strategies.Side from, Strategies.Side to);
    event OrderPlaced(uint256 indexed id, Strategies.Action action, uint256 orderId, uint256 size, uint256 price);
    event OrderDropped(uint256 indexed id, uint256 orderId);
    event ActionRefused(uint256 indexed id, Strategies.Action action);
    event ExitedElsewhere(uint256 indexed id, Strategies.Side side);
    event StrategyPaused(uint256 indexed id, bool afterRefusals);

    function setUp() public override {
        super.setUp();
        factory = new AgentAccountFactory(IERC20(address(usdc)), engine);
        strats = new Strategies(engine, factory);
        acct = _account(alice, 1_000e6);
    }

    /// @dev An account for `who` with 50,000 of collateral, the agent key (1,000 per call at up to 20x) and, if
    ///      `cap` is set, this contract approved for `cap` per order at up to 20x.
    function _account(address who, uint128 cap) internal returns (AgentAccount a) {
        a = AgentAccount(factory.createAccount(who));
        vm.startPrank(who);
        usdc.transfer(address(a), 50_000e6);
        a.setAgent(agentKey, uint64(block.timestamp + 30 days), 20, 1_000e6);
        if (cap != 0) a.setAgent(address(strats), type(uint64).max, 20, cap);
        vm.stopPrank();
    }

    // ───────────────────────────── Configs ─────────────────────────────

    /// @dev 100 of margin at 10x, a sample a minute, 0.5% slippage.
    function _common(Strategies.Kind kind, bool allowShort) internal pure returns (Strategies.Config memory c) {
        c.kind = kind;
        c.interval = 60;
        c.margin = 100e6;
        c.leverage = 10;
        c.maxSlippageBps = 50;
        c.allowShort = allowShort;
    }

    function _trend(uint16 fast, uint16 slow, uint16 band, bool allowShort)
        internal
        pure
        returns (Strategies.Config memory c)
    {
        c = _common(Strategies.Kind.Trend, allowShort);
        c.period = fast;
        c.slowPeriod = slow;
        c.bandBps = band;
    }

    function _meanRevert(uint16 period, uint16 entry, uint16 exit, bool allowShort)
        internal
        pure
        returns (Strategies.Config memory c)
    {
        c = _common(Strategies.Kind.MeanRevert, allowShort);
        c.period = period;
        c.bandBps = entry;
        c.exitBps = exit;
    }

    /// @dev Up to 500 of margin per order at 10x (5,000 per order).
    function _copy(address leader, uint32 ratioBps, uint80 maxSize) internal pure returns (Strategies.Config memory c) {
        c = _common(Strategies.Kind.Copy, true);
        c.margin = 500e6;
        c.leader = leader;
        c.ratioBps = ratioBps;
        c.maxSize = maxSize;
    }

    // ───────────────────────────── Helpers ─────────────────────────────

    function _poke(uint256 id) internal {
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        strats.poke(ids);
    }

    /// @dev The next sample, a minute after the last one, with BTC at `usd`.
    function _sampleAt(uint256 id, uint256 usd) internal {
        skip(59);
        _setBtc(usd);
        _poke(id);
    }

    /// @dev The keeper fills the strategy's order on the book at `usd`.
    function _fill(uint256 id, uint256 usd) internal {
        uint256 orderId = _state(id).pendingOrder;
        assertTrue(orderId != 0, "an order to fill");
        _setBtc(usd);
        _exec(orderId);
    }

    function _state(uint256 id) internal view returns (Strategies.State memory) {
        return strats.getStrategy(id).state;
    }

    function _pos() internal view returns (Position memory) {
        return engine.getPosition(address(acct), BTC);
    }

    function _create(Strategies.Config memory c) internal returns (uint256 id) {
        vm.prank(alice);
        id = strats.create(acct, BTC, c);
    }

    /// @dev Four samples rising 100,000 -> 103,000 (the trend turns long once the slow EMA has four), the long
    ///      filled at 103,000 and recorded.
    function _trendLong(Strategies.Config memory c) internal returns (uint256 id) {
        id = _create(c);
        _setBtc(100_000);
        _poke(id);
        _sampleAt(id, 101_000);
        _sampleAt(id, 102_000);
        _sampleAt(id, 103_000);
        _fill(id, 103_000);
        _poke(id);
        assertEq(_pos().size, 1_000e6);
        assertEq(uint8(_state(id).holding), uint8(Strategies.Side.Long));
    }

    // ───────────────────────────── Trend ─────────────────────────────

    function test_trend_waitsForTheSlowEma_thenGoesLongOnTheCrossover() public {
        uint256 id = _create(_trend(2, 4, 0, true));
        assertTrue(strats.due(id), "the first sample is due at once");
        _setBtc(100_000);
        _poke(id);
        assertEq(_state(id).samples, 1);
        assertFalse(strats.due(id), "not before the interval");
        // Rising from the start, so the fast EMA leads at once; nothing happens before the slow one has four.
        _sampleAt(id, 101_000);
        _sampleAt(id, 102_000);
        assertEq(engine.nextOrderId(), 1, "no order while warming up");
        assertEq(uint8(_state(id).target), uint8(Strategies.Side.Flat));

        skip(59);
        _setBtc(103_000);
        vm.expectEmit(true, false, false, true, address(strats));
        emit TargetChanged(id, Strategies.Side.Flat, Strategies.Side.Long);
        vm.expectEmit(true, false, false, true, address(strats));
        emit OrderPlaced(id, Strategies.Action.Open, 1, 1_000e6, 103_515e18);
        _poke(id);
        Strategies.State memory s = _state(id);
        assertEq(s.pendingOrder, 1);
        assertEq(uint8(s.pendingAction), uint8(Strategies.Action.Open));
        Order memory o = engine.getOrder(1);
        assertEq(o.trader, address(acct));
        assertEq(o.margin, 100e6);
        assertEq(o.size, 1_000e6, "margin x leverage");
        assertEq(o.triggerPrice, 103_515e18, "marketable: the ask plus 0.5%");
        assertFalse(strats.due(id), "nothing more while its order works");

        // Filled by the keeper: due at once to record it; then nothing until the next sample.
        _fill(id, 103_000);
        assertTrue(strats.due(id));
        _poke(id);
        s = _state(id);
        assertEq(uint8(s.holding), uint8(Strategies.Side.Long));
        assertEq(s.pendingOrder, 0);
        assertFalse(s.todo);
        assertFalse(strats.due(id));
        assertEq(_pos().entryPrice, 103_000e18, "fills at the price, not the bound");

        // The trend holds: nothing added.
        _sampleAt(id, 104_000);
        assertEq(_pos().size, 1_000e6);
        assertEq(_state(id).actions, 1);
    }

    function test_trend_holdsInsideTheHysteresisBand() public {
        uint256 id = _create(_trend(2, 4, 100, true)); // 1% band
        _setBtc(100_000);
        _poke(id);
        _sampleAt(id, 100_000);
        _sampleAt(id, 100_000);
        _sampleAt(id, 100_000);
        // fast 100,667 vs slow 100,400 (+0.27%), then 102,222 vs 101,440 (+0.77%): inside the band.
        _sampleAt(id, 101_000);
        _sampleAt(id, 103_000);
        assertEq(uint8(_state(id).target), uint8(Strategies.Side.Flat));
        assertEq(engine.nextOrderId(), 1);
        // 104,074 vs 102,864 (+1.18%): through it.
        _sampleAt(id, 105_000);
        assertEq(uint8(_state(id).target), uint8(Strategies.Side.Long));
        assertEq(engine.nextOrderId(), 2);
        assertGt(_state(id).emaFast, _state(id).emaSlow);
    }

    function test_trend_aFlipClosesFirst_andOpensOnALaterPoke() public {
        uint256 id = _trendLong(_trend(2, 4, 0, true));
        // A sharp fall: fast 97,506 under slow 99,094. The long is closed first; no short yet.
        skip(59);
        _setBtc(95_000);
        vm.expectEmit(true, false, false, true, address(strats));
        emit OrderPlaced(id, Strategies.Action.Close, 2, 0, 94_525e18);
        _poke(id);
        Order memory o = engine.getOrder(2);
        assertEq(uint8(o.orderType), uint8(OrderType.Close));
        assertEq(o.triggerPrice, 94_525e18, "the worst price: the bid less 0.5%");
        assertTrue(_pos().isLong, "still long until the keeper closes it");
        assertEq(uint8(_state(id).target), uint8(Strategies.Side.Short));

        _fill(id, 95_000);
        assertEq(_pos().trader, address(0));
        // The next poke (due at once) records the close and opens the short.
        assertTrue(strats.due(id));
        vm.expectEmit(true, false, false, true, address(strats));
        emit OrderPlaced(id, Strategies.Action.Open, 3, 1_000e6, 94_525e18);
        _poke(id);
        assertEq(uint8(_state(id).holding), uint8(Strategies.Side.Flat));
        _fill(id, 95_000);
        _poke(id);
        Position memory p = _pos();
        assertFalse(p.isLong);
        assertEq(p.size, 1_000e6);
        assertEq(uint8(_state(id).holding), uint8(Strategies.Side.Short));
        assertEq(_state(id).actions, 3);
    }

    function test_trend_longOnly_goesFlatInsteadOfShort() public {
        uint256 id = _trendLong(_trend(2, 4, 0, false));
        _sampleAt(id, 95_000);
        assertEq(uint8(_state(id).target), uint8(Strategies.Side.Flat));
        _fill(id, 95_000);
        _poke(id);
        assertEq(_pos().trader, address(0));
        Strategies.State memory s = _state(id);
        assertEq(uint8(s.holding), uint8(Strategies.Side.Flat));
        assertFalse(s.todo);
        assertEq(s.pendingOrder, 0, "nothing opened");
        _sampleAt(id, 90_000);
        assertEq(engine.nextOrderId(), 3, "still nothing");
    }

    function test_trend_aStoppedOutPositionIsNotReopened_untilTheNextSignal() public {
        Strategies.Config memory c = _trend(2, 4, 0, true);
        c.stopLossBps = 200;
        c.takeProfitBps = 300;
        uint256 id = _trendLong(c);
        // The new position carries the stop and the target, from the price it was placed at (103,000).
        Position memory p = _pos();
        assertTrue(p.slOrderId != 0 && p.tpOrderId != 0);
        assertEq(engine.getOrder(p.slOrderId).triggerPrice, 100_940e18);
        assertEq(engine.getOrder(p.tpOrderId).triggerPrice, 106_090e18);

        // A dip trips the stop.
        _setBtc(100_000);
        _exec(p.slOrderId);
        assertEq(_pos().trader, address(0));
        // The trend is still (barely) long, but the strategy does not buy back in.
        skip(58);
        _setBtc(101_000);
        vm.expectEmit(true, false, false, true, address(strats));
        emit ExitedElsewhere(id, Strategies.Side.Long);
        _poke(id);
        Strategies.State memory s = _state(id);
        assertEq(uint8(s.target), uint8(Strategies.Side.Long));
        assertEq(uint8(s.holding), uint8(Strategies.Side.Flat));
        assertFalse(s.todo);
        assertEq(s.pendingOrder, 0);
        // The next signal opens straight away (already flat).
        _sampleAt(id, 95_000);
        assertEq(uint8(_state(id).target), uint8(Strategies.Side.Short));
        assertEq(uint8(_state(id).pendingAction), uint8(Strategies.Action.Open));
        assertFalse(engine.getOrder(_state(id).pendingOrder).isLong);
    }

    // ───────────────────────────── Mean reversion ─────────────────────────────

    function test_meanReversion_buysTheDip_exitsBackInsideTheBand_andShortsASpike() public {
        // EMA over 4 samples; in when 2% away from it, out once back within 0.5%.
        uint256 id = _create(_meanRevert(4, 200, 50, true));
        _setBtc(100_000);
        _poke(id);
        _sampleAt(id, 100_000);
        _sampleAt(id, 100_000);
        _sampleAt(id, 100_000);
        // 3% under the mean of the samples before it: long.
        _sampleAt(id, 97_000);
        assertEq(uint8(_state(id).target), uint8(Strategies.Side.Long));
        assertEq(_state(id).emaFast, 98_800e18, "the dip folded in after the comparison");
        _fill(id, 97_000);
        _poke(id);
        assertTrue(_pos().isLong);
        // 98,000 vs a mean of 98,800: neither 2% under it nor back within 0.5%. Holds.
        _sampleAt(id, 98_000);
        assertEq(uint8(_state(id).target), uint8(Strategies.Side.Long));
        assertEq(_state(id).pendingOrder, 0);
        // 98,500 vs 98,480: back. Flat.
        _sampleAt(id, 98_500);
        assertEq(uint8(_state(id).target), uint8(Strategies.Side.Flat));
        _fill(id, 98_500);
        _poke(id);
        assertEq(_pos().trader, address(0));
        // 3.6% over the mean (98,488): short.
        _sampleAt(id, 102_000);
        assertEq(uint8(_state(id).target), uint8(Strategies.Side.Short));
        _fill(id, 102_000);
        _poke(id);
        assertFalse(_pos().isLong);
    }

    function test_meanReversion_longOnly_ignoresSpikes() public {
        uint256 id = _create(_meanRevert(4, 200, 50, false));
        _setBtc(100_000);
        _poke(id);
        _sampleAt(id, 100_000);
        _sampleAt(id, 100_000);
        _sampleAt(id, 100_000);
        _sampleAt(id, 103_000);
        assertEq(uint8(_state(id).target), uint8(Strategies.Side.Flat));
        assertEq(engine.nextOrderId(), 1);
    }

    function test_emaMath_isExactFixedPoint() public {
        // Period 3: alpha is exactly 1/2. 100,000 then 110,000 then 120,000 gives 105,000 then 112,500.
        uint256 id = _create(_meanRevert(3, 2_000, 0, true));
        _setBtc(100_000);
        _poke(id);
        assertEq(_state(id).emaFast, 100_000e18, "seeded with the first price");
        _sampleAt(id, 110_000);
        assertEq(_state(id).emaFast, 105_000e18);
        _sampleAt(id, 120_000);
        assertEq(_state(id).emaFast, 112_500e18);
        _sampleAt(id, 112_500);
        assertEq(_state(id).emaFast, 112_500e18, "a price on the EMA leaves it exactly where it is");

        // Period 2: alpha = 2/3, rounded down to 18 decimals, and the step rounded down.
        vm.prank(alice);
        uint256 t = strats.create(acct, ETH, _trend(2, 4, 0, true));
        _setEth(4_000);
        _poke(t);
        skip(59);
        _setEth(4_100);
        _poke(t);
        uint256 alpha = uint256(2e18) / 3;
        uint256 expected = (4_100e18 * alpha + 4_000e18 * (1e18 - alpha)) / 1e18;
        assertEq(strats.getStrategy(t).state.emaFast, expected);
        assertEq(strats.getStrategy(t).state.emaSlow, 4_040e18, "alpha 2/5 is exact");
        assertApproxEqRel(expected, 4_066_666_666_666_666_666_667, 1, "within 1e-18 of the exact value");
    }

    // ───────────────────────────── Copy ─────────────────────────────

    function test_copy_mirrorsTheLeader_resizes_andFlattens() public {
        // Half of bob's size, at most 6,000.
        uint256 id = _create(_copy(bob, 5_000, 6_000e6));
        _setBtc(100_000);
        _poke(id);
        assertEq(_state(id).pendingOrder, 0, "the leader is flat");

        // bob goes long 8,000: the copy opens 4,000 (at its own 10x: 400 of margin).
        _open(bob, BTC, true, 1_000e6, 8_000e6);
        _sampleAt(id, 100_000);
        Order memory o = engine.getOrder(_state(id).pendingOrder);
        assertTrue(o.isLong);
        assertEq(o.size, 4_000e6);
        assertEq(o.margin, 400e6);
        _fill(id, 100_000);
        _poke(id);
        assertEq(_pos().size, 4_000e6);
        assertFalse(_state(id).todo, "within 10% of the target");

        // bob doubles to 16,000: half is 8,000, capped at 6,000; the copy adds 2,000.
        _open(bob, BTC, true, 1_000e6, 8_000e6);
        _sampleAt(id, 100_000);
        assertEq(uint8(_state(id).pendingAction), uint8(Strategies.Action.Increase));
        assertEq(engine.getOrder(_state(id).pendingOrder).size, 2_000e6);
        _fill(id, 100_000);
        _poke(id);
        assertEq(_pos().size, 6_000e6);

        // bob trims to 10,000: target 5,000, the copy is 20% over and takes 1,000 off.
        _setBtc(100_000);
        vm.prank(bob);
        engine.closePosition(BTC, 6_000e6, 0, _noBytes());
        _sampleAt(id, 100_000);
        assertEq(uint8(_state(id).pendingAction), uint8(Strategies.Action.Reduce));
        o = engine.getOrder(_state(id).pendingOrder);
        assertEq(uint8(o.orderType), uint8(OrderType.Close));
        assertEq(o.size, 1_000e6);
        _fill(id, 100_000);
        _poke(id);
        assertEq(_pos().size, 5_000e6);

        // bob adds 600 (target 5,300): under 10% off, no trade.
        _setBtc(100_000);
        _open(bob, BTC, true, 100e6, 600e6);
        _sampleAt(id, 100_000);
        assertEq(_state(id).pendingOrder, 0);
        assertEq(_state(id).targetSize, 5_300e6);

        // bob closes: so does the copy.
        _setBtc(100_000);
        _close(bob, BTC);
        _sampleAt(id, 100_000);
        assertEq(uint8(_state(id).pendingAction), uint8(Strategies.Action.Close));
        _fill(id, 100_000);
        _poke(id);
        assertEq(_pos().trader, address(0));
        assertEq(uint8(_state(id).holding), uint8(Strategies.Side.Flat));
    }

    function test_copy_buildsALargeTargetOneCappedOrderAtATime_andFlipsWithTheLeader() public {
        // The same size as bob, at most 5,000 per order.
        uint256 id = _create(_copy(bob, 10_000, 20_000e6));
        _setBtc(100_000);
        _open(bob, BTC, false, 1_200e6, 12_000e6);
        _poke(id);
        assertEq(engine.getOrder(_state(id).pendingOrder).size, 5_000e6);
        _fill(id, 100_000);
        _poke(id); // records it and adds the next 5,000 at once
        assertEq(uint8(_state(id).pendingAction), uint8(Strategies.Action.Increase));
        _fill(id, 100_000);
        _poke(id);
        _fill(id, 100_000);
        _poke(id);
        assertEq(_pos().size, 12_000e6);
        assertFalse(_pos().isLong);
        assertFalse(_state(id).todo);

        // bob flips long: the copy closes, then opens long.
        _setBtc(100_000);
        _close(bob, BTC);
        _open(bob, BTC, true, 500e6, 3_000e6);
        _sampleAt(id, 100_000);
        assertEq(uint8(_state(id).pendingAction), uint8(Strategies.Action.Close));
        _fill(id, 100_000);
        _poke(id);
        assertEq(uint8(_state(id).pendingAction), uint8(Strategies.Action.Open));
        _fill(id, 100_000);
        _poke(id);
        assertTrue(_pos().isLong);
        assertEq(_pos().size, 3_000e6);
    }

    function test_copy_sitsOutTheTradeItWasClosedOutOf_andFollowsTheNextOne() public {
        uint256 id = _create(_copy(bob, 10_000, 10_000e6));
        _setBtc(100_000);
        _open(bob, BTC, true, 500e6, 2_000e6);
        uint64 bobsTrade = engine.getPosition(bob, BTC).openedAt;
        _poke(id);
        _fill(id, 100_000);
        _poke(id);
        assertEq(_pos().size, 2_000e6);

        // The owner closes the copy by hand; bob is still in.
        _setBtc(100_000);
        vm.prank(alice);
        acct.closePosition(BTC, 0, 0, _noBytes());
        skip(57);
        _setBtc(100_000);
        vm.expectEmit(true, false, false, true, address(strats));
        emit ExitedElsewhere(id, Strategies.Side.Long);
        _poke(id);
        assertEq(_state(id).blockedAt, bobsTrade);
        assertEq(_state(id).pendingOrder, 0, "not reopened");
        _sampleAt(id, 100_000);
        assertEq(_state(id).pendingOrder, 0, "still not");

        // bob's next trade is followed.
        _setBtc(100_000);
        _close(bob, BTC);
        _open(bob, BTC, true, 500e6, 3_000e6);
        _sampleAt(id, 100_000);
        assertEq(_state(id).blockedAt, 0);
        assertEq(engine.getOrder(_state(id).pendingOrder).size, 3_000e6);
    }

    function test_copy_longOnlyIgnoresTheLeadersShorts() public {
        Strategies.Config memory c = _copy(bob, 10_000, 10_000e6);
        c.allowShort = false;
        uint256 id = _create(c);
        _setBtc(100_000);
        _open(bob, BTC, false, 500e6, 2_000e6);
        _poke(id);
        assertEq(_state(id).pendingOrder, 0);
        assertEq(uint8(_state(id).target), uint8(Strategies.Side.Flat));
    }

    // ───────────────────────────── Orders, refusals, gas ─────────────────────────────

    function test_anOrderStillOnTheBookAnIntervalLaterIsCancelled_andTheStepTriedAgain() public {
        uint256 id = _create(_trend(2, 4, 0, true));
        _setBtc(100_000);
        _poke(id);
        _sampleAt(id, 101_000);
        _sampleAt(id, 102_000);
        _sampleAt(id, 103_000);
        uint256 first = _state(id).pendingOrder;
        // The price gaps 2% up before the keeper gets to it: over the bound, so the order rests.
        _setBtc(105_100);
        vm.prank(keeper);
        vm.expectRevert(PerpEngine.TriggerNotMet.selector);
        engine.executeOrder(first, _noBytes());
        assertFalse(strats.due(id), "still working");

        // A full interval later: cancelled (the escrow back to the account) and placed again at the new price.
        uint256 before = _bal(address(acct));
        skip(58);
        _setBtc(105_100);
        vm.expectEmit(true, false, false, true, address(strats));
        emit OrderDropped(id, first);
        _poke(id);
        assertEq(engine.getOrder(first).trader, address(0));
        uint256 second = _state(id).pendingOrder;
        assertGt(second, first);
        assertEq(engine.getOrder(second).triggerPrice, (105_100e18 * 10_050) / 10_000);
        // The refund of the old escrow and the new escrow are the same size: net nothing moved.
        assertEq(_bal(address(acct)), before);
        _fill(id, 105_100);
        _poke(id);
        assertEq(_pos().entryPrice, 105_100e18);
    }

    function test_anOrderTheOwnerCancelsEndsTheStep_untilTheNextSignal() public {
        uint256 id = _create(_trend(2, 4, 0, true));
        _setBtc(100_000);
        _poke(id);
        _sampleAt(id, 101_000);
        _sampleAt(id, 102_000);
        _sampleAt(id, 103_000);
        uint256 orderId = _state(id).pendingOrder;
        vm.prank(alice);
        acct.cancelOrder(orderId);
        _setBtc(103_000);
        assertTrue(strats.due(id));
        _poke(id);
        Strategies.State memory s = _state(id);
        assertEq(s.pendingOrder, 0);
        assertFalse(s.todo, "not placed again");
        assertEq(uint8(s.target), uint8(Strategies.Side.Long));
        assertEq(engine.nextOrderId(), orderId + 1);
        _sampleAt(id, 104_000);
        assertEq(engine.nextOrderId(), orderId + 1, "the trend still holds: nothing new");
    }

    function test_threeRefusalsInARowPause_andResumeTriesAgain() public {
        uint256 id = _create(_trend(2, 4, 0, true));
        _setBtc(100_000);
        _poke(id);
        _sampleAt(id, 101_000);
        _sampleAt(id, 102_000);
        // The owner shrinks the contract's approval under an entry: the account refuses it.
        vm.prank(alice);
        acct.setAgent(address(strats), type(uint64).max, 20, 50e6);
        skip(59);
        _setBtc(103_000);
        vm.expectEmit(true, false, false, true, address(strats));
        emit ActionRefused(id, Strategies.Action.Open);
        _poke(id);
        assertEq(_state(id).refusals, 1);
        assertEq(_state(id).pendingOrder, 0);
        assertFalse(strats.due(id), "tried again after an interval, not at every poke");
        _sampleAt(id, 104_000);
        assertEq(_state(id).refusals, 2);
        skip(59);
        _setBtc(105_000);
        vm.expectEmit(true, false, false, true, address(strats));
        emit StrategyPaused(id, true);
        _poke(id);
        assertEq(uint8(_state(id).status), uint8(Strategies.Status.Paused));
        assertFalse(strats.due(id));
        uint32 samples = _state(id).samples;
        _sampleAt(id, 106_000);
        assertEq(_state(id).samples, samples, "paused: no samples");

        // Approval restored and resumed: the long goes out at the next poke; the EMAs warm up again.
        vm.startPrank(alice);
        acct.setAgent(address(strats), type(uint64).max, 20, 1_000e6);
        strats.resume(id);
        vm.stopPrank();
        _setBtc(106_000);
        _poke(id);
        Strategies.State memory s = _state(id);
        assertEq(s.samples, 1);
        assertEq(s.refusals, 0);
        assertEq(uint8(s.pendingAction), uint8(Strategies.Action.Open));
        assertTrue(s.pendingOrder != 0);
    }

    function test_aPokeShortOfGasForItsOrderRevertsWhole() public {
        uint256 id = _create(_trend(2, 4, 0, true));
        _setBtc(100_000);
        _poke(id);
        _sampleAt(id, 101_000);
        _sampleAt(id, 102_000);
        skip(59);
        _setBtc(103_000);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        vm.expectRevert(Strategies.InsufficientGas.selector);
        strats.poke{gas: 300_000}(ids);
        assertTrue(strats.due(id), "still due: nothing was used up");
        assertEq(_state(id).samples, 3, "not even the sample");
        assertEq(_state(id).refusals, 0, "not counted as the account's refusal");
        strats.poke(ids);
        assertTrue(_state(id).pendingOrder != 0);
    }

    function test_gasPerPoke() public {
        uint256 id = _create(_trend(2, 4, 0, true));
        _setBtc(100_000);
        uint256[] memory ids = new uint256[](1);
        ids[0] = id;
        uint256 g = gasleft();
        strats.poke(ids);
        uint256 firstSample = g - gasleft();
        _sampleAt(id, 101_000);
        skip(59);
        _setBtc(102_000);
        g = gasleft();
        strats.poke(ids);
        uint256 sample = g - gasleft();
        skip(59);
        _setBtc(103_000);
        g = gasleft();
        strats.poke(ids);
        uint256 sampleAndOpen = g - gasleft();
        _setBtc(103_000);
        _exec(_state(id).pendingOrder);
        g = gasleft();
        strats.poke(ids);
        uint256 settle = g - gasleft();
        emit log_named_uint("first sample", firstSample);
        emit log_named_uint("sample", sample);
        emit log_named_uint("sample + open order", sampleAndOpen);
        emit log_named_uint("settle a fill", settle);
        assertLt(sample, 150_000);
        assertLt(sampleAndOpen, 600_000);
        assertLt(settle, 150_000);
    }

    // ───────────────────────────── Management ─────────────────────────────

    function test_onlyTheOwnerOrAnAgentManages_pauseDropsAnOpenOrder_stopFreesTheMarket() public {
        Strategies.Config memory c = _trend(2, 4, 0, true);
        vm.prank(stranger);
        vm.expectRevert(Strategies.NotAllowed.selector);
        strats.create(acct, BTC, c);
        vm.prank(agentKey);
        uint256 id = strats.create(acct, BTC, c);
        vm.prank(alice);
        vm.expectRevert(Strategies.MarketTaken.selector);
        strats.create(acct, BTC, c);

        _setBtc(100_000);
        _poke(id);
        _sampleAt(id, 101_000);
        _sampleAt(id, 102_000);
        _sampleAt(id, 103_000);
        uint256 orderId = _state(id).pendingOrder;
        assertTrue(engine.getOrder(orderId).trader != address(0));

        vm.prank(stranger);
        vm.expectRevert(Strategies.NotAllowed.selector);
        strats.pause(id);
        // Pausing never adds exposure: its open order is cancelled and the escrow comes back.
        uint256 before = _bal(address(acct));
        vm.prank(agentKey);
        strats.pause(id);
        assertEq(engine.getOrder(orderId).trader, address(0));
        assertGt(_bal(address(acct)), before);
        assertEq(uint8(_state(id).status), uint8(Strategies.Status.Paused));
        assertFalse(strats.due(id));
        vm.prank(alice);
        vm.expectRevert(Strategies.NoStrategy.selector);
        strats.pause(id);

        vm.prank(alice);
        strats.resume(id);
        assertEq(uint8(_state(id).status), uint8(Strategies.Status.Active));
        vm.prank(stranger);
        vm.expectRevert(Strategies.NotAllowed.selector);
        strats.stop(id);
        vm.prank(alice);
        strats.stop(id);
        assertEq(uint8(_state(id).status), uint8(Strategies.Status.Stopped));
        assertEq(strats.strategyOf(address(acct), BTC), 0);
        assertEq(strats.strategyCount(), 0);
        vm.prank(alice);
        vm.expectRevert(Strategies.NoStrategy.selector);
        strats.resume(id);
        _setBtc(100_000);
        _poke(id); // a stopped strategy does nothing
        assertEq(_state(id).pendingOrder, 0);

        // The market is free again; the account's history keeps both.
        vm.prank(alice);
        uint256 again = strats.create(acct, BTC, c);
        assertEq(again, id + 1);
        uint256[] memory mine = strats.strategiesOf(address(acct));
        assertEq(mine.length, 2);
        assertEq(mine[1], again);
        (uint256[] memory ids, Strategies.Strategy[] memory list) = strats.getStrategies(0, 10);
        assertEq(ids.length, 1);
        assertEq(ids[0], again);
        assertEq(list[0].account, address(acct));
        assertEq(list[0].marketId, BTC);
        assertEq(uint8(list[0].config.kind), uint8(Strategies.Kind.Trend));
        (ids,) = strats.getStrategies(1, 10);
        assertEq(ids.length, 0);
    }

    function test_anAgentCannotStartAStrategyBeyondItsOwnPolicy_andTheContractMustBeApproved() public {
        // agentKey may use 1,000 per call at up to 20x.
        Strategies.Config memory c = _trend(2, 4, 0, true);
        c.margin = 2_000e6;
        vm.prank(agentKey);
        vm.expectRevert(Strategies.AgentPolicyExceeded.selector);
        strats.create(acct, BTC, c);
        c.margin = 100e6;
        c.leverage = 21;
        vm.prank(agentKey);
        vm.expectRevert(Strategies.AgentPolicyExceeded.selector);
        strats.create(acct, BTC, c);

        // The contract itself is approved for 1,000 per order at 20x: a bigger entry could never go out.
        c.leverage = 10;
        c.margin = 1_500e6;
        vm.prank(alice);
        vm.expectRevert(Strategies.NotApproved.selector);
        strats.create(acct, BTC, c);
        // Nor on an account that never approved it, or that keeps it out of the market.
        AgentAccount b = _account(bob, 0);
        c.margin = 100e6;
        vm.prank(bob);
        vm.expectRevert(Strategies.NotApproved.selector);
        strats.create(b, BTC, c);
        vm.startPrank(alice);
        acct.setRestrictMarkets(true);
        acct.setMarketAllowed(ETH, true);
        vm.expectRevert(Strategies.NotApproved.selector);
        strats.create(acct, BTC, c);
        strats.create(acct, ETH, c);
        // The owner is not capped by any agent policy, only by what the contract is approved for.
        acct.setAgent(address(strats), type(uint64).max, 50, 5_000e6);
        acct.setMarketAllowed(BTC, true);
        c.margin = 4_000e6;
        c.leverage = 50;
        uint256 id = strats.create(acct, BTC, c);
        vm.stopPrank();
        assertEq(strats.getStrategy(id).config.margin, 4_000e6);
    }

    function test_invalidConfigsAreRefused() public {
        vm.startPrank(alice);
        Strategies.Config memory c = _trend(2, 4, 0, true);
        c.interval = 59;
        _expectInvalid(c, BTC);
        c = _trend(4, 4, 0, true); // fast not under slow
        _expectInvalid(c, BTC);
        c = _trend(1, 4, 0, true);
        _expectInvalid(c, BTC);
        c = _trend(2, 201, 0, true);
        _expectInvalid(c, BTC);
        c = _trend(2, 4, 2_001, true);
        _expectInvalid(c, BTC);
        c = _trend(2, 4, 0, true);
        c.maxSlippageBps = 0;
        _expectInvalid(c, BTC);
        c.maxSlippageBps = 501;
        _expectInvalid(c, BTC);
        c = _trend(2, 4, 0, true);
        c.leverage = 101; // over the market's 100x
        _expectInvalid(c, BTC);
        c.leverage = 0;
        _expectInvalid(c, BTC);
        c = _trend(2, 4, 0, true);
        c.margin = 4e6; // under the engine's minimum
        _expectInvalid(c, BTC);
        c = _trend(2, 4, 0, true);
        c.takeProfitBps = 50; // not wider than the slippage bound
        _expectInvalid(c, BTC);
        c.takeProfitBps = 0;
        c.stopLossBps = 5;
        _expectInvalid(c, BTC);
        c = _trend(2, 4, 0, true);
        c.leader = bob; // copy fields on a trend
        _expectInvalid(c, BTC);
        c = _meanRevert(4, 200, 200, true); // the exit band must sit inside the entry band
        _expectInvalid(c, BTC);
        c = _meanRevert(4, 0, 0, true);
        _expectInvalid(c, BTC);
        c = _meanRevert(4, 200, 50, true);
        c.slowPeriod = 8;
        _expectInvalid(c, BTC);
        c = _copy(address(0), 10_000, 1_000e6);
        _expectInvalid(c, BTC);
        c = _copy(address(acct), 10_000, 1_000e6); // itself
        _expectInvalid(c, BTC);
        c = _copy(bob, 0, 1_000e6);
        _expectInvalid(c, BTC);
        c = _copy(bob, 100_001, 1_000e6);
        _expectInvalid(c, BTC);
        c = _copy(bob, 10_000, 0);
        _expectInvalid(c, BTC);
        c = _copy(bob, 10_000, 1_000e6);
        c.period = 4;
        _expectInvalid(c, BTC);
        _expectInvalid(_trend(2, 4, 0, true), keccak256("NO-SUCH-MARKET"));
        vm.stopPrank();
        // A dated market that has expired.
        vm.warp(EXPIRY);
        vm.prank(alice);
        vm.expectRevert(Strategies.InvalidStrategy.selector);
        strats.create(acct, FUT, _trend(2, 4, 0, true));
    }

    function _expectInvalid(Strategies.Config memory c, bytes32 market) internal {
        vm.expectRevert(Strategies.InvalidStrategy.selector);
        strats.create(acct, market, c);
    }

    function test_dueNeedsAUsablePrice_andAPokeWithoutOneDoesNothing() public {
        uint256 id = _create(_trend(2, 4, 0, true));
        skip(1 hours); // every price is stale
        assertFalse(strats.due(id));
        _poke(id);
        assertEq(_state(id).samples, 0);
        _setBtc(100_000);
        assertTrue(strats.due(id));
    }

    function test_onePokeRunsSeveralStrategies() public {
        uint256 a = _create(_copy(bob, 10_000, 10_000e6));
        AgentAccount cAcct = _account(carol, 1_000e6);
        Strategies.Config memory c = _copy(bob, 5_000, 10_000e6);
        vm.prank(carol);
        uint256 b = strats.create(cAcct, BTC, c);
        _setBtc(100_000);
        _open(bob, BTC, true, 500e6, 4_000e6);
        uint256[] memory ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
        strats.poke(ids);
        assertEq(engine.getOrder(_state(a).pendingOrder).size, 4_000e6);
        assertEq(engine.getOrder(strats.getStrategy(b).state.pendingOrder).size, 2_000e6);
        assertEq(engine.getOrder(strats.getStrategy(b).state.pendingOrder).trader, address(cAcct));
    }
}
