// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";

import {HouseVault} from "../src/HouseVault.sol";
import {PerpEngine} from "../src/PerpEngine.sol";
import {RewardToken} from "../src/RewardToken.sol";
import {Base} from "./Base.t.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev Drives the protocol with random but well-formed actions from a fixed set of actors.
contract Handler is Test {
    MockUSDC internal usdc;
    MockPyth internal pyth;
    HouseVault internal vault;
    RewardToken internal house;
    PerpEngine internal engine;

    address[] public actors;
    address internal lp;
    address internal keeper;
    bytes32[2] internal ids;
    int64[2] internal prices;

    uint256 public liquidations;
    uint256 public closes;
    uint256 public fills;

    constructor(
        MockUSDC usdc_,
        MockPyth pyth_,
        HouseVault vault_,
        RewardToken house_,
        PerpEngine engine_,
        address[] memory actors_,
        address lp_,
        address keeper_,
        bytes32 btc,
        bytes32 eth
    ) {
        usdc = usdc_;
        pyth = pyth_;
        vault = vault_;
        house = house_;
        engine = engine_;
        actors = actors_;
        lp = lp_;
        keeper = keeper_;
        ids = [btc, eth];
        prices = [int64(100_000e8), int64(4_000e8)];
        vm.deal(address(this), 1 ether);
    }

    function _publish(uint256 m) internal {
        bytes[] memory data = new bytes[](1);
        uint64 t = uint64(block.timestamp);
        data[0] = pyth.createPriceFeedUpdateData(ids[m], prices[m], 0, -8, prices[m], 0, t, t);
        pyth.updatePriceFeeds{value: 1}(data);
    }

    /// @dev Every action starts a second later with both prices fresh.
    modifier tick() {
        skip(1);
        _publish(0);
        _publish(1);
        _;
    }

    function open(uint256 actorSeed, uint256 marketSeed, bool isLong, uint256 margin, uint256 leverage, uint8 brackets)
        external
        tick
    {
        address actor = actors[actorSeed % actors.length];
        uint256 m = marketSeed % 2;
        margin = bound(margin, 5e6, 5_000e6);
        leverage = bound(leverage, 1, 100);
        uint256 price = uint256(uint64(prices[m])) * 1e10;
        PerpEngine.OpenParams memory p = PerpEngine.OpenParams({
            priceId: ids[m],
            isLong: isLong,
            margin: margin,
            size: margin * leverage,
            acceptablePrice: 0,
            takeProfit: brackets & 1 != 0 ? (isLong ? price + price / 50 : price - price / 50) : 0,
            stopLoss: brackets & 2 != 0 ? (isLong ? price - price / 200 : price + price / 200) : 0
        });
        vm.prank(actor);
        try engine.openPosition(p, new bytes[](0)) {} catch {}
    }

    function close(uint256 actorSeed, uint256 marketSeed) external tick {
        vm.prank(actors[actorSeed % actors.length]);
        try engine.closePosition(ids[marketSeed % 2], 0, new bytes[](0)) {
            ++closes;
        } catch {}
    }

    function movePrice(uint256 marketSeed, int256 bps) external tick {
        uint256 m = marketSeed % 2;
        bps = bound(bps, -300, 300);
        int256 next = (int256(prices[m]) * (10_000 + bps)) / 10_000;
        if (next < 1e8) next = 1e8;
        if (next > 1e15) next = 1e15;
        prices[m] = int64(next);
        skip(1);
        _publish(0);
        _publish(1);
        // Keepers react to every price move.
        _liquidateAll();
        _executeOrders();
    }

    function liquidateAll() external tick {
        _liquidateAll();
    }

    function _liquidateAll() internal {
        PerpEngine.PositionView[] memory ps = engine.getPositions(0, type(uint256).max);
        bytes32[] memory keys = new bytes32[](ps.length);
        for (uint256 i; i < ps.length; ++i) {
            keys[i] = ps[i].key;
        }
        vm.prank(keeper);
        try engine.liquidateBatch(keys, new bytes[](0)) returns (uint256 n) {
            liquidations += n;
        } catch {}
    }

    function createLimit(uint256 actorSeed, uint256 marketSeed, bool isLong, uint256 margin, uint256 leverage)
        external
        tick
    {
        uint256 m = marketSeed % 2;
        margin = bound(margin, 5e6, 5_000e6);
        uint256 price = uint256(uint64(prices[m])) * 1e10;
        PerpEngine.LimitParams memory p = PerpEngine.LimitParams({
            priceId: ids[m],
            isLong: isLong,
            margin: margin,
            size: margin * bound(leverage, 1, 100),
            triggerPrice: isLong ? price - price / 100 : price + price / 100,
            takeProfit: 0,
            stopLoss: isLong ? price - price / 50 : price + price / 50
        });
        vm.prank(actors[actorSeed % actors.length]);
        try engine.createLimitOrder(p) {} catch {}
    }

    function executeOrders() external tick {
        _executeOrders();
    }

    function _executeOrders() internal {
        (uint256[] memory orderIds,) = engine.getOrders(0, type(uint256).max);
        for (uint256 i; i < orderIds.length; ++i) {
            vm.prank(keeper);
            try engine.executeOrder(orderIds[i], new bytes[](0)) {
                ++fills;
            } catch {}
        }
    }

    function cancelOrder(uint256 seed) external tick {
        (uint256[] memory orderIds, PerpEngine.Order[] memory orders) = engine.getOrders(0, type(uint256).max);
        if (orderIds.length == 0) return;
        uint256 i = seed % orderIds.length;
        vm.prank(orders[i].trader);
        engine.cancelOrder(orderIds[i]);
    }

    function setTrigger(uint256 actorSeed, uint256 marketSeed, bool takeProfit, uint256 offsetBps) external tick {
        uint256 m = marketSeed % 2;
        uint256 price = uint256(uint64(prices[m])) * 1e10;
        uint256 trigger = (price * (9_500 + bound(offsetBps, 0, 1_000))) / 10_000;
        vm.prank(actors[actorSeed % actors.length]);
        try engine.setTriggerOrder(
            ids[m], takeProfit ? PerpEngine.OrderType.TakeProfit : PerpEngine.OrderType.StopLoss, trigger
        ) {}
            catch {}
    }

    function stake(uint256 actorSeed, uint256 amount) external {
        address actor = actors[actorSeed % actors.length];
        uint256 balance = house.balanceOf(actor);
        if (balance == 0) return;
        vm.prank(actor);
        house.stake(bound(amount, 1, balance));
    }

    function unstake(uint256 actorSeed, uint256 amount) external {
        address actor = actors[actorSeed % actors.length];
        uint256 staked = house.stakedBalance(actor);
        if (staked == 0) return;
        vm.prank(actor);
        house.unstake(bound(amount, 1, staked));
    }

    function claim(uint256 actorSeed) external {
        vm.prank(actors[actorSeed % actors.length]);
        try house.claimYield() {} catch {}
    }

    function lpDeposit(uint256 amount) external {
        vm.prank(lp);
        vault.deposit(bound(amount, 1e6, 100_000e6), lp);
    }

    function lpWithdraw(uint256 amount) external {
        skip(1 hours);
        uint256 max = vault.maxWithdraw(lp);
        if (max == 0) return;
        vm.prank(lp);
        vault.withdraw(bound(amount, 1, max), lp, lp);
    }
}

contract InvariantTest is Base {
    Handler internal handler;
    address[] internal actors;
    uint256 internal initialUsdc;

    function setUp() public override {
        super.setUp();
        actors = [alice, bob, carol];
        handler = new Handler(usdc, pyth, vault, house, engine, actors, lp, keeper, BTC, ETH);
        initialUsdc = usdc.totalSupply();
        targetContract(address(handler));
    }

    /// @dev The engine holds exactly the open margins plus open order escrows, and the vault holds exactly
    ///      its NAV plus unclaimed staker yield. Nothing is ever stranded or double-counted.
    function invariant_custodyMatchesBooks() public view {
        _assertEngineSolvent();
        assertEq(address(engine).balance, 0);
    }

    /// @dev USDC only moves between known parties.
    function invariant_usdcIsConserved() public view {
        uint256 sum = usdc.balanceOf(address(engine)) + usdc.balanceOf(address(vault)) + usdc.balanceOf(lp)
            + usdc.balanceOf(keeper);
        for (uint256 i; i < actors.length; ++i) {
            sum += usdc.balanceOf(actors[i]);
        }
        assertEq(sum, initialUsdc);
    }

    /// @dev Open interest counters equal the sum of live position sizes, per side and in total.
    function invariant_openInterestMatchesPositions() public view {
        PerpEngine.PositionView[] memory ps = engine.getPositions(0, type(uint256).max);
        uint256 total;
        uint256 btcLong;
        uint256 btcShort;
        for (uint256 i; i < ps.length; ++i) {
            PerpEngine.Position memory p = ps[i].position;
            total += p.size;
            if (p.priceId == BTC) {
                if (p.isLong) btcLong += p.size;
                else btcShort += p.size;
            }
            assertEq(ps[i].key, engine.positionKey(p.trader, p.priceId));
            assertGe(p.size, p.margin);
            assertLe(p.size, p.margin * 100);
        }
        assertEq(engine.totalOpenInterest(), total);
        (,,,,,, uint256 longOi, uint256 shortOi,) = engine.markets(BTC);
        assertEq(longOi, btcLong);
        assertEq(shortOi, btcShort);
    }

    /// @dev Every take-profit / stop-loss order belongs to a live position that points back at it.
    function invariant_triggerOrdersAreLinked() public view {
        (uint256[] memory orderIds, PerpEngine.Order[] memory orders) = engine.getOrders(0, type(uint256).max);
        uint256 triggers;
        for (uint256 i; i < orders.length; ++i) {
            if (orders[i].orderType == PerpEngine.OrderType.LimitOpen) continue;
            ++triggers;
            PerpEngine.Position memory p = engine.getPosition(orders[i].trader, orders[i].priceId);
            assertEq(p.trader, orders[i].trader);
            uint256 linked = orders[i].orderType == PerpEngine.OrderType.TakeProfit ? p.tpOrderId : p.slOrderId;
            assertEq(linked, orderIds[i]);
        }
        PerpEngine.PositionView[] memory ps = engine.getPositions(0, type(uint256).max);
        uint256 links;
        for (uint256 i; i < ps.length; ++i) {
            if (ps[i].position.tpOrderId != 0) ++links;
            if (ps[i].position.slOrderId != 0) ++links;
        }
        assertEq(links, triggers);
    }

    /// @dev Stakers can never be owed more than the vault has set aside for them.
    function invariant_stakerYieldIsBacked() public view {
        uint256 owed;
        for (uint256 i; i < actors.length; ++i) {
            owed += house.earned(actors[i]);
        }
        assertLe(owed, vault.pendingStakerYield());
        assertEq(house.totalYieldNotified() - house.totalYieldClaimed(), vault.pendingStakerYield());
        assertEq(house.totalSupply(), house.totalRebatesMinted());
    }

    /// @dev Share accounting: redeeming every share can never take out more than NAV.
    function invariant_sharesAreBackedByNav() public view {
        assertLe(vault.convertToAssets(vault.totalSupply()), vault.totalHouseBalance());
    }
}
