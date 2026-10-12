// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

import {IHouseVault} from "./interfaces/IHouseVault.sol";
import {IPerpEngine} from "./interfaces/IPerpEngine.sol";
import {IRewardToken} from "./interfaces/IRewardToken.sol";

/// @title PerpEngine
/// @notice Synthetic perpetuals engine for Arc. Traders post USDC margin and take leveraged long/short exposure to
///         Pyth-priced markets; the HouseVault is the counterparty to every position.
///
/// @dev Conventions
///  - USDC amounts (margin, size, fees) use 6 decimals. `size` is the position notional in USDC.
///  - Prices are normalised to 18 decimals. Markets flagged `invert` use the reciprocal of the Pyth feed
///    (Pyth publishes USD/JPY; the JPY/USD market inverts it).
///  - One position per trader per market, keyed by `positionKey(trader, priceId)`.
///  - Trades that favour the trader execute on the adverse side of Pyth's confidence band (buys at price+conf,
///    sells at price-conf). Liquidations and trigger conditions are evaluated at the mid price.
///  - A position can only be closed (by its trader or by a TP/SL order) against a price published after the
///    second it was opened in; liquidation has no such restriction.
///  - A position is liquidatable once price loss plus funding owed reaches 90% of its margin.
///  - Engine USDC holdings always equal the sum of open position margins plus open order escrows; everything
///    else is forwarded to the vault, the trader or the keeper in the same transaction.
///  - Pyth update fees are paid in Arc's native USDC via `msg.value`; any excess is refunded to the caller.
contract PerpEngine is IPerpEngine, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using EnumerableSet for EnumerableSet.UintSet;

    // ───────────────────────────── Types ─────────────────────────────

    struct Position {
        uint256 margin; // USDC collateral, 6 decimals
        uint256 size; // USDC notional, 6 decimals
        uint256 entryPrice; // 18 decimals
        bool isLong;
        bytes32 priceId; // Pyth feed id; also the market id
        address trader;
        uint64 openedAt;
        uint64 tpOrderId; // linked take-profit order, 0 if none
        uint64 slOrderId; // linked stop-loss order, 0 if none
        int256 entryFundingIndex;
    }

    struct Market {
        bool enabled; // false blocks new positions; closes and liquidations still work
        bool invert; // use 1/price of the Pyth feed
        uint16 maxLeverage; // whole multiples, 1..100
        uint64 lastFundingTime;
        uint256 maxOiPerSide; // USDC notional cap for each of long and short
        uint256 skewScale; // USDC notional floor for the skew-ratio denominator
        uint256 longOi;
        uint256 shortOi;
        int256 fundingIndex; // cumulative funding per unit of notional, 1e18; positive means longs have paid
    }

    enum OrderType {
        LimitOpen,
        TakeProfit,
        StopLoss
    }

    struct Order {
        address trader;
        bytes32 priceId;
        OrderType orderType;
        bool isLong;
        uint64 createdAt;
        uint256 margin; // LimitOpen only
        uint256 size; // LimitOpen only
        uint256 triggerPrice; // 18 decimals
        uint256 takeProfit; // LimitOpen only: bracket TP to attach on fill, 0 for none
        uint256 stopLoss; // LimitOpen only: bracket SL to attach on fill, 0 for none
        uint256 feeBudget; // LimitOpen only: escrowed maximum open fee
        uint256 executionFee; // keeper fee escrowed per execution (this order and each bracket)
    }

    struct OpenParams {
        bytes32 priceId;
        bool isLong;
        uint256 margin;
        uint256 size;
        uint256 acceptablePrice; // worst execution price accepted; 0 disables the check
        uint256 takeProfit; // optional bracket trigger, 0 for none
        uint256 stopLoss; // optional bracket trigger, 0 for none
    }

    struct LimitParams {
        bytes32 priceId;
        bool isLong;
        uint256 margin;
        uint256 size;
        uint256 triggerPrice; // long fills at or below, short fills at or above
        uint256 takeProfit;
        uint256 stopLoss;
    }

    struct PositionView {
        bytes32 key;
        Position position;
        int256 fundingOwed; // positive: the position owes funding
        uint256 liquidationPrice; // type(uint256).max / 0 when liquidatable at any price
    }

    struct OraclePrice {
        uint256 mid;
        uint256 bid;
        uint256 ask;
        uint256 publishTime;
    }

    enum PriceStatus {
        Ok,
        Unavailable,
        Stale,
        Invalid,
        ConfidenceTooWide
    }

    // ───────────────────────────── Constants ─────────────────────────────

    uint256 internal constant BPS = 10_000;
    uint256 internal constant PRICE_PRECISION = 1e18;
    int256 internal constant FUNDING_PRECISION = 1e18;

    /// @notice Hard ceiling on per-market leverage.
    uint256 public constant MAX_LEVERAGE = 100;
    /// @notice A position is liquidated once its loss (price move plus funding) reaches this share of margin.
    uint256 public constant LIQUIDATION_THRESHOLD_BPS = 9_000;
    /// @notice Share of the liquidated margin paid to the liquidator; the remainder goes to the vault.
    uint256 public constant LIQUIDATOR_FEE_BPS = 200;

    uint256 public constant MAX_BASE_FEE_BPS = 50;
    uint256 public constant MAX_SKEW_FEE_BPS = 100;
    /// @notice Ceiling for the full-skew funding rate: 1000% of notional per year.
    uint256 public constant MAX_FUNDING_RATE_PER_SECOND = 317_097_919_837;
    uint256 public constant MAX_EXECUTION_FEE = 10e6;
    uint256 public constant MAX_PRICE_AGE = 60;
    uint256 public constant MAX_CONF_BPS = 500;
    /// @notice Bounds for `maxOiToNavBps` (0.5x to 10x of NAV), so the reserve can neither vanish nor be
    ///         inflated to freeze every withdrawal.
    uint256 public constant MIN_OI_TO_NAV_BPS = 5_000;
    uint256 public constant MAX_OI_TO_NAV_BPS = 100_000;

    // ───────────────────────────── Immutables ─────────────────────────────

    IERC20 public immutable usdc;
    IPyth public immutable pyth;
    IHouseVault public immutable vault;
    IRewardToken public immutable rewardToken;

    // ───────────────────────────── Parameters ─────────────────────────────

    /// @notice Fee on notional charged at open and at close.
    uint256 public baseFeeBps = 5;
    /// @notice Extra open fee on notional at 100% skew, charged pro rata when a trade increases the skew.
    uint256 public maxSkewFeeBps = 10;
    /// @notice Funding per second per unit of notional at 100% skew, 1e18 scale. Default is 50% per year.
    uint256 public maxFundingRatePerSecond = 15_854_895_991;
    /// @notice Flat USDC fee escrowed with every keeper-executed order and paid to whoever executes it.
    uint256 public executionFee = 0.1e6;
    /// @notice Maximum age, in seconds, of a Pyth price used for any state change.
    uint256 public maxPriceAge = 3;
    /// @notice Maximum Pyth confidence interval relative to price.
    uint256 public maxConfBps = 50;
    /// @notice Maximum total open interest as a multiple of vault NAV, in basis points (30000 = 3x).
    uint256 public maxOiToNavBps = 30_000;
    /// @notice Minimum position margin.
    uint256 public minMargin = 5e6;

    // ───────────────────────────── State ─────────────────────────────

    mapping(bytes32 priceId => Market) public markets;
    bytes32[] private _marketIds;

    mapping(bytes32 key => Position) private _positions;
    EnumerableSet.Bytes32Set private _positionKeys;

    mapping(uint256 orderId => Order) private _orders;
    EnumerableSet.UintSet private _orderIds;
    uint64 public nextOrderId = 1;

    /// @notice Sum of long and short notional across all markets.
    uint256 public totalOpenInterest;

    // ───────────────────────────── Events ─────────────────────────────

    event MarketConfigured(
        bytes32 indexed priceId, bool enabled, bool invert, uint16 maxLeverage, uint256 maxOiPerSide, uint256 skewScale
    );
    event FeeParamsSet(
        uint256 baseFeeBps, uint256 maxSkewFeeBps, uint256 maxFundingRatePerSecond, uint256 executionFee
    );
    event RiskParamsSet(uint256 maxPriceAge, uint256 maxConfBps, uint256 maxOiToNavBps, uint256 minMargin);
    event PositionOpened(
        bytes32 indexed key,
        address indexed trader,
        bytes32 indexed priceId,
        bool isLong,
        uint256 margin,
        uint256 size,
        uint256 entryPrice,
        uint256 fee
    );
    event PositionClosed(
        bytes32 indexed key,
        address indexed trader,
        bytes32 indexed priceId,
        uint256 exitPrice,
        int256 pnl,
        uint256 fee,
        uint256 payout
    );
    event PositionLiquidated(
        bytes32 indexed key,
        address indexed trader,
        address indexed liquidator,
        bytes32 priceId,
        uint256 price,
        uint256 margin,
        uint256 liquidatorFee,
        uint256 toVault
    );
    event OrderCreated(
        uint256 indexed orderId,
        address indexed trader,
        bytes32 indexed priceId,
        OrderType orderType,
        bool isLong,
        uint256 triggerPrice,
        uint256 margin,
        uint256 size
    );
    event OrderUpdated(uint256 indexed orderId, uint256 triggerPrice);
    event OrderCancelled(uint256 indexed orderId, address indexed trader);
    event OrderExecuted(uint256 indexed orderId, address indexed trader, address indexed keeper, uint256 price);

    // ───────────────────────────── Errors ─────────────────────────────

    error ZeroAddress();
    error InvalidParam();
    error MarketExists();
    error MarketNotFound();
    error MarketDisabled();
    error MarginTooLow();
    error LeverageOutOfRange();
    error PositionExists();
    error PositionNotFound();
    error PositionLiquidatable();
    error MarketOiCapExceeded();
    error VaultOiCapExceeded();
    error SlippageExceeded();
    error InvalidTrigger();
    error TriggerNotMet();
    error OrderNotFound();
    error NotOrderOwner();
    error NotTriggerOrderType();
    error PriceBeforeOrder();
    error PriceNotAfterOpen();
    error NothingToLiquidate();
    error InsufficientOracleFee();
    error RefundFailed();
    error OraclePriceUnavailable();
    error OraclePriceStale();
    error OraclePriceInvalid();
    error OracleConfidenceTooWide();

    // ───────────────────────────── Constructor ─────────────────────────────

    constructor(IERC20 usdc_, IPyth pyth_, IHouseVault vault_, IRewardToken rewardToken_, address owner_)
        Ownable(owner_)
    {
        if (
            address(usdc_) == address(0) || address(pyth_) == address(0) || address(vault_) == address(0)
                || address(rewardToken_) == address(0)
        ) revert ZeroAddress();
        usdc = usdc_;
        pyth = pyth_;
        vault = vault_;
        rewardToken = rewardToken_;
        // The vault pulls losses and fees from the engine.
        usdc_.forceApprove(address(vault_), type(uint256).max);
    }

    // ───────────────────────────── Admin ─────────────────────────────

    /// @notice Lists a new market for Pyth feed `priceId`.
    function addMarket(bytes32 priceId, bool invert, uint16 maxLeverage, uint256 maxOiPerSide, uint256 skewScale)
        external
        onlyOwner
    {
        Market storage m = markets[priceId];
        if (m.lastFundingTime != 0) revert MarketExists();
        if (priceId == bytes32(0)) revert InvalidParam();
        _checkMarketParams(maxLeverage, skewScale);
        m.enabled = true;
        m.invert = invert;
        m.maxLeverage = maxLeverage;
        m.lastFundingTime = uint64(block.timestamp);
        m.maxOiPerSide = maxOiPerSide;
        m.skewScale = skewScale;
        _marketIds.push(priceId);
        emit MarketConfigured(priceId, true, invert, maxLeverage, maxOiPerSide, skewScale);
    }

    /// @notice Updates a market's risk parameters. Disabling only blocks new positions.
    function setMarket(bytes32 priceId, bool enabled, uint16 maxLeverage, uint256 maxOiPerSide, uint256 skewScale)
        external
        onlyOwner
    {
        Market storage m = _existingMarket(priceId);
        _checkMarketParams(maxLeverage, skewScale);
        _accrueFunding(m); // skewScale feeds the funding rate; settle at the old value first
        m.enabled = enabled;
        m.maxLeverage = maxLeverage;
        m.maxOiPerSide = maxOiPerSide;
        m.skewScale = skewScale;
        emit MarketConfigured(priceId, enabled, m.invert, maxLeverage, maxOiPerSide, skewScale);
    }

    function setFeeParams(
        uint256 baseFeeBps_,
        uint256 maxSkewFeeBps_,
        uint256 maxFundingRatePerSecond_,
        uint256 executionFee_
    ) external onlyOwner {
        if (
            baseFeeBps_ > MAX_BASE_FEE_BPS || maxSkewFeeBps_ > MAX_SKEW_FEE_BPS
                || maxFundingRatePerSecond_ > MAX_FUNDING_RATE_PER_SECOND || executionFee_ > MAX_EXECUTION_FEE
        ) revert InvalidParam();
        // Settle funding at the old rate before it changes.
        uint256 n = _marketIds.length;
        for (uint256 i; i < n; ++i) {
            _accrueFunding(markets[_marketIds[i]]);
        }
        baseFeeBps = baseFeeBps_;
        maxSkewFeeBps = maxSkewFeeBps_;
        maxFundingRatePerSecond = maxFundingRatePerSecond_;
        executionFee = executionFee_;
        emit FeeParamsSet(baseFeeBps_, maxSkewFeeBps_, maxFundingRatePerSecond_, executionFee_);
    }

    function setRiskParams(uint256 maxPriceAge_, uint256 maxConfBps_, uint256 maxOiToNavBps_, uint256 minMargin_)
        external
        onlyOwner
    {
        if (
            maxPriceAge_ == 0 || maxPriceAge_ > MAX_PRICE_AGE || maxConfBps_ == 0 || maxConfBps_ > MAX_CONF_BPS
                || maxOiToNavBps_ < MIN_OI_TO_NAV_BPS || maxOiToNavBps_ > MAX_OI_TO_NAV_BPS || minMargin_ == 0
        ) revert InvalidParam();
        maxPriceAge = maxPriceAge_;
        maxConfBps = maxConfBps_;
        maxOiToNavBps = maxOiToNavBps_;
        minMargin = minMargin_;
        emit RiskParamsSet(maxPriceAge_, maxConfBps_, maxOiToNavBps_, minMargin_);
    }

    /// @notice Blocks new positions and new/filled limit orders. Closes, triggers and liquidations keep working.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ───────────────────────────── Trading ─────────────────────────────

    /// @notice Opens a position at the current Pyth price, optionally with take-profit / stop-loss brackets.
    /// @dev The caller pays `margin + open fee + executionFee per bracket` in USDC (approve first), plus the Pyth
    ///      update fee in native value.
    /// @param p See {OpenParams}.
    /// @param priceUpdate Pyth update data from Hermes. May be empty if a fresh enough price is already on-chain.
    function openPosition(OpenParams calldata p, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
        whenNotPaused
        returns (bytes32 key)
    {
        _updateOracle(priceUpdate);
        Market storage m = _existingMarket(p.priceId);
        _validateTrade(m, p.margin, p.size);

        OraclePrice memory px = _readPrice(p.priceId, m.invert);
        uint256 price = p.isLong ? px.ask : px.bid;
        if (p.acceptablePrice != 0 && (p.isLong ? price > p.acceptablePrice : price < p.acceptablePrice)) {
            revert SlippageExceeded();
        }
        _validateBrackets(p.isLong, price, p.takeProfit, p.stopLoss);

        uint256 execFee = executionFee;
        uint256 fee = _openFee(m, p.size, p.isLong);
        uint256 brackets = (p.takeProfit != 0 ? 1 : 0) + (p.stopLoss != 0 ? 1 : 0);
        usdc.safeTransferFrom(msg.sender, address(this), p.margin + fee + brackets * execFee);

        key = _open(msg.sender, p.priceId, m, p.isLong, p.margin, p.size, price, fee);
        _attachBrackets(key, p.takeProfit, p.stopLoss, execFee);
    }

    /// @notice Closes the caller's position in `priceId` at the current Pyth price.
    /// @param acceptablePrice Worst execution price accepted (minimum for longs, maximum for shorts); 0 disables.
    function closePosition(bytes32 priceId, uint256 acceptablePrice, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
    {
        _updateOracle(priceUpdate);
        bytes32 key = positionKey(msg.sender, priceId);
        Position storage pos = _positions[key];
        if (pos.trader == address(0)) revert PositionNotFound();
        Market storage m = markets[priceId];

        OraclePrice memory px = _readPrice(priceId, m.invert);
        _requirePriceAfterOpen(pos, px);
        _accrueFunding(m);
        if (_isLiquidatable(pos, px.mid, m.fundingIndex)) revert PositionLiquidatable();

        bool isLong = pos.isLong;
        uint256 price = isLong ? px.bid : px.ask;
        if (acceptablePrice != 0 && (isLong ? price < acceptablePrice : price > acceptablePrice)) {
            revert SlippageExceeded();
        }
        _close(key, m, price);
    }

    // ───────────────────────────── Orders ─────────────────────────────

    /// @notice Places a limit order to open a position when price reaches `triggerPrice`.
    /// @dev Escrows margin, the maximum possible open fee and one execution fee for the order plus one per
    ///      bracket. Unused fee budget is refunded on fill; everything is refunded on cancel.
    function createLimitOrder(LimitParams calldata p) external nonReentrant whenNotPaused returns (uint256 orderId) {
        Market storage m = _existingMarket(p.priceId);
        _validateTrade(m, p.margin, p.size);
        if (p.triggerPrice == 0) revert InvalidTrigger();
        _validateBrackets(p.isLong, p.triggerPrice, p.takeProfit, p.stopLoss);

        uint256 execFee = executionFee;
        uint256 feeBudget = Math.mulDiv(p.size, baseFeeBps + maxSkewFeeBps, BPS, Math.Rounding.Ceil);
        uint256 brackets = (p.takeProfit != 0 ? 1 : 0) + (p.stopLoss != 0 ? 1 : 0);
        usdc.safeTransferFrom(msg.sender, address(this), p.margin + feeBudget + (1 + brackets) * execFee);

        orderId = nextOrderId++;
        _orders[orderId] = Order({
            trader: msg.sender,
            priceId: p.priceId,
            orderType: OrderType.LimitOpen,
            isLong: p.isLong,
            createdAt: uint64(block.timestamp),
            margin: p.margin,
            size: p.size,
            triggerPrice: p.triggerPrice,
            takeProfit: p.takeProfit,
            stopLoss: p.stopLoss,
            feeBudget: feeBudget,
            executionFee: execFee
        });
        _orderIds.add(orderId);
        emit OrderCreated(
            orderId, msg.sender, p.priceId, OrderType.LimitOpen, p.isLong, p.triggerPrice, p.margin, p.size
        );
    }

    /// @notice Sets (or moves) the take-profit or stop-loss on the caller's open position in `priceId`.
    /// @dev A position has at most one order of each type. Creating one escrows `executionFee`; moving an
    ///      existing one is free. Take-profit fires when the mid price is at or beyond the trigger in the
    ///      position's favour, stop-loss when it is at or beyond the trigger against it.
    function setTriggerOrder(bytes32 priceId, OrderType orderType, uint256 triggerPrice)
        external
        nonReentrant
        returns (uint256 orderId)
    {
        if (orderType == OrderType.LimitOpen) revert NotTriggerOrderType();
        if (triggerPrice == 0) revert InvalidTrigger();
        bytes32 key = positionKey(msg.sender, priceId);
        Position storage pos = _positions[key];
        if (pos.trader == address(0)) revert PositionNotFound();

        orderId = orderType == OrderType.TakeProfit ? pos.tpOrderId : pos.slOrderId;
        if (orderId != 0) {
            Order storage o = _orders[orderId];
            o.triggerPrice = triggerPrice;
            o.createdAt = uint64(block.timestamp);
            emit OrderUpdated(orderId, triggerPrice);
        } else {
            uint256 execFee = executionFee;
            usdc.safeTransferFrom(msg.sender, address(this), execFee);
            orderId = _createTrigger(key, orderType, triggerPrice, execFee);
        }
    }

    /// @notice Cancels the caller's order and refunds everything escrowed for it.
    function cancelOrder(uint256 orderId) external nonReentrant {
        Order memory o = _orders[orderId];
        if (o.trader == address(0)) revert OrderNotFound();
        if (o.trader != msg.sender) revert NotOrderOwner();

        uint256 refund;
        if (o.orderType == OrderType.LimitOpen) {
            uint256 brackets = (o.takeProfit != 0 ? 1 : 0) + (o.stopLoss != 0 ? 1 : 0);
            refund = o.margin + o.feeBudget + (1 + brackets) * o.executionFee;
        } else {
            Position storage pos = _positions[positionKey(o.trader, o.priceId)];
            if (o.orderType == OrderType.TakeProfit) pos.tpOrderId = 0;
            else pos.slOrderId = 0;
            refund = o.executionFee;
        }
        _removeOrder(orderId, o.trader);
        if (refund != 0) usdc.safeTransfer(o.trader, refund);
    }

    /// @notice Executes order `orderId` if its trigger is met. Anyone may call; the caller earns the order's
    ///         execution fee.
    /// @dev The price used must have been published at or after the order was created or last moved, so an
    ///      order can never be filled against a price that predates it.
    function executeOrder(uint256 orderId, bytes[] calldata priceUpdate) external payable nonReentrant {
        _updateOracle(priceUpdate);
        Order memory o = _orders[orderId];
        if (o.trader == address(0)) revert OrderNotFound();
        Market storage m = markets[o.priceId];

        OraclePrice memory px = _readPrice(o.priceId, m.invert);
        if (px.publishTime < o.createdAt) revert PriceBeforeOrder();

        uint256 price;
        if (o.orderType == OrderType.LimitOpen) {
            price = _fillLimit(orderId, o, m, px);
        } else {
            price = _fillTrigger(orderId, o, m, px);
        }
        emit OrderExecuted(orderId, o.trader, msg.sender, price);
        if (o.executionFee != 0) usdc.safeTransfer(msg.sender, o.executionFee);
    }

    // ───────────────────────────── Liquidations ─────────────────────────────

    /// @notice Liquidates every liquidatable position of `trader` using prices already on-chain.
    /// @dev Reverts with {NothingToLiquidate} if none qualifies (including when prices are stale).
    function liquidate(address trader) external nonReentrant returns (uint256 liquidated) {
        liquidated = _liquidateTrader(trader);
    }

    /// @notice Same as {liquidate(address)} after pushing fresh Pyth prices. This is what keepers call.
    function liquidate(address trader, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
        returns (uint256 liquidated)
    {
        _updateOracle(priceUpdate);
        liquidated = _liquidateTrader(trader);
    }

    /// @notice Liquidates each position in `keys` that qualifies and skips the rest.
    /// @dev Reverts with {NothingToLiquidate} if none qualifies, so a keeper's simulation fails cheaply.
    function liquidateBatch(bytes32[] calldata keys, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
        returns (uint256 liquidated)
    {
        _updateOracle(priceUpdate);
        uint256 n = keys.length;
        for (uint256 i; i < n; ++i) {
            if (_tryLiquidate(keys[i])) ++liquidated;
        }
        if (liquidated == 0) revert NothingToLiquidate();
    }

    // ───────────────────────────── Views ─────────────────────────────

    function positionKey(address trader, bytes32 priceId) public pure returns (bytes32) {
        return keccak256(abi.encode(trader, priceId));
    }

    /// @inheritdoc IPerpEngine
    function reservedLiquidity() external view returns (uint256) {
        return Math.mulDiv(totalOpenInterest, BPS, maxOiToNavBps, Math.Rounding.Ceil);
    }

    function getMarketIds() external view returns (bytes32[] memory) {
        return _marketIds;
    }

    function getPosition(address trader, bytes32 priceId) external view returns (Position memory) {
        return _positions[positionKey(trader, priceId)];
    }

    function getPositionByKey(bytes32 key) external view returns (Position memory) {
        return _positions[key];
    }

    function positionCount() external view returns (uint256) {
        return _positionKeys.length();
    }

    /// @notice Pages through all open positions. Ordering is not stable across state changes.
    function getPositions(uint256 offset, uint256 limit) external view returns (PositionView[] memory out) {
        uint256 total = _positionKeys.length();
        if (offset >= total) return out;
        uint256 n = Math.min(limit, total - offset);
        out = new PositionView[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = _positionView(_positionKeys.at(offset + i));
        }
    }

    /// @notice All open positions of `trader`, one per market at most.
    function getTraderPositions(address trader) external view returns (PositionView[] memory out) {
        uint256 n = _marketIds.length;
        PositionView[] memory tmp = new PositionView[](n);
        uint256 count;
        for (uint256 i; i < n; ++i) {
            bytes32 key = positionKey(trader, _marketIds[i]);
            if (_positions[key].trader != address(0)) tmp[count++] = _positionView(key);
        }
        out = new PositionView[](count);
        for (uint256 i; i < count; ++i) {
            out[i] = tmp[i];
        }
    }

    /// @notice Values a position at an arbitrary `price` (18 decimals).
    /// @return pnl Price PnL minus funding owed, before the close fee.
    /// @return fundingOwed Funding the position owes (negative: is owed).
    /// @return liquidationPrice Mid price at which the position becomes liquidatable.
    /// @return liquidatable Whether it would be liquidatable at `price`.
    function getPositionState(bytes32 key, uint256 price)
        external
        view
        returns (int256 pnl, int256 fundingOwed, uint256 liquidationPrice, bool liquidatable)
    {
        Position storage pos = _positions[key];
        if (pos.trader == address(0)) revert PositionNotFound();
        int256 index = _currentFundingIndex(markets[pos.priceId]);
        fundingOwed = _fundingOwed(pos, index);
        pnl = _pricePnl(pos, price) - fundingOwed;
        liquidationPrice = _liquidationPrice(pos, index);
        liquidatable = _isLiquidatable(pos, price, index);
    }

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    function orderCount() external view returns (uint256) {
        return _orderIds.length();
    }

    /// @notice Pages through all open orders. Ordering is not stable across state changes.
    function getOrders(uint256 offset, uint256 limit) external view returns (uint256[] memory ids, Order[] memory out) {
        uint256 total = _orderIds.length();
        if (offset >= total) return (ids, out);
        uint256 n = Math.min(limit, total - offset);
        ids = new uint256[](n);
        out = new Order[](n);
        for (uint256 i; i < n; ++i) {
            uint256 id = _orderIds.at(offset + i);
            ids[i] = id;
            out[i] = _orders[id];
        }
    }

    /// @notice All open orders of `trader`. Linear in the number of open orders; intended for eth_call.
    function getTraderOrders(address trader) external view returns (uint256[] memory ids, Order[] memory out) {
        uint256 total = _orderIds.length();
        uint256 count;
        for (uint256 i; i < total; ++i) {
            if (_orders[_orderIds.at(i)].trader == trader) ++count;
        }
        ids = new uint256[](count);
        out = new Order[](count);
        uint256 j;
        for (uint256 i; j < count; ++i) {
            uint256 id = _orderIds.at(i);
            if (_orders[id].trader == trader) {
                ids[j] = id;
                out[j++] = _orders[id];
            }
        }
    }

    /// @notice Open fee a trade of `size` on the given side would pay right now.
    function quoteOpenFee(bytes32 priceId, uint256 size, bool isLong) external view returns (uint256) {
        return _openFee(_existingMarket(priceId), size, isLong);
    }

    /// @notice Current funding rate per second per unit of notional (1e18). Positive: longs pay shorts.
    function fundingRate(bytes32 priceId) external view returns (int256) {
        return _fundingRate(_existingMarket(priceId));
    }

    /// @notice Funding index including funding accrued since the last on-chain update.
    function currentFundingIndex(bytes32 priceId) external view returns (int256) {
        return _currentFundingIndex(_existingMarket(priceId));
    }

    /// @notice Validated on-chain price of a market; reverts if Pyth has no usable price.
    function getPrice(bytes32 priceId) external view returns (OraclePrice memory) {
        return _readPrice(priceId, _existingMarket(priceId).invert);
    }

    // ───────────────────────────── Internal: trading ─────────────────────────────

    function _open(
        address trader,
        bytes32 priceId,
        Market storage m,
        bool isLong,
        uint256 margin,
        uint256 size,
        uint256 price,
        uint256 fee
    ) private returns (bytes32 key) {
        key = positionKey(trader, priceId);
        if (_positions[key].trader != address(0)) revert PositionExists();

        _accrueFunding(m);
        uint256 sideOi = isLong ? (m.longOi += size) : (m.shortOi += size);
        if (sideOi > m.maxOiPerSide) revert MarketOiCapExceeded();
        uint256 totalOi = (totalOpenInterest += size);
        if (totalOi * BPS > vault.totalAssets() * maxOiToNavBps) revert VaultOiCapExceeded();

        _positions[key] = Position({
            margin: margin,
            size: size,
            entryPrice: price,
            isLong: isLong,
            priceId: priceId,
            trader: trader,
            openedAt: uint64(block.timestamp),
            tpOrderId: 0,
            slOrderId: 0,
            entryFundingIndex: m.fundingIndex
        });
        _positionKeys.add(key);
        emit PositionOpened(key, trader, priceId, isLong, margin, size, price, fee);

        if (fee != 0) vault.receiveFees(fee);
    }

    /// @dev Settles and removes a position at `price`. Funding must already be accrued for `m`.
    function _close(bytes32 key, Market storage m, uint256 price) private {
        Position memory pos = _positions[key];
        int256 pnl = _pricePnl(_positions[key], price) - _fundingOwed(_positions[key], m.fundingIndex);
        uint256 refund = _removePosition(key, pos, m);
        uint256 fee = Math.mulDiv(pos.size, baseFeeBps, BPS, Math.Rounding.Ceil);

        uint256 fromEngine; // USDC returned to the trader out of margin and order escrow
        uint256 fromVault; // profit paid by the vault
        if (pnl >= 0) {
            fee = Math.min(fee, pos.margin);
            fromEngine = pos.margin - fee;
            if (fee != 0) vault.receiveFees(fee);
            if (pnl != 0) fromVault = vault.payoutTraderProfit(pos.trader, pnl.toUint256());
        } else {
            uint256 loss = Math.min((-pnl).toUint256(), pos.margin);
            uint256 remaining = pos.margin - loss;
            fee = Math.min(fee, remaining);
            fromEngine = remaining - fee;
            vault.receiveTraderLoss(pos.trader, loss);
            rewardToken.mintLossRebate(pos.trader, loss);
            if (fee != 0) vault.receiveFees(fee);
        }
        emit PositionClosed(key, pos.trader, pos.priceId, price, pnl, fee, fromEngine + fromVault);

        fromEngine += refund;
        if (fromEngine != 0) usdc.safeTransfer(pos.trader, fromEngine);
    }

    function _fillLimit(uint256 orderId, Order memory o, Market storage m, OraclePrice memory px)
        private
        whenNotPaused
        returns (uint256 price)
    {
        // Limits may have changed since the order was placed; it must still be a valid trade now.
        _validateTrade(m, o.margin, o.size);
        price = o.isLong ? px.ask : px.bid;
        if (o.isLong ? price > o.triggerPrice : price < o.triggerPrice) revert TriggerNotMet();
        // On a gap through the stop the fill would be stopped out at once; leave the order resting instead.
        _validateBrackets(o.isLong, price, 0, o.stopLoss);

        _removeOrder(orderId, address(0));
        uint256 fee = Math.min(_openFee(m, o.size, o.isLong), o.feeBudget);
        bytes32 key = _open(o.trader, o.priceId, m, o.isLong, o.margin, o.size, price, fee);
        _attachBrackets(key, o.takeProfit, o.stopLoss, o.executionFee);

        if (o.feeBudget > fee) usdc.safeTransfer(o.trader, o.feeBudget - fee);
    }

    function _fillTrigger(uint256 orderId, Order memory o, Market storage m, OraclePrice memory px)
        private
        returns (uint256 price)
    {
        bytes32 key = positionKey(o.trader, o.priceId);
        Position storage pos = _positions[key];
        _requirePriceAfterOpen(pos, px);
        _accrueFunding(m);
        // Past the liquidation threshold the position belongs to liquidators, not to its stop-loss.
        if (_isLiquidatable(pos, px.mid, m.fundingIndex)) revert PositionLiquidatable();

        bool isLong = pos.isLong;
        bool priceAtOrAbove = px.mid >= o.triggerPrice;
        bool priceAtOrBelow = px.mid <= o.triggerPrice;
        if (o.orderType == OrderType.TakeProfit) {
            if (isLong ? !priceAtOrAbove : !priceAtOrBelow) revert TriggerNotMet();
            pos.tpOrderId = 0;
        } else {
            if (isLong ? !priceAtOrBelow : !priceAtOrAbove) revert TriggerNotMet();
            pos.slOrderId = 0;
        }
        _removeOrder(orderId, address(0));

        price = isLong ? px.bid : px.ask;
        _close(key, m, price);
    }

    function _liquidateTrader(address trader) private returns (uint256 liquidated) {
        uint256 n = _marketIds.length;
        for (uint256 i; i < n; ++i) {
            if (_tryLiquidate(positionKey(trader, _marketIds[i]))) ++liquidated;
        }
        if (liquidated == 0) revert NothingToLiquidate();
    }

    /// @dev Liquidates `key` if it exists, has a usable price and is past the threshold. Never reverts on a
    ///      position that merely does not qualify, so one bad entry cannot block a batch.
    function _tryLiquidate(bytes32 key) private returns (bool) {
        Position memory pos = _positions[key];
        if (pos.trader == address(0)) return false;
        Market storage m = markets[pos.priceId];
        (PriceStatus status, OraclePrice memory px) = _peekPrice(pos.priceId, m.invert);
        if (status != PriceStatus.Ok) return false;
        _accrueFunding(m);
        if (!_isLiquidatable(_positions[key], px.mid, m.fundingIndex)) return false;

        // Escrow of the position's bracket orders is not returned to the trader here: a transfer to a
        // blocklisted trader would revert and make the position unliquidatable. It goes to the vault as a fee.
        uint256 orphanedEscrow = _removePosition(key, pos, m);
        uint256 liquidatorFee = (pos.margin * LIQUIDATOR_FEE_BPS) / BPS;
        uint256 toVault = pos.margin - liquidatorFee;

        vault.receiveTraderLoss(pos.trader, toVault);
        rewardToken.mintLossRebate(pos.trader, toVault);
        if (orphanedEscrow != 0) vault.receiveFees(orphanedEscrow);
        emit PositionLiquidated(key, pos.trader, msg.sender, pos.priceId, px.mid, pos.margin, liquidatorFee, toVault);
        if (liquidatorFee != 0) usdc.safeTransfer(msg.sender, liquidatorFee);
        return true;
    }

    /// @dev Deletes the position, releases its open interest and cancels its bracket orders.
    /// @return escrow Execution fees that were escrowed for the cancelled bracket orders.
    function _removePosition(bytes32 key, Position memory pos, Market storage m) private returns (uint256 escrow) {
        if (pos.isLong) m.longOi -= pos.size;
        else m.shortOi -= pos.size;
        totalOpenInterest -= pos.size;

        if (pos.tpOrderId != 0) {
            escrow += _orders[pos.tpOrderId].executionFee;
            _removeOrder(pos.tpOrderId, pos.trader);
        }
        if (pos.slOrderId != 0) {
            escrow += _orders[pos.slOrderId].executionFee;
            _removeOrder(pos.slOrderId, pos.trader);
        }
        delete _positions[key];
        _positionKeys.remove(key);
    }

    function _attachBrackets(bytes32 key, uint256 takeProfit, uint256 stopLoss, uint256 execFee) private {
        if (takeProfit != 0) _createTrigger(key, OrderType.TakeProfit, takeProfit, execFee);
        if (stopLoss != 0) _createTrigger(key, OrderType.StopLoss, stopLoss, execFee);
    }

    /// @dev Creates a TP/SL order linked to position `key`. The execution fee must already be held.
    function _createTrigger(bytes32 key, OrderType orderType, uint256 triggerPrice, uint256 execFee)
        private
        returns (uint64 orderId)
    {
        Position storage pos = _positions[key];
        orderId = nextOrderId++;
        _orders[orderId] = Order({
            trader: pos.trader,
            priceId: pos.priceId,
            orderType: orderType,
            isLong: pos.isLong,
            createdAt: uint64(block.timestamp),
            margin: 0,
            size: 0,
            triggerPrice: triggerPrice,
            takeProfit: 0,
            stopLoss: 0,
            feeBudget: 0,
            executionFee: execFee
        });
        _orderIds.add(orderId);
        if (orderType == OrderType.TakeProfit) pos.tpOrderId = orderId;
        else pos.slOrderId = orderId;
        emit OrderCreated(orderId, pos.trader, pos.priceId, orderType, pos.isLong, triggerPrice, 0, 0);
    }

    /// @dev `cancelledFor` is the trader when the order is being cancelled, or zero when it is being filled.
    function _removeOrder(uint256 orderId, address cancelledFor) private {
        delete _orders[orderId];
        _orderIds.remove(orderId);
        if (cancelledFor != address(0)) emit OrderCancelled(orderId, cancelledFor);
    }

    // ───────────────────────────── Internal: validation and math ─────────────────────────────

    /// @dev A position may only be closed voluntarily against a price published after the second it was
    ///      opened in. Without this, a trader holding two signed prices from the same staleness window could
    ///      open on the older and close on the newer in one block for a risk-free profit.
    function _requirePriceAfterOpen(Position storage pos, OraclePrice memory px) private view {
        if (px.publishTime <= pos.openedAt) revert PriceNotAfterOpen();
    }

    function _existingMarket(bytes32 priceId) private view returns (Market storage m) {
        m = markets[priceId];
        if (m.lastFundingTime == 0) revert MarketNotFound();
    }

    function _checkMarketParams(uint16 maxLeverage, uint256 skewScale) private pure {
        if (maxLeverage == 0 || maxLeverage > MAX_LEVERAGE || skewScale == 0) revert InvalidParam();
    }

    function _validateTrade(Market storage m, uint256 margin, uint256 size) private view {
        if (!m.enabled) revert MarketDisabled();
        if (margin < minMargin) revert MarginTooLow();
        if (size < margin || size > margin * m.maxLeverage) revert LeverageOutOfRange();
    }

    /// @dev At creation a take-profit must sit on the profit side of the reference price and a stop-loss on the
    ///      loss side; anything else would fire immediately and is almost certainly an input mistake.
    function _validateBrackets(bool isLong, uint256 refPrice, uint256 takeProfit, uint256 stopLoss) private pure {
        if (takeProfit != 0 && (isLong ? takeProfit <= refPrice : takeProfit >= refPrice)) revert InvalidTrigger();
        if (stopLoss != 0 && (isLong ? stopLoss >= refPrice : stopLoss <= refPrice)) revert InvalidTrigger();
    }

    /// @dev Base fee plus a skew surcharge. The surcharge applies only when the trade leaves the market more
    ///      one-sided than it found it, and scales with the resulting skew ratio.
    function _openFee(Market storage m, uint256 size, bool isLong) private view returns (uint256 fee) {
        uint256 longOi = m.longOi;
        uint256 shortOi = m.shortOi;
        uint256 skewBefore = _absDiff(longOi, shortOi);
        if (isLong) longOi += size;
        else shortOi += size;
        uint256 skewAfter = _absDiff(longOi, shortOi);

        fee = Math.mulDiv(size, baseFeeBps, BPS, Math.Rounding.Ceil);
        if (skewAfter > skewBefore) {
            uint256 denominator = Math.max(longOi + shortOi, m.skewScale);
            fee += Math.mulDiv(size * maxSkewFeeBps, skewAfter, denominator * BPS, Math.Rounding.Ceil);
        }
    }

    /// @dev Funding per second per unit of notional. The heavier side pays, the lighter side receives, and the
    ///      vault keeps the difference, so funding can never cost the vault anything.
    function _fundingRate(Market storage m) private view returns (int256) {
        uint256 longOi = m.longOi;
        uint256 shortOi = m.shortOi;
        if (longOi == shortOi) return 0;
        uint256 denominator = Math.max(longOi + shortOi, m.skewScale);
        int256 rate = Math.mulDiv(maxFundingRatePerSecond, _absDiff(longOi, shortOi), denominator).toInt256();
        return longOi > shortOi ? rate : -rate;
    }

    function _currentFundingIndex(Market storage m) private view returns (int256) {
        return m.fundingIndex + _fundingRate(m) * (block.timestamp - m.lastFundingTime).toInt256();
    }

    function _accrueFunding(Market storage m) private {
        if (block.timestamp == m.lastFundingTime) return;
        m.fundingIndex = _currentFundingIndex(m);
        m.lastFundingTime = uint64(block.timestamp);
    }

    /// @dev Funding owed by the position since entry; negative when the position is owed funding.
    function _fundingOwed(Position storage pos, int256 fundingIndex) private view returns (int256 owed) {
        owed = (pos.size.toInt256() * (fundingIndex - pos.entryFundingIndex)) / FUNDING_PRECISION;
        if (!pos.isLong) owed = -owed;
    }

    /// @dev PnL from the price move alone. Rounded against the trader: profits down, losses up.
    function _pricePnl(Position storage pos, uint256 price) private view returns (int256) {
        uint256 entry = pos.entryPrice;
        bool profit = pos.isLong ? price >= entry : price <= entry;
        uint256 magnitude =
            Math.mulDiv(pos.size, _absDiff(price, entry), entry, profit ? Math.Rounding.Floor : Math.Rounding.Ceil);
        return profit ? magnitude.toInt256() : -magnitude.toInt256();
    }

    function _isLiquidatable(Position storage pos, uint256 price, int256 fundingIndex) private view returns (bool) {
        int256 pnl = _pricePnl(pos, price) - _fundingOwed(pos, fundingIndex);
        return pnl <= -((pos.margin * LIQUIDATION_THRESHOLD_BPS) / BPS).toInt256();
    }

    function _liquidationPrice(Position storage pos, int256 fundingIndex) private view returns (uint256) {
        // Price loss the position can still absorb before it hits the threshold.
        int256 room = ((pos.margin * LIQUIDATION_THRESHOLD_BPS) / BPS).toInt256() - _fundingOwed(pos, fundingIndex);
        if (room <= 0) return pos.isLong ? type(uint256).max : 0;
        uint256 r = room.toUint256();
        if (pos.isLong) {
            return r >= pos.size ? 0 : Math.mulDiv(pos.entryPrice, pos.size - r, pos.size, Math.Rounding.Ceil);
        }
        return Math.mulDiv(pos.entryPrice, pos.size + r, pos.size);
    }

    function _positionView(bytes32 key) private view returns (PositionView memory v) {
        Position storage pos = _positions[key];
        int256 index = _currentFundingIndex(markets[pos.priceId]);
        v.key = key;
        v.position = pos;
        v.fundingOwed = _fundingOwed(pos, index);
        v.liquidationPrice = _liquidationPrice(pos, index);
    }

    function _absDiff(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a - b : b - a;
    }

    // ───────────────────────────── Internal: oracle ─────────────────────────────

    /// @dev Forwards `priceUpdate` to Pyth, paying its fee from `msg.value`, and refunds the remainder. Every
    ///      payable entry point calls this exactly once, so the engine never retains native value.
    function _updateOracle(bytes[] calldata priceUpdate) private {
        uint256 fee;
        if (priceUpdate.length != 0) {
            fee = pyth.getUpdateFee(priceUpdate);
            if (msg.value < fee) revert InsufficientOracleFee();
            pyth.updatePriceFeeds{value: fee}(priceUpdate);
        }
        if (msg.value > fee) {
            (bool ok,) = msg.sender.call{value: msg.value - fee}("");
            if (!ok) revert RefundFailed();
        }
    }

    function _readPrice(bytes32 priceId, bool invert) private view returns (OraclePrice memory px) {
        PriceStatus status;
        (status, px) = _peekPrice(priceId, invert);
        if (status == PriceStatus.Ok) return px;
        if (status == PriceStatus.Unavailable) revert OraclePriceUnavailable();
        if (status == PriceStatus.Stale) revert OraclePriceStale();
        if (status == PriceStatus.ConfidenceTooWide) revert OracleConfidenceTooWide();
        revert OraclePriceInvalid();
    }

    /// @dev Reads and validates the latest on-chain Pyth price without reverting.
    function _peekPrice(bytes32 priceId, bool invert) private view returns (PriceStatus, OraclePrice memory px) {
        PythStructs.Price memory p;
        try pyth.getPriceUnsafe(priceId) returns (PythStructs.Price memory fetched) {
            p = fetched;
        } catch {
            return (PriceStatus.Unavailable, px);
        }
        if (_absDiff(block.timestamp, p.publishTime) > maxPriceAge) return (PriceStatus.Stale, px);
        if (p.price <= 0 || p.expo > 0 || p.expo < -18) return (PriceStatus.Invalid, px);

        uint256 raw = uint256(uint64(p.price));
        uint256 conf = p.conf;
        if (conf * BPS > raw * maxConfBps) return (PriceStatus.ConfidenceTooWide, px);

        // maxConfBps <= 5% guarantees conf < raw, so the band stays strictly positive.
        uint256 scale = 10 ** (18 - uint256(uint32(-p.expo)));
        px.mid = raw * scale;
        px.bid = (raw - conf) * scale;
        px.ask = (raw + conf) * scale;
        px.publishTime = p.publishTime;
        if (invert) {
            uint256 one = PRICE_PRECISION * PRICE_PRECISION;
            (px.bid, px.ask) = (one / px.ask, Math.ceilDiv(one, px.bid));
            px.mid = one / px.mid;
            if (px.bid == 0) return (PriceStatus.Invalid, px);
        }
        return (PriceStatus.Ok, px);
    }
}
