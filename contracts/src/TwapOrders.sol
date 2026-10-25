// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {AgentAccount, AgentAccountFactory} from "./AgentAccount.sol";
import {IEngine} from "./interfaces/IEngine.sol";
import {LimitParams, OraclePrice, Position} from "./Types.sol";

/// @title TwapOrders
/// @notice TWAP entries for an {AgentAccount}, without a change to the engine: a size split into equal slices,
///         one every `interval` seconds. The account approves this contract as an agent, with a policy that caps
///         each slice (margin per call, leverage); anyone may {poke}, and a poke that is due places the next slice
///         as a keeper-filled market order through the account. Slices on the side held add to the position.
/// @dev What keeps it safe:
///      - Its only call into an account is `createLimitOrder` with a marketable trigger, inside the account's own
///        policy for this contract (the policy caps every slice, whatever the TWAP says).
///      - The trigger is the engine's own price plus the TWAP's slippage bound, and keeper orders fill only at a
///        price published after the order: a poker chooses when a due slice goes, not its price.
///      - A slice is due no earlier than `interval` after the last one; a poke cannot speed a TWAP up.
///      - An agent key may only start a TWAP whose slices fit its own policy: approving this contract never lets a
///        key open more per call, or at more leverage, than it could itself.
///      - A slice is skipped while the account holds the other side (it could not fill), and while the market has
///        no usable price. Three refusals in a row (approval revoked, collateral short, market closed) end the TWAP.
///      - A slice short of gas reverts the poke whole (see {TrailingStops}), so estimated pokes never pass for an
///        account's refusal.
///      - A slice that cannot fill within its slippage rests as a limit order at that bound; cancel it on the
///        account if wanted.
contract TwapOrders {
    using EnumerableSet for EnumerableSet.Bytes32Set;

    /// @param isLong Side the slices open (or add to).
    /// @param slices Total slices; `done` of them placed so far.
    /// @param interval Seconds between slices.
    /// @param maxSlippageBps Worst fill accepted, from the price when the slice is placed.
    /// @param nextAt Earliest time for the next slice.
    /// @param sliceMargin Margin per slice (6 decimals); `sliceSize` its notional.
    /// @param refusals Slices the account refused in a row; {MAX_REFUSALS} ends the TWAP.
    struct Twap {
        bool isLong;
        uint16 slices;
        uint16 done;
        uint32 interval;
        uint16 maxSlippageBps;
        uint64 nextAt;
        uint96 sliceMargin;
        uint8 refusals;
        uint96 sliceSize;
    }

    uint16 public constant MAX_SLICES = 100;
    uint32 public constant MIN_INTERVAL = 30;
    uint32 public constant MAX_INTERVAL = 1 days;
    uint16 public constant MAX_SLIPPAGE_BPS = 500;
    uint8 public constant MAX_REFUSALS = 3;
    /// @notice Gas a slice must have before it starts: a keeper order with its escrow takes about 330k.
    uint256 public constant SLICE_GAS = 500_000;
    uint256 private constant BPS = 10_000;

    IEngine public immutable engine;
    AgentAccountFactory public immutable factory;

    mapping(bytes32 id => Twap) private _twaps;
    mapping(bytes32 id => address) private _accountOf;
    mapping(bytes32 id => bytes32) private _marketOf;
    EnumerableSet.Bytes32Set private _ids;

    event TwapSet(
        address indexed account,
        bytes32 indexed marketId,
        bool isLong,
        uint256 sliceMargin,
        uint256 sliceSize,
        uint16 slices,
        uint32 interval,
        uint16 maxSlippageBps
    );
    event SlicePlaced(
        address indexed account, bytes32 indexed marketId, uint256 orderId, uint16 slice, uint256 triggerPrice
    );
    /// @notice The account refused the slice (policy too small, approval revoked, not enough collateral).
    event SliceRefused(address indexed account, bytes32 indexed marketId, uint16 slice);
    event TwapEnded(address indexed account, bytes32 indexed marketId, uint16 done, uint16 slices);

    error NotAllowed();
    /// @notice An agent tried to start slices beyond its own margin or leverage cap.
    error AgentPolicyExceeded();
    error InvalidTwap();
    error NoTwap();
    error InsufficientGas();

    constructor(IEngine engine_, AgentAccountFactory factory_) {
        engine = engine_;
        factory = factory_;
    }

    function twapId(address account, bytes32 marketId) public pure returns (bytes32) {
        return keccak256(abi.encode(account, marketId));
    }

    function getTwap(address account, bytes32 marketId) external view returns (Twap memory) {
        return _twaps[twapId(account, marketId)];
    }

    function twapCount() external view returns (uint256) {
        return _ids.length();
    }

    /// @notice A page of TWAPs, for keepers.
    function getTwaps(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory accounts, bytes32[] memory markets, Twap[] memory twaps)
    {
        uint256 n = _ids.length();
        uint256 end = offset + limit > n ? n : offset + limit;
        uint256 len = end > offset ? end - offset : 0;
        accounts = new address[](len);
        markets = new bytes32[](len);
        twaps = new Twap[](len);
        for (uint256 i; i < len; ++i) {
            bytes32 id = _ids.at(offset + i);
            accounts[i] = _accountOf[id];
            markets[i] = _marketOf[id];
            twaps[i] = _twaps[id];
        }
    }

    /// @notice Starts (or replaces) a TWAP on `account` in `marketId`: `slices` orders of `sliceMargin` margin and
    ///         `sliceSize` notional, one every `interval` seconds, the first at the next poke. The account's owner
    ///         or one of its active agents may call (an agent only within its own policy); the account must have
    ///         approved this contract as an agent with a policy that covers a slice.
    function setTwap(
        AgentAccount account,
        bytes32 marketId,
        bool isLong,
        uint96 sliceMargin,
        uint96 sliceSize,
        uint16 slices,
        uint32 interval,
        uint16 maxSlippageBps
    ) external {
        (uint16 maxLeverage, uint128 maxMargin) = _authorize(account);
        if (sliceMargin > maxMargin || sliceSize > uint256(sliceMargin) * maxLeverage) revert AgentPolicyExceeded();
        if (
            slices < 2 || slices > MAX_SLICES || interval < MIN_INTERVAL || interval > MAX_INTERVAL
                || maxSlippageBps == 0 || maxSlippageBps > MAX_SLIPPAGE_BPS || sliceMargin == 0
                || sliceSize < sliceMargin
        ) revert InvalidTwap();
        bytes32 id = twapId(address(account), marketId);
        _twaps[id] = Twap({
            isLong: isLong,
            slices: slices,
            done: 0,
            interval: interval,
            maxSlippageBps: maxSlippageBps,
            nextAt: uint64(block.timestamp),
            sliceMargin: sliceMargin,
            refusals: 0,
            sliceSize: sliceSize
        });
        if (_ids.add(id)) {
            _accountOf[id] = address(account);
            _marketOf[id] = marketId;
        }
        emit TwapSet(address(account), marketId, isLong, sliceMargin, sliceSize, slices, interval, maxSlippageBps);
    }

    /// @notice Stops the TWAP. Slices already placed stay (cancel resting ones on the account if wanted).
    function cancelTwap(AgentAccount account, bytes32 marketId) external {
        _authorize(account);
        bytes32 id = twapId(address(account), marketId);
        if (!_ids.contains(id)) revert NoTwap();
        Twap memory t = _twaps[id];
        _end(id, t);
    }

    /// @notice Whether a poke would place a slice now (due, a usable price, not holding the other side).
    function due(address account, bytes32 marketId) public view returns (bool) {
        Twap memory t = _twaps[twapId(account, marketId)];
        if (t.slices == 0 || t.done >= t.slices || block.timestamp < t.nextAt) return false;
        Position memory pos = engine.getPosition(account, marketId);
        if (pos.trader != address(0) && pos.isLong != t.isLong) return false;
        try engine.getPrice(marketId) returns (OraclePrice memory) {
            return true;
        } catch {
            return false;
        }
    }

    /// @notice Places the next slice of each given TWAP that is due. Anyone may call.
    function poke(address[] calldata accounts, bytes32[] calldata marketIds) external {
        uint256 n = accounts.length;
        if (marketIds.length != n) revert InvalidTwap();
        for (uint256 i; i < n; ++i) {
            _poke(accounts[i], marketIds[i]);
        }
    }

    function _poke(address account, bytes32 marketId) private {
        if (!due(account, marketId)) return;
        bytes32 id = twapId(account, marketId);
        Twap memory t = _twaps[id];
        OraclePrice memory px = engine.getPrice(marketId);
        // Marketable: a long accepts up to the ask plus the slippage, a short down to the bid minus it.
        uint256 trigger =
            t.isLong ? (px.ask * (BPS + t.maxSlippageBps)) / BPS : (px.bid * (BPS - t.maxSlippageBps)) / BPS;
        // Due again only after a full interval, whether this slice is placed or refused.
        _twaps[id].nextAt = uint64(block.timestamp) + t.interval;

        uint256 gasBefore = gasleft();
        if (gasBefore < SLICE_GAS) revert InsufficientGas();
        LimitParams memory p = LimitParams({
            priceId: marketId,
            isLong: t.isLong,
            margin: t.sliceMargin,
            size: t.sliceSize,
            triggerPrice: trigger,
            takeProfit: 0,
            stopLoss: 0,
            stopEntry: false
        });
        try AgentAccount(account).createLimitOrder(p) returns (uint256 orderId) {
            uint16 done_ = t.done + 1;
            emit SlicePlaced(account, marketId, orderId, done_, trigger);
            if (done_ >= t.slices) {
                t.done = done_;
                _end(id, t);
            } else {
                _twaps[id].done = done_;
                if (t.refusals != 0) _twaps[id].refusals = 0;
            }
        } catch {
            if (gasleft() <= gasBefore / 16) revert InsufficientGas();
            emit SliceRefused(account, marketId, t.done + 1);
            uint8 refusals = t.refusals + 1;
            if (refusals >= MAX_REFUSALS) _end(id, t);
            else _twaps[id].refusals = refusals;
        }
    }

    /// @dev The caller is the account's owner or an active agent; returns the caller's caps (none for the owner).
    function _authorize(AgentAccount account) private view returns (uint16 maxLeverage, uint128 maxMargin) {
        address owner = account.owner();
        if (factory.accountOf(owner) != address(account)) revert NotAllowed();
        if (msg.sender == owner) return (type(uint16).max, type(uint128).max);
        uint64 expiry;
        (expiry, maxLeverage, maxMargin) = account.agents(msg.sender);
        if (expiry <= block.timestamp) revert NotAllowed();
    }

    function _end(bytes32 id, Twap memory t) private {
        address account = _accountOf[id];
        bytes32 marketId = _marketOf[id];
        delete _twaps[id];
        delete _accountOf[id];
        delete _marketOf[id];
        _ids.remove(id);
        emit TwapEnded(account, marketId, t.done, t.slices);
    }
}
