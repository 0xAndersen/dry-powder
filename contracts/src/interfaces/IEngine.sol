// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";

import {IHouseVault} from "./IHouseVault.sol";
import {IPerpEngine} from "./IPerpEngine.sol";
import {IRewardToken} from "./IRewardToken.sol";
import {PythOracle} from "../PythOracle.sol";
import {
    FeeMode,
    LimitParams,
    Market,
    MarketConfig,
    OpenParams,
    OraclePrice,
    Order,
    OrderType,
    Position
} from "../Types.sol";

/// @notice Everything callable on the engine's address. The engine is two contracts behind one address:
///         {PerpEngine} holds the trading path and forwards every other call to {PerpEngineExt}, which runs on the
///         engine's storage. Callers use this interface; events and errors are declared on {PerpEngineBase} (and
///         reachable as `PerpEngine.X`).
interface IEngine is IPerpEngine {
    // ───────────────────────────── Trading (PerpEngine) ─────────────────────────────

    function openPosition(OpenParams calldata p, bytes[] calldata priceUpdate) external payable returns (bytes32 key);

    function closePosition(bytes32 marketId, uint256 size, uint256 acceptablePrice, bytes[] calldata priceUpdate)
        external
        payable;

    function createLimitOrder(LimitParams calldata p) external returns (uint256 orderId);

    function createLimitOrderUntil(LimitParams calldata p, uint64 expiresAt) external returns (uint256 orderId);

    function setTriggerOrder(bytes32 marketId, OrderType orderType, uint256 triggerPrice, uint256 size)
        external
        returns (uint256 orderId);

    function cancelOrder(uint256 orderId) external;

    function executeOrder(uint256 orderId, bytes[] calldata priceUpdate) external payable;

    function liquidateBatch(bytes32[] calldata keys, bytes[] calldata priceUpdate)
        external
        payable
        returns (uint256 liquidated);

    function positionKey(address trader, bytes32 marketId) external pure returns (bytes32);

    function getMarket(bytes32 marketId) external view returns (Market memory);

    function getPosition(address trader, bytes32 marketId) external view returns (Position memory);

    function getPositionByKey(bytes32 key) external view returns (Position memory);

    function getOrder(uint256 orderId) external view returns (Order memory);

    function getPrice(bytes32 marketId) external view returns (OraclePrice memory);

    // ───────────────────────────── Positions, orders, settlement (PerpEngineExt) ─────────────────────────────

    function addMargin(bytes32 marketId, uint256 amount) external;

    function removeMargin(bytes32 marketId, uint256 amount, bytes[] calldata priceUpdate) external payable;

    function claim() external;

    function setReferrer(address referrer) external;

    function setOrderExpiry(uint256 orderId, uint64 expiresAt) external;

    function cancelExpired(uint256[] calldata orderIds) external returns (uint256 cancelled);

    function settleMarket(bytes32 marketId, bytes[] calldata priceUpdate) external payable;

    function settlePositions(bytes32[] calldata keys) external returns (uint256 settled);

    // ───────────────────────────── Admin (PerpEngineExt) ─────────────────────────────

    function addMarket(bytes32 marketId, MarketConfig calldata cfg) external;

    function setMarket(bytes32 marketId, bool enabled, uint16 maxLeverage, uint256 maxOiPerSide, uint256 skewScale)
        external;

    function setMarketFeeMode(bytes32 marketId, FeeMode mode) external;

    function setFeeParams(
        uint256 baseFeeBps_,
        uint256 maxSkewFeeBps_,
        uint256 maxFundingRatePerSecond_,
        uint256 executionFee_
    ) external;

    function setRiskParams(uint256 maxPriceAge_, uint256 maxConfBps_, uint256 maxOiToNavBps_, uint256 minMargin_)
        external;

    function setMaxProfitMultiple(uint256 maxProfitMultiple_) external;

    function setProfitShare(uint256 profitShareBps_) external;

    function setReferralParams(uint256 referralShareBps_, uint256 referralDiscountBps_) external;

    function pause() external;

    function unpause() external;

    // ───────────────────────────── Views (PerpEngineExt) ─────────────────────────────

    function getMarketIds() external view returns (bytes32[] memory);

    function positionCount() external view returns (uint256);

    function positionKeys(uint256 offset, uint256 limit) external view returns (bytes32[] memory);

    function orderCount() external view returns (uint256);

    function orderIds(uint256 offset, uint256 limit) external view returns (uint256[] memory);

    function quoteOpenFee(bytes32 marketId, uint256 size, bool isLong, uint256 margin) external view returns (uint256);

    function fundingRate(bytes32 marketId) external view returns (int256);

    function currentFundingIndex(bytes32 marketId) external view returns (int256);

    // ───────────────────────────── Public state ─────────────────────────────

    function usdc() external view returns (IERC20);

    function pyth() external view returns (IPyth);

    function oracle() external view returns (PythOracle);

    function vault() external view returns (IHouseVault);

    function rewardToken() external view returns (IRewardToken);

    function extension() external view returns (address);

    function MAX_LEVERAGE() external view returns (uint256);

    function DIRECT_MAX_LEVERAGE() external view returns (uint256);

    function MARGIN_FEE_CAP_BPS() external view returns (uint256);

    function LIQUIDATION_THRESHOLD_BPS() external view returns (uint256);

    function REBATE_NOTIONAL_BPS() external view returns (uint256);

    function baseFeeBps() external view returns (uint256);

    function maxSkewFeeBps() external view returns (uint256);

    function maxFundingRatePerSecond() external view returns (uint256);

    function executionFee() external view returns (uint256);

    function maxPriceAge() external view returns (uint256);

    function maxConfBps() external view returns (uint256);

    function maxOiToNavBps() external view returns (uint256);

    function minMargin() external view returns (uint256);

    function maxProfitMultiple() external view returns (uint256);

    function profitShareBps() external view returns (uint256);

    function referralShareBps() external view returns (uint256);

    function referralDiscountBps() external view returns (uint256);

    function nextOrderId() external view returns (uint64);

    function totalOpenInterest() external view returns (uint256);

    function totalExposure() external view returns (uint256);

    function claimable(address account) external view returns (uint256);

    function totalClaimable() external view returns (uint256);

    function referrerOf(address trader) external view returns (address);

    function owner() external view returns (address);

    function pendingOwner() external view returns (address);

    function transferOwnership(address newOwner) external;

    function acceptOwnership() external;

    function renounceOwnership() external;

    function paused() external view returns (bool);
}
