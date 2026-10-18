// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {AgentAccount, AgentAccountFactory} from "./AgentAccount.sol";
import {PerpEngine} from "./PerpEngine.sol";
import {Order, OrderType, OraclePrice, Position} from "./Types.sol";

/// @title TrailingStops
/// @notice Trailing stop-losses for positions held by an {AgentAccount}, without a change to the engine: the
///         account approves this contract as an agent, and anyone (in practice the venue's keeper) may call
///         {poke}, which reads the engine's oracle price and moves the position's stop-loss up behind a long (down
///         behind a short) when the market has moved in its favour. The stop itself is an ordinary engine
///         stop-loss, executed by keepers like any other.
/// @dev What keeps it safe:
///      - The stop only ever tightens: a poke sets it only when the new level is better for the trader than the
///        one in place, so a caller can choose when to poke but never loosen a stop.
///      - Levels come from the engine's own price (`getPrice`: fresh, within its confidence band), the same price
///        a stop-loss executes against. The best price is the mid, as the engine's stop-loss rule uses the mid.
///      - The contract's only call into an account is `setTriggerOrder(market, StopLoss, level, size)`. Approve it
///        with the smallest policy the account allows (margin cap 1 micro-USDC, 1x): it never opens anything.
///      - A trail belongs to one position: when that position is gone (or the account now holds the other side)
///        the trail is cleared at the next poke.
///      Creating the stop (when the position has none) escrows the engine's execution fee from the account, as a
///      stop-loss set by the trader would; moving it is free.
contract TrailingStops {
    using EnumerableSet for EnumerableSet.Bytes32Set;

    /// @notice One trailing stop. Prices have 18 decimals, sizes 6.
    /// @param distanceBps How far behind the best price the stop trails, in basis points (10 to 5,000).
    /// @param isLong Side of the position the trail was set for.
    /// @param size Notional the stop closes when it fires; 0 closes the whole position.
    /// @param activation The trail starts once the mid reaches this (long: at or above, short: at or below);
    ///        0 starts it at once.
    /// @param best Best mid since the trail started (long: highest, short: lowest); 0 before activation.
    struct Trail {
        uint16 distanceBps;
        bool isLong;
        uint96 size;
        uint128 activation;
        uint128 best;
    }

    uint16 public constant MIN_DISTANCE_BPS = 10;
    /// @notice Gas a move must have before it starts: creating a stop-loss (a new engine order and its escrow)
    ///         takes about 260k. Pokes with less are refused whole rather than reported as the account's refusal.
    uint256 public constant MOVE_GAS = 400_000;
    uint16 public constant MAX_DISTANCE_BPS = 5_000;
    uint256 private constant BPS = 10_000;

    PerpEngine public immutable engine;
    /// @notice Only accounts this factory deployed can have trails (no spam from look-alike contracts).
    AgentAccountFactory public immutable factory;

    mapping(bytes32 id => Trail) private _trails;
    mapping(bytes32 id => address) private _accountOf;
    mapping(bytes32 id => bytes32) private _marketOf;
    EnumerableSet.Bytes32Set private _ids;

    event TrailSet(
        address indexed account, bytes32 indexed marketId, uint16 distanceBps, uint256 size, uint256 activation
    );
    event TrailCleared(address indexed account, bytes32 indexed marketId);
    event StopTrailed(address indexed account, bytes32 indexed marketId, uint256 best, uint256 stop);
    /// @notice The account refused the move (this contract is not, or no longer, one of its agents).
    event TrailRefused(address indexed account, bytes32 indexed marketId, uint256 stop);

    error NotAllowed();
    error NoPosition();
    error InvalidDistance();
    error NoTrail();
    /// @notice The move ran out of gas: the poke as a whole is refused, so callers (and gas estimates) give it enough.
    error InsufficientGas();

    constructor(PerpEngine engine_, AgentAccountFactory factory_) {
        engine = engine_;
        factory = factory_;
    }

    /// @notice The trail's id: one per account and market.
    function trailId(address account, bytes32 marketId) public pure returns (bytes32) {
        return keccak256(abi.encode(account, marketId));
    }

    function getTrail(address account, bytes32 marketId) external view returns (Trail memory) {
        return _trails[trailId(account, marketId)];
    }

    function trailCount() external view returns (uint256) {
        return _ids.length();
    }

    /// @notice A page of trails, for keepers: accounts, markets and the trails themselves.
    function getTrails(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory accounts, bytes32[] memory markets, Trail[] memory trails)
    {
        uint256 n = _ids.length();
        uint256 end = offset + limit > n ? n : offset + limit;
        uint256 len = end > offset ? end - offset : 0;
        accounts = new address[](len);
        markets = new bytes32[](len);
        trails = new Trail[](len);
        for (uint256 i; i < len; ++i) {
            bytes32 id = _ids.at(offset + i);
            accounts[i] = _accountOf[id];
            markets[i] = _marketOf[id];
            trails[i] = _trails[id];
        }
    }

    /// @notice Sets (or replaces) the trailing stop of `account`'s position in `marketId`. The account's owner or
    ///         one of its active agents may call; the account must have approved this contract as an agent for
    ///         pokes to move the stop. The trail starts from the current mid (or at `activation`).
    function setTrail(AgentAccount account, bytes32 marketId, uint16 distanceBps, uint96 size, uint128 activation)
        external
    {
        _authorize(account);
        if (distanceBps < MIN_DISTANCE_BPS || distanceBps > MAX_DISTANCE_BPS) revert InvalidDistance();
        Position memory pos = engine.getPosition(address(account), marketId);
        if (pos.trader == address(0)) revert NoPosition();
        bytes32 id = trailId(address(account), marketId);
        // Without an activation price the trail starts from the current mid, or from the first one a poke sees.
        uint128 best;
        if (activation == 0) {
            try engine.getPrice(marketId) returns (OraclePrice memory px) {
                best = uint128(px.mid);
            } catch {}
        }
        _trails[id] =
            Trail({distanceBps: distanceBps, isLong: pos.isLong, size: size, activation: activation, best: best});
        if (_ids.add(id)) {
            _accountOf[id] = address(account);
            _marketOf[id] = marketId;
        }
        emit TrailSet(address(account), marketId, distanceBps, size, activation);
    }

    /// @notice Removes the trail. The stop-loss it last set stays in place (cancel it on the account if unwanted).
    function clearTrail(AgentAccount account, bytes32 marketId) external {
        _authorize(account);
        bytes32 id = trailId(address(account), marketId);
        if (!_ids.contains(id)) revert NoTrail();
        _clear(id);
    }

    /// @notice The stop-loss level a poke would set now, or 0 when it would not move the stop (not active yet,
    ///         no usable price, or not better than the stop in place). Keepers call this before {poke}.
    function pending(address account, bytes32 marketId) external view returns (uint256 level) {
        bytes32 id = trailId(account, marketId);
        Trail memory t = _trails[id];
        if (t.distanceBps == 0) return 0;
        Position memory pos = engine.getPosition(account, marketId);
        if (pos.trader == address(0) || pos.isLong != t.isLong) return 0;
        try engine.getPrice(marketId) returns (OraclePrice memory px) {
            (, level) = _next(t, px.mid);
            if (level != 0 && !_better(pos, level, t.isLong)) level = 0;
        } catch {
            return 0;
        }
    }

    /// @notice Moves the stops of the given trails behind the market where it has moved in their favour. Anyone
    ///         may call. Trails whose position is gone are cleared; markets without a usable price are skipped.
    function poke(address[] calldata accounts, bytes32[] calldata marketIds) external {
        uint256 n = accounts.length;
        if (marketIds.length != n) revert NotAllowed();
        for (uint256 i; i < n; ++i) {
            _poke(accounts[i], marketIds[i]);
        }
    }

    function _poke(address account, bytes32 marketId) private {
        bytes32 id = trailId(account, marketId);
        Trail memory t = _trails[id];
        if (t.distanceBps == 0) return;
        Position memory pos = engine.getPosition(account, marketId);
        if (pos.trader == address(0) || pos.isLong != t.isLong) {
            _clear(id);
            return;
        }
        OraclePrice memory px;
        try engine.getPrice(marketId) returns (OraclePrice memory p) {
            px = p;
        } catch {
            return;
        }
        (uint128 best, uint256 level) = _next(t, px.mid);
        if (best != t.best) _trails[id].best = best;
        if (level == 0 || !_better(pos, level, t.isLong)) return;
        // One account's refusal (approval revoked, fee unpaid) must not stop the other trails in the batch. But a
        // call that fails for want of gas is the caller's doing, so it reverts the whole poke: otherwise a gas
        // estimate settles on the cheaper path through the catch, and every estimated poke is "refused". Hence a
        // floor before the call, and after a failure a check that the call did not just run dry (each call level
        // keeps back 1/64 of its gas, so a failure deep in the engine leaves the caller a few 64ths).
        uint256 gasBefore = gasleft();
        if (gasBefore < MOVE_GAS) revert InsufficientGas();
        try AgentAccount(account).setTriggerOrder(marketId, OrderType.StopLoss, level, t.size) {
            emit StopTrailed(account, marketId, best, level);
        } catch {
            if (gasleft() <= gasBefore / 16) revert InsufficientGas();
            emit TrailRefused(account, marketId, level);
        }
    }

    /// @dev The best mid after seeing `mid`, and the stop level behind it (0 while not active).
    function _next(Trail memory t, uint256 mid) private pure returns (uint128 best, uint256 level) {
        best = t.best;
        if (best == 0) {
            // Not started: start now, or once the mid reaches the activation price.
            if (t.activation != 0 && (t.isLong ? mid < t.activation : mid > t.activation)) return (0, 0);
            best = uint128(mid);
        } else if (t.isLong ? mid > best : mid < best) {
            best = uint128(mid);
        }
        // The offset rounds down, so the stop never sits further from the best price than the distance asked for.
        uint256 offset = (uint256(best) * t.distanceBps) / BPS;
        level = t.isLong ? best - offset : best + offset;
    }

    /// @dev True when `level` is a tighter stop than the position's current one (or it has none).
    function _better(Position memory pos, uint256 level, bool isLong) private view returns (bool) {
        if (pos.slOrderId == 0) return true;
        Order memory o = engine.getOrder(pos.slOrderId);
        if (o.trader == address(0)) return true;
        return isLong ? level > o.triggerPrice : level < o.triggerPrice;
    }

    function _authorize(AgentAccount account) private view {
        address owner = account.owner();
        if (factory.accountOf(owner) != address(account)) revert NotAllowed();
        if (msg.sender == owner) return;
        (uint64 expiry,,) = account.agents(msg.sender);
        if (expiry <= block.timestamp) revert NotAllowed();
    }

    function _clear(bytes32 id) private {
        address account = _accountOf[id];
        bytes32 marketId = _marketOf[id];
        delete _trails[id];
        delete _accountOf[id];
        delete _marketOf[id];
        _ids.remove(id);
        emit TrailCleared(account, marketId);
    }
}
