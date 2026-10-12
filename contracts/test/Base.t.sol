// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";

import {EngineLens} from "../src/EngineLens.sol";
import {HouseVault} from "../src/HouseVault.sol";
import {PerpEngine} from "../src/PerpEngine.sol";
import {PythOracle} from "../src/PythOracle.sol";
import {RewardToken} from "../src/RewardToken.sol";
import {IHouseVault} from "../src/interfaces/IHouseVault.sol";
import {IRewardToken} from "../src/interfaces/IRewardToken.sol";
import {
    LimitParams,
    Market,
    MarketConfig,
    OpenParams,
    Order,
    OrderType,
    Position,
    PositionView
} from "../src/Types.sol";
import {MockUSDC} from "./mocks/MockUSDC.sol";

/// @notice Shared fixture: the protocol wired together over a mock USDC and MockPyth (through the PythOracle
///         adapter), six markets (four plain perpetuals of which one inverted, one cross, one dated future),
///         a seeded vault and funded actors.
abstract contract Base is Test {
    bytes32 internal constant BTC = 0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43;
    bytes32 internal constant ETH = 0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace;
    bytes32 internal constant EUR = 0xa995d00bb36a63cef7fd2c287dc105fc8f3d93779f062f09551b0af3e81ec30b;
    bytes32 internal constant JPY = 0xef2c98c804ba503c6a707e38be4dfbb16683775f195b091252bf24693042fd52;
    /// @dev Cross: ETH priced in BTC (ETH feed / BTC feed).
    bytes32 internal constant ETHBTC = keccak256("ETH-BTC");
    /// @dev Dated future on the BTC feed, expiring at `EXPIRY`.
    bytes32 internal constant FUT = keccak256("BTC-USD-FUT");

    uint256 internal constant T0 = 1_760_000_000;
    uint64 internal constant EXPIRY = uint64(T0 + 30 days);
    uint256 internal constant LOCK = 1 hours;
    uint256 internal constant EPOCH = 1 days;
    uint256 internal constant STREAM = 1 days;
    uint256 internal constant PYTH_FEE = 1; // native wei per price update
    uint256 internal constant EXEC_FEE = 0.1e6;
    uint256 internal constant LP_SEED = 1_000_000e6;
    uint256 internal constant SKEW_SCALE = 1_000_000e6;
    uint256 internal constant MAX_OI_PER_SIDE = 2_000_000e6;

    MockUSDC internal usdc;
    MockPyth internal pyth;
    PythOracle internal oracle;
    HouseVault internal vault;
    RewardToken internal house;
    PerpEngine internal engine;
    EngineLens internal lens;

    address internal owner = makeAddr("owner");
    address internal lp = makeAddr("lp");
    address internal alice = makeAddr("alice");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");
    address internal keeper = makeAddr("keeper");

    function setUp() public virtual {
        vm.warp(T0);
        usdc = new MockUSDC();
        pyth = new MockPyth(60, PYTH_FEE);
        oracle = new PythOracle(IPyth(address(pyth)));

        uint256 nonce = vm.getNonce(address(this));
        address predictedVault = vm.computeCreateAddress(address(this), nonce);
        address predictedToken = vm.computeCreateAddress(address(this), nonce + 1);
        address predictedEngine = vm.computeCreateAddress(address(this), nonce + 2);
        vault = new HouseVault(IERC20(address(usdc)), predictedEngine, predictedToken, LOCK, EPOCH);
        house = new RewardToken(predictedVault, predictedEngine, STREAM);
        engine = new PerpEngine(
            IERC20(address(usdc)), oracle, IHouseVault(predictedVault), IRewardToken(predictedToken), owner
        );
        assertEq(address(vault), predictedVault);
        assertEq(address(house), predictedToken);
        assertEq(address(engine), predictedEngine);
        lens = new EngineLens(engine);

        vm.startPrank(owner);
        engine.addMarket(BTC, _cfg("BTC-USD", BTC, bytes32(0), false, 0));
        engine.addMarket(ETH, _cfg("ETH-USD", ETH, bytes32(0), false, 0));
        engine.addMarket(EUR, _cfg("EUR-USD", EUR, bytes32(0), false, 0));
        engine.addMarket(JPY, _cfg("JPY-USD", JPY, bytes32(0), true, 0));
        engine.addMarket(ETHBTC, _cfg("ETH-BTC", ETH, BTC, false, 0));
        engine.addMarket(FUT, _cfg("BTC-USD-FUT", BTC, bytes32(0), false, EXPIRY));
        vm.stopPrank();

        _fund(lp, 5_000_000e6);
        _fund(alice, 1_000_000e6);
        _fund(bob, 1_000_000e6);
        _fund(carol, 1_000_000e6);
        vm.deal(keeper, 1 ether);

        vm.prank(lp);
        vault.deposit(LP_SEED, lp);

        _setPrice(BTC, 100_000e8, 0, -8);
        _setPrice(ETH, 4_000e8, 0, -8);
        _setPrice(EUR, 110_000, 0, -5);
        _setPrice(JPY, 150_000, 0, -3);
        _refreshAll();
    }

    function _cfg(string memory symbol, bytes32 feedId, bytes32 quoteFeedId, bool invert, uint64 expiry)
        internal
        pure
        returns (MarketConfig memory)
    {
        return MarketConfig({
            symbol: symbol,
            feedId: feedId,
            quoteFeedId: quoteFeedId,
            invert: invert,
            maxLeverage: 100,
            expiry: expiry,
            maxOiPerSide: MAX_OI_PER_SIDE,
            skewScale: SKEW_SCALE
        });
    }

    // ───────────────────────────── Actors ─────────────────────────────

    function _fund(address who, uint256 amount) internal {
        usdc.mint(who, amount);
        vm.deal(who, 1 ether);
        vm.startPrank(who);
        usdc.approve(address(engine), type(uint256).max);
        usdc.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }

    // ───────────────────────────── Oracle ─────────────────────────────

    mapping(bytes32 => int64) internal lastPrice;
    mapping(bytes32 => uint64) internal lastConf;
    mapping(bytes32 => int32) internal lastExpo;

    function _updateData(bytes32 id, int64 price, uint64 conf, int32 expo, uint64 publishTime)
        internal
        view
        returns (bytes[] memory data)
    {
        data = new bytes[](1);
        data[0] = pyth.createPriceFeedUpdateData(id, price, conf, expo, price, conf, publishTime, publishTime);
    }

    /// @dev Update data for `id` stamped with the current block time.
    function _fresh(bytes32 id, int64 price, uint64 conf, int32 expo) internal view returns (bytes[] memory) {
        return _updateData(id, price, conf, expo, uint64(vm.getBlockTimestamp()));
    }

    /// @dev Advances one second (MockPyth only accepts strictly newer prices) and publishes on-chain.
    function _setPrice(bytes32 id, int64 price, uint64 conf, int32 expo) internal {
        skip(1);
        _publish(id, price, conf, expo);
    }

    function _publish(bytes32 id, int64 price, uint64 conf, int32 expo) internal {
        lastPrice[id] = price;
        lastConf[id] = conf;
        lastExpo[id] = expo;
        pyth.updatePriceFeeds{value: PYTH_FEE}(_fresh(id, price, conf, expo));
    }

    /// @dev Advances one second and republishes every feed at its last price, so all are fresh together.
    function _refreshAll() internal {
        skip(1);
        _publish(BTC, lastPrice[BTC], lastConf[BTC], lastExpo[BTC]);
        _publish(ETH, lastPrice[ETH], lastConf[ETH], lastExpo[ETH]);
        _publish(EUR, lastPrice[EUR], lastConf[EUR], lastExpo[EUR]);
        _publish(JPY, lastPrice[JPY], lastConf[JPY], lastExpo[JPY]);
    }

    function _setBtc(uint256 usd) internal {
        _setPrice(BTC, int64(uint64(usd * 1e8)), 0, -8);
    }

    function _setEth(uint256 usd) internal {
        _setPrice(ETH, int64(uint64(usd * 1e8)), 0, -8);
    }

    /// @dev Advances one second and publishes BTC and ETH together (both legs of the cross).
    function _setBtcEth(uint256 btcUsd, uint256 ethUsd) internal {
        skip(1);
        _publish(BTC, int64(uint64(btcUsd * 1e8)), 0, -8);
        _publish(ETH, int64(uint64(ethUsd * 1e8)), 0, -8);
    }

    // ───────────────────────────── Trading ─────────────────────────────

    function _noBytes() internal pure returns (bytes[] memory) {
        return new bytes[](0);
    }

    function _params(bytes32 id, bool isLong, uint256 margin, uint256 size) internal pure returns (OpenParams memory) {
        return OpenParams({
            priceId: id, isLong: isLong, margin: margin, size: size, acceptablePrice: 0, takeProfit: 0, stopLoss: 0
        });
    }

    function _open(address who, bytes32 id, bool isLong, uint256 margin, uint256 size) internal returns (bytes32) {
        vm.prank(who);
        return engine.openPosition(_params(id, isLong, margin, size), _noBytes());
    }

    function _close(address who, bytes32 id) internal {
        vm.prank(who);
        engine.closePosition(id, 0, _noBytes());
    }

    function _limit(bytes32 id, bool isLong, uint256 margin, uint256 size, uint256 trigger)
        internal
        pure
        returns (LimitParams memory)
    {
        return LimitParams({
            priceId: id, isLong: isLong, margin: margin, size: size, triggerPrice: trigger, takeProfit: 0, stopLoss: 0
        });
    }

    function _exec(uint256 orderId) internal {
        vm.prank(keeper);
        engine.executeOrder(orderId, _noBytes());
    }

    function _keys(bytes32 a) internal pure returns (bytes32[] memory keys) {
        keys = new bytes32[](1);
        keys[0] = a;
    }

    function _keys(bytes32 a, bytes32 b) internal pure returns (bytes32[] memory keys) {
        keys = new bytes32[](2);
        keys[0] = a;
        keys[1] = b;
    }

    /// @dev Turns funding and the skew surcharge off so tests can assert exact price-only arithmetic.
    function _flatFees() internal {
        vm.prank(owner);
        engine.setFeeParams(5, 0, 0, EXEC_FEE);
    }

    /// @dev Mints HOUSE to `who` as the engine would for a loss, and stakes `amount` of it.
    function _stake(address who, uint256 amount) internal {
        vm.prank(address(engine));
        house.mintLossRebate(who, amount / 100e12);
        vm.prank(who);
        house.stake(amount);
    }

    /// @dev Books `amount` of fee income at the vault, as the engine would.
    function _feeIncome(uint256 amount) internal {
        usdc.mint(address(engine), amount);
        vm.prank(address(engine));
        vault.receiveFees(amount);
    }

    function _market(bytes32 id) internal view returns (Market memory) {
        return engine.getMarket(id);
    }

    function _bal(address a) internal view returns (uint256) {
        return usdc.balanceOf(a);
    }

    /// @dev Engine holdings must equal open margins plus open order escrows plus deferred payments, and the
    ///      vault's holdings its realised balance plus unclaimed staker yield.
    function _assertEngineSolvent() internal view {
        uint256 expected = engine.totalClaimable();
        PositionView[] memory ps = lens.getPositions(0, type(uint256).max);
        for (uint256 i; i < ps.length; ++i) {
            expected += ps[i].position.margin;
        }
        (, Order[] memory os) = lens.getOrders(0, type(uint256).max);
        for (uint256 i; i < os.length; ++i) {
            Order memory o = os[i];
            uint256 brackets = (o.takeProfit != 0 ? 1 : 0) + (o.stopLoss != 0 ? 1 : 0);
            expected += o.margin + o.feeBudget + (1 + brackets) * o.executionFee;
        }
        assertEq(usdc.balanceOf(address(engine)), expected, "engine USDC != margins + escrows + claimable");
        assertEq(
            usdc.balanceOf(address(vault)),
            vault.totalHouseBalance() + vault.pendingStakerYield(),
            "vault USDC != house balance + staker yield"
        );
    }
}
