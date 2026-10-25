// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Base} from "./Base.t.sol";
import {PerpEngine} from "../src/PerpEngine.sol";
import {PerpEngineBase} from "../src/PerpEngineBase.sol";
import {AgentAccount, AgentAccountFactory} from "../src/AgentAccount.sol";
import {OrderType, Position} from "../src/Types.sol";

/// @notice 1000x: allowed per market, but above DIRECT_MAX_LEVERAGE only through keeper-executed orders, which
///         always fill at a price published after the order (no stale-price option against the vault).
contract HighLeverageTest is Base {
    uint256 internal constant MARGIN = 10e6; // $10
    uint256 internal constant SIZE_1000X = 10_000e6; // $10,000

    function setUp() public override {
        super.setUp();
        vm.startPrank(owner);
        engine.setMarket(BTC, true, 1000, MAX_OI_PER_SIDE, SKEW_SCALE);
        engine.setMarket(FUT, true, 1000, MAX_OI_PER_SIDE, SKEW_SCALE);
        vm.stopPrank();
    }

    /// @dev Opens a 1000x long on BTC through a marketable limit order filled by the keeper at the next price.
    function _open1000x(address who) internal returns (uint256 orderId) {
        vm.prank(who);
        orderId = engine.createLimitOrder(_limit(BTC, true, MARGIN, SIZE_1000X, 101_000e18));
        _setBtc(100_000); // a price published after the order
        vm.prank(keeper);
        engine.executeOrder(orderId, _noBytes());
    }

    function test_marketAcceptsUpTo5000x_notMore() public {
        assertEq(engine.getMarket(BTC).maxLeverage, 1000);
        vm.startPrank(owner);
        engine.setMarket(BTC, true, 5000, MAX_OI_PER_SIDE, SKEW_SCALE);
        vm.expectRevert(PerpEngineBase.InvalidParam.selector);
        engine.setMarket(BTC, true, 5001, MAX_OI_PER_SIDE, SKEW_SCALE);
        vm.stopPrank();
    }

    function test_directOpen_allowedUpTo100x_refusedAbove() public {
        _open(alice, BTC, true, MARGIN, MARGIN * 100);
        vm.prank(bob);
        vm.expectRevert(PerpEngineBase.HighLeverageNeedsOrder.selector);
        engine.openPosition(_params(BTC, true, MARGIN, MARGIN * 100 + 1), _noBytes());
    }

    function test_1000x_opensThroughKeeperOrder() public {
        _open1000x(alice);
        Position memory p = engine.getPosition(alice, BTC);
        assertEq(p.size, SIZE_1000X);
        assertEq(p.margin, MARGIN);
    }

    function test_1000x_leverageAboveMarketMaxStillRefused() public {
        vm.prank(alice);
        vm.expectRevert(PerpEngineBase.LeverageOutOfRange.selector);
        engine.createLimitOrder(_limit(ETH, true, MARGIN, MARGIN * 101, 5_000e18)); // ETH stays at 100x
    }

    function test_1000x_directCloseRefused_closeOrderWorks() public {
        _open1000x(alice);
        _setBtc(100_050); // +0.05%: +$5 on $10,000

        vm.prank(alice);
        vm.expectRevert(PerpEngineBase.HighLeverageNeedsOrder.selector);
        engine.closePosition(BTC, 0, 0, _noBytes());

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 closeId = engine.setTriggerOrder(BTC, OrderType.Close, 0, 0);
        _setBtc(100_050);
        vm.prank(keeper);
        engine.executeOrder(closeId, _noBytes());
        assertEq(engine.getPosition(alice, BTC).trader, address(0));
        // Margin back plus about $5 of profit, less the close fee, capped at 10% of margin ($1, not $5).
        uint256 received = usdc.balanceOf(alice) - before;
        // (The close order's execution fee went to the keeper.)
        assertApproxEqAbs(received, MARGIN + 5e6 - 1e6 - EXEC_FEE, 10);
    }

    function test_feesCappedAt10PercentOfMarginPerSide() public {
        // At 1000x, 5 bp of notional is 50% of margin; the cap makes it 10%.
        assertEq(engine.quoteOpenFee(BTC, SIZE_1000X, true, MARGIN), MARGIN / 10);
        // At 10x the cap does not bind: 5 bp of $100 notional plus the skew surcharge.
        assertLt(engine.quoteOpenFee(BTC, 100e6, true, MARGIN), MARGIN / 10);

        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(_limit(BTC, true, MARGIN, SIZE_1000X, 101_000e18));
        // Escrow: margin + fee budget (capped) + one execution fee.
        assertEq(before - usdc.balanceOf(alice), MARGIN + MARGIN / 10 + EXEC_FEE);
        _setBtc(100_000);
        vm.prank(keeper);
        engine.executeOrder(id, _noBytes());
        assertEq(before - usdc.balanceOf(alice), MARGIN + MARGIN / 10 + EXEC_FEE);
    }

    function test_1000x_liquidatedByASmallMove() public {
        _open1000x(alice);
        // Liquidation at 90% of margin lost: $9 on $10,000 is a 0.09% move.
        _setBtc(99_900); // -0.1%
        vm.prank(keeper);
        _liquidate(alice);
        assertEq(engine.getPosition(alice, BTC).trader, address(0));
    }

    function test_1000x_profitCappedAtMaxProfitMultiple() public {
        _open1000x(alice);
        _setBtc(102_000); // +2% on 1000x would be 20x margin; capped at 10x
        uint256 before = usdc.balanceOf(alice);
        vm.prank(alice);
        uint256 closeId = engine.setTriggerOrder(BTC, OrderType.Close, 0, 0);
        _setBtc(102_000);
        vm.prank(keeper);
        engine.executeOrder(closeId, _noBytes());
        uint256 received = usdc.balanceOf(alice) - before;
        assertLe(received, MARGIN + MARGIN * engine.maxProfitMultiple());
        assertGt(received, MARGIN * 10);
    }

    function test_1000x_takeProfitAndStopLossFill() public {
        _open1000x(alice);
        vm.startPrank(alice);
        engine.setTriggerOrder(BTC, OrderType.TakeProfit, 100_060e18, 0);
        uint256 sl = engine.setTriggerOrder(BTC, OrderType.StopLoss, 99_950e18, 0);
        vm.stopPrank();
        _setBtc(99_940);
        vm.prank(keeper);
        engine.executeOrder(sl, _noBytes());
        assertEq(engine.getPosition(alice, BTC).trader, address(0));
    }

    function test_settledDatedMarket_directCloseAllowedAtAnyLeverage() public {
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(_limit(FUT, true, MARGIN, SIZE_1000X, 101_000e18));
        _setBtc(100_000);
        vm.prank(keeper);
        engine.executeOrder(id, _noBytes());

        vm.warp(EXPIRY + 1);
        _setBtc(100_020);
        engine.settleMarket(FUT, _noBytes());
        vm.prank(alice);
        engine.closePosition(FUT, 0, 0, _noBytes()); // fixed settlement price: no stale-price option left
        assertEq(engine.getPosition(alice, FUT).trader, address(0));
    }

    function test_agentAccount_canTrade1000xWithinPolicy() public {
        AgentAccountFactory factory = new AgentAccountFactory(IERC20(address(usdc)), engine);
        AgentAccount acct = AgentAccount(factory.createAccount(alice));
        vm.prank(alice);
        usdc.transfer(address(acct), 1_000e6);
        address agent = makeAddr("agent");
        vm.prank(alice);
        acct.setAgent(agent, uint64(block.timestamp + 1 days), 1000, 50e6);

        vm.prank(agent);
        uint256 id = acct.createLimitOrder(_limit(BTC, true, MARGIN, SIZE_1000X, 101_000e18));
        _setBtc(100_000);
        vm.prank(keeper);
        engine.executeOrder(id, _noBytes());
        assertEq(engine.getPosition(address(acct), BTC).size, SIZE_1000X);

        vm.prank(agent);
        vm.expectRevert(PerpEngineBase.HighLeverageNeedsOrder.selector);
        acct.closePosition(BTC, 0, 0, _noBytes());
    }
}
