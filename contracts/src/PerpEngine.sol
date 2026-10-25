// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {IHouseVault} from "./interfaces/IHouseVault.sol";
import {IRewardToken} from "./interfaces/IRewardToken.sol";
import {PerpEngineBase} from "./PerpEngineBase.sol";
import {PerpEngineExt} from "./PerpEngineExt.sol";
import {PythOracle} from "./PythOracle.sol";
import {
    FeeMode,
    LimitParams,
    Market,
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
///         This contract is the engine's address and holds its storage and funds. It implements the trading path:
///         opening and closing positions, orders and their execution, and liquidation. Every other function (admin,
///         adding and removing margin, claims, referrals, order expiry, settlement of dated markets and the
///         heavier views) is forwarded to {PerpEngineExt} with `delegatecall`, so it runs here, on this storage.
///         Callers see one contract: use {IEngine}. Conventions are documented on {PerpEngineBase}.
contract PerpEngine is PerpEngineBase {
    using SafeERC20 for IERC20;

    /// @notice Code that every call not defined here runs (by `delegatecall`, on this contract's storage).
    address public immutable extension;

    /// @param extension_ A {PerpEngineExt} built with the same token, oracle, vault and reward token: it runs on this
    ///                   contract's storage but reads its own immutables, so they must match.
    constructor(
        IERC20 usdc_,
        PythOracle oracle_,
        IHouseVault vault_,
        IRewardToken rewardToken_,
        address owner_,
        PerpEngineExt extension_
    ) PerpEngineBase(usdc_, oracle_, vault_, rewardToken_, owner_) {
        if (address(extension_) == address(0)) revert ZeroAddress();
        if (
            extension_.usdc() != usdc_ || extension_.oracle() != oracle_ || extension_.vault() != vault_
                || extension_.rewardToken() != rewardToken_
        ) revert InvalidParam();
        extension = address(extension_);
        // The vault pulls losses and fees from the engine.
        usdc_.forceApprove(address(vault_), type(uint256).max);
    }

    /// @notice Runs any function not defined here in {PerpEngineExt}, on this contract's storage, and returns or
    ///         reverts with whatever it returns or reverts with. A plain value transfer has no matching function
    ///         there and reverts.
    fallback() external payable {
        address target = extension;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            calldatacopy(ptr, 0, calldatasize())
            let ok := delegatecall(gas(), target, ptr, calldatasize(), 0, 0)
            returndatacopy(ptr, 0, returndatasize())
            if iszero(ok) { revert(ptr, returndatasize()) }
            return(ptr, returndatasize())
        }
    }

    /// @notice Plain value transfers are refused (Pyth fees come with the call that needs them).
    receive() external payable {
        revert InvalidParam();
    }

    // ───────────────────────────── Trading ─────────────────────────────

    /// @notice Opens a position at the current Pyth price, or adds to the caller's position on the same side,
    ///         optionally with take-profit / stop-loss brackets.
    /// @dev The caller pays `margin + open fee + executionFee per bracket` in USDC (approve first), plus the Pyth
    ///      update fee in native value. When the position already has an order of a bracket's type, that order is
    ///      moved to the new trigger and the bracket's execution fee is refunded. Callers that cannot land a
    ///      transaction within `maxPriceAge` of fetching a price (people using wallets) should place a marketable
    ///      limit order with {createLimitOrder} instead. Upside markets only take orders ({OrdersOnly}).
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
        if (m.feeMode == FeeMode.Upside) revert OrdersOnly();
        _validateTrade(m, p.margin, p.size);
        if (p.size > p.margin * DIRECT_MAX_LEVERAGE) revert HighLeverageNeedsOrder();

        OraclePrice memory px = _readPrice(m);
        uint256 price = p.isLong ? px.ask : px.bid;
        if (p.acceptablePrice != 0 && (p.isLong ? price > p.acceptablePrice : price < p.acceptablePrice)) {
            revert SlippageExceeded();
        }
        _validateBrackets(p.isLong, price, p.takeProfit, p.stopLoss);

        uint256 execFee = executionFee;
        uint256 fee = _discounted(msg.sender, _openFee(m, p.size, p.isLong, p.margin));
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
        if (m.settlementPrice == 0) {
            if (m.feeMode == FeeMode.Upside) revert OrdersOnly();
            if (pos.size > pos.margin * DIRECT_MAX_LEVERAGE) revert HighLeverageNeedsOrder();
        }

        uint256 price = _exitPrice(pos, m, _readPrice(m));
        if (acceptablePrice != 0 && (pos.isLong ? price < acceptablePrice : price > acceptablePrice)) {
            revert SlippageExceeded();
        }
        _close(key, pos, m, price, size);
    }

    // ───────────────────────────── Orders ─────────────────────────────

    /// @notice Places an order to open a position (or add to the caller's position on the same side) once the
    ///         market reaches `triggerPrice`. A limit order fills at the trigger or better; with a trigger at or
    ///         beyond the current price it is a market order executed by a keeper against the next price. With
    ///         `stopEntry` it is a stop-entry (breakout) order, which fills once the market trades through the
    ///         trigger: a long once the ask is at or above it, a short once the bid is at or below it (in Upside
    ///         markets, once the mid is).
    /// @dev Escrows margin, the maximum possible open fee (none in Upside markets) and one execution fee for the
    ///      order plus one per bracket. Unused fee budget is refunded on fill; everything is refunded on cancel.
    function createLimitOrder(LimitParams calldata p) external nonReentrant whenNotPaused returns (uint256 orderId) {
        orderId = _createLimitOrder(p, 0);
    }

    /// @notice {createLimitOrder} that cannot execute after `expiresAt` (good-til-time). Once expired anyone may
    ///         remove it with `cancelExpired`, earning its execution fee; the rest of the escrow is refunded.
    function createLimitOrderUntil(LimitParams calldata p, uint64 expiresAt)
        external
        nonReentrant
        whenNotPaused
        returns (uint256 orderId)
    {
        if (expiresAt <= block.timestamp) revert InvalidParam();
        orderId = _createLimitOrder(p, expiresAt);
    }

    /// @notice Sets (or moves) an order attached to the caller's open position in `marketId` that closes `size`
    ///         of it when it executes (0: all of it; it never closes more than is open).
    /// @dev A position has at most one order of each type; creating one escrows `executionFee`, moving it (a new
    ///      trigger and size) is free and keeps its expiry.
    ///      - TakeProfit fires when the mid price is at or beyond `triggerPrice` in the position's favour.
    ///      - StopLoss fires when it is at or beyond `triggerPrice` against it.
    ///      - Close is a market close executed by a keeper against the next price; `triggerPrice` is the worst
    ///        acceptable execution price (0 for none).
    ///      With a fresh price on-chain, a take-profit must sit on the profit side of the mid and a stop-loss on the
    ///      loss side ({InvalidTrigger}): one already through the price would fire at once, like a bracket placed
    ///      the wrong way round at open.
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
        if (orderType != OrderType.Close) {
            (PriceStatus status, OraclePrice memory px) = _peekPrice(_markets[marketId], maxPriceAge);
            if (status == PriceStatus.Ok) {
                bool tp = orderType == OrderType.TakeProfit;
                _validateBrackets(pos.isLong, px.mid, tp ? triggerPrice : 0, tp ? 0 : triggerPrice);
            }
        }

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

        uint256 refund = o.executionFee;
        if (_isOpenOrder(o.orderType)) {
            refund += _openOrderRefund(o);
        } else {
            _setLink(_positions[positionKey(o.trader, o.priceId)], o.orderType, 0);
        }
        _removeOrder(orderId, o.trader);
        _pay(o.trader, refund);
    }

    /// @notice Executes order `orderId` if its condition is met. Anyone may call; the caller earns the order's
    ///         execution fee.
    /// @dev The price used must have been published at or after the order was created or last moved, so an
    ///      order can never be filled against a price that predates it. An order past its expiry cannot execute.
    function executeOrder(uint256 orderId, bytes[] calldata priceUpdate) external payable nonReentrant {
        _updateOracle(priceUpdate);
        Order memory o = _orders[orderId];
        if (o.trader == address(0)) revert OrderNotFound();
        if (o.expiresAt != 0 && block.timestamp > o.expiresAt) revert OrderHasExpired();
        Market storage m = _markets[o.priceId];

        OraclePrice memory px = _readPrice(m);
        if (px.publishTime < o.createdAt) revert PriceBeforeOrder();

        uint256 price = _isOpenOrder(o.orderType) ? _fillOpen(orderId, o, m, px) : _fillTrigger(orderId, o, m, px);
        emit OrderExecuted(orderId, o.trader, msg.sender, price);
        if (o.executionFee != 0) usdc.safeTransfer(msg.sender, o.executionFee);
    }

    // ───────────────────────────── Liquidations ─────────────────────────────

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

    // ───────────────────────────── Views ─────────────────────────────

    function getMarket(bytes32 marketId) external view returns (Market memory) {
        return _markets[marketId];
    }

    function getPosition(address trader, bytes32 marketId) external view returns (Position memory) {
        return _positions[positionKey(trader, marketId)];
    }

    function getPositionByKey(bytes32 key) external view returns (Position memory) {
        return _positions[key];
    }

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    /// @notice Who placed order `orderId`; zero once it has been filled, cancelled or expired away. One storage
    ///         read, for add-ons that only need to know whether an order of theirs is still open.
    function orderTrader(uint256 orderId) external view returns (address) {
        return _orders[orderId].trader;
    }

    /// @notice Validated on-chain price of a market; reverts if there is no usable price.
    function getPrice(bytes32 marketId) external view returns (OraclePrice memory) {
        return _readPrice(_existingMarket(marketId));
    }
}
