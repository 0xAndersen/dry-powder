// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

import {OraclePrice, PriceStatus} from "./Types.sol";

/// @title PythOracle
/// @notice Stateless reader that turns Pyth feeds into validated 18-decimal bid / mid / ask prices for
///         PerpEngine, including crosses (feed / quoteFeed) and inverted quotes. It never reverts on a bad
///         price; it reports a status and lets the caller decide.
contract PythOracle {
    uint256 internal constant BPS = 10_000;
    uint256 internal constant ONE = 1e18;

    IPyth public immutable pyth;

    constructor(IPyth pyth_) {
        pyth = pyth_;
    }

    /// @param feedId Pyth feed of the base asset.
    /// @param quoteFeedId Pyth feed to divide by, or zero for a direct market.
    /// @param invert Return the reciprocal of the (possibly crossed) price.
    /// @param maxAge Maximum distance in seconds between a publish time and now; max-uint disables the check.
    /// @param maxConfBps Maximum confidence interval of each feed relative to its price.
    /// @return status Ok, or the first reason the price is unusable.
    /// @return px The price band. `publishTime` is the older of the two feeds for a cross.
    function peek(bytes32 feedId, bytes32 quoteFeedId, bool invert, uint256 maxAge, uint256 maxConfBps)
        external
        view
        returns (PriceStatus status, OraclePrice memory px)
    {
        (status, px) = _feed(feedId, maxAge, maxConfBps);
        if (status != PriceStatus.Ok) return (status, px);

        if (quoteFeedId != bytes32(0)) {
            OraclePrice memory q;
            (status, q) = _feed(quoteFeedId, maxAge, maxConfBps);
            if (status != PriceStatus.Ok) return (status, px);
            // Widest consistent band: lowest base over highest quote, and the reverse.
            px.bid = (px.bid * ONE) / q.ask;
            px.ask = Math.ceilDiv(px.ask * ONE, q.bid);
            px.mid = (px.mid * ONE) / q.mid;
            if (q.publishTime < px.publishTime) px.publishTime = q.publishTime;
            if (px.bid == 0) return (PriceStatus.Invalid, px);
        }
        if (invert) {
            uint256 one = ONE * ONE;
            (px.bid, px.ask) = (one / px.ask, Math.ceilDiv(one, px.bid));
            px.mid = one / px.mid;
            if (px.bid == 0) return (PriceStatus.Invalid, px);
        }
    }

    function _feed(bytes32 feedId, uint256 maxAge, uint256 maxConfBps)
        private
        view
        returns (PriceStatus, OraclePrice memory px)
    {
        PythStructs.Price memory p;
        try pyth.getPriceUnsafe(feedId) returns (PythStructs.Price memory fetched) {
            p = fetched;
        } catch {
            return (PriceStatus.Unavailable, px);
        }
        uint256 age =
            block.timestamp > p.publishTime ? block.timestamp - p.publishTime : p.publishTime - block.timestamp;
        if (age > maxAge) return (PriceStatus.Stale, px);
        if (p.price <= 0 || p.expo > 0 || p.expo < -18) return (PriceStatus.Invalid, px);

        uint256 raw = uint256(uint64(p.price));
        uint256 conf = p.conf;
        if (conf * BPS > raw * maxConfBps) return (PriceStatus.ConfidenceTooWide, px);

        // maxConfBps is bounded at 5% by the engine, so conf < raw and the band stays strictly positive.
        uint256 scale = 10 ** (18 - uint256(uint32(-p.expo)));
        px.mid = raw * scale;
        px.bid = (raw - conf) * scale;
        px.ask = (raw + conf) * scale;
        px.publishTime = p.publishTime;
        return (PriceStatus.Ok, px);
    }
}
