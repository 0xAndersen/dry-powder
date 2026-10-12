// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {Position} from "../Types.sol";

/// @notice Position valuation shared by PerpEngine and EngineLens, so that what the lens reports is by
///         construction what the engine enforces.
library PositionMath {
    using SafeCast for uint256;
    using SafeCast for int256;

    uint256 internal constant BPS = 10_000;
    int256 internal constant FUNDING_PRECISION = 1e18;
    /// @dev A position is liquidated once its loss (price move plus funding) reaches this share of margin.
    uint256 internal constant LIQUIDATION_THRESHOLD_BPS = 9_000;
    /// @dev Scale of the per-market unit counters used for mark-to-market.
    uint256 internal constant UNIT_PRECISION = 1e36;

    /// @dev Funding owed by the position since entry; negative when the position is owed funding.
    function fundingOwed(Position memory pos, int256 fundingIndex) internal pure returns (int256 owed) {
        owed = (pos.size.toInt256() * (fundingIndex - pos.entryFundingIndex)) / FUNDING_PRECISION;
        if (!pos.isLong) owed = -owed;
    }

    /// @dev PnL from the price move alone. Rounded against the trader: profits down, losses up.
    function pricePnl(Position memory pos, uint256 price) internal pure returns (int256) {
        uint256 entry = pos.entryPrice;
        bool profit = pos.isLong ? price >= entry : price <= entry;
        uint256 diff = price > entry ? price - entry : entry - price;
        uint256 magnitude = Math.mulDiv(pos.size, diff, entry, profit ? Math.Rounding.Floor : Math.Rounding.Ceil);
        return profit ? magnitude.toInt256() : -magnitude.toInt256();
    }

    function isLiquidatable(Position memory pos, uint256 price, int256 fundingIndex) internal pure returns (bool) {
        int256 pnl = pricePnl(pos, price) - fundingOwed(pos, fundingIndex);
        return pnl <= -((pos.margin * LIQUIDATION_THRESHOLD_BPS) / BPS).toInt256();
    }

    /// @dev Mid price at which the position becomes liquidatable. For a long, max-uint means "at any price"
    ///      and 0 "never"; for a short, 0 means "at any price".
    function liquidationPrice(Position memory pos, int256 fundingIndex) internal pure returns (uint256) {
        // Price loss the position can still absorb before it hits the threshold.
        int256 room = ((pos.margin * LIQUIDATION_THRESHOLD_BPS) / BPS).toInt256() - fundingOwed(pos, fundingIndex);
        if (room <= 0) return pos.isLong ? type(uint256).max : 0;
        uint256 r = room.toUint256();
        if (pos.isLong) {
            return r >= pos.size ? 0 : Math.mulDiv(pos.entryPrice, pos.size - r, pos.size, Math.Rounding.Ceil);
        }
        return Math.mulDiv(pos.entryPrice, pos.size + r, pos.size);
    }

    /// @dev Units of the underlying a position of `size` at `entryPrice` represents, scaled by UNIT_PRECISION.
    function units(uint256 size, uint256 entryPrice) internal pure returns (uint256) {
        return Math.mulDiv(size, UNIT_PRECISION, entryPrice);
    }
}
