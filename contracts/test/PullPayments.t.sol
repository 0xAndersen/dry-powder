// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

import {HouseVault} from "../src/HouseVault.sol";
import {PerpEngine} from "../src/PerpEngine.sol";
import {RewardToken} from "../src/RewardToken.sol";
import {IHouseVault} from "../src/interfaces/IHouseVault.sol";
import {IRewardToken} from "../src/interfaces/IRewardToken.sol";
import {LimitParams, OpenParams, OrderType} from "../src/Types.sol";
import {Base} from "./Base.t.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";
import {OddUSDC} from "./mocks/OddUSDC.sol";

/// @notice Payments to traders never block: when USDC refuses a transfer the amount is parked in `claimable`
///         for that same address, and the position or order is removed regardless.
contract PullPaymentsTest is Base {
    function setUp() public override {
        super.setUp();
        _flatFees();
    }

    function _blocklist(address who) internal {
        usdc.setBlocklisted(who, true);
    }

    function test_claim_nothingToClaim() public {
        vm.prank(alice);
        vm.expectRevert(PerpEngine.NothingToClaim.selector);
        engine.claim();
    }

    function test_blocklisted_manualClose_inProfit() public {
        bytes32 key = _open(alice, BTC, true, 1_000e6, 10_000e6);
        _blocklist(alice);
        _setBtc(101_000);

        // The close itself is unaffected: same event, same accounting, the vault pays the engine.
        vm.expectEmit(address(engine));
        emit PerpEngine.PositionClosed(key, alice, BTC, 101_000e18, 100e6, 5e6, 1_095e6);
        vm.expectEmit(address(engine));
        emit PerpEngine.PaymentDeferred(alice, 1_095e6);
        _close(alice, BTC);

        assertEq(engine.positionCount(), 0);
        assertEq(engine.totalOpenInterest(), 0);
        assertEq(engine.claimable(alice), 1_095e6);
        assertEq(engine.totalClaimable(), 1_095e6);
        assertEq(usdc.balanceOf(address(engine)), 1_095e6);
        assertEq(vault.totalTraderProfits(), 100e6);
        assertEq(vault.totalHouseBalance(), LP_SEED + 5e6 + 5e6 - 100e6);
        _assertEngineSolvent();

        // While she is blocklisted the claim reverts and changes nothing.
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(MockUSDC.Blocklisted.selector, alice));
        engine.claim();
        assertEq(engine.claimable(alice), 1_095e6);
        // Nobody else can take it.
        vm.prank(bob);
        vm.expectRevert(PerpEngine.NothingToClaim.selector);
        engine.claim();

        usdc.setBlocklisted(alice, false);
        uint256 before = usdc.balanceOf(alice);
        vm.expectEmit(address(engine));
        emit PerpEngine.Claimed(alice, 1_095e6);
        vm.prank(alice);
        engine.claim();
        assertEq(usdc.balanceOf(alice), before + 1_095e6);
        assertEq(engine.claimable(alice), 0);
        assertEq(engine.totalClaimable(), 0);
        assertEq(usdc.balanceOf(address(engine)), 0);

        vm.prank(alice);
        vm.expectRevert(PerpEngine.NothingToClaim.selector);
        engine.claim();
    }

    function test_blocklisted_manualClose_atALoss() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        _blocklist(alice);
        _setBtc(99_000);
        _close(alice, BTC);
        // margin 1,000 - loss 100 - fee 5; the loss and the rebate are booked as usual
        assertEq(engine.claimable(alice), 895e6);
        assertEq(vault.totalTraderLosses(), 100e6);
        assertEq(house.balanceOf(alice), 10_000e18);
        _assertEngineSolvent();
    }

    function test_blocklisted_closeWithNothingLeft_defersNothing() public {
        _open(alice, BTC, true, 100e6, 10_000e6);
        _blocklist(alice);
        // The bid is 1.05% down: the whole margin is lost at execution, nothing is owed to her.
        _setPrice(BTC, 99_110e8, 160e8, -8);
        _close(alice, BTC);
        assertEq(engine.claimable(alice), 0);
        assertEq(engine.totalClaimable(), 0);
        assertEq(engine.positionCount(), 0);
    }

    function test_blocklisted_takeProfitAndStopLoss() public {
        OpenParams memory p = _params(BTC, true, 1_000e6, 10_000e6);
        p.takeProfit = 102_000e18;
        p.stopLoss = 98_000e18;
        vm.prank(alice);
        engine.openPosition(p, _noBytes());
        vm.prank(bob);
        engine.openPosition(p, _noBytes());
        _blocklist(alice);
        _blocklist(bob);

        _setBtc(102_000);
        _exec(1); // alice's take-profit
        // margin - fee + 200 profit, plus the escrow of her cancelled stop-loss
        assertEq(engine.claimable(alice), 1_195e6 + EXEC_FEE);

        _setBtc(98_000);
        _exec(4); // bob's stop-loss
        assertEq(engine.claimable(bob), 1_000e6 - 200e6 - 5e6 + EXEC_FEE);
        assertEq(engine.totalClaimable(), 1_195e6 + 795e6 + 2 * EXEC_FEE);
        // The keeper is paid directly both times.
        assertEq(usdc.balanceOf(keeper), 2 * EXEC_FEE);
        assertEq(engine.positionCount(), 0);
        assertEq(engine.orderCount(), 0);
        _assertEngineSolvent();
    }

    function test_blocklisted_closeOrder() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        vm.prank(alice);
        uint256 id = engine.setTriggerOrder(BTC, OrderType.Close, 0, 0);
        _blocklist(alice);
        _setBtc(100_000);
        _exec(id);
        assertEq(engine.claimable(alice), 995e6);
        assertEq(engine.positionCount(), 0);
        _assertEngineSolvent();
    }

    function test_blocklisted_settlePositions() public {
        bytes32 aliceKey = _open(alice, FUT, true, 1_000e6, 10_000e6);
        bytes32 bobKey = _open(bob, FUT, false, 1_000e6, 10_000e6);
        _blocklist(alice);
        uint256 bobBefore = usdc.balanceOf(bob);
        vm.warp(EXPIRY);
        _publish(BTC, 104_000e8, 0, -8);
        engine.settleMarket(FUT, _noBytes());

        // One blocklisted trader in the batch does not hold up the others.
        assertEq(engine.settlePositions(_keys(aliceKey, bobKey)), 2);
        assertEq(engine.claimable(alice), 1_395e6);
        assertEq(usdc.balanceOf(bob), bobBefore + 595e6);
        assertEq(engine.positionCount(), 0);
        _assertEngineSolvent();
    }

    function test_blocklisted_cancelLimitOrder() public {
        LimitParams memory p = _limit(BTC, true, 1_000e6, 10_000e6, 99_000e18);
        p.takeProfit = 105_000e18;
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(p);
        uint256 escrow = 1_000e6 + 5e6 + 2 * EXEC_FEE; // margin, fee budget, the order's fee and its bracket's
        assertEq(usdc.balanceOf(address(engine)), escrow);
        _blocklist(alice);

        vm.expectEmit(address(engine));
        emit PerpEngine.OrderCancelled(id, alice);
        vm.expectEmit(address(engine));
        emit PerpEngine.PaymentDeferred(alice, escrow);
        vm.prank(alice);
        engine.cancelOrder(id);
        assertEq(engine.orderCount(), 0);
        assertEq(engine.getOrder(id).trader, address(0));
        assertEq(engine.claimable(alice), escrow);
        _assertEngineSolvent();
    }

    function test_blocklisted_cancelTriggerOrder() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        vm.prank(alice);
        uint256 id = engine.setTriggerOrder(BTC, OrderType.StopLoss, 99_000e18, 0);
        _blocklist(alice);
        vm.prank(alice);
        engine.cancelOrder(id);
        assertEq(engine.claimable(alice), EXEC_FEE);
        assertEq(engine.getPosition(alice, BTC).slOrderId, 0);
        _assertEngineSolvent();
    }

    function test_blocklisted_limitFillRefund() public {
        vm.prank(owner);
        engine.setFeeParams(5, 10, 0, EXEC_FEE); // a budget above the actual fee, so there is a refund
        vm.prank(alice);
        uint256 id = engine.createLimitOrder(_limit(BTC, true, 1_000e6, 10_000e6, 100_000e18));
        _blocklist(alice);
        _setBtc(100_000);

        // Budget 15, actual fee 5.10: the 9.90 refund cannot be delivered, but the fill goes through.
        vm.expectEmit(address(engine));
        emit PerpEngine.PaymentDeferred(alice, 9.9e6);
        _exec(id);
        assertEq(engine.getPosition(alice, BTC).size, 10_000e6);
        assertEq(engine.claimable(alice), 9.9e6);
        assertEq(usdc.balanceOf(keeper), EXEC_FEE);
        _assertEngineSolvent();

        // Deferred amounts add up, and the position can still be liquidated or closed.
        _setBtc(100_500);
        _close(alice, BTC);
        assertEq(engine.claimable(alice), 9.9e6 + 1_000e6 + 50e6 - 5e6);
        assertEq(engine.totalClaimable(), engine.claimable(alice));
        _assertEngineSolvent();
    }

    /// @dev M-05 in the v1 review: 750k of healthy notional owned by a blocklisted trader could never be
    ///      removed. Now it closes, and the LP reserve it pinned is released.
    function test_blocklisted_positionNoLongerPinsLpLiquidity() public {
        skip(LOCK);
        _refreshAll();
        _open(alice, BTC, true, 750_000e6, 750_000e6);
        _blocklist(alice);
        assertEq(engine.reservedLiquidity(), 250_000e6);
        _setBtc(100_000);
        _close(alice, BTC);
        assertEq(engine.reservedLiquidity(), 0);
        assertApproxEqAbs(vault.maxWithdraw(lp), vault.totalHouseBalance(), 1);
    }

    function test_unaffectedTraders_arePaidDirectly() public {
        _open(alice, BTC, true, 1_000e6, 10_000e6);
        uint256 before = usdc.balanceOf(alice);
        _setBtc(101_000);
        _close(alice, BTC);
        assertEq(usdc.balanceOf(alice), before + 1_095e6);
        assertEq(engine.claimable(alice), 0);
        assertEq(engine.totalClaimable(), 0);
    }

    // ───────────────────────────── Non-standard tokens ─────────────────────────────

    struct Stack {
        OddUSDC token;
        HouseVault vault;
        RewardToken house;
        PerpEngine engine;
    }

    /// @dev A second protocol instance over `OddUSDC`, sharing the fixture's oracle.
    function _deployOver() internal returns (Stack memory s) {
        s.token = new OddUSDC();
        uint256 nonce = vm.getNonce(address(this));
        address predictedVault = vm.computeCreateAddress(address(this), nonce);
        address predictedToken = vm.computeCreateAddress(address(this), nonce + 1);
        address predictedEngine = vm.computeCreateAddress(address(this), nonce + 2);
        s.vault = new HouseVault(IERC20(address(s.token)), predictedEngine, predictedToken, LOCK, EPOCH);
        s.house = new RewardToken(predictedVault, predictedEngine, STREAM);
        s.engine = new PerpEngine(
            IERC20(address(s.token)), oracle, IHouseVault(predictedVault), IRewardToken(predictedToken), owner
        );
        vm.startPrank(owner);
        s.engine.addMarket(BTC, _cfg("BTC-USD", BTC, bytes32(0), false, 0));
        s.engine.setFeeParams(5, 0, 0, EXEC_FEE);
        vm.stopPrank();

        s.token.mint(lp, LP_SEED);
        s.token.mint(alice, 10_000e6);
        vm.startPrank(lp);
        s.token.approve(address(s.vault), type(uint256).max);
        s.vault.deposit(LP_SEED, lp);
        vm.stopPrank();
        vm.prank(alice);
        s.token.approve(address(s.engine), type(uint256).max);
    }

    /// @dev A token that signals a refused transfer by returning false (no revert) defers just the same.
    function test_falseReturningToken_defersInsteadOfLosingThePayment() public {
        Stack memory s = _deployOver();
        vm.prank(alice);
        s.engine.openPosition(_params(BTC, true, 1_000e6, 10_000e6), _noBytes());
        s.token.setRefused(alice, true);
        _setBtc(101_000);

        vm.expectEmit(address(s.engine));
        emit PerpEngine.PaymentDeferred(alice, 1_095e6);
        vm.prank(alice);
        s.engine.closePosition(BTC, 0, 0, _noBytes());
        assertEq(s.engine.positionCount(), 0);
        assertEq(s.engine.claimable(alice), 1_095e6);
        assertEq(s.token.balanceOf(address(s.engine)), 1_095e6);
        assertEq(s.token.balanceOf(alice), 10_000e6 - 1_005e6);

        // claim() uses a checked transfer: a false return reverts and keeps the claim intact.
        vm.prank(alice);
        vm.expectRevert();
        s.engine.claim();
        assertEq(s.engine.claimable(alice), 1_095e6);

        s.token.setRefused(alice, false);
        vm.prank(alice);
        s.engine.claim();
        assertEq(s.token.balanceOf(alice), 10_000e6 + 90e6);
        assertEq(s.token.balanceOf(address(s.engine)), 0);
        assertEq(s.engine.totalClaimable(), 0);
    }

    /// @dev A token whose transfer returns no data at all (USDT-style) counts as paid.
    function test_noReturnDataToken_countsAsPaid() public {
        Stack memory s = _deployOver();
        vm.prank(alice);
        s.engine.openPosition(_params(BTC, true, 1_000e6, 10_000e6), _noBytes());
        s.token.setNoReturnData(true);
        _setBtc(101_000);
        vm.prank(alice);
        s.engine.closePosition(BTC, 0, 0, _noBytes());
        assertEq(s.engine.claimable(alice), 0);
        assertEq(s.token.balanceOf(alice), 10_000e6 + 90e6);
        assertEq(s.token.balanceOf(address(s.engine)), 0);
    }
}
