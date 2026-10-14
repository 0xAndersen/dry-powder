// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";

import {EngineLens} from "../src/EngineLens.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {PerpEngine} from "../src/PerpEngine.sol";
import {RewardToken} from "../src/RewardToken.sol";
import {
    LimitParams,
    Market,
    MarketConfig,
    OpenParams,
    OraclePrice,
    Order,
    OrderType,
    Position,
    PositionView
} from "../src/Types.sol";
import {Base} from "./Base.t.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @dev Drives the protocol with random but well-formed actions from a fixed set of actors: plain, cross and
///      dated markets, all four order types, liquidations, market and position settlement, epoch settlement,
///      staking, LP flows and USDC blocklisting.
contract Handler is Test {
    MockUSDC internal usdc;
    MockPyth internal pyth;
    HouseVault internal vault;
    RewardToken internal house;
    PerpEngine internal engine;
    EngineLens internal lens;

    address[] public actors;
    address internal lp;
    address internal keeper;
    address internal engineOwner;

    bytes32[2] internal feeds;
    int64[2] internal prices;
    uint64[2] internal confs;
    /// @dev Tradable market ids: BTC, ETH, the ETH/BTC cross, and every dated future listed so far.
    bytes32[] public ids;
    bytes32[] public dated;

    // Ghost state checked by the invariants.
    mapping(bytes32 => uint256) public settledAt;
    uint256 public lastHighWaterMark;
    bool public highWaterMarkDecreased;
    uint256 public unexpectedReverts;

    // Coverage counters.
    uint256 public opens;
    uint256 public closes;
    uint256 public liquidations;
    uint256 public fills;
    uint256 public marketsSettled;
    uint256 public positionsSettled;
    uint256 public epochsSettled;
    uint256 public yieldSettled;
    uint256 public deferrals;
    uint256 public claims;

    constructor(
        MockUSDC usdc_,
        MockPyth pyth_,
        HouseVault vault_,
        RewardToken house_,
        PerpEngine engine_,
        EngineLens lens_,
        address[] memory actors_,
        address[3] memory roles, // lp, keeper, engine owner
        bytes32[2] memory feeds_,
        bytes32[] memory ids_,
        bytes32 firstDated
    ) {
        usdc = usdc_;
        pyth = pyth_;
        vault = vault_;
        house = house_;
        engine = engine_;
        lens = lens_;
        actors = actors_;
        lp = roles[0];
        keeper = roles[1];
        engineOwner = roles[2];
        feeds = feeds_;
        ids = ids_;
        dated.push(firstDated);
        prices = [int64(100_000e8), int64(4_000e8)];
        lastHighWaterMark = vault_.highWaterMark();
        vm.deal(address(this), 1 ether);
    }

    function _publish(uint256 f) internal {
        bytes[] memory data = new bytes[](1);
        uint64 t = uint64(vm.getBlockTimestamp());
        data[0] = pyth.createPriceFeedUpdateData(feeds[f], prices[f], confs[f], -8, prices[f], confs[f], t, t);
        pyth.updatePriceFeeds{value: 1}(data);
    }

    function _refresh() internal {
        skip(1);
        _publish(0);
        _publish(1);
    }

    /// @dev Every action starts a second later with both feeds fresh, and ends with the ghost checks.
    modifier tick() {
        _refresh();
        _;
        _track();
    }

    function _track() internal {
        uint256 mark = vault.highWaterMark();
        if (mark < lastHighWaterMark) highWaterMarkDecreased = true;
        lastHighWaterMark = mark;
    }

    function _actor(uint256 seed) internal view returns (address) {
        return actors[seed % actors.length];
    }

    function _id(uint256 seed) internal view returns (bytes32) {
        return ids[seed % ids.length];
    }

    /// @dev Current mid of a market, or 0 when it has none.
    function _mid(bytes32 id) internal view returns (uint256) {
        try engine.getPrice(id) returns (OraclePrice memory px) {
            return px.mid;
        } catch {
            return 0;
        }
    }

    // ───────────────────────────── Trading ─────────────────────────────

    function open(uint256 actorSeed, uint256 marketSeed, bool isLong, uint256 margin, uint256 leverage, uint8 brackets)
        external
        tick
    {
        bytes32 id = _id(marketSeed);
        uint256 price = _mid(id);
        margin = bound(margin, 5e6, 5_000e6);
        OpenParams memory p = OpenParams({
            priceId: id,
            isLong: isLong,
            margin: margin,
            size: margin * bound(leverage, 1, 100),
            acceptablePrice: 0,
            takeProfit: brackets & 1 != 0 ? (isLong ? price + price / 50 : price - price / 50) : 0,
            stopLoss: brackets & 2 != 0 ? (isLong ? price - price / 200 : price + price / 200) : 0
        });
        vm.prank(_actor(actorSeed));
        try engine.openPosition(p, new bytes[](0)) {
            ++opens;
        } catch {}
    }

    function close(uint256 actorSeed, uint256 marketSeed) external tick {
        address actor = _actor(actorSeed);
        uint256 owed = engine.claimable(actor);
        vm.prank(actor);
        try engine.closePosition(_id(marketSeed), 0, new bytes[](0)) {
            ++closes;
            if (engine.claimable(actor) != owed) ++deferrals;
        } catch {}
    }

    function createLimit(uint256 actorSeed, uint256 marketSeed, bool isLong, uint256 margin, uint256 leverage, bool mkt)
        external
        tick
    {
        bytes32 id = _id(marketSeed);
        uint256 price = _mid(id);
        if (price == 0) return;
        margin = bound(margin, 5e6, 5_000e6);
        // Either a resting limit 1% away, or a marketable one (the keeper-executed market order).
        uint256 trigger = isLong == mkt ? price + price / 100 : price - price / 100;
        LimitParams memory p = LimitParams({
            priceId: id,
            isLong: isLong,
            margin: margin,
            size: margin * bound(leverage, 1, 100),
            triggerPrice: trigger,
            takeProfit: 0,
            stopLoss: isLong ? trigger - trigger / 50 : trigger + trigger / 50
        });
        vm.prank(_actor(actorSeed));
        try engine.createLimitOrder(p) {} catch {}
    }

    function setTrigger(uint256 actorSeed, uint256 marketSeed, uint8 kind, uint256 offsetBps) external tick {
        bytes32 id = _id(marketSeed);
        uint256 price = _mid(id);
        OrderType orderType = OrderType(1 + (kind % 3));
        uint256 trigger = (price * (9_500 + bound(offsetBps, 0, 1_000))) / 10_000;
        // Half of the Close orders are unbounded.
        if (orderType == OrderType.Close && offsetBps % 2 == 0) trigger = 0;
        vm.prank(_actor(actorSeed));
        try engine.setTriggerOrder(id, orderType, trigger) {} catch {}
    }

    /// @dev Cancelling one's own order must always succeed, whatever the state of the market or of USDC.
    function cancelOrder(uint256 seed) external tick {
        (uint256[] memory orderIds, Order[] memory orders) = lens.getOrders(0, type(uint256).max);
        if (orderIds.length == 0) return;
        uint256 i = seed % orderIds.length;
        vm.prank(orders[i].trader);
        try engine.cancelOrder(orderIds[i]) {}
        catch {
            ++unexpectedReverts;
        }
    }

    function executeOrders() external tick {
        _executeOrders();
    }

    function _executeOrders() internal {
        (uint256[] memory orderIds,) = lens.getOrders(0, type(uint256).max);
        for (uint256 i; i < orderIds.length; ++i) {
            vm.prank(keeper);
            try engine.executeOrder(orderIds[i], new bytes[](0)) {
                ++fills;
            } catch {}
        }
    }

    function liquidateAll() external tick {
        _liquidateAll();
    }

    function _allKeys() internal view returns (bytes32[] memory keys) {
        keys = engine.positionKeys(0, type(uint256).max);
    }

    function _liquidateAll() internal {
        bytes32[] memory keys = _allKeys();
        vm.prank(keeper);
        try engine.liquidateBatch(keys, new bytes[](0)) returns (uint256 n) {
            liquidations += n;
        } catch {}
    }

    // ───────────────────────────── Oracle ─────────────────────────────

    function movePrice(uint256 feedSeed, int256 bps, uint256 confBps) external tick {
        uint256 f = feedSeed % 2;
        bps = bound(bps, -300, 300);
        int256 next = (int256(prices[f]) * (10_000 + bps)) / 10_000;
        if (next < 1e8) next = 1e8;
        if (next > 1e15) next = 1e15;
        prices[f] = int64(next);
        confs[f] = uint64((uint256(next) * bound(confBps, 0, 40)) / 10_000);
        _refresh();
        // Keepers react to every price move.
        _liquidateAll();
        _executeOrders();
    }

    // ───────────────────────────── Dated markets ─────────────────────────────

    function passTime(uint256 secs) external {
        skip(bound(secs, 1 minutes, 3 days));
    }

    function listFuture(uint256 lifetime) external tick {
        if (dated.length >= 4) return;
        bytes32 id = keccak256(abi.encode("FUT", dated.length));
        MarketConfig memory cfg = MarketConfig({
            symbol: "BTC-USD-ROLL",
            feedId: feeds[0],
            quoteFeedId: bytes32(0),
            invert: false,
            maxLeverage: 100,
            expiry: uint64(vm.getBlockTimestamp() + bound(lifetime, 1 hours, 5 days)),
            maxOiPerSide: 2_000_000e6,
            skewScale: 1_000_000e6
        });
        vm.prank(engineOwner);
        engine.addMarket(id, cfg);
        ids.push(id);
        dated.push(id);
    }

    function settleMarket(uint256 seed) external tick {
        bytes32 id = dated[seed % dated.length];
        try engine.settleMarket(id, new bytes[](0)) {
            ++marketsSettled;
            settledAt[id] = engine.getMarket(id).settlementPrice;
        } catch {}
    }

    function settlePositions() external tick {
        bytes32[] memory keys = _allKeys();
        vm.prank(keeper);
        positionsSettled += engine.settlePositions(keys);
    }

    // ───────────────────────────── Vault and staking ─────────────────────────────

    function settleEpoch() external {
        skip(vault.epochLength());
        _refresh();
        uint256 toStakers = vault.settleEpoch();
        ++epochsSettled;
        yieldSettled += toStakers;
        _track();
    }

    function stake(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        uint256 balance = house.balanceOf(actor);
        if (balance == 0) return;
        vm.prank(actor);
        house.stake(bound(amount, 1, balance));
    }

    function unstake(uint256 actorSeed, uint256 amount) external {
        address actor = _actor(actorSeed);
        uint256 staked = house.stakedBalance(actor);
        if (staked == 0) return;
        vm.prank(actor);
        house.unstake(bound(amount, 1, staked));
    }

    function claimYield(uint256 actorSeed) external {
        vm.prank(_actor(actorSeed));
        try house.claimYield() {} catch {}
    }

    function lpDeposit(uint256 amount) external tick {
        amount = Math.min(bound(amount, 1e6, 100_000e6), usdc.balanceOf(lp));
        if (amount == 0) return;
        vm.prank(lp);
        try vault.deposit(amount, lp) {}
        catch {
            ++unexpectedReverts;
        }
    }

    /// @dev Whatever `maxWithdraw` reports must actually be withdrawable.
    function lpWithdraw(uint256 amount) external {
        skip(1 hours);
        uint256 max = vault.maxWithdraw(lp);
        if (max == 0) return;
        vm.prank(lp);
        try vault.withdraw(bound(amount, 1, max), lp, lp) {}
        catch {
            ++unexpectedReverts;
        }
        _track();
    }

    function lpRedeemMax() external {
        skip(1 hours);
        uint256 max = vault.maxRedeem(lp);
        if (max == 0) return;
        vm.prank(lp);
        try vault.redeem(max, lp, lp) {}
        catch {
            ++unexpectedReverts;
        }
        _track();
    }

    // ───────────────────────────── USDC blocklist ─────────────────────────────

    function setBlocklisted(uint256 actorSeed, bool status) external {
        usdc.setBlocklisted(_actor(actorSeed), status);
    }

    function claim(uint256 actorSeed) external {
        address actor = _actor(actorSeed);
        uint256 owed = engine.claimable(actor);
        bool blocked = usdc.blocklisted(actor);
        vm.prank(actor);
        try engine.claim() {
            ++claims;
            // A claim can only succeed for a non-zero amount and an account USDC accepts.
            if (owed == 0 || blocked) ++unexpectedReverts;
        } catch {
            if (owed != 0 && !blocked) ++unexpectedReverts;
        }
    }

    function datedCount() external view returns (uint256) {
        return dated.length;
    }
}

contract InvariantTest is Base {
    Handler internal handler;
    address[] internal actors;
    uint256 internal initialUsdc;

    function setUp() public override {
        super.setUp();
        actors = [alice, bob, carol];
        bytes32[] memory ids = new bytes32[](4);
        ids[0] = BTC;
        ids[1] = ETH;
        ids[2] = ETHBTC;
        ids[3] = FUT;
        handler = new Handler(usdc, pyth, vault, house, engine, lens, actors, [lp, keeper, owner], [BTC, ETH], ids, FUT);
        initialUsdc = usdc.totalSupply();
        targetContract(address(handler));
    }

    /// @dev The engine holds exactly the open margins plus open order escrows plus deferred payments, and the
    ///      vault holds exactly its house balance plus unclaimed staker yield. Nothing is ever stranded or
    ///      double-counted.
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

    /// @dev Deferred payments are owed to the actors and to nobody else.
    function invariant_claimableSumsToTotal() public view {
        uint256 sum;
        for (uint256 i; i < actors.length; ++i) {
            sum += engine.claimable(actors[i]);
        }
        assertEq(sum, engine.totalClaimable());
        assertEq(engine.claimable(keeper) + engine.claimable(lp), 0);
    }

    /// @dev For every market, the open-interest and unit counters of each side equal the sums over its live
    ///      positions, and the global counter equals the sum over all of them.
    function invariant_marketCountersMatchPositions() public view {
        PositionView[] memory ps = lens.getPositions(0, type(uint256).max);
        bytes32[] memory ids = engine.getMarketIds();
        uint256 total;
        for (uint256 m; m < ids.length; ++m) {
            uint256 longOi;
            uint256 shortOi;
            uint256 longUnits;
            uint256 shortUnits;
            for (uint256 i; i < ps.length; ++i) {
                Position memory p = ps[i].position;
                if (p.priceId != ids[m]) continue;
                uint256 units = Math.mulDiv(p.size, 1e36, p.entryPrice);
                if (p.isLong) {
                    longOi += p.size;
                    longUnits += units;
                } else {
                    shortOi += p.size;
                    shortUnits += units;
                }
            }
            Market memory market = engine.getMarket(ids[m]);
            assertEq(market.longOi, longOi, "longOi");
            assertEq(market.shortOi, shortOi, "shortOi");
            assertEq(market.longUnits, longUnits, "longUnits");
            assertEq(market.shortUnits, shortUnits, "shortUnits");
            assertLe(longOi, market.maxOiPerSide);
            assertLe(shortOi, market.maxOiPerSide);
            total += longOi + shortOi;
        }
        assertEq(engine.totalOpenInterest(), total);
        assertEq(engine.positionCount(), ps.length);
        for (uint256 i; i < ps.length; ++i) {
            Position memory p = ps[i].position;
            assertEq(ps[i].key, engine.positionKey(p.trader, p.priceId));
            assertGe(p.size, p.margin);
            assertLe(p.size, p.margin * 100);
            assertGt(p.entryPrice, 0);
        }
    }

    /// @dev Every take-profit / stop-loss / close order belongs to a live position that points back at it
    ///      through the slot of its type, and every slot of every position points at such an order.
    function invariant_orderLinksAreConsistent() public view {
        (uint256[] memory orderIds, Order[] memory orders) = lens.getOrders(0, type(uint256).max);
        uint256 triggers;
        for (uint256 i; i < orders.length; ++i) {
            assertLt(orderIds[i], engine.nextOrderId());
            if (orders[i].orderType == OrderType.LimitOpen) {
                assertGt(orders[i].margin, 0);
                continue;
            }
            ++triggers;
            Position memory p = engine.getPosition(orders[i].trader, orders[i].priceId);
            assertEq(p.trader, orders[i].trader, "trigger order without a position");
            assertEq(p.isLong, orders[i].isLong);
            uint256 linked = orders[i].orderType == OrderType.TakeProfit
                ? p.tpOrderId
                : orders[i].orderType == OrderType.StopLoss ? p.slOrderId : p.closeOrderId;
            assertEq(linked, orderIds[i], "position does not link back");
        }
        PositionView[] memory ps = lens.getPositions(0, type(uint256).max);
        uint256 links;
        for (uint256 i; i < ps.length; ++i) {
            Position memory p = ps[i].position;
            links += _checkSlot(p, p.tpOrderId, OrderType.TakeProfit);
            links += _checkSlot(p, p.slOrderId, OrderType.StopLoss);
            links += _checkSlot(p, p.closeOrderId, OrderType.Close);
        }
        assertEq(links, triggers);
        assertEq(engine.orderCount(), orders.length);
    }

    function _checkSlot(Position memory p, uint64 orderId, OrderType expected) internal view returns (uint256) {
        if (orderId == 0) return 0;
        Order memory o = engine.getOrder(orderId);
        assertEq(o.trader, p.trader, "slot points at a dead or foreign order");
        assertEq(o.priceId, p.priceId);
        assertEq(uint8(o.orderType), uint8(expected));
        return 1;
    }

    /// @dev Stakers can never be owed more than the vault has set aside for them.
    function invariant_stakerYieldIsBacked() public view {
        uint256 owed;
        for (uint256 i; i < actors.length; ++i) {
            owed += house.earned(actors[i]);
        }
        assertLe(owed, vault.pendingStakerYield());
        assertEq(house.totalYieldNotified() - house.totalYieldClaimed(), vault.pendingStakerYield());
        assertEq(house.totalYieldNotified(), vault.totalStakerYieldAllocated());
        assertEq(house.totalSupply(), house.totalRebatesMinted());
        assertEq(house.balanceOf(address(house)), house.totalStaked());
    }

    /// @dev Share accounting: the exit value never exceeds the realised balance (nor the entry value), and
    ///      redeeming every share can never take out more than the exit value.
    function invariant_vaultValuation() public view {
        uint256 exit = vault.exitValue();
        assertLe(exit, vault.totalHouseBalance());
        assertGe(vault.entryValue(), vault.totalHouseBalance());
        assertEq(vault.totalAssets(), exit);
        assertLe(vault.convertToAssets(vault.totalSupply()), exit);
        assertLe(vault.maxWithdraw(lp), vault.freeLiquidity());
    }

    /// @dev A settled market's price never changes, the high-water mark never falls, and none of the calls
    ///      that must always succeed (cancelling an order, withdrawing the reported maximum, claiming a
    ///      deferred payment once USDC accepts the account) ever reverted.
    function invariant_ghosts() public view {
        uint256 n = handler.datedCount();
        for (uint256 i; i < n; ++i) {
            bytes32 id = handler.dated(i);
            uint256 settled = handler.settledAt(id);
            if (settled != 0) assertEq(engine.getMarket(id).settlementPrice, settled);
            else assertEq(engine.getMarket(id).settlementPrice, 0);
        }
        assertFalse(handler.highWaterMarkDecreased());
        assertEq(handler.unexpectedReverts(), 0);
    }

    /// @dev A fixed walk through every handler action, asserting that each of them really does something.
    ///      Guards against the handler silently degenerating into a sequence of reverts.
    function test_handler_reachesEveryPath() public {
        handler.open(0, 0, true, 1_000e6, 100, 3); // alice BTC 100x long with brackets
        handler.open(1, 1, false, 1_000e6, 10, 0); // bob ETH short
        handler.open(2, 2, true, 1_000e6, 10, 0); // carol ETH/BTC long
        handler.open(1, 3, true, 1_000e6, 10, 0); // bob future long
        handler.open(2, 3, false, 50e6, 100, 0); // carol future short, 100x
        assertEq(handler.opens(), 5);
        handler.createLimit(2, 0, true, 1_000e6, 5, true); // carol marketable BTC long
        handler.setTrigger(1, 1, 2, 0); // bob unbounded Close on ETH
        handler.executeOrders();
        assertEq(handler.fills(), 2);
        handler.movePrice(0, -150, 10); // BTC -1.5%: alice is liquidated
        assertEq(handler.liquidations(), 1);
        handler.setBlocklisted(2, true);
        handler.close(2, 2); // carol closes while blocklisted
        assertEq(handler.deferrals(), 1);
        handler.claim(2);
        handler.setBlocklisted(2, false);
        handler.claim(2);
        assertEq(handler.claims(), 1);
        handler.stake(0, type(uint256).max); // alice stakes her rebate
        handler.settleEpoch();
        assertGt(handler.yieldSettled(), 0);
        handler.listFuture(1 days);
        vm.warp(EXPIRY);
        handler.settleMarket(0);
        assertEq(handler.marketsSettled(), 1);
        handler.settlePositions();
        assertEq(handler.positionsSettled(), 2);
        handler.lpDeposit(5_000e6);
        handler.lpWithdraw(1_000e6);
        handler.lpRedeemMax();
        handler.cancelOrder(0);
        handler.passTime(1 days);
        handler.claimYield(0);
        handler.unstake(0, 1);
        assertEq(handler.unexpectedReverts(), 0);

        invariant_custodyMatchesBooks();
        invariant_usdcIsConserved();
        invariant_claimableSumsToTotal();
        invariant_marketCountersMatchPositions();
        invariant_orderLinksAreConsistent();
        invariant_stakerYieldIsBacked();
        invariant_vaultValuation();
        invariant_ghosts();
    }
}
