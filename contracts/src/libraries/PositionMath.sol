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

    /// @dev Price PnL minus funding owed: what closing the position at `price` would realise before the close
    ///      fee and the profit cap.
    function pnl(Position memory pos, uint256 price, int256 fundingIndex) internal pure returns (int256) {
        return pricePnl(pos, price) - fundingOwed(pos, fundingIndex);
    }

    function isLiquidatable(Position memory pos, uint256 price, int256 fundingIndex) internal pure returns (bool) {
        return pnl(pos, price, fundingIndex) <= -((pos.margin * LIQUIDATION_THRESHOLD_BPS) / BPS).toInt256();
    }

    /// @dev Entry funding index of a position of `size` at `index` after `added` more is opened at
    ///      `currentIndex`: the size-weighted average, so the funding owed at `currentIndex` is unchanged. Rounded
    ///      against the trader (down for a long, which owes more the lower its entry index; up for a short), so
    ///      the funding owed can only grow, by less than one unit.
    function blendIndex(int256 index, uint256 size, int256 currentIndex, uint256 added, bool isLong)
        internal
        pure
        returns (int256)
    {
        // Measured from the lower of the two, so the weighted sum is non-negative and rounding is a plain choice.
        int256 low = index < currentIndex ? index : currentIndex;
        uint256 sum = size * (index - low).toUint256() + added * (currentIndex - low).toUint256();
        uint256 total = size + added;
        return low + (isLong ? sum / total : Math.ceilDiv(sum, total)).toInt256();
    }

    /// @dev Mid price at which the position becomes liquidatable: a long is liquidatable at or below it, a
    ///      short at or above it. Once funding owed alone exceeds the threshold the price lies on the profit
    ///      side of entry (the position survives only while its price gain covers the excess). Zero means a
    ///      long that no price can liquidate, or a short that every price does.
    function liquidationPrice(Position memory pos, int256 fundingIndex) internal pure returns (uint256) {
        // Price loss the position can still absorb before it hits the threshold; negative once funding has
        // taken it past the threshold, in which case it is the price gain it needs to stay alive.
        int256 room = ((pos.margin * LIQUIDATION_THRESHOLD_BPS) / BPS).toInt256() - fundingOwed(pos, fundingIndex);
        int256 size = pos.size.toInt256();
        int256 scaled = pos.isLong ? size - room : size + room;
        if (scaled <= 0) return 0;
        return Math.mulDiv(
            pos.entryPrice, scaled.toUint256(), pos.size, pos.isLong ? Math.Rounding.Ceil : Math.Rounding.Floor
        );
    }

    /// @dev Units of the underlying a position of `size` at `entryPrice` represents, scaled by UNIT_PRECISION.
    function units(uint256 size, uint256 entryPrice) internal pure returns (uint256) {
        return Math.mulDiv(size, UNIT_PRECISION, entryPrice);
    }
}
