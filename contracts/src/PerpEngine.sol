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

import {IHouseVault} from "./interfaces/IHouseVault.sol";
import {IPerpEngine} from "./interfaces/IPerpEngine.sol";
import {IRewardToken} from "./interfaces/IRewardToken.sol";
import {PositionMath} from "./libraries/PositionMath.sol";
import {PythOracle} from "./PythOracle.sol";
import {
    LimitParams,
    Market,
    MarketConfig,
    OpenParams,
    OraclePrice,
    Order,
    OrderType,
    Position,
    PriceStatus
} from "./Types.sol";

/// @title PerpEngine
/// @notice Synthetic derivatives engine for Arc. Traders post USDC margin and take leveraged long/short exposure
///         to Pyth-priced instruments; the HouseVault is the counterparty to every position.
///
/// @dev Instruments
///  A market is a Pyth feed plus three optional switches (see {Market}): a quote feed (crosses such as ETH/BTC),
///  inversion (JPY/USD from USD/JPY) and an expiry (dated, cash-settled futures). Positions are sized in USDC
///  notional, so every instrument is fractional down to `minMargin`.
///
/// @dev Conventions
///  - USDC amounts (margin, size, fees) use 6 decimals; prices use 18.
///  - One position per trader per market, keyed by `positionKey(trader, marketId)`. The market id is called
///    `priceId` in structs and events; for a plain perpetual it is the Pyth feed id. An open on the side the
///    trader already holds adds to that position; an open on the other side reverts with {PositionExists}.
///  - Trades that favour the trader execute on the adverse side of Pyth's confidence band (buys at price+conf,
///    sells at price-conf). Liquidations and trigger conditions are evaluated at the mid price.
///  - A position can only be closed (by its trader or by an order) against a price published after the second
///    it was opened or last increased in; liquidation has no such restriction.
///  - A position is liquidatable once price loss plus funding owed reaches 90% of its margin.
///  - Profit is capped at `maxProfitMultiple` times margin, for a whole position and for each part closed.
///  - Engine USDC holdings always equal open position margins plus open order escrows plus deferred payments.
///  - Payments to traders never block: if USDC refuses the transfer (a blocklisted recipient) the amount is
///    parked in `claimable` for that same address and the position is still removed.
///  - Pyth update fees are paid in Arc's native USDC via `msg.value`; any excess is refunded to the caller.
contract PerpEngine is IPerpEngine, Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using EnumerableSet for EnumerableSet.UintSet;

    // ───────────────────────────── Constants ─────────────────────────────

    uint256 internal constant BPS = 10_000;

    /// @notice Hard ceiling on per-market leverage.
    uint256 public constant MAX_LEVERAGE = 1_000;
    /// @notice Above this leverage a position can be opened and closed only through keeper-executed orders, which
    ///         fill at a price published after the order. Direct calls read a stored price up to `maxPriceAge` old;
    ///         at 1000x a 0.1% move is the whole margin, so a stale price would be a free option on the vault.
    uint256 public constant DIRECT_MAX_LEVERAGE = 100;
    /// @notice Each side's trading fee is at most this share of the position's margin (10%). Fees are charged on
    ///         notional, so without a cap a 1000x round trip would cost the whole margin; the cap only binds above
    ///         200x at the default 5 bp.
    uint256 public constant MARGIN_FEE_CAP_BPS = 1_000;
    /// @notice A position is liquidated once its loss (price move plus funding) reaches this share of margin.
    uint256 public constant LIQUIDATION_THRESHOLD_BPS = PositionMath.LIQUIDATION_THRESHOLD_BPS;
    // Bounds on what the owner can set. Internal (no getters) to keep the engine under the EIP-170 size limit;
    // they are fixed in this source and documented in SECURITY.md.

    /// @dev Share of the liquidated margin paid to the liquidator; the remainder goes to the vault.
    uint256 internal constant LIQUIDATOR_FEE_BPS = 200;
    uint256 internal constant MAX_BASE_FEE_BPS = 50;
    uint256 internal constant MAX_SKEW_FEE_BPS = 100;
    /// @dev Ceiling for the full-skew funding rate: 1000% of notional per year.
    uint256 internal constant MAX_FUNDING_RATE_PER_SECOND = 317_097_919_837;
    uint256 internal constant MAX_EXECUTION_FEE = 10e6;
    uint256 internal constant MAX_PRICE_AGE = 60;
    uint256 internal constant MAX_CONF_BPS = 500;
    /// @dev Bounds for `maxOiToNavBps` (0.5x to 10x of NAV).
    uint256 internal constant MIN_OI_TO_NAV_BPS = 5_000;
    uint256 internal constant MAX_OI_TO_NAV_BPS = 100_000;
    uint256 internal constant MAX_MARKETS = 64;

    // ───────────────────────────── Immutables ─────────────────────────────

    IERC20 public immutable usdc;
    IPyth public immutable pyth;
    PythOracle public immutable oracle;
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
    /// @notice A position's profit is capped at this multiple of its margin.
    uint256 public maxProfitMultiple = 10;

    // ───────────────────────────── State ─────────────────────────────

    mapping(bytes32 marketId => Market) private _markets;
    bytes32[] private _marketIds;

    mapping(bytes32 key => Position) private _positions;
    EnumerableSet.Bytes32Set private _positionKeys;

    mapping(uint256 orderId => Order) private _orders;
    EnumerableSet.UintSet private _orderIds;
    uint64 public nextOrderId = 1;

    /// @notice Sum of long and short notional across all markets.
    uint256 public totalOpenInterest;

    /// @notice USDC owed to `account` whose transfer was refused; collect with {claim}.
    mapping(address account => uint256) public claimable;
    uint256 public totalClaimable;

    // ───────────────────────────── Events ─────────────────────────────

    event MarketConfigured(
        bytes32 indexed priceId, bool enabled, bool invert, uint16 maxLeverage, uint256 maxOiPerSide, uint256 skewScale
    );
    event MarketListed(
        bytes32 indexed priceId, string symbol, bytes32 feedId, bytes32 quoteFeedId, bool invert, uint64 expiry
    );
    event MarketSettled(bytes32 indexed priceId, uint256 settlementPrice);
    event FeeParamsSet(
        uint256 baseFeeBps, uint256 maxSkewFeeBps, uint256 maxFundingRatePerSecond, uint256 executionFee
    );
    event RiskParamsSet(uint256 maxPriceAge, uint256 maxConfBps, uint256 maxOiToNavBps, uint256 minMargin);
    event MaxProfitMultipleSet(uint256 maxProfitMultiple);
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
    /// @notice An open added to an existing position (`price` is the fill price of the addition).
    event PositionIncreased(
        bytes32 indexed key,
        address indexed trader,
        bytes32 indexed priceId,
        bool isLong,
        uint256 addedMargin,
        uint256 addedSize,
        uint256 price,
        uint256 fee,
        uint256 newMargin,
        uint256 newSize,
        uint256 newEntryPrice
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
    /// @notice Part of a position was closed; the rest stays open. `payout` is what the closed part paid out.
    event PositionDecreased(
        bytes32 indexed key,
        address indexed trader,
        bytes32 indexed priceId,
        uint256 exitPrice,
        uint256 closedSize,
        uint256 releasedMargin,
        int256 pnl,
        uint256 fee,
        uint256 payout
    );
    event MarginAdded(bytes32 indexed key, address indexed trader, uint256 amount, uint256 newMargin);
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
    event PaymentDeferred(address indexed account, uint256 amount);
    event Claimed(address indexed account, uint256 amount);

    // ───────────────────────────── Errors ─────────────────────────────

    error ZeroAddress();
    error InvalidParam();
    error MarketExists();
    error MarketNotFound();
    error MarketDisabled();
    error MarketExpired();
    error MarketNotExpired();
    error MarketAlreadySettled();
    error PriceBeforeExpiry();
    error MarginTooLow();
    error LeverageOutOfRange();
    error HighLeverageNeedsOrder();
    error PositionExists();
    error PositionNotFound();
    error PositionLiquidatable();
    /// @notice {addMargin} on a position whose PnL (after funding) is above zero.
    error PositionInProfit();
    /// @notice An increase of a position whose PnL (after funding) is already beyond its profit cap.
    error ProfitCapReached();
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
    error NothingToClaim();
    error InsufficientOracleFee();
    error RefundFailed();
    error OraclePriceUnavailable();
    error OraclePriceStale();
    error OraclePriceInvalid();
    error OracleConfidenceTooWide();

    // ───────────────────────────── Constructor ─────────────────────────────

    constructor(IERC20 usdc_, PythOracle oracle_, IHouseVault vault_, IRewardToken rewardToken_, address owner_)
        Ownable(owner_)
    {
        if (
            address(usdc_) == address(0) || address(oracle_) == address(0) || address(vault_) == address(0)
                || address(rewardToken_) == address(0)
        ) revert ZeroAddress();
        usdc = usdc_;
        oracle = oracle_;
        pyth = oracle_.pyth();
        vault = vault_;
        rewardToken = rewardToken_;
        // The vault pulls losses and fees from the engine.
        usdc_.forceApprove(address(vault_), type(uint256).max);
    }

    // ───────────────────────────── Admin ─────────────────────────────

    /// @notice Lists a new instrument under `marketId`.
    /// @dev By convention a plain perpetual uses its Pyth feed id as market id; crosses and dated futures use
    ///      any other unique id (the deploy script hashes the symbol).
    function addMarket(bytes32 marketId, MarketConfig calldata cfg) external onlyOwner {
        Market storage m = _markets[marketId];
        if (m.lastFundingTime != 0) revert MarketExists();
        if (
            marketId == bytes32(0) || cfg.feedId == bytes32(0) || cfg.feedId == cfg.quoteFeedId
                || (cfg.expiry != 0 && cfg.expiry <= block.timestamp) || _marketIds.length == MAX_MARKETS
        ) revert InvalidParam();
        _checkMarketParams(cfg.maxLeverage, cfg.skewScale);
        m.enabled = true;
        m.invert = cfg.invert;
        m.maxLeverage = cfg.maxLeverage;
        m.lastFundingTime = uint64(block.timestamp);
        m.expiry = cfg.expiry;
        m.feedId = cfg.feedId;
        m.quoteFeedId = cfg.quoteFeedId;
        m.maxOiPerSide = cfg.maxOiPerSide;
        m.skewScale = cfg.skewScale;
        m.symbol = cfg.symbol;
        _marketIds.push(marketId);
        emit MarketListed(marketId, cfg.symbol, cfg.feedId, cfg.quoteFeedId, cfg.invert, cfg.expiry);
        emit MarketConfigured(marketId, true, cfg.invert, cfg.maxLeverage, cfg.maxOiPerSide, cfg.skewScale);
    }

    /// @notice Updates a market's risk parameters. Disabling only blocks new positions.
    function setMarket(bytes32 marketId, bool enabled, uint16 maxLeverage, uint256 maxOiPerSide, uint256 skewScale)
        external
        onlyOwner
    {
        Market storage m = _existingMarket(marketId);
        _checkMarketParams(maxLeverage, skewScale);
        _accrueFunding(m); // skewScale feeds the funding rate; settle at the old value first
        m.enabled = enabled;
        m.maxLeverage = maxLeverage;
        m.maxOiPerSide = maxOiPerSide;
        m.skewScale = skewScale;
        emit MarketConfigured(marketId, enabled, m.invert, maxLeverage, maxOiPerSide, skewScale);
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
            _accrueFunding(_markets[_marketIds[i]]);
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

    /// @notice Sets the profit cap, as a multiple of margin (1 to 100).
    function setMaxProfitMultiple(uint256 maxProfitMultiple_) external onlyOwner {
        if (maxProfitMultiple_ == 0 || maxProfitMultiple_ > 100) revert InvalidParam();
        maxProfitMultiple = maxProfitMultiple_;
        emit MaxProfitMultipleSet(maxProfitMultiple_);
    }

    /// @notice Blocks new positions, increases and new/filled open orders. Closes, triggers, margin top-ups and
    ///         liquidations keep working.
    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ───────────────────────────── Trading ─────────────────────────────

    /// @notice Opens a position at the current Pyth price, or adds to the caller's position on the same side,
    ///         optionally with take-profit / stop-loss brackets.
    /// @dev The caller pays `margin + open fee + executionFee per bracket` in USDC (approve first), plus the Pyth
    ///      update fee in native value. When the position already has an order of a bracket's type, that order is
    ///      moved to the new trigger and the bracket's execution fee is refunded. Callers that cannot land a
    ///      transaction within `maxPriceAge` of fetching a price (people using wallets) should place a marketable
    ///      limit order with {createLimitOrder} instead.
    /// @param p See {OpenParams}. Margin and size are those of this trade; leverage limits apply to it alone.
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
        if (p.size > p.margin * DIRECT_MAX_LEVERAGE) revert HighLeverageNeedsOrder();

        OraclePrice memory px = _readPrice(m);
        uint256 price = p.isLong ? px.ask : px.bid;
        if (p.acceptablePrice != 0 && (p.isLong ? price > p.acceptablePrice : price < p.acceptablePrice)) {
            revert SlippageExceeded();
        }
        _validateBrackets(p.isLong, price, p.takeProfit, p.stopLoss);

        uint256 execFee = executionFee;
        uint256 fee = _openFee(m, p.size, p.isLong, p.margin);
        uint256 brackets = (p.takeProfit != 0 ? 1 : 0) + (p.stopLoss != 0 ? 1 : 0);
        usdc.safeTransferFrom(msg.sender, address(this), p.margin + fee + brackets * execFee);

        key = _open(msg.sender, p.priceId, m, p.isLong, p.margin, p.size, price, fee);
        _pay(msg.sender, _attachBrackets(key, p.takeProfit, p.stopLoss, execFee));
    }

    /// @notice Closes `size` of the caller's position in `marketId` at the current price (or at the settlement
    ///         price of a settled dated market); `size` 0, or at least the position's size, closes all of it.
    /// @dev A partial close releases margin in proportion and leaves the rest of the position with its entry price,
    ///      funding index, open time and orders. If the rest would hold less than `minMargin`, everything closes.
    /// @param acceptablePrice Worst execution price accepted (minimum for longs, maximum for shorts); 0 disables.
    function closePosition(bytes32 marketId, uint256 size, uint256 acceptablePrice, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
    {
        _updateOracle(priceUpdate);
        bytes32 key = positionKey(msg.sender, marketId);
        Position memory pos = _positions[key];
        if (pos.trader == address(0)) revert PositionNotFound();
        Market storage m = _markets[marketId];
        // A settled dated market closes at its fixed settlement price, so no stale-price option remains there.
        if (m.settlementPrice == 0 && pos.size > pos.margin * DIRECT_MAX_LEVERAGE) revert HighLeverageNeedsOrder();

        uint256 price = _exitPrice(pos, m, _readPrice(m));
        if (acceptablePrice != 0 && (pos.isLong ? price < acceptablePrice : price > acceptablePrice)) {
            revert SlippageExceeded();
        }
        _close(key, pos, m, price, size);
    }

    /// @notice Adds `amount` USDC (approve first) to the margin of the caller's position in `marketId`, lowering
    ///         its leverage and moving its liquidation price away. Works while paused.
    /// @dev Refused with {PositionInProfit} while the position's PnL after funding is above zero at the last price
    ///      on-chain, however old (with no usable price at all it is allowed): margin added to a winner would lift
    ///      its profit cap. Leverage can be brought down to 1x, not below ({LeverageOutOfRange}). Restarts
    ///      `openedAt` like an increase: margin can bring a keeper-only position under `DIRECT_MAX_LEVERAGE`, and
    ///      the direct close that then becomes possible must not use a price from before the top-up.
    function addMargin(bytes32 marketId, uint256 amount) external nonReentrant {
        bytes32 key = positionKey(msg.sender, marketId);
        Position storage pos = _positions[key];
        if (pos.trader == address(0)) revert PositionNotFound();
        Market storage m = _markets[marketId];
        _accrueFunding(m);
        (PriceStatus status, OraclePrice memory px) = _peekPrice(m, type(uint256).max);
        if (status == PriceStatus.Ok && PositionMath.pnl(pos, px.mid, m.fundingIndex) > 0) revert PositionInProfit();
        if (amount == 0) revert InvalidParam();
        uint256 margin = pos.margin + amount;
        if (margin > pos.size) revert LeverageOutOfRange();
        pos.margin = margin;
        pos.openedAt = uint64(block.timestamp);
        emit MarginAdded(key, msg.sender, amount, margin);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Collects USDC that could not be delivered to the caller earlier.
    function claim() external nonReentrant {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        totalClaimable -= amount;
        emit Claimed(msg.sender, amount);
        usdc.safeTransfer(msg.sender, amount);
    }

    // ───────────────────────────── Orders ─────────────────────────────

    /// @notice Places an order to open a position (or add to the caller's position on the same side) once the
    ///         market reaches `triggerPrice`. A limit order fills at the trigger or better; with a trigger at or
    ///         beyond the current price it is a market order executed by a keeper against the next price. With
    ///         `stopEntry` it is a stop-entry (breakout) order, which fills once the market trades through the
    ///         trigger: a long once the ask is at or above it, a short once the bid is at or below it.
    /// @dev Escrows margin, the maximum possible open fee and one execution fee for the order plus one per
    ///      bracket. Unused fee budget is refunded on fill; everything is refunded on cancel.
    function createLimitOrder(LimitParams calldata p) external nonReentrant whenNotPaused returns (uint256 orderId) {
        Market storage m = _existingMarket(p.priceId);
        _validateTrade(m, p.margin, p.size);
        if (p.triggerPrice == 0) revert InvalidTrigger();
        _validateBrackets(p.isLong, p.triggerPrice, p.takeProfit, p.stopLoss);

        uint256 execFee = executionFee;
        uint256 feeBudget =
            Math.min(Math.mulDiv(p.size, baseFeeBps + maxSkewFeeBps, BPS, Math.Rounding.Ceil), _feeCap(p.margin));
        uint256 brackets = (p.takeProfit != 0 ? 1 : 0) + (p.stopLoss != 0 ? 1 : 0);
        usdc.safeTransferFrom(msg.sender, address(this), p.margin + feeBudget + (1 + brackets) * execFee);

        OrderType orderType = p.stopEntry ? OrderType.StopOpen : OrderType.LimitOpen;
        orderId = nextOrderId++;
        _orders[orderId] = Order({
            trader: msg.sender,
            priceId: p.priceId,
            orderType: orderType,
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
        emit OrderCreated(orderId, msg.sender, p.priceId, orderType, p.isLong, p.triggerPrice, p.margin, p.size);
    }

    /// @notice Sets (or moves) an order attached to the caller's open position in `marketId` that closes `size`
    ///         of it when it executes (0: all of it; it never closes more than is open).
    /// @dev A position has at most one order of each type; creating one escrows `executionFee`, moving it (a new
    ///      trigger and size) is free.
    ///      - TakeProfit fires when the mid price is at or beyond `triggerPrice` in the position's favour.
    ///      - StopLoss fires when it is at or beyond `triggerPrice` against it.
    ///      - Close is a market close executed by a keeper against the next price; `triggerPrice` is the worst
    ///        acceptable execution price (0 for none).
    function setTriggerOrder(bytes32 marketId, OrderType orderType, uint256 triggerPrice, uint256 size)
        external
        nonReentrant
        returns (uint256 orderId)
    {
        if (_isOpenOrder(orderType)) revert NotTriggerOrderType();
        if (triggerPrice == 0 && orderType != OrderType.Close) revert InvalidTrigger();
        bytes32 key = positionKey(msg.sender, marketId);
        Position storage pos = _positions[key];
        if (pos.trader == address(0)) revert PositionNotFound();

        orderId = _link(pos, orderType);
        if (orderId != 0) {
            _orders[orderId].size = size;
            _moveOrder(orderId, triggerPrice);
        } else {
            uint256 execFee = executionFee;
            usdc.safeTransferFrom(msg.sender, address(this), execFee);
            orderId = _createTrigger(key, orderType, triggerPrice, size, execFee);
        }
    }

    /// @notice Cancels the caller's order and refunds everything escrowed for it.
    function cancelOrder(uint256 orderId) external nonReentrant {
        Order memory o = _orders[orderId];
        if (o.trader == address(0)) revert OrderNotFound();
        if (o.trader != msg.sender) revert NotOrderOwner();

        uint256 refund;
        if (_isOpenOrder(o.orderType)) {
            uint256 brackets = (o.takeProfit != 0 ? 1 : 0) + (o.stopLoss != 0 ? 1 : 0);
            refund = o.margin + o.feeBudget + (1 + brackets) * o.executionFee;
        } else {
            _setLink(_positions[positionKey(o.trader, o.priceId)], o.orderType, 0);
            refund = o.executionFee;
        }
        _removeOrder(orderId, o.trader);
        _pay(o.trader, refund);
    }

    /// @notice Executes order `orderId` if its condition is met. Anyone may call; the caller earns the order's
    ///         execution fee.
    /// @dev The price used must have been published at or after the order was created or last moved, so an
    ///      order can never be filled against a price that predates it.
    function executeOrder(uint256 orderId, bytes[] calldata priceUpdate) external payable nonReentrant {
        _updateOracle(priceUpdate);
        Order memory o = _orders[orderId];
        if (o.trader == address(0)) revert OrderNotFound();
        Market storage m = _markets[o.priceId];

        OraclePrice memory px = _readPrice(m);
        if (px.publishTime < o.createdAt) revert PriceBeforeOrder();

        uint256 price = _isOpenOrder(o.orderType) ? _fillOpen(orderId, o, m, px) : _fillTrigger(orderId, o, m, px);
        emit OrderExecuted(orderId, o.trader, msg.sender, price);
        if (o.executionFee != 0) usdc.safeTransfer(msg.sender, o.executionFee);
    }

    // ───────────────────────────── Liquidations and settlement ─────────────────────────────

    /// @notice Liquidates each position in `keys` that qualifies and skips the rest, after pushing `priceUpdate`
    ///         (may be empty to use the prices already on-chain).
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

    /// @notice Fixes the settlement price of a dated market once it has expired. Anyone may call.
    /// @dev The settlement price is the first usable mid price submitted at or after expiry.
    function settleMarket(bytes32 marketId, bytes[] calldata priceUpdate) external payable nonReentrant {
        _updateOracle(priceUpdate);
        Market storage m = _existingMarket(marketId);
        if (m.expiry == 0 || block.timestamp < m.expiry) revert MarketNotExpired();
        if (m.settlementPrice != 0) revert MarketAlreadySettled();
        OraclePrice memory px = _readPrice(m);
        if (px.publishTime < m.expiry) revert PriceBeforeExpiry();
        _accrueFunding(m);
        m.settlementPrice = px.mid;
        emit MarketSettled(marketId, px.mid);
    }

    /// @notice Closes positions in settled dated markets at the settlement price, liquidating those that are
    ///         past the threshold. Anyone may call; entries that do not qualify are skipped.
    function settlePositions(bytes32[] calldata keys) external nonReentrant returns (uint256 settled) {
        uint256 n = keys.length;
        for (uint256 i; i < n; ++i) {
            bytes32 key = keys[i];
            Position memory pos = _positions[key];
            if (pos.trader == address(0)) continue;
            Market storage m = _markets[pos.priceId];
            uint256 price = m.settlementPrice;
            if (price == 0) continue;
            if (!_tryLiquidate(key)) _close(key, pos, m, price, 0);
            ++settled;
        }
    }

    // ───────────────────────────── Views ─────────────────────────────

    function positionKey(address trader, bytes32 marketId) public pure returns (bytes32) {
        return keccak256(abi.encode(trader, marketId));
    }

    /// @inheritdoc IPerpEngine
    /// @dev Reserves against net exposure: a book that is long and short in equal size needs no backing, so
    ///      matched open interest cannot be used to lock LP withdrawals.
    function reservedLiquidity() external view returns (uint256) {
        uint256 skew;
        uint256 n = _marketIds.length;
        for (uint256 i; i < n; ++i) {
            Market storage m = _markets[_marketIds[i]];
            skew += _absDiff(m.longOi, m.shortOi);
        }
        return Math.mulDiv(skew, BPS, maxOiToNavBps, Math.Rounding.Ceil);
    }

    /// @inheritdoc IPerpEngine
    /// @dev Uses the last price Pyth holds for each market regardless of age, and skips markets without one.
    ///      It ignores funding, the profit cap and the fact that losses stop at margin, so it is an estimate;
    ///      the vault only ever uses it on the conservative side.
    function unrealizedTraderPnl() external view returns (int256 total) {
        uint256 n = _marketIds.length;
        for (uint256 i; i < n; ++i) {
            Market storage m = _markets[_marketIds[i]];
            if (m.longOi == 0 && m.shortOi == 0) continue;
            (PriceStatus status, OraclePrice memory px) = _peekPrice(m, type(uint256).max);
            if (status != PriceStatus.Ok) continue;
            uint256 longValue = Math.mulDiv(m.longUnits, px.mid, PositionMath.UNIT_PRECISION);
            uint256 shortValue = Math.mulDiv(m.shortUnits, px.mid, PositionMath.UNIT_PRECISION);
            total += longValue.toInt256() - m.longOi.toInt256() + m.shortOi.toInt256() - shortValue.toInt256();
        }
    }

    function getMarketIds() external view returns (bytes32[] memory) {
        return _marketIds;
    }

    function getMarket(bytes32 marketId) external view returns (Market memory) {
        return _markets[marketId];
    }

    function getPosition(address trader, bytes32 marketId) external view returns (Position memory) {
        return _positions[positionKey(trader, marketId)];
    }

    function getPositionByKey(bytes32 key) external view returns (Position memory) {
        return _positions[key];
    }

    function positionCount() external view returns (uint256) {
        return _positionKeys.length();
    }

    /// @notice Pages through the keys of all open positions. Ordering is not stable across state changes.
    function positionKeys(uint256 offset, uint256 limit) external view returns (bytes32[] memory out) {
        uint256 total = _positionKeys.length();
        if (offset >= total) return out;
        uint256 n = Math.min(limit, total - offset);
        out = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = _positionKeys.at(offset + i);
        }
    }

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    function orderCount() external view returns (uint256) {
        return _orderIds.length();
    }

    /// @notice Pages through the ids of all open orders. Ordering is not stable across state changes.
    function orderIds(uint256 offset, uint256 limit) external view returns (uint256[] memory out) {
        uint256 total = _orderIds.length();
        if (offset >= total) return out;
        uint256 n = Math.min(limit, total - offset);
        out = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = _orderIds.at(offset + i);
        }
    }

    /// @notice Open fee a trade of `size` and `margin` on the given side would pay right now.
    function quoteOpenFee(bytes32 marketId, uint256 size, bool isLong, uint256 margin) external view returns (uint256) {
        return _openFee(_existingMarket(marketId), size, isLong, margin);
    }

    /// @notice Current funding rate per second per unit of notional (1e18). Positive: longs pay shorts.
    function fundingRate(bytes32 marketId) external view returns (int256) {
        return _fundingRate(_existingMarket(marketId));
    }

    /// @notice Funding index including funding accrued since the last on-chain update.
    function currentFundingIndex(bytes32 marketId) external view returns (int256) {
        return _currentFundingIndex(_existingMarket(marketId));
    }

    /// @notice Validated on-chain price of a market; reverts if there is no usable price.
    function getPrice(bytes32 marketId) external view returns (OraclePrice memory) {
        return _readPrice(_existingMarket(marketId));
    }

    // ───────────────────────────── Internal: trading ─────────────────────────────

    /// @dev Opens a position of `size` at `price`, or adds that to the trader's position on the same side (the
    ///      other side reverts). An increase takes its entry price from units, so the market's unit counter (the
    ///      vault's mark-to-market) stays the exact sum over its positions; blends the entry funding index so the
    ///      funding owed is unchanged; and restarts `openedAt`, so no close can use a price from before it. Open
    ///      interest, units and the caps apply to the added size as for a new position.
    function _open(
        address trader,
        bytes32 marketId,
        Market storage m,
        bool isLong,
        uint256 margin,
        uint256 size,
        uint256 price,
        uint256 fee
    ) private returns (bytes32 key) {
        key = positionKey(trader, marketId);
        // All zero when there is none; linked order ids carry over on an increase.
        Position memory pos = _positions[key];
        _accrueFunding(m);
        bool increase = pos.trader != address(0);
        uint256 unitsBefore;
        if (increase) {
            if (pos.isLong != isLong) revert PositionExists();
            // Profit beyond the cap is forfeit when the position closes; margin added now must not revive it.
            if (PositionMath.pnl(pos, price, m.fundingIndex) > (pos.margin * maxProfitMultiple).toInt256()) {
                revert ProfitCapReached();
            }
            unitsBefore = PositionMath.units(pos.size, pos.entryPrice);
            // Rounded against the trader: up for a long, down for a short.
            pos.entryPrice = Math.mulDiv(
                pos.size + size,
                PositionMath.UNIT_PRECISION,
                unitsBefore + PositionMath.units(size, price),
                isLong ? Math.Rounding.Ceil : Math.Rounding.Floor
            );
            pos.entryFundingIndex =
                PositionMath.blendIndex(pos.entryFundingIndex, pos.size, m.fundingIndex, size, isLong);
        } else {
            pos.entryPrice = price;
            pos.entryFundingIndex = m.fundingIndex;
            pos.isLong = isLong;
            pos.priceId = marketId;
            pos.trader = trader;
        }
        pos.size += size;
        pos.margin += margin;
        pos.openedAt = uint64(block.timestamp);

        uint256 unitsAfter = PositionMath.units(pos.size, pos.entryPrice);
        uint256 sideOi;
        if (isLong) {
            sideOi = (m.longOi += size);
            m.longUnits = m.longUnits + unitsAfter - unitsBefore;
        } else {
            sideOi = (m.shortOi += size);
            m.shortUnits = m.shortUnits + unitsAfter - unitsBefore;
        }
        if (sideOi > m.maxOiPerSide) revert MarketOiCapExceeded();
        uint256 totalOi = (totalOpenInterest += size);
        if (totalOi * BPS > vault.totalAssets() * maxOiToNavBps) revert VaultOiCapExceeded();

        _positions[key] = pos;
        if (increase) {
            emit PositionIncreased(
                key, trader, marketId, isLong, margin, size, price, fee, pos.margin, pos.size, pos.entryPrice
            );
        } else {
            _positionKeys.add(key);
            emit PositionOpened(key, trader, marketId, isLong, margin, size, price, fee);
        }

        if (fee != 0) vault.receiveFees(fee);
    }

    /// @dev Settles `closeSize` of position `key` (a copy of which is `pos`) at `price`: the whole position when
    ///      `closeSize` is zero or at least its size, or when the rest would hold less than `minMargin`. A part
    ///      is settled like a position of its own: margin released in proportion (rounded down, so the rest
    ///      keeps any remainder), price PnL and funding on its size, and its own profit and fee caps. The rest
    ///      keeps its entry price, funding index, open time and linked orders. Funding must already be accrued
    ///      for `m`.
    function _close(bytes32 key, Position memory pos, Market storage m, uint256 price, uint256 closeSize) private {
        uint256 size = pos.size;
        uint256 marginOut = closeSize != 0 && closeSize < size ? Math.mulDiv(pos.margin, closeSize, size) : pos.margin;
        uint256 refund;
        // Partial unless nothing would be left (a full close) or too little to keep open.
        bool partial_ = pos.margin - marginOut >= minMargin;
        if (partial_) {
            Position storage rest = _positions[key];
            rest.size = size - closeSize;
            rest.margin = pos.margin - marginOut;
            _release(m, pos.isLong, pos.entryPrice, size, size - closeSize);
            // From here on `pos` describes the part being closed.
            pos.size = closeSize;
            pos.margin = marginOut;
        } else {
            refund = _removePosition(key, pos, m);
        }
        (int256 pnl, uint256 fee, uint256 payout) = _settle(pos, price, m.fundingIndex);
        if (partial_) {
            emit PositionDecreased(key, pos.trader, pos.priceId, price, pos.size, pos.margin, pnl, fee, payout);
        } else {
            emit PositionClosed(key, pos.trader, pos.priceId, price, pnl, fee, payout);
        }
        _pay(pos.trader, payout + refund);
    }

    /// @dev Realises `pos` (a whole position or the part of one being closed) at `price` with the vault: profit up
    ///      to the cap is paid by the vault, a loss of up to the margin goes to it (with the DRY rebate), and the
    ///      close fee comes out of what is left. Returns the PnL after the cap, the fee and what the trader gets.
    function _settle(Position memory pos, uint256 price, int256 fundingIndex)
        private
        returns (int256 pnl, uint256 fee, uint256 payout)
    {
        uint256 margin = pos.margin;
        pnl = PositionMath.pnl(pos, price, fundingIndex);
        int256 cap = (margin * maxProfitMultiple).toInt256();
        if (pnl > cap) pnl = cap;
        fee = Math.min(Math.mulDiv(pos.size, baseFeeBps, BPS, Math.Rounding.Ceil), _feeCap(margin));
        if (pnl >= 0) {
            fee = Math.min(fee, margin);
            payout = margin - fee;
            if (fee != 0) vault.receiveFees(fee);
            if (pnl != 0) payout += vault.payoutTraderProfit(pos.trader, pnl.toUint256());
        } else {
            uint256 loss = Math.min((-pnl).toUint256(), margin);
            uint256 remaining = margin - loss;
            fee = Math.min(fee, remaining);
            payout = remaining - fee;
            vault.receiveTraderLoss(pos.trader, loss);
            rewardToken.mintLossRebate(pos.trader, loss);
            if (fee != 0) vault.receiveFees(fee);
        }
    }

    /// @dev Checks shared by every close a trader or an order makes, and its execution price: the price must be
    ///      newer than the position's last open or increase, and past the liquidation threshold the position
    ///      belongs to liquidators. Accrues funding for `m`.
    function _exitPrice(Position memory pos, Market storage m, OraclePrice memory px) private returns (uint256) {
        if (px.publishTime <= pos.openedAt) revert PriceNotAfterOpen();
        _accrueFunding(m);
        if (PositionMath.isLiquidatable(pos, px.mid, m.fundingIndex)) revert PositionLiquidatable();
        return pos.isLong ? px.bid : px.ask;
    }

    function _fillOpen(uint256 orderId, Order memory o, Market storage m, OraclePrice memory px)
        private
        whenNotPaused
        returns (uint256 price)
    {
        // Limits may have changed since the order was placed; it must still be a valid trade now.
        _validateTrade(m, o.margin, o.size);
        price = o.isLong ? px.ask : px.bid;
        // A limit fills at its trigger or better; a stop-entry once the market is at or through its trigger.
        if (price != o.triggerPrice && (price > o.triggerPrice) == (o.isLong == (o.orderType == OrderType.LimitOpen)))
        {
            revert TriggerNotMet();
        }
        // On a gap through a bracket the fill would be closed out at once; leave the order resting instead.
        _validateBrackets(o.isLong, price, o.takeProfit, o.stopLoss);

        _removeOrder(orderId, address(0));
        uint256 fee = Math.min(_openFee(m, o.size, o.isLong, o.margin), o.feeBudget);
        bytes32 key = _open(o.trader, o.priceId, m, o.isLong, o.margin, o.size, price, fee);
        _pay(o.trader, o.feeBudget - fee + _attachBrackets(key, o.takeProfit, o.stopLoss, o.executionFee));
    }

    function _fillTrigger(uint256 orderId, Order memory o, Market storage m, OraclePrice memory px)
        private
        returns (uint256 price)
    {
        bytes32 key = positionKey(o.trader, o.priceId);
        Position storage linked = _positions[key];
        // Unlinked before the position is read: its fee goes to the keeper, not back to the trader, and a partial
        // close leaves the rest of the position without it.
        _setLink(linked, o.orderType, 0);
        _removeOrder(orderId, address(0));
        Position memory pos = linked;
        price = _exitPrice(pos, m, px);
        bool met;
        if (o.orderType == OrderType.Close) {
            met = o.triggerPrice == 0 || (pos.isLong ? price >= o.triggerPrice : price <= o.triggerPrice);
        } else {
            // Take-profit wants the price at or beyond the trigger in the position's favour, stop-loss against.
            bool wantsHigher = pos.isLong == (o.orderType == OrderType.TakeProfit);
            met = wantsHigher ? px.mid >= o.triggerPrice : px.mid <= o.triggerPrice;
        }
        if (!met) revert TriggerNotMet();
        _close(key, pos, m, price, o.size);
    }

    /// @dev Liquidates `key` if it exists, has a usable price and is past the threshold. Never reverts on a
    ///      position that merely does not qualify, so one bad entry cannot block a batch.
    function _tryLiquidate(bytes32 key) private returns (bool) {
        Position memory pos = _positions[key];
        if (pos.trader == address(0)) return false;
        Market storage m = _markets[pos.priceId];
        (PriceStatus status, OraclePrice memory px) = _peekPrice(m, maxPriceAge);
        if (status != PriceStatus.Ok) return false;
        _accrueFunding(m);
        if (!PositionMath.isLiquidatable(pos, px.mid, m.fundingIndex)) return false;

        // Escrow of the position's orders is not returned to the trader on liquidation; it goes to the vault.
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

    /// @dev Deletes the position, releases its open interest and cancels its linked orders.
    /// @return escrow Execution fees that were escrowed for the cancelled orders.
    function _removePosition(bytes32 key, Position memory pos, Market storage m) private returns (uint256 escrow) {
        _release(m, pos.isLong, pos.entryPrice, pos.size, 0);
        escrow = _cancelLinked(pos.tpOrderId, pos.trader) + _cancelLinked(pos.slOrderId, pos.trader)
            + _cancelLinked(pos.closeOrderId, pos.trader);
        delete _positions[key];
        _positionKeys.remove(key);
    }

    /// @dev Takes `size - sizeLeft` of a position at `entry` out of the open-interest and unit counters. The
    ///      units removed are the position's units before less its units after, so the counter stays the exact
    ///      sum over open positions; the subtraction saturates all the same, so rounding can never make a close
    ///      or a liquidation revert.
    function _release(Market storage m, bool isLong, uint256 entry, uint256 size, uint256 sizeLeft) private {
        uint256 out = size - sizeLeft;
        uint256 unitsOut = PositionMath.units(size, entry) - PositionMath.units(sizeLeft, entry);
        if (isLong) {
            m.longOi -= out;
            m.longUnits = _subFloor(m.longUnits, unitsOut);
        } else {
            m.shortOi -= out;
            m.shortUnits = _subFloor(m.shortUnits, unitsOut);
        }
        totalOpenInterest -= out;
    }

    function _cancelLinked(uint64 orderId, address trader) private returns (uint256 escrow) {
        if (orderId == 0) return 0;
        escrow = _orders[orderId].executionFee;
        _removeOrder(orderId, trader);
    }

    /// @dev Attaches an open's brackets to position `key`. Where the position already has an order of a bracket's
    ///      type (an increase), that order is moved instead and the bracket's execution fee is returned for the
    ///      caller to refund: one order per type, and no escrow left without an order.
    function _attachBrackets(bytes32 key, uint256 takeProfit, uint256 stopLoss, uint256 execFee)
        private
        returns (uint256 refund)
    {
        if (takeProfit != 0) refund = _bracket(key, OrderType.TakeProfit, takeProfit, execFee);
        if (stopLoss != 0) refund += _bracket(key, OrderType.StopLoss, stopLoss, execFee);
    }

    function _bracket(bytes32 key, OrderType orderType, uint256 triggerPrice, uint256 execFee)
        private
        returns (uint256 refund)
    {
        uint64 orderId = _link(_positions[key], orderType);
        if (orderId == 0) {
            _createTrigger(key, orderType, triggerPrice, 0, execFee);
        } else {
            _moveOrder(orderId, triggerPrice);
            refund = execFee;
        }
    }

    /// @dev Creates an order linked to position `key` that closes `size` of it. The execution fee must already be
    ///      held.
    function _createTrigger(bytes32 key, OrderType orderType, uint256 triggerPrice, uint256 size, uint256 execFee)
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
            size: size,
            triggerPrice: triggerPrice,
            takeProfit: 0,
            stopLoss: 0,
            feeBudget: 0,
            executionFee: execFee
        });
        _orderIds.add(orderId);
        _setLink(pos, orderType, orderId);
        emit OrderCreated(orderId, pos.trader, pos.priceId, orderType, pos.isLong, triggerPrice, 0, size);
    }

    /// @dev Moving re-arms {PriceBeforeOrder}: the order cannot execute against a price older than the move.
    function _moveOrder(uint256 orderId, uint256 triggerPrice) private {
        Order storage o = _orders[orderId];
        o.triggerPrice = triggerPrice;
        o.createdAt = uint64(block.timestamp);
        emit OrderUpdated(orderId, triggerPrice);
    }

    function _link(Position storage pos, OrderType orderType) private view returns (uint64) {
        if (orderType == OrderType.TakeProfit) return pos.tpOrderId;
        if (orderType == OrderType.StopLoss) return pos.slOrderId;
        return pos.closeOrderId;
    }

    function _setLink(Position storage pos, OrderType orderType, uint64 orderId) private {
        if (orderType == OrderType.TakeProfit) pos.tpOrderId = orderId;
        else if (orderType == OrderType.StopLoss) pos.slOrderId = orderId;
        else pos.closeOrderId = orderId;
    }

    /// @dev `cancelledFor` is the trader when the order is being cancelled, or zero when it is being filled.
    function _removeOrder(uint256 orderId, address cancelledFor) private {
        delete _orders[orderId];
        _orderIds.remove(orderId);
        if (cancelledFor != address(0)) emit OrderCancelled(orderId, cancelledFor);
    }

    /// @dev Pays `amount` USDC to `to`. If USDC refuses (Arc's USDC reverts for blocklisted accounts) the
    ///      amount is parked for that same account instead, so no position or order can be made immovable.
    function _pay(address to, uint256 amount) private {
        if (amount == 0) return;
        (bool ok, bytes memory ret) = address(usdc).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (ok && (ret.length == 0 || abi.decode(ret, (bool)))) return;
        claimable[to] += amount;
        totalClaimable += amount;
        emit PaymentDeferred(to, amount);
    }

    // ───────────────────────────── Internal: validation and math ─────────────────────────────

    function _existingMarket(bytes32 marketId) private view returns (Market storage m) {
        m = _markets[marketId];
        if (m.lastFundingTime == 0) revert MarketNotFound();
    }

    function _checkMarketParams(uint16 maxLeverage, uint256 skewScale) private pure {
        if (maxLeverage == 0 || maxLeverage > MAX_LEVERAGE || skewScale == 0) revert InvalidParam();
    }

    /// @dev LimitOpen and StopOpen escrow margin and open (or add to) a position; the rest close one.
    function _isOpenOrder(OrderType orderType) private pure returns (bool) {
        return orderType == OrderType.LimitOpen || orderType == OrderType.StopOpen;
    }

    function _validateTrade(Market storage m, uint256 margin, uint256 size) private view {
        if (!m.enabled) revert MarketDisabled();
        if (m.expiry != 0 && block.timestamp >= m.expiry) revert MarketExpired();
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
    function _openFee(Market storage m, uint256 size, bool isLong, uint256 margin) private view returns (uint256 fee) {
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
        fee = Math.min(fee, _feeCap(margin));
    }

    function _feeCap(uint256 margin) private pure returns (uint256) {
        return (margin * MARGIN_FEE_CAP_BPS) / BPS;
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

    /// @dev Funding stops accruing at a dated market's expiry.
    function _fundingTime(Market storage m) private view returns (uint256 t) {
        t = block.timestamp;
        if (m.expiry != 0 && t > m.expiry) t = m.expiry;
    }

    function _currentFundingIndex(Market storage m) private view returns (int256) {
        return m.fundingIndex + _fundingRate(m) * (_fundingTime(m) - m.lastFundingTime).toInt256();
    }

    function _accrueFunding(Market storage m) private {
        uint256 t = _fundingTime(m);
        if (t == m.lastFundingTime) return;
        m.fundingIndex = _currentFundingIndex(m);
        m.lastFundingTime = uint64(t);
    }

    function _absDiff(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a - b : b - a;
    }

    function _subFloor(uint256 a, uint256 b) private pure returns (uint256) {
        return a > b ? a - b : 0;
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

    function _readPrice(Market storage m) private view returns (OraclePrice memory px) {
        PriceStatus status;
        (status, px) = _peekPrice(m, maxPriceAge);
        if (status == PriceStatus.Ok) return px;
        if (status == PriceStatus.Unavailable) revert OraclePriceUnavailable();
        if (status == PriceStatus.Stale) revert OraclePriceStale();
        if (status == PriceStatus.ConfidenceTooWide) revert OracleConfidenceTooWide();
        revert OraclePriceInvalid();
    }

    /// @dev A settled dated market trades at its settlement price for ever; everything else asks the oracle.
    function _peekPrice(Market storage m, uint256 maxAge) private view returns (PriceStatus, OraclePrice memory px) {
        uint256 settled = m.settlementPrice;
        if (settled != 0) {
            px.mid = px.bid = px.ask = settled;
            px.publishTime = block.timestamp;
            return (PriceStatus.Ok, px);
        }
        return oracle.peek(m.feedId, m.quoteFeedId, m.invert, maxAge, maxConfBps);
    }
}
