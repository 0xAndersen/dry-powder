// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PositionMath} from "./libraries/PositionMath.sol";
import {PerpEngine} from "./PerpEngine.sol";
import {Market, OraclePrice, Order, Position, PositionView} from "./Types.sol";

/// @title EngineLens
/// @notice Read-only aggregation over PerpEngine for front-ends and keepers. Holds no state and no funds; it
///         exists so the engine's bytecode is spent on logic rather than on views. All valuation goes through
///         the same PositionMath library the engine uses.
contract EngineLens {
    PerpEngine public immutable engine;

    struct MarketView {
        bytes32 id;
        Market market;
        int256 fundingRate; // per second, 1e18; positive: longs pay
        bool hasPrice; // false when the oracle has no usable price right now (stale, closed market, ...)
        OraclePrice price;
    }

    error PositionNotFound();

    constructor(PerpEngine engine_) {
        engine = engine_;
    }

    /// @notice Every listed market with its configuration, open interest, funding rate and current price.
    function getMarkets() external view returns (MarketView[] memory out) {
        bytes32[] memory ids = engine.getMarketIds();
        out = new MarketView[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            out[i].id = ids[i];
            out[i].market = engine.getMarket(ids[i]);
            out[i].fundingRate = engine.fundingRate(ids[i]);
            try engine.getPrice(ids[i]) returns (OraclePrice memory px) {
                out[i].hasPrice = true;
                out[i].price = px;
            } catch {}
        }
    }

    /// @notice Pages through all open positions. Ordering is not stable across state changes.
    function getPositions(uint256 offset, uint256 limit) external view returns (PositionView[] memory out) {
        bytes32[] memory keys = engine.positionKeys(offset, limit);
        out = new PositionView[](keys.length);
        for (uint256 i; i < keys.length; ++i) {
            out[i] = _view(keys[i], engine.getPositionByKey(keys[i]));
        }
    }

    /// @notice All open positions of `trader`, one per market at most.
    function getTraderPositions(address trader) external view returns (PositionView[] memory out) {
        bytes32[] memory ids = engine.getMarketIds();
        PositionView[] memory tmp = new PositionView[](ids.length);
        uint256 count;
        for (uint256 i; i < ids.length; ++i) {
            Position memory pos = engine.getPosition(trader, ids[i]);
            if (pos.trader != address(0)) tmp[count++] = _view(engine.positionKey(trader, ids[i]), pos);
        }
        out = new PositionView[](count);
        for (uint256 i; i < count; ++i) {
            out[i] = tmp[i];
        }
    }

    /// @notice Values a position at an arbitrary `price` (18 decimals).
    /// @return pnl Price PnL minus funding owed, before the close fee and the profit cap.
    /// @return fundingOwed Funding the position owes (negative: is owed).
    /// @return liquidationPrice Mid price at or below (long) / at or above (short) which it is liquidatable.
    /// @return liquidatable Whether it would be liquidatable at `price`.
    function getPositionState(bytes32 key, uint256 price)
        external
        view
        returns (int256 pnl, int256 fundingOwed, uint256 liquidationPrice, bool liquidatable)
    {
        Position memory pos = engine.getPositionByKey(key);
        if (pos.trader == address(0)) revert PositionNotFound();
        int256 index = engine.currentFundingIndex(pos.priceId);
        fundingOwed = PositionMath.fundingOwed(pos, index);
        pnl = PositionMath.pricePnl(pos, price) - fundingOwed;
        liquidationPrice = PositionMath.liquidationPrice(pos, index);
        liquidatable = PositionMath.isLiquidatable(pos, price, index);
    }

    /// @notice Pages through all open orders. Ordering is not stable across state changes.
    function getOrders(uint256 offset, uint256 limit) external view returns (uint256[] memory ids, Order[] memory out) {
        ids = engine.orderIds(offset, limit);
        out = new Order[](ids.length);
        for (uint256 i; i < ids.length; ++i) {
            out[i] = engine.getOrder(ids[i]);
        }
    }

    /// @notice All open orders of `trader`. Linear in the number of open orders; intended for eth_call.
    function getTraderOrders(address trader) external view returns (uint256[] memory ids, Order[] memory out) {
        uint256[] memory all = engine.orderIds(0, type(uint256).max);
        Order[] memory tmp = new Order[](all.length);
        uint256 count;
        for (uint256 i; i < all.length; ++i) {
            Order memory o = engine.getOrder(all[i]);
            if (o.trader == trader) {
                all[count] = all[i];
                tmp[count++] = o;
            }
        }
        ids = new uint256[](count);
        out = new Order[](count);
        for (uint256 i; i < count; ++i) {
            ids[i] = all[i];
            out[i] = tmp[i];
        }
    }

    function _view(bytes32 key, Position memory pos) private view returns (PositionView memory v) {
        int256 index = engine.currentFundingIndex(pos.priceId);
        v.key = key;
        v.position = pos;
        v.fundingOwed = PositionMath.fundingOwed(pos, index);
        v.liquidationPrice = PositionMath.liquidationPrice(pos, index);
    }
}
