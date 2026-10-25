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
import {IRewardToken} from "./interfaces/IRewardToken.sol";
import {PositionMath} from "./libraries/PositionMath.sol";
import {PythOracle} from "./PythOracle.sol";
import {FeeMode, LimitParams, Market, OraclePrice, Order, OrderType, Position, PriceStatus} from "./Types.sol";

/// @title PerpEngineBase
/// @notice Storage, events, errors and every internal routine of the engine. Two contracts derive from it and share
///         one address: {PerpEngine}, which holds the trading path (opens, closes, orders, execution, liquidation)
///         and forwards every other call to {PerpEngineExt}, which runs on PerpEngine's storage through
///         `delegatecall` (admin, margin, settlement, expiry, referrals and the heavier views). Neither declares a
///         state variable of its own, so both see exactly this layout; the split exists only because one contract
///         holding everything no longer fits the EIP-170 size limit.
///
/// @dev Instruments
///  A market is a Pyth feed plus three optional switches (see {Market}): a quote feed (crosses such as ETH/BTC),
///  inversion (JPY/USD from USD/JPY) and an expiry (dated, cash-settled futures). Positions are sized in USDC
///  notional, so every instrument is fractional down to `minMargin`. Each market also has a fee mode ({FeeMode}).
///
/// @dev Conventions
///  - USDC amounts (margin, size, fees) use 6 decimals; prices use 18.
///  - One position per trader per market, keyed by `positionKey(trader, marketId)`. The market id is called
///    `priceId` in structs and events; for a plain perpetual it is the Pyth feed id. An open on the side the
///    trader already holds adds to that position; an open on the other side reverts with {PositionExists}.
///  - In Standard markets trades that favour the trader execute on the adverse side of Pyth's confidence band
///    (buys at price+conf, sells at price-conf). Upside markets fill keeper orders at the mid price. Liquidations
///    and trigger conditions are evaluated at the mid price.
///  - A position can only be closed (by its trader or by an order) against a price published after the second
///    it was opened or last increased in; liquidation has no such restriction.
///  - A position is liquidatable once price loss plus funding owed reaches 90% of its margin.
///  - Profit is capped at `maxProfitMultiple` times margin, for a whole position and for each part closed.
///  - Engine USDC holdings always equal open position margins plus open order escrows plus deferred payments
///    (`totalClaimable`, which includes referral rewards not yet collected).
///  - Payments to traders never block: if USDC refuses the transfer (a blocklisted recipient) the amount is
///    parked in `claimable` for that same address and the position is still removed.
///  - Pyth update fees are paid in Arc's native USDC via `msg.value`; any excess is refunded to the caller.
abstract contract PerpEngineBase is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using SafeCast for uint256;
    using SafeCast for int256;
    using EnumerableSet for EnumerableSet.Bytes32Set;
    using EnumerableSet for EnumerableSet.UintSet;

    // ───────────────────────────── Constants ─────────────────────────────

    uint256 internal constant BPS = 10_000;

    /// @notice Hard ceiling on per-market leverage.
    uint256 public constant MAX_LEVERAGE = 5_000;
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
    /// @notice What one close or liquidation reports to the DRY rebate is capped at this share of its notional
    ///         (1%), win or loss. From 100x up a whole margin fits under the cap. Below it the cap is what keeps a
    ///         hedged pair on two accounts from minting DRY on a large loss for the price of fees on notional: the
    ///         pair pays the house at least 24 bp of notional in fees and spread at the default parameters, and DRY
    ///         on 1% of notional cannot earn that back from the stakers' 15% (SECURITY.md).
    uint256 public constant REBATE_NOTIONAL_BPS = 100;
    // Bounds on what the owner can set. Internal (no getters) to keep the bytecode small; they are fixed in this
    // source and documented in SECURITY.md.

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
    /// @dev Ceiling for the Upside profit share and for each referral parameter (50%).
    uint256 internal constant MAX_SHARE_BPS = 5_000;
    /// @dev Floor on what the house keeps of an Upside win after the referral discount and share, assuming the
    ///      trader referred themselves (15%, the stakers' share of house profit): a hedged pair across two accounts
    ///      then pays the house more on the winning leg than the DRY minted on the losing leg can earn in staker
    ///      yield.
    uint256 internal constant MIN_NET_PROFIT_SHARE_BPS = 1_500;

    // ───────────────────────────── Immutables ─────────────────────────────

    IERC20 public immutable usdc;
    IPyth public immutable pyth;
    PythOracle public immutable oracle;
    IHouseVault public immutable vault;
    IRewardToken public immutable rewardToken;

    // ───────────────────────────── Parameters ─────────────────────────────

    /// @notice Fee on notional charged at open and at close (Standard markets).
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
    /// @notice Share of a winning close's profit the house keeps in Upside markets, the only fee they charge.
    uint256 public profitShareBps = 2_000;
    /// @notice Share of every fee a referred trader pays that goes to their referrer (collected with `claim`).
    uint256 public referralShareBps = 1_000;
    /// @notice Discount on every fee for a trader who has a referrer.
    uint256 public referralDiscountBps = 500;

    // ───────────────────────────── State ─────────────────────────────

    mapping(bytes32 marketId => Market) internal _markets;
    bytes32[] internal _marketIds;

    mapping(bytes32 key => Position) internal _positions;
    EnumerableSet.Bytes32Set internal _positionKeys;

    mapping(uint256 orderId => Order) internal _orders;
    EnumerableSet.UintSet internal _orderIds;
    uint64 public nextOrderId = 1;

    /// @notice Sum of long and short notional across all markets.
    uint256 public totalOpenInterest;
    /// @notice Sum over markets and sides of what each side can cost the vault at most: its notional, or its margin
    ///         times `maxProfitMultiple` where that is less (no position can win more than its capped profit). The
    ///         vault cap (`maxOiToNavBps`) and the LP reserve are measured in it, so a 5000x position counts for
    ///         its capped profit rather than for 5000 times its margin.
    uint256 public totalExposure;

    /// @notice USDC owed to `account` whose transfer was refused, or referral rewards; collect with `claim`.
    mapping(address account => uint256) public claimable;
    uint256 public totalClaimable;

    /// @notice Who referred `trader` (a front-end, wallet, agent builder or person). Set once, by the trader.
    mapping(address trader => address) public referrerOf;

    // ───────────────────────────── Events ─────────────────────────────

    event MarketConfigured(
        bytes32 indexed priceId, bool enabled, bool invert, uint16 maxLeverage, uint256 maxOiPerSide, uint256 skewScale
    );
    event MarketListed(
        bytes32 indexed priceId, string symbol, bytes32 feedId, bytes32 quoteFeedId, bool invert, uint64 expiry
    );
    event MarketFeeModeSet(bytes32 indexed priceId, FeeMode mode);
    event MarketSettled(bytes32 indexed priceId, uint256 settlementPrice);
    event FeeParamsSet(
        uint256 baseFeeBps, uint256 maxSkewFeeBps, uint256 maxFundingRatePerSecond, uint256 executionFee
    );
    event RiskParamsSet(uint256 maxPriceAge, uint256 maxConfBps, uint256 maxOiToNavBps, uint256 minMargin);
    event MaxProfitMultipleSet(uint256 maxProfitMultiple);
    event ProfitShareSet(uint256 profitShareBps);
    event ReferralParamsSet(uint256 referralShareBps, uint256 referralDiscountBps);
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
    /// @notice `fee` is the close fee, or in Upside markets the share of profit the house kept.
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
    event MarginRemoved(bytes32 indexed key, address indexed trader, uint256 amount, uint256 newMargin);
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
    event OrderExpirySet(uint256 indexed orderId, uint64 expiresAt);
    event OrderCancelled(uint256 indexed orderId, address indexed trader);
    /// @notice Order `orderId` passed its expiry and was removed by `keeper`, who earned its execution fee; the
    ///         rest of its escrow went back to the trader. Always emitted together with {OrderCancelled}.
    event OrderExpired(uint256 indexed orderId, address indexed trader, address indexed keeper);
    event OrderExecuted(uint256 indexed orderId, address indexed trader, address indexed keeper, uint256 price);
    event ReferrerSet(address indexed trader, address indexed referrer);
    event ReferralFeePaid(address indexed referrer, address indexed trader, uint256 amount);
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
    /// @notice A direct open or close in an Upside market: they fill at the mid price, so only keeper orders, which
    ///         fill at a price published after them, may trade there.
    error OrdersOnly();
    error PositionExists();
    error PositionNotFound();
    error PositionLiquidatable();
    /// @notice {addMargin} on a position whose PnL (after funding) is above zero.
    error PositionInProfit();
    /// @notice An increase of a position whose PnL (after funding) is already beyond its profit cap.
    error ProfitCapReached();
    /// @notice {removeMargin} would leave less equity than the market's initial margin at the exit price.
    error InsufficientMargin();
    error MarketOiCapExceeded();
    error VaultOiCapExceeded();
    error SlippageExceeded();
    error InvalidTrigger();
    error TriggerNotMet();
    error OrderNotFound();
    error NotOrderOwner();
    error NotTriggerOrderType();
    error OrderHasExpired();
    error NothingToCancel();
    error PriceBeforeOrder();
    error PriceNotAfterOpen();
    error NothingToLiquidate();
    error NothingToClaim();
    error ReferrerAlreadySet();
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
    }

    // ───────────────────────────── Shared views ─────────────────────────────

    function positionKey(address trader, bytes32 marketId) public pure returns (bytes32) {
        return keccak256(abi.encode(trader, marketId));
    }

    // ───────────────────────────── Internal: trading ─────────────────────────────

    /// @dev Escrows and records an open order (a limit or a stop-entry) for the caller; see
    ///      {PerpEngine.createLimitOrder}. `expiresAt` 0 means good until cancelled.
    function _createLimitOrder(LimitParams calldata p, uint64 expiresAt) internal returns (uint256 orderId) {
        Market storage m = _existingMarket(p.priceId);
        _validateTrade(m, p.margin, p.size);
        if (p.triggerPrice == 0) revert InvalidTrigger();
        _validateBrackets(p.isLong, p.triggerPrice, p.takeProfit, p.stopLoss);

        uint256 execFee = executionFee;
        // Upside markets charge nothing at open, so there is no fee budget to escrow.
        uint256 feeBudget = m.feeMode == FeeMode.Upside
            ? 0
            : Math.min(Math.mulDiv(p.size, baseFeeBps + maxSkewFeeBps, BPS, Math.Rounding.Ceil), _feeCap(p.margin));
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
            expiresAt: expiresAt,
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
        if (expiresAt != 0) emit OrderExpirySet(orderId, expiresAt);
    }

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
    ) internal returns (bytes32 key) {
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
        uint256 exposureBefore = _exposure(m);
        uint256 sideOi;
        if (isLong) {
            sideOi = (m.longOi += size);
            m.longUnits = m.longUnits + unitsAfter - unitsBefore;
            m.longMargin += margin;
        } else {
            sideOi = (m.shortOi += size);
            m.shortUnits = m.shortUnits + unitsAfter - unitsBefore;
            m.shortMargin += margin;
        }
        if (sideOi > m.maxOiPerSide) revert MarketOiCapExceeded();
        totalOpenInterest += size;
        uint256 exposure = totalExposure + _exposure(m) - exposureBefore;
        totalExposure = exposure;
        if (exposure * BPS > vault.totalAssets() * maxOiToNavBps) revert VaultOiCapExceeded();

        _positions[key] = pos;
        if (increase) {
            emit PositionIncreased(
                key, trader, marketId, isLong, margin, size, price, fee, pos.margin, pos.size, pos.entryPrice
            );
        } else {
            _positionKeys.add(key);
            emit PositionOpened(key, trader, marketId, isLong, margin, size, price, fee);
        }

        _collectFee(trader, fee);
    }

    /// @dev Settles `closeSize` of position `key` (a copy of which is `pos`) at `price`: the whole position when
    ///      `closeSize` is zero or at least its size, or when the rest would hold less than `minMargin`. A part
    ///      is settled like a position of its own: margin released in proportion (rounded down, so the rest
    ///      keeps any remainder), price PnL and funding on its size, and its own profit and fee caps. The rest
    ///      keeps its entry price, funding index, open time and linked orders. Funding must already be accrued
    ///      for `m`.
    function _close(bytes32 key, Position memory pos, Market storage m, uint256 price, uint256 closeSize) internal {
        uint256 size = pos.size;
        uint256 marginOut = closeSize != 0 && closeSize < size ? Math.mulDiv(pos.margin, closeSize, size) : pos.margin;
        uint256 refund;
        // Partial unless nothing would be left (a full close) or too little to keep open.
        bool partial_ = pos.margin - marginOut >= minMargin;
        if (partial_) {
            Position storage rest = _positions[key];
            rest.size = size - closeSize;
            rest.margin = pos.margin - marginOut;
            _release(m, pos.isLong, pos.entryPrice, size, size - closeSize, marginOut);
            // From here on `pos` describes the part being closed.
            pos.size = closeSize;
            pos.margin = marginOut;
        } else {
            refund = _removePosition(key, pos, m);
        }
        (int256 pnl, uint256 fee, uint256 payout) = _settle(pos, m, price);
        if (partial_) {
            emit PositionDecreased(key, pos.trader, pos.priceId, price, pos.size, pos.margin, pnl, fee, payout);
        } else {
            emit PositionClosed(key, pos.trader, pos.priceId, price, pnl, fee, payout);
        }
        _pay(pos.trader, payout + refund);
    }

    /// @dev Realises `pos` (a whole position or the part of one being closed) at `price` with the vault: profit up
    ///      to the cap is paid by the vault, a loss of up to the margin goes to it, and the result is reported to
    ///      the DRY rebate. Standard markets take the close fee out of what is left of the margin; Upside markets
    ///      charge nothing on a loss and keep `profitShareBps` of a profit. Returns the PnL after the cap, the fee
    ///      and what the trader gets.
    function _settle(Position memory pos, Market storage m, uint256 price)
        internal
        returns (int256 pnl, uint256 fee, uint256 payout)
    {
        uint256 margin = pos.margin;
        pnl = PositionMath.pnl(pos, price, m.fundingIndex);
        int256 cap = (margin * maxProfitMultiple).toInt256();
        if (pnl > cap) pnl = cap;
        bool upside = m.feeMode == FeeMode.Upside;
        if (pnl >= 0) {
            uint256 profit = pnl.toUint256();
            payout = margin;
            if (upside) {
                fee = _discounted(pos.trader, Math.mulDiv(profit, profitShareBps, BPS, Math.Rounding.Ceil));
                // The house keeps the share by paying out less; the referrer's part of it is paid out with the
                // profit and credited to them, last, so a short-paying vault shorts the referrer first.
                uint256 owed = profit - fee;
                uint256 toReferrer = _referralShare(pos.trader, fee);
                if (owed + toReferrer != 0) {
                    uint256 paid = vault.payoutTraderProfit(pos.trader, owed + toReferrer);
                    toReferrer = paid > owed ? paid - owed : 0;
                    _creditReferrer(pos.trader, toReferrer);
                    payout += paid - toReferrer;
                }
            } else {
                fee = Math.min(_discounted(pos.trader, _closeFee(pos.size, margin)), margin);
                payout -= fee;
                _collectFee(pos.trader, fee);
                if (profit != 0) payout += vault.payoutTraderProfit(pos.trader, profit);
            }
            if (profit != 0) rewardToken.recordResult(pos.trader, _rebateBase(pos.size, profit).toInt256());
        } else {
            uint256 loss = Math.min((-pnl).toUint256(), margin);
            uint256 remaining = margin - loss;
            if (!upside) fee = Math.min(_discounted(pos.trader, _closeFee(pos.size, margin)), remaining);
            payout = remaining - fee;
            vault.receiveTraderLoss(pos.trader, loss);
            rewardToken.recordResult(pos.trader, -_rebateBase(pos.size, loss).toInt256());
            _collectFee(pos.trader, fee);
        }
    }

    /// @dev Checks shared by every close a trader or an order makes, and its execution price: the price must be
    ///      newer than the position's last open or increase, and past the liquidation threshold the position
    ///      belongs to liquidators. Upside markets fill at the mid price. Accrues funding for `m`.
    function _exitPrice(Position memory pos, Market storage m, OraclePrice memory px) internal returns (uint256) {
        if (px.publishTime <= pos.openedAt) revert PriceNotAfterOpen();
        _accrueFunding(m);
        if (PositionMath.isLiquidatable(pos, px.mid, m.fundingIndex)) revert PositionLiquidatable();
        if (m.feeMode == FeeMode.Upside) return px.mid;
        return pos.isLong ? px.bid : px.ask;
    }

    function _fillOpen(uint256 orderId, Order memory o, Market storage m, OraclePrice memory px)
        internal
        whenNotPaused
        returns (uint256 price)
    {
        // Limits may have changed since the order was placed; it must still be a valid trade now.
        _validateTrade(m, o.margin, o.size);
        price = m.feeMode == FeeMode.Upside ? px.mid : o.isLong ? px.ask : px.bid;
        // A limit fills at its trigger or better; a stop-entry once the market is at or through its trigger.
        if (price != o.triggerPrice && (price > o.triggerPrice) == (o.isLong == (o.orderType == OrderType.LimitOpen))) {
            revert TriggerNotMet();
        }
        // On a gap through a bracket the fill would be closed out at once; leave the order resting instead.
        _validateBrackets(o.isLong, price, o.takeProfit, o.stopLoss);

        _removeOrder(orderId, address(0));
        uint256 fee = Math.min(_discounted(o.trader, _openFee(m, o.size, o.isLong, o.margin)), o.feeBudget);
        bytes32 key = _open(o.trader, o.priceId, m, o.isLong, o.margin, o.size, price, fee);
        _pay(o.trader, o.feeBudget - fee + _attachBrackets(key, o.takeProfit, o.stopLoss, o.executionFee));
    }

    function _fillTrigger(uint256 orderId, Order memory o, Market storage m, OraclePrice memory px)
        internal
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
    function _tryLiquidate(bytes32 key) internal returns (bool) {
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
        rewardToken.recordResult(pos.trader, -_rebateBase(pos.size, toVault).toInt256());
        if (orphanedEscrow != 0) vault.receiveFees(orphanedEscrow);
        emit PositionLiquidated(key, pos.trader, msg.sender, pos.priceId, px.mid, pos.margin, liquidatorFee, toVault);
        if (liquidatorFee != 0) usdc.safeTransfer(msg.sender, liquidatorFee);
        return true;
    }

    /// @dev Deletes the position, releases its open interest and cancels its linked orders.
    /// @return escrow Execution fees that were escrowed for the cancelled orders.
    function _removePosition(bytes32 key, Position memory pos, Market storage m) internal returns (uint256 escrow) {
        _release(m, pos.isLong, pos.entryPrice, pos.size, 0, pos.margin);
        escrow = _cancelLinked(pos.tpOrderId, pos.trader) + _cancelLinked(pos.slOrderId, pos.trader)
            + _cancelLinked(pos.closeOrderId, pos.trader);
        delete _positions[key];
        _positionKeys.remove(key);
    }

    /// @dev Takes `size - sizeLeft` of a position at `entry`, and `marginOut` of its margin, out of the market's
    ///      counters and the exposure total. The units removed are the position's units before less its units
    ///      after, so the counter stays the exact sum over open positions; the subtractions saturate all the same,
    ///      so rounding can never make a close or a liquidation revert.
    function _release(Market storage m, bool isLong, uint256 entry, uint256 size, uint256 sizeLeft, uint256 marginOut)
        internal
    {
        uint256 out = size - sizeLeft;
        uint256 unitsOut = PositionMath.units(size, entry) - PositionMath.units(sizeLeft, entry);
        uint256 exposureBefore = _exposure(m);
        if (isLong) {
            m.longOi -= out;
            m.longUnits = _subFloor(m.longUnits, unitsOut);
            m.longMargin = _subFloor(m.longMargin, marginOut);
        } else {
            m.shortOi -= out;
            m.shortUnits = _subFloor(m.shortUnits, unitsOut);
            m.shortMargin = _subFloor(m.shortMargin, marginOut);
        }
        totalOpenInterest -= out;
        _changeExposure(exposureBefore, _exposure(m));
    }

    /// @dev Moves `totalExposure` from a market's exposure `before` a change to its exposure `afterwards`.
    function _changeExposure(uint256 before, uint256 afterwards) internal {
        totalExposure = _subFloor(totalExposure + afterwards, before);
    }

    /// @dev What one side can cost the vault at most: its notional, or its margin times the profit cap if less.
    function _sideExposure(uint256 oi, uint256 margin) internal view returns (uint256) {
        return Math.min(oi, margin * maxProfitMultiple);
    }

    /// @dev Both sides of a market, see `totalExposure`.
    function _exposure(Market storage m) internal view returns (uint256) {
        return _sideExposure(m.longOi, m.longMargin) + _sideExposure(m.shortOi, m.shortMargin);
    }

    function _cancelLinked(uint64 orderId, address trader) internal returns (uint256 escrow) {
        if (orderId == 0) return 0;
        escrow = _orders[orderId].executionFee;
        _removeOrder(orderId, trader);
    }

    /// @dev Attaches an open's brackets to position `key`. Where the position already has an order of a bracket's
    ///      type (an increase), that order is moved instead and the bracket's execution fee is returned for the
    ///      caller to refund: one order per type, and no escrow left without an order.
    function _attachBrackets(bytes32 key, uint256 takeProfit, uint256 stopLoss, uint256 execFee)
        internal
        returns (uint256 refund)
    {
        if (takeProfit != 0) refund = _bracket(key, OrderType.TakeProfit, takeProfit, execFee);
        if (stopLoss != 0) refund += _bracket(key, OrderType.StopLoss, stopLoss, execFee);
    }

    function _bracket(bytes32 key, OrderType orderType, uint256 triggerPrice, uint256 execFee)
        internal
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
        internal
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
            expiresAt: 0,
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
    function _moveOrder(uint256 orderId, uint256 triggerPrice) internal {
        Order storage o = _orders[orderId];
        o.triggerPrice = triggerPrice;
        o.createdAt = uint64(block.timestamp);
        emit OrderUpdated(orderId, triggerPrice);
    }

    function _link(Position storage pos, OrderType orderType) internal view returns (uint64) {
        if (orderType == OrderType.TakeProfit) return pos.tpOrderId;
        if (orderType == OrderType.StopLoss) return pos.slOrderId;
        return pos.closeOrderId;
    }

    function _setLink(Position storage pos, OrderType orderType, uint64 orderId) internal {
        if (orderType == OrderType.TakeProfit) pos.tpOrderId = orderId;
        else if (orderType == OrderType.StopLoss) pos.slOrderId = orderId;
        else pos.closeOrderId = orderId;
    }

    /// @dev `cancelledFor` is the trader when the order is being cancelled, or zero when it is being filled.
    function _removeOrder(uint256 orderId, address cancelledFor) internal {
        delete _orders[orderId];
        _orderIds.remove(orderId);
        if (cancelledFor != address(0)) emit OrderCancelled(orderId, cancelledFor);
    }

    /// @dev Escrow an open order holds beyond its execution fee: margin, fee budget and one fee per bracket.
    function _openOrderRefund(Order memory o) internal pure returns (uint256) {
        uint256 brackets = (o.takeProfit != 0 ? 1 : 0) + (o.stopLoss != 0 ? 1 : 0);
        return o.margin + o.feeBudget + brackets * o.executionFee;
    }

    /// @dev Pays `amount` USDC to `to`. If USDC refuses (Arc's USDC reverts for blocklisted accounts) the
    ///      amount is parked for that same account instead, so no position or order can be made immovable.
    function _pay(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, bytes memory ret) = address(usdc).call(abi.encodeCall(IERC20.transfer, (to, amount)));
        if (ok && (ret.length == 0 || abi.decode(ret, (bool)))) return;
        _defer(to, amount);
    }

    function _defer(address to, uint256 amount) internal {
        claimable[to] += amount;
        totalClaimable += amount;
        emit PaymentDeferred(to, amount);
    }

    // ───────────────────────────── Internal: fees and referrals ─────────────────────────────

    /// @dev `fee` less the referral discount when `trader` has a referrer.
    function _discounted(address trader, uint256 fee) internal view returns (uint256) {
        if (fee == 0 || referrerOf[trader] == address(0)) return fee;
        return fee - (fee * referralDiscountBps) / BPS;
    }

    /// @dev The part of `fee` (paid by `trader`) that belongs to their referrer; zero without one.
    function _referralShare(address trader, uint256 fee) internal view returns (uint256) {
        if (fee == 0 || referrerOf[trader] == address(0)) return 0;
        return (fee * referralShareBps) / BPS;
    }

    /// @dev Credits `amount` (held by the engine) to `trader`'s referrer; they collect it with `claim`.
    function _creditReferrer(address trader, uint256 amount) internal {
        if (amount == 0) return;
        address referrer = referrerOf[trader];
        claimable[referrer] += amount;
        totalClaimable += amount;
        emit ReferralFeePaid(referrer, trader, amount);
    }

    /// @dev Sends a fee the engine holds to the vault, less the referrer's share, which stays in the engine as the
    ///      referrer's claimable balance.
    function _collectFee(address trader, uint256 fee) internal {
        if (fee == 0) return;
        uint256 share = _referralShare(trader, fee);
        _creditReferrer(trader, share);
        if (fee > share) vault.receiveFees(fee - share);
    }

    /// @dev Close fee of a Standard market before the referral discount.
    function _closeFee(uint256 size, uint256 margin) internal view returns (uint256) {
        return Math.min(Math.mulDiv(size, baseFeeBps, BPS, Math.Rounding.Ceil), _feeCap(margin));
    }

    /// @dev What one close or liquidation of a position of `size` reports to the DRY rebate for `amount`.
    function _rebateBase(uint256 size, uint256 amount) internal pure returns (uint256) {
        return Math.min(amount, (size * REBATE_NOTIONAL_BPS) / BPS);
    }

    // ───────────────────────────── Internal: validation and math ─────────────────────────────

    function _existingMarket(bytes32 marketId) internal view returns (Market storage m) {
        m = _markets[marketId];
        if (m.lastFundingTime == 0) revert MarketNotFound();
    }

    /// @dev LimitOpen and StopOpen escrow margin and open (or add to) a position; the rest close one.
    function _isOpenOrder(OrderType orderType) internal pure returns (bool) {
        return orderType == OrderType.LimitOpen || orderType == OrderType.StopOpen;
    }

    function _validateTrade(Market storage m, uint256 margin, uint256 size) internal view {
        if (!m.enabled) revert MarketDisabled();
        if (m.expiry != 0 && block.timestamp >= m.expiry) revert MarketExpired();
        if (margin < minMargin) revert MarginTooLow();
        if (size < margin || size > margin * m.maxLeverage) revert LeverageOutOfRange();
    }

    /// @dev At creation a take-profit must sit on the profit side of the reference price and a stop-loss on the
    ///      loss side; anything else would fire immediately and is almost certainly an input mistake.
    function _validateBrackets(bool isLong, uint256 refPrice, uint256 takeProfit, uint256 stopLoss) internal pure {
        if (takeProfit != 0 && (isLong ? takeProfit <= refPrice : takeProfit >= refPrice)) revert InvalidTrigger();
        if (stopLoss != 0 && (isLong ? stopLoss >= refPrice : stopLoss <= refPrice)) revert InvalidTrigger();
    }

    /// @dev Base fee plus a skew surcharge, before any referral discount. The surcharge applies only when the trade
    ///      leaves the market more one-sided than it found it, and scales with the resulting skew ratio. Upside
    ///      markets charge nothing at open.
    function _openFee(Market storage m, uint256 size, bool isLong, uint256 margin) internal view returns (uint256 fee) {
        if (m.feeMode == FeeMode.Upside) return 0;
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

    function _feeCap(uint256 margin) internal pure returns (uint256) {
        return (margin * MARGIN_FEE_CAP_BPS) / BPS;
    }

    /// @dev Funding per second per unit of notional. The heavier side pays, the lighter side receives, and the
    ///      vault keeps the difference, so funding can never cost the vault anything.
    function _fundingRate(Market storage m) internal view returns (int256) {
        uint256 longOi = m.longOi;
        uint256 shortOi = m.shortOi;
        if (longOi == shortOi) return 0;
        uint256 denominator = Math.max(longOi + shortOi, m.skewScale);
        int256 rate = Math.mulDiv(maxFundingRatePerSecond, _absDiff(longOi, shortOi), denominator).toInt256();
        return longOi > shortOi ? rate : -rate;
    }

    /// @dev Funding stops accruing at a dated market's expiry.
    function _fundingTime(Market storage m) internal view returns (uint256 t) {
        t = block.timestamp;
        if (m.expiry != 0 && t > m.expiry) t = m.expiry;
    }

    function _currentFundingIndex(Market storage m) internal view returns (int256) {
        return m.fundingIndex + _fundingRate(m) * (_fundingTime(m) - m.lastFundingTime).toInt256();
    }

    function _accrueFunding(Market storage m) internal {
        uint256 t = _fundingTime(m);
        if (t == m.lastFundingTime) return;
        m.fundingIndex = _currentFundingIndex(m);
        m.lastFundingTime = uint64(t);
    }

    function _absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }

    function _subFloor(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : 0;
    }

    // ───────────────────────────── Internal: oracle ─────────────────────────────

    /// @dev Forwards `priceUpdate` to Pyth, paying its fee from `msg.value`, and refunds the remainder. Every
    ///      payable entry point calls this exactly once, so the engine never retains native value.
    function _updateOracle(bytes[] calldata priceUpdate) internal {
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

    function _readPrice(Market storage m) internal view returns (OraclePrice memory px) {
        PriceStatus status;
        (status, px) = _peekPrice(m, maxPriceAge);
        if (status == PriceStatus.Ok) return px;
        if (status == PriceStatus.Unavailable) revert OraclePriceUnavailable();
        if (status == PriceStatus.Stale) revert OraclePriceStale();
        if (status == PriceStatus.ConfidenceTooWide) revert OracleConfidenceTooWide();
        revert OraclePriceInvalid();
    }

    /// @dev A settled dated market trades at its settlement price for ever; everything else asks the oracle.
    function _peekPrice(Market storage m, uint256 maxAge) internal view returns (PriceStatus, OraclePrice memory px) {
        uint256 settled = m.settlementPrice;
        if (settled != 0) {
            px.mid = px.bid = px.ask = settled;
            px.publishTime = block.timestamp;
            return (PriceStatus.Ok, px);
        }
        return oracle.peek(m.feedId, m.quoteFeedId, m.invert, maxAge, maxConfBps);
    }
}
