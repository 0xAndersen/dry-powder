// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

import {IHouseVault} from "./interfaces/IHouseVault.sol";
import {IPerpEngine} from "./interfaces/IPerpEngine.sol";
import {IRewardToken} from "./interfaces/IRewardToken.sol";
import {PositionMath} from "./libraries/PositionMath.sol";
import {PerpEngineBase} from "./PerpEngineBase.sol";
import {PythOracle} from "./PythOracle.sol";
import {FeeMode, Market, MarketConfig, OraclePrice, Order, Position, PriceStatus} from "./Types.sol";

/// @title PerpEngineExt
/// @notice The part of the engine that is not on the trading path: listing and configuring markets, fee and risk
///         parameters, pausing, adding and removing margin, claims, referrals, order expiry, settlement of dated
///         markets, and the views that loop over markets or orders. {PerpEngine} forwards every call it does not
///         define here with `delegatecall`, so this code always runs on PerpEngine's storage, with PerpEngine's
///         address, balance and owner. Called at its own address it refuses ({NotDelegated}).
contract PerpEngineExt is PerpEngineBase, IPerpEngine {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using EnumerableSet for EnumerableSet.UintSet;

    address private immutable _self;

    /// @notice Called directly rather than through {PerpEngine}.
    error NotDelegated();

    modifier delegated() {
        if (address(this) == _self) revert NotDelegated();
        _;
    }

    /// @dev The arguments must be the ones the PerpEngine using this extension is built with (it checks). The
    ///      owner set here is this contract's own and is never used: through PerpEngine, PerpEngine's owner rules.
    constructor(IERC20 usdc_, PythOracle oracle_, IHouseVault vault_, IRewardToken rewardToken_)
        PerpEngineBase(usdc_, oracle_, vault_, rewardToken_, msg.sender)
    {
        _self = address(this);
    }

    // ───────────────────────────── Admin ─────────────────────────────

    /// @notice Lists a new instrument under `marketId`, in the Standard fee mode.
    /// @dev By convention a plain perpetual uses its Pyth feed id as market id; crosses, dated futures and markets
    ///      that share a feed with another use any other unique id (the deploy script hashes the symbol).
    function addMarket(bytes32 marketId, MarketConfig calldata cfg) external delegated onlyOwner {
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
        delegated
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

    /// @notice Switches how a market charges ({FeeMode}). Only while it has no open interest, so no position is
    ///         opened under one model and closed under the other.
    /// @dev Open orders already resting keep the fee budget they escrowed: one placed in Upside mode escrowed none
    ///      and, if the market is switched to Standard before it fills, opens without a fee.
    function setMarketFeeMode(bytes32 marketId, FeeMode mode) external delegated onlyOwner {
        Market storage m = _existingMarket(marketId);
        if (m.longOi != 0 || m.shortOi != 0) revert InvalidParam();
        m.feeMode = mode;
        emit MarketFeeModeSet(marketId, mode);
    }

    function setFeeParams(
        uint256 baseFeeBps_,
        uint256 maxSkewFeeBps_,
        uint256 maxFundingRatePerSecond_,
        uint256 executionFee_
    ) external delegated onlyOwner {
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
        delegated
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

    /// @notice Sets the profit cap, as a multiple of margin (1 to 100). Exposure is re-measured at the new cap.
    function setMaxProfitMultiple(uint256 maxProfitMultiple_) external delegated onlyOwner {
        if (maxProfitMultiple_ == 0 || maxProfitMultiple_ > 100) revert InvalidParam();
        maxProfitMultiple = maxProfitMultiple_;
        uint256 exposure;
        uint256 n = _marketIds.length;
        for (uint256 i; i < n; ++i) {
            exposure += _exposure(_markets[_marketIds[i]]);
        }
        totalExposure = exposure;
        emit MaxProfitMultipleSet(maxProfitMultiple_);
    }

    /// @notice Sets the share of profit Upside markets keep from a winning close (at most 50%). With the referral
    ///         parameters it must leave the house at least 15% of a self-referred trader's profit.
    function setProfitShare(uint256 profitShareBps_) external delegated onlyOwner {
        _checkShares(profitShareBps_, referralShareBps, referralDiscountBps);
        profitShareBps = profitShareBps_;
        emit ProfitShareSet(profitShareBps_);
    }

    /// @notice Sets the referrer's share of a referred trader's fees and the referred trader's discount (each at
    ///         most 50%), within the same 15% floor as {setProfitShare}.
    function setReferralParams(uint256 referralShareBps_, uint256 referralDiscountBps_) external delegated onlyOwner {
        _checkShares(profitShareBps, referralShareBps_, referralDiscountBps_);
        referralShareBps = referralShareBps_;
        referralDiscountBps = referralDiscountBps_;
        emit ReferralParamsSet(referralShareBps_, referralDiscountBps_);
    }

    /// @notice Blocks new positions, increases, margin removal and new/filled open orders. Closes, triggers, margin
    ///         top-ups and liquidations keep working.
    function pause() external delegated onlyOwner {
        _pause();
    }

    function unpause() external delegated onlyOwner {
        _unpause();
    }

    // ───────────────────────────── Positions ─────────────────────────────

    /// @notice Adds `amount` USDC (approve first) to the margin of the caller's position in `marketId`, lowering
    ///         its leverage and moving its liquidation price away. Works while paused.
    /// @dev Refused with {PositionInProfit} while the position's PnL after funding is above zero at the last price
    ///      on-chain, however old (with no usable price at all it is allowed): margin added to a winner would lift
    ///      its profit cap. Leverage can be brought down to 1x, not below ({LeverageOutOfRange}). Restarts
    ///      `openedAt` like an increase: margin can bring a keeper-only position under `DIRECT_MAX_LEVERAGE`, and
    ///      the direct close that then becomes possible must not use a price from before the top-up.
    function addMargin(bytes32 marketId, uint256 amount) external nonReentrant delegated {
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
        // A top-up raises the position's profit cap, so it can raise exposure; it is not refused for that, since
        // it is how a trader keeps a position from liquidation, but the next open is measured against it.
        uint256 exposureBefore = _exposure(m);
        if (pos.isLong) m.longMargin += amount;
        else m.shortMargin += amount;
        _changeExposure(exposureBefore, _exposure(m));
        emit MarginAdded(key, msg.sender, amount, margin);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Takes `amount` USDC of margin out of the caller's position in `marketId`, raising its leverage.
    /// @dev What stays must hold at least `minMargin`, keep the position within the market's leverage limit and at
    ///      most `DIRECT_MAX_LEVERAGE` (the check reads a stored price, which a keeper-only leverage must never
    ///      rely on), and cover any loss at the exit price (bid for a long, ask for a short) plus the initial
    ///      margin at that leverage ({InsufficientMargin}). Unrealised profit never counts, so margin can come out
    ///      but profit cannot. The price must be newer than the position's last open, increase or top-up.
    function removeMargin(bytes32 marketId, uint256 amount, bytes[] calldata priceUpdate)
        external
        payable
        nonReentrant
        whenNotPaused
        delegated
    {
        _updateOracle(priceUpdate);
        bytes32 key = positionKey(msg.sender, marketId);
        Position storage stored = _positions[key];
        if (stored.trader == address(0)) revert PositionNotFound();
        Position memory pos = stored;
        if (amount == 0 || amount >= pos.margin) revert InvalidParam();
        Market storage m = _markets[marketId];
        OraclePrice memory px = _readPrice(m);
        if (px.publishTime <= pos.openedAt) revert PriceNotAfterOpen();
        _accrueFunding(m);

        uint256 margin = pos.margin - amount;
        uint256 maxLeverage = Math.min(m.maxLeverage, DIRECT_MAX_LEVERAGE);
        if (margin < minMargin) revert MarginTooLow();
        if (pos.size > margin * maxLeverage) revert LeverageOutOfRange();
        int256 pnl = PositionMath.pnl(pos, pos.isLong ? px.bid : px.ask, m.fundingIndex);
        uint256 loss = pnl < 0 ? (-pnl).toUint256() : 0;
        if (margin < loss + Math.ceilDiv(pos.size, maxLeverage)) revert InsufficientMargin();

        stored.margin = margin;
        uint256 exposureBefore = _exposure(m);
        if (pos.isLong) m.longMargin = _subFloor(m.longMargin, amount);
        else m.shortMargin = _subFloor(m.shortMargin, amount);
        _changeExposure(exposureBefore, _exposure(m));
        emit MarginRemoved(key, msg.sender, amount, margin);
        _pay(msg.sender, amount);
    }

    /// @notice Collects USDC that could not be delivered to the caller earlier, and referral rewards.
    function claim() external nonReentrant delegated {
        uint256 amount = claimable[msg.sender];
        if (amount == 0) revert NothingToClaim();
        claimable[msg.sender] = 0;
        totalClaimable -= amount;
        emit Claimed(msg.sender, amount);
        usdc.safeTransfer(msg.sender, amount);
    }

    /// @notice Records who referred the caller: a front-end, wallet, agent builder or friend. From then on the
    ///         caller's fees are `referralDiscountBps` lower and `referralShareBps` of each fee goes to `referrer`,
    ///         who collects it with {claim}. Can be set once.
    function setReferrer(address referrer) external delegated {
        if (referrer == address(0) || referrer == msg.sender) revert InvalidParam();
        if (referrerOf[msg.sender] != address(0)) revert ReferrerAlreadySet();
        referrerOf[msg.sender] = referrer;
        emit ReferrerSet(msg.sender, referrer);
    }

    // ───────────────────────────── Order expiry ─────────────────────────────

    /// @notice Sets when the caller's order `orderId` stops being executable (0: never). Any order type.
    function setOrderExpiry(uint256 orderId, uint64 expiresAt) external delegated {
        Order storage o = _orders[orderId];
        address trader = o.trader;
        if (trader == address(0)) revert OrderNotFound();
        if (trader != msg.sender) revert NotOrderOwner();
        if (expiresAt != 0 && expiresAt <= block.timestamp) revert InvalidParam();
        o.expiresAt = expiresAt;
        emit OrderExpirySet(orderId, expiresAt);
    }

    /// @notice Removes every order in `ids` that is past its expiry and skips the rest. Anyone may call: the caller
    ///         earns each removed order's execution fee and the rest of its escrow goes back to its trader.
    /// @dev Reverts with {NothingToCancel} if none qualifies, so a keeper's simulation fails cheaply.
    function cancelExpired(uint256[] calldata ids) external nonReentrant delegated returns (uint256 cancelled) {
        uint256 reward;
        uint256 n = ids.length;
        for (uint256 i; i < n; ++i) {
            uint256 orderId = ids[i];
            Order memory o = _orders[orderId];
            if (o.trader == address(0) || o.expiresAt == 0 || block.timestamp <= o.expiresAt) continue;
            uint256 refund;
            if (_isOpenOrder(o.orderType)) refund = _openOrderRefund(o);
            else _setLink(_positions[positionKey(o.trader, o.priceId)], o.orderType, 0);
            _removeOrder(orderId, o.trader);
            emit OrderExpired(orderId, o.trader, msg.sender);
            reward += o.executionFee;
            _pay(o.trader, refund);
            ++cancelled;
        }
        if (cancelled == 0) revert NothingToCancel();
        if (reward != 0) usdc.safeTransfer(msg.sender, reward);
    }

    // ───────────────────────────── Settlement of dated markets ─────────────────────────────

    /// @notice Fixes the settlement price of a dated market once it has expired. Anyone may call.
    /// @dev The settlement price is the first usable mid price submitted at or after expiry.
    function settleMarket(bytes32 marketId, bytes[] calldata priceUpdate) external payable nonReentrant delegated {
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
    function settlePositions(bytes32[] calldata keys) external nonReentrant delegated returns (uint256 settled) {
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

    /// @inheritdoc IPerpEngine
    /// @dev Reserves against net exposure (see `totalExposure`): a book whose sides can cost the vault the same at
    ///      most needs no backing, so matched open interest cannot be used to lock LP withdrawals.
    function reservedLiquidity() external view delegated returns (uint256) {
        uint256 skew;
        uint256 n = _marketIds.length;
        for (uint256 i; i < n; ++i) {
            Market storage m = _markets[_marketIds[i]];
            skew += _absDiff(_sideExposure(m.longOi, m.longMargin), _sideExposure(m.shortOi, m.shortMargin));
        }
        return Math.mulDiv(skew, BPS, maxOiToNavBps, Math.Rounding.Ceil);
    }

    /// @inheritdoc IPerpEngine
    /// @dev Uses the last price Pyth holds for each market regardless of age, and skips markets without one. Each
    ///      side's result is held between losing all of the side's margin and winning its capped profit; within a
    ///      side positions are netted and funding is ignored, so it is an estimate, and the vault only ever uses
    ///      it on the conservative side.
    function unrealizedTraderPnl() external view delegated returns (int256 total) {
        uint256 multiple = maxProfitMultiple;
        uint256 n = _marketIds.length;
        for (uint256 i; i < n; ++i) {
            Market storage m = _markets[_marketIds[i]];
            if (m.longOi == 0 && m.shortOi == 0) continue;
            (PriceStatus status, OraclePrice memory px) = _peekPrice(m, type(uint256).max);
            if (status != PriceStatus.Ok) continue;
            uint256 longValue = Math.mulDiv(m.longUnits, px.mid, PositionMath.UNIT_PRECISION);
            uint256 shortValue = Math.mulDiv(m.shortUnits, px.mid, PositionMath.UNIT_PRECISION);
            total += _bound(longValue.toInt256() - m.longOi.toInt256(), m.longMargin, multiple)
            + _bound(m.shortOi.toInt256() - shortValue.toInt256(), m.shortMargin, multiple);
        }
    }

    function getMarketIds() external view delegated returns (bytes32[] memory) {
        return _marketIds;
    }

    function positionCount() external view delegated returns (uint256) {
        return _positionKeys.length();
    }

    /// @notice Pages through the keys of all open positions. Ordering is not stable across state changes.
    function positionKeys(uint256 offset, uint256 limit) external view delegated returns (bytes32[] memory out) {
        uint256 total = _positionKeys.length();
        if (offset >= total) return out;
        uint256 n = Math.min(limit, total - offset);
        out = new bytes32[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = _positionKeys.at(offset + i);
        }
    }

    function orderCount() external view delegated returns (uint256) {
        return _orderIds.length();
    }

    /// @notice Pages through the ids of all open orders. Ordering is not stable across state changes.
    function orderIds(uint256 offset, uint256 limit) external view delegated returns (uint256[] memory out) {
        uint256 total = _orderIds.length();
        if (offset >= total) return out;
        uint256 n = Math.min(limit, total - offset);
        out = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = _orderIds.at(offset + i);
        }
    }

    /// @notice Open fee a trade of `size` and `margin` on the given side would pay right now, before any referral
    ///         discount (zero in Upside markets).
    function quoteOpenFee(bytes32 marketId, uint256 size, bool isLong, uint256 margin)
        external
        view
        delegated
        returns (uint256)
    {
        return _openFee(_existingMarket(marketId), size, isLong, margin);
    }

    /// @notice Current funding rate per second per unit of notional (1e18). Positive: longs pay shorts.
    function fundingRate(bytes32 marketId) external view delegated returns (int256) {
        return _fundingRate(_existingMarket(marketId));
    }

    /// @notice Funding index including funding accrued since the last on-chain update.
    function currentFundingIndex(bytes32 marketId) external view delegated returns (int256) {
        return _currentFundingIndex(_existingMarket(marketId));
    }

    // ───────────────────────────── Internal ─────────────────────────────

    /// @dev `pnl` of one side held between -`margin` (losses stop at margin) and `margin * multiple` (the cap).
    function _bound(int256 pnl, uint256 margin, uint256 multiple) private pure returns (int256) {
        int256 low = -margin.toInt256();
        int256 high = (margin * multiple).toInt256();
        return pnl < low ? low : pnl > high ? high : pnl;
    }

    function _checkMarketParams(uint16 maxLeverage, uint256 skewScale) private pure {
        if (maxLeverage == 0 || maxLeverage > MAX_LEVERAGE || skewScale == 0) revert InvalidParam();
    }

    /// @dev Bounds each parameter to 50% and keeps what the house nets from a self-referred Upside win (the profit
    ///      share after the discount, less the referrer's part of it) at or above MIN_NET_PROFIT_SHARE_BPS.
    function _checkShares(uint256 profitShare, uint256 referralShare, uint256 discount) private pure {
        if (profitShare > MAX_SHARE_BPS || referralShare > MAX_SHARE_BPS || discount > MAX_SHARE_BPS) {
            revert InvalidParam();
        }
        if (profitShare * (BPS - discount) * (BPS - referralShare) < MIN_NET_PROFIT_SHARE_BPS * BPS * BPS) {
            revert InvalidParam();
        }
    }
}
