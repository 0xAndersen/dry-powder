// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {AgentAccount, AgentAccountFactory} from "./AgentAccount.sol";
import {PerpEngine} from "./PerpEngine.sol";
import {LimitParams, Market, OraclePrice, OrderType, Position} from "./Types.sol";

/// @title Strategies
/// @notice Strategy agents for an {AgentAccount}, run on-chain without a change to the engine: trend following (a
///         fast and a slow EMA of the engine's price), mean reversion (an EMA and bands around it) and copy trading
///         (another trader's position in a market, scaled). The account approves this contract as an agent with a
///         policy that caps each order (margin per call, leverage); its owner or one of its agents starts a
///         strategy on one market; anyone may {poke}. A poke that is due samples the price, updates the signal
///         and, when the account's position does not match it, places one keeper-filled order through the
///         account to move towards it. One live strategy per account and market: it manages the account's whole
///         position there.
/// @dev What keeps it safe (the rules of {TwapOrders}):
///      - Its only calls into an account are `createLimitOrder` with a marketable trigger, `setTriggerOrder(market,
///        Close, worst price, size)` and `cancelOrder` of an order it placed, all inside the account's own policy
///        for this contract: the policy caps every order, whatever the strategy says.
///      - Prices are the engine's own (`getPrice`: fresh, within its confidence band), and keeper orders fill only
///        at a price published after the order, within the strategy's slippage bound: a poker chooses when a due
///        sample is taken (in the seconds before the venue's keeper takes it), never the price of a fill.
///      - Samples are at least `interval` apart: a poke cannot speed a strategy up.
///      - One order at a time: nothing is placed while its last order is on the book. An order still there a
///        full interval later (the price ran through its bound) is cancelled and the step tried again.
///      - A flip is two steps: the close, then, once flat, the open on a later poke.
///      - A position the strategy held that something else closed (its stop-loss, a liquidation, the owner) is
///        not reopened: trend and mean reversion wait for the next signal, a copy for the leader's next trade.
///      - An agent key may only start a strategy whose orders fit its own policy.
///      - Three refusals in a row (approval revoked or too small, collateral short, market closed) pause it.
///      - An order short of gas reverts the poke whole (see {TrailingStops}), so estimated pokes never pass for an
///        account's refusal.
///      Calls go only to the engine and to accounts the factory deployed (whose code is known), so nothing can
///      re-enter while a poke holds a strategy's state in memory.
contract Strategies {
    using EnumerableSet for EnumerableSet.UintSet;

    enum Kind {
        Trend,
        MeanRevert,
        Copy
    }

    enum Side {
        Flat,
        Long,
        Short
    }

    /// @dev Open: a new position. Increase: a copy adding to its position. Close: all of it. Reduce: a copy taking
    ///      part of it off. Cancel: an order of its own that went stale.
    enum Action {
        Open,
        Increase,
        Close,
        Reduce,
        Cancel
    }

    /// @dev None: no such strategy. Paused strategies keep their market; stopped ones free it.
    enum Status {
        None,
        Active,
        Paused,
        Stopped
    }

    /// @notice What a strategy trades and how. Amounts have 6 decimals.
    /// @param interval Seconds between samples (60 s to 1 day). Also how long an order may wait for its fill.
    /// @param margin Margin of an entry (trend, mean reversion) or the most margin per order (copy).
    /// @param leverage Whole multiple: an entry's size is `margin * leverage`.
    /// @param maxSlippageBps Worst fill accepted, from the price when the order is placed (at most 500).
    /// @param allowShort False: the strategy only goes long (a short signal means flat; a copy ignores shorts).
    /// @param stopLossBps Stop-loss on each new position, this far from the price (10 to 5,000 bp); 0 for none.
    /// @param takeProfitBps Take-profit likewise; it must be wider than the slippage bound; 0 for none.
    /// @param period Trend: the fast EMA's period; mean reversion: the EMA's period. In samples, 2 to 200.
    /// @param slowPeriod Trend: the slow EMA's period, above `period`. Unused (0) otherwise.
    /// @param bandBps Trend: hysteresis around the slow EMA (0 to 2,000); mean reversion: the entry band (1 to
    ///        2,000).
    /// @param exitBps Mean reversion: the exit band, inside the entry band. Unused (0) otherwise.
    /// @param ratioBps Copy: the copy's size as a share of the leader's (10,000 is the same size; up to 100,000).
    /// @param leader Copy: the trader copied (any address: a wallet or another account).
    /// @param maxSize Copy: the largest position the copy takes.
    struct Config {
        Kind kind;
        uint32 interval;
        uint64 margin;
        uint16 leverage;
        uint16 maxSlippageBps;
        bool allowShort;
        uint16 stopLossBps;
        uint16 takeProfitBps;
        uint16 period;
        uint16 slowPeriod;
        uint16 bandBps;
        uint16 exitBps;
        uint32 ratioBps;
        address leader;
        uint80 maxSize;
    }

    /// @notice A strategy's moving parts, all public so the app can show them.
    /// @param target Where the last sample said to be.
    /// @param holding The side the strategy put on and holds, as far as it knows (Flat once something else
    ///        closed it).
    /// @param todo True while the position does not match the target yet.
    /// @param refusals Orders the account refused in a row; {MAX_REFUSALS} pauses the strategy.
    /// @param pendingAction What its order on the book does; `pendingSide` the side it is for.
    /// @param nextAt Earliest time for the next sample.
    /// @param actAt Earliest time for the next order after a refusal.
    /// @param samples Samples taken (trend and mean reversion act once their EMAs have seen a full period).
    /// @param pendingOrder Its order on the book (0: none), placed at `pendingSince`.
    /// @param targetSize Copy: the size the last sample asked for.
    /// @param actions Orders placed so far.
    /// @param emaFast Trend: the fast EMA; mean reversion: the EMA (18 decimals, like prices).
    /// @param emaSlow Trend: the slow EMA.
    /// @param lastPrice The mid at the last sample.
    /// @param blockedAt Copy: `openedAt` of the leader's position the copy was closed out of; that one is not
    ///        followed again (0: none).
    struct State {
        Status status;
        Side target;
        Side holding;
        bool todo;
        uint8 refusals;
        Action pendingAction;
        Side pendingSide;
        uint64 nextAt;
        uint64 actAt;
        uint32 samples;
        uint64 pendingOrder;
        uint64 pendingSince;
        uint96 targetSize;
        uint32 actions;
        uint128 emaFast;
        uint128 emaSlow;
        uint128 lastPrice;
        uint64 blockedAt;
    }

    struct Strategy {
        address account;
        bytes32 marketId;
        Config config;
        State state;
    }

    uint32 public constant MIN_INTERVAL = 60;
    uint32 public constant MAX_INTERVAL = 1 days;
    uint16 public constant MAX_SLIPPAGE_BPS = 500;
    uint16 public constant MIN_PERIOD = 2;
    uint16 public constant MAX_PERIOD = 200;
    uint16 public constant MAX_BAND_BPS = 2_000;
    uint16 public constant MIN_BRACKET_BPS = 10;
    uint16 public constant MAX_BRACKET_BPS = 5_000;
    uint32 public constant MAX_RATIO_BPS = 100_000;
    /// @notice A copy is resized when its size is off the target by more than this share of the target.
    uint256 public constant RESIZE_BPS = 1_000;
    uint8 public constant MAX_REFUSALS = 3;
    /// @notice Gas an order (or a cancel) must have before it starts: a keeper order with brackets and escrow
    ///         takes about 400k.
    uint256 public constant ACTION_GAS = 500_000;
    uint256 private constant BPS = 10_000;
    uint256 private constant WAD = 1e18;

    PerpEngine public immutable engine;
    /// @notice Only accounts this factory deployed can run strategies.
    AgentAccountFactory public immutable factory;

    /// @notice Id of the next strategy created (ids start at 1).
    uint256 public nextId = 1;

    mapping(uint256 id => Strategy) private _strategies;
    /// @dev Live (active or paused) strategy of an account in a market, by `keccak256(account, marketId)`.
    mapping(bytes32 key => uint256 id) private _liveOf;
    mapping(address account => uint256[] ids) private _byAccount;
    EnumerableSet.UintSet private _live;

    event StrategyCreated(uint256 indexed id, address indexed account, bytes32 indexed marketId, Config config);
    /// @notice A sample. `a` and `b`: trend, the fast and slow EMAs; mean reversion, the EMA the price was compared
    ///         with, and the EMA after it; copy, the leader's size and the copy's target size.
    event Sampled(uint256 indexed id, uint256 price, uint256 a, uint256 b, Side target);
    /// @notice The signal: the target moved.
    event TargetChanged(uint256 indexed id, Side from, Side to);
    /// @notice An order placed through the account; `price` is its trigger (opens) or worst price (closes).
    event OrderPlaced(uint256 indexed id, Action action, uint256 orderId, uint256 size, uint256 price);
    /// @notice Its order left the book; `filled` when the position shows it did what it was placed for.
    event OrderSettled(uint256 indexed id, uint256 orderId, bool filled);
    /// @notice The strategy cancelled an order of its own (stale, or an open on pause or stop).
    event OrderDropped(uint256 indexed id, uint256 orderId);
    /// @notice The account refused an order (or a cancel).
    event ActionRefused(uint256 indexed id, Action action);
    /// @notice The position the strategy held was closed by something else (a stop, a liquidation, the owner).
    event ExitedElsewhere(uint256 indexed id, Side side);
    event StrategyPaused(uint256 indexed id, bool afterRefusals);
    event StrategyResumed(uint256 indexed id);
    event StrategyStopped(uint256 indexed id);

    error NotAllowed();
    /// @notice An agent tried to start a strategy beyond its own margin or leverage cap.
    error AgentPolicyExceeded();
    error InvalidStrategy();
    /// @notice The account does not (yet) let this contract trade one order of the strategy: approve it first.
    error NotApproved();
    /// @notice The account already runs a strategy in this market.
    error MarketTaken();
    error NoStrategy();
    error InsufficientGas();

    constructor(PerpEngine engine_, AgentAccountFactory factory_) {
        engine = engine_;
        factory = factory_;
    }

    // ───────────────────────────── Views ─────────────────────────────

    function getStrategy(uint256 id) external view returns (Strategy memory) {
        return _strategies[id];
    }

    /// @notice Live (active or paused) strategies.
    function strategyCount() external view returns (uint256) {
        return _live.length();
    }

    /// @notice A page of live strategies, for keepers and the app.
    function getStrategies(uint256 offset, uint256 limit)
        external
        view
        returns (uint256[] memory ids, Strategy[] memory list)
    {
        uint256 n = _live.length();
        uint256 end = offset + limit > n ? n : offset + limit;
        uint256 len = end > offset ? end - offset : 0;
        ids = new uint256[](len);
        list = new Strategy[](len);
        for (uint256 i; i < len; ++i) {
            uint256 id = _live.at(offset + i);
            ids[i] = id;
            list[i] = _strategies[id];
        }
    }

    /// @notice Every strategy `account` ever ran, stopped ones included, oldest first.
    function strategiesOf(address account) external view returns (uint256[] memory) {
        return _byAccount[account];
    }

    /// @notice The live strategy of `account` in `marketId`, 0 for none.
    function strategyOf(address account, bytes32 marketId) external view returns (uint256) {
        return _liveOf[_key(account, marketId)];
    }

    /// @notice Whether a poke would do something now: a sample due, its order settled or stale, or a step to take
    ///         (and a usable price).
    function due(uint256 id) external view returns (bool) {
        Strategy storage st = _strategies[id];
        State memory s = st.state;
        if (s.status != Status.Active) return false;
        try engine.getPrice(st.marketId) returns (OraclePrice memory px) {
            if (px.mid > type(uint128).max) return false;
        } catch {
            return false;
        }
        if (block.timestamp >= s.nextAt) return true;
        if (s.pendingOrder != 0) {
            if (engine.getOrder(s.pendingOrder).trader == address(0)) return true;
            return block.timestamp >= uint256(s.pendingSince) + st.config.interval && block.timestamp >= s.actAt;
        }
        return s.todo && block.timestamp >= s.actAt;
    }

    // ───────────────────────────── Owner or agent ─────────────────────────────

    /// @notice Starts a strategy on `account` in `marketId`. The account's owner or one of its active agents may
    ///         call (an agent only within its own policy), and the account must already have approved this
    ///         contract as an agent with a policy that covers one order (`setAgent(strategies, expiry, leverage,
    ///         margin)`). The first sample is taken at the next poke.
    function create(AgentAccount account, bytes32 marketId, Config calldata c) external returns (uint256 id) {
        (uint16 maxLeverage, uint128 maxMargin) = _authorize(account);
        if (c.margin > maxMargin || c.leverage > maxLeverage) revert AgentPolicyExceeded();
        _validate(address(account), marketId, c);
        (uint64 expiry, uint16 lev, uint128 cap) = account.agents(address(this));
        if (
            expiry <= block.timestamp || c.margin > cap || c.leverage > lev
                || (account.restrictMarkets() && !account.marketAllowed(marketId))
        ) revert NotApproved();
        bytes32 key = _key(address(account), marketId);
        if (_liveOf[key] != 0) revert MarketTaken();

        id = nextId++;
        Strategy storage st = _strategies[id];
        st.account = address(account);
        st.marketId = marketId;
        st.config = c;
        st.state.status = Status.Active;
        st.state.nextAt = uint64(block.timestamp);
        _liveOf[key] = id;
        _live.add(id);
        _byAccount[address(account)].push(id);
        emit StrategyCreated(id, address(account), marketId, c);
    }

    /// @notice Pauses the strategy: no samples, no orders. An open order of its own still on the book is
    ///         cancelled (a pause never adds exposure); a close on the book stays and fills.
    function pause(uint256 id) external {
        Strategy storage st = _strategies[id];
        State memory s = st.state;
        if (s.status != Status.Active) revert NoStrategy();
        _authorize(AgentAccount(st.account));
        s.status = Status.Paused;
        _dropOpenOrder(id, st.account, s);
        st.state = s;
        emit StrategyPaused(id, false);
    }

    /// @notice Resumes a paused strategy. Trend and mean reversion warm up again (their EMAs restart from the
    ///         next sample, so no signal comes from prices seen before the pause); a step left to take (a refused
    ///         order) is tried at the next poke.
    function resume(uint256 id) external {
        Strategy storage st = _strategies[id];
        State memory s = st.state;
        if (s.status != Status.Paused) revert NoStrategy();
        _authorize(AgentAccount(st.account));
        s.status = Status.Active;
        s.refusals = 0;
        s.actAt = 0;
        s.nextAt = uint64(block.timestamp);
        if (st.config.kind != Kind.Copy) s.samples = 0;
        st.state = s;
        emit StrategyResumed(id);
    }

    /// @notice Stops the strategy for good and frees its market. Its position stays (close it on the account if
    ///         wanted); an open order of its own on the book is cancelled, a close stays.
    function stop(uint256 id) external {
        Strategy storage st = _strategies[id];
        State memory s = st.state;
        if (s.status != Status.Active && s.status != Status.Paused) revert NoStrategy();
        address account = st.account;
        _authorize(AgentAccount(account));
        _dropOpenOrder(id, account, s);
        s.status = Status.Stopped;
        st.state = s;
        delete _liveOf[_key(account, st.marketId)];
        _live.remove(id);
        emit StrategyStopped(id);
    }

    // ───────────────────────────── Keepers ─────────────────────────────

    /// @notice Runs each given strategy that has something to do. Anyone may call.
    function poke(uint256[] calldata ids) external {
        uint256 n = ids.length;
        for (uint256 i; i < n; ++i) {
            _poke(ids[i]);
        }
    }

    function _poke(uint256 id) private {
        Strategy storage st = _strategies[id];
        State memory s = st.state;
        if (s.status != Status.Active) return;
        bytes32 marketId = st.marketId;
        OraclePrice memory px;
        try engine.getPrice(marketId) returns (OraclePrice memory p) {
            px = p;
        } catch {
            return;
        }
        if (px.mid > type(uint128).max) return;
        address account = st.account;
        Config memory c = st.config;
        // The position is read only when something needs it (an idle, flat strategy just samples).
        Position memory pos;
        bool read = s.pendingOrder != 0 || s.holding != Side.Flat;
        if (read) pos = engine.getPosition(account, marketId);

        // 1. Its last order: settled, still working (wait), or stale (cancel it, and take the step again below).
        bool waiting = s.pendingOrder != 0 && !_clearPending(id, c, s, account, pos);
        // 2. A position it held that something else closed.
        if (!waiting) _checkExit(id, c, s, marketId, pos);
        // 3. The signal, at most once per interval (also while an order works, so the EMAs keep their pace).
        if (s.status == Status.Active && block.timestamp >= s.nextAt) _sample(id, c, s, marketId, px.mid);
        // 4. One order towards the target.
        if (!waiting && s.status == Status.Active && s.todo && block.timestamp >= s.actAt) {
            if (!read) pos = engine.getPosition(account, marketId);
            _act(id, c, s, account, marketId, pos, px);
        }
        st.state = s;
    }

    /// @dev Returns true when the pending order is gone (settled, or cancelled here), false while it waits.
    function _clearPending(uint256 id, Config memory c, State memory s, address account, Position memory pos)
        private
        returns (bool)
    {
        uint256 orderId = s.pendingOrder;
        if (engine.getOrder(orderId).trader == address(0)) {
            _settled(id, c, s, pos);
            return true;
        }
        if (block.timestamp < uint256(s.pendingSince) + c.interval || block.timestamp < s.actAt) return false;
        // Still on the book a full interval later: the price ran through its bound. Cancel; the step is retried.
        uint256 gasBefore = gasleft();
        if (gasBefore < ACTION_GAS) revert InsufficientGas();
        try AgentAccount(account).cancelOrder(orderId) {
            emit OrderDropped(id, orderId);
            s.pendingOrder = 0;
            s.pendingSince = 0;
            return true;
        } catch {
            if (gasleft() <= gasBefore / 16) revert InsufficientGas();
            _refused(id, c, s, Action.Cancel);
            return false;
        }
    }

    /// @dev Its order left the book (filled, or cancelled or dropped by the engine). When the position does not
    ///      show it took effect, something else intervened: trend and mean reversion end the step there (the
    ///      next signal starts a new one); a copy re-checks at its next sample.
    function _settled(uint256 id, Config memory c, State memory s, Position memory pos) private {
        Side have = _sideOf(pos);
        Action a = s.pendingAction;
        bool filled = true;
        if (a == Action.Open || a == Action.Increase) {
            filled = have == s.pendingSide;
            if (filled) s.holding = have;
        } else if (a == Action.Close) {
            filled = have == Side.Flat;
            if (filled) s.holding = Side.Flat;
        }
        if (!filled && c.kind != Kind.Copy) s.todo = false;
        emit OrderSettled(id, s.pendingOrder, filled);
        s.pendingOrder = 0;
        s.pendingSince = 0;
    }

    function _checkExit(uint256 id, Config memory c, State memory s, bytes32 marketId, Position memory pos) private {
        if (s.holding == Side.Flat || _sideOf(pos) == s.holding) return;
        emit ExitedElsewhere(id, s.holding);
        if (c.kind == Kind.Copy) {
            // The leader's position it was following is not followed again; a new one (or an addition to it,
            // which restarts its open time) is.
            Position memory l = engine.getPosition(c.leader, marketId);
            s.blockedAt = l.trader == address(0) ? 0 : l.openedAt;
        }
        s.holding = Side.Flat;
        s.todo = false;
    }

    function _sample(uint256 id, Config memory c, State memory s, bytes32 marketId, uint256 mid) private {
        s.nextAt = uint64(block.timestamp) + c.interval;
        s.lastPrice = uint128(mid);
        Side want = s.target;
        uint256 a;
        uint256 b;
        if (c.kind == Kind.Trend) {
            a = s.samples == 0 ? mid : _ema(s.emaFast, mid, c.period);
            b = s.samples == 0 ? mid : _ema(s.emaSlow, mid, c.slowPeriod);
            s.emaFast = uint128(a);
            s.emaSlow = uint128(b);
            if (s.samples < type(uint32).max) ++s.samples;
            // Acts once the slow EMA has seen a full period; inside the hysteresis band the target holds.
            if (s.samples >= c.slowPeriod) {
                if (a * BPS > b * (BPS + c.bandBps)) want = Side.Long;
                else if (a * BPS < b * (BPS - c.bandBps)) want = c.allowShort ? Side.Short : Side.Flat;
            }
        } else if (c.kind == Kind.MeanRevert) {
            // The price is compared with the EMA of the samples before it, then folded in.
            a = s.emaFast;
            if (s.samples >= c.period) {
                uint256 p = mid * BPS;
                if (p < a * (BPS - c.bandBps)) want = Side.Long;
                else if (p > a * (BPS + c.bandBps)) want = c.allowShort ? Side.Short : Side.Flat;
                else if (want == Side.Long && p >= a * (BPS - c.exitBps)) want = Side.Flat;
                else if (want == Side.Short && p <= a * (BPS + c.exitBps)) want = Side.Flat;
            }
            b = s.samples == 0 ? mid : _ema(a, mid, c.period);
            s.emaFast = uint128(b);
            if (s.samples < type(uint32).max) ++s.samples;
        } else {
            Position memory l = engine.getPosition(c.leader, marketId);
            Side side = _sideOf(l);
            if (side == Side.Short && !c.allowShort) side = Side.Flat;
            if (s.blockedAt != 0 && side != Side.Flat && l.openedAt == s.blockedAt) {
                // Still the leader's trade the copy was closed out of: sit it out.
                emit Sampled(id, mid, l.size, 0, s.target);
                return;
            }
            s.blockedAt = 0;
            uint256 size = side == Side.Flat ? 0 : Math.min((l.size * c.ratioBps) / BPS, c.maxSize);
            if (size == 0) side = Side.Flat;
            want = side;
            s.targetSize = uint96(size);
            // Every sample re-checks the copy's size against the leader's.
            s.todo = true;
            a = l.size;
            b = size;
        }
        if (want != s.target) {
            emit TargetChanged(id, s.target, want);
            s.target = want;
            s.todo = true;
        }
        emit Sampled(id, mid, a, b, want);
    }

    /// @dev One order towards the target: close what is on the wrong side (a flip opens on a later poke), open
    ///      what is missing, resize a copy that is more than {RESIZE_BPS} off its target.
    function _act(
        uint256 id,
        Config memory c,
        State memory s,
        address account,
        bytes32 marketId,
        Position memory pos,
        OraclePrice memory px
    ) private {
        Side have = _sideOf(pos);
        Side want = s.target;
        if (have != Side.Flat && have != want) {
            _close(id, c, s, account, marketId, pos.isLong, 0, Action.Close, px);
            return;
        }
        if (want == Side.Flat) {
            s.todo = false;
            return;
        }
        bool isLong = want == Side.Long;
        uint256 cap = uint256(c.margin) * c.leverage;
        if (c.kind != Kind.Copy) {
            if (have == want) {
                s.holding = want;
                s.todo = false;
                return;
            }
            _open(id, c, s, account, marketId, isLong, c.margin, cap, Action.Open, px);
            return;
        }
        uint256 held = have == Side.Flat ? 0 : pos.size;
        uint256 target = s.targetSize;
        uint256 off = held > target ? held - target : target - held;
        if (off * BPS <= target * RESIZE_BPS) {
            if (have != Side.Flat) s.holding = want;
            s.todo = false;
            return;
        }
        if (held > target) {
            _close(id, c, s, account, marketId, isLong, held - target, Action.Reduce, px);
            return;
        }
        uint256 size = Math.min(target - held, cap);
        uint256 margin = Math.max(Math.ceilDiv(size, c.leverage), engine.minMargin());
        if (size < margin) {
            // Too small to trade (under the engine's minimum margin at 1x).
            s.todo = false;
            return;
        }
        _open(id, c, s, account, marketId, isLong, margin, size, have == Side.Flat ? Action.Open : Action.Increase, px);
    }

    function _open(
        uint256 id,
        Config memory c,
        State memory s,
        address account,
        bytes32 marketId,
        bool isLong,
        uint256 margin,
        uint256 size,
        Action action,
        OraclePrice memory px
    ) private {
        // Marketable: a long accepts up to the ask plus the slippage, a short down to the bid minus it.
        uint256 ref = isLong ? px.ask : px.bid;
        uint256 trigger = isLong ? (ref * (BPS + c.maxSlippageBps)) / BPS : (ref * (BPS - c.maxSlippageBps)) / BPS;
        LimitParams memory p = LimitParams({
            priceId: marketId,
            isLong: isLong,
            margin: margin,
            size: size,
            triggerPrice: trigger,
            takeProfit: 0,
            stopLoss: 0,
            stopEntry: false
        });
        // Brackets on a new position only, from the price it should fill at; an increase keeps the position's.
        if (action == Action.Open) {
            if (c.takeProfitBps != 0) {
                p.takeProfit = isLong ? (ref * (BPS + c.takeProfitBps)) / BPS : (ref * (BPS - c.takeProfitBps)) / BPS;
            }
            if (c.stopLossBps != 0) {
                p.stopLoss = isLong ? (ref * (BPS - c.stopLossBps)) / BPS : (ref * (BPS + c.stopLossBps)) / BPS;
            }
        }
        uint256 gasBefore = gasleft();
        if (gasBefore < ACTION_GAS) revert InsufficientGas();
        try AgentAccount(account).createLimitOrder(p) returns (uint256 orderId) {
            _placed(id, s, action, isLong ? Side.Long : Side.Short, orderId, size, trigger);
        } catch {
            if (gasleft() <= gasBefore / 16) revert InsufficientGas();
            _refused(id, c, s, action);
        }
    }

    /// @dev A keeper-executed close of `size` (0: all) of the position, accepting down to the bid minus the
    ///      slippage (a long) or up to the ask plus it (a short).
    function _close(
        uint256 id,
        Config memory c,
        State memory s,
        address account,
        bytes32 marketId,
        bool isLong,
        uint256 size,
        Action action,
        OraclePrice memory px
    ) private {
        uint256 worst = isLong ? (px.bid * (BPS - c.maxSlippageBps)) / BPS : (px.ask * (BPS + c.maxSlippageBps)) / BPS;
        uint256 gasBefore = gasleft();
        if (gasBefore < ACTION_GAS) revert InsufficientGas();
        try AgentAccount(account).setTriggerOrder(marketId, OrderType.Close, worst, size) returns (uint256 orderId) {
            _placed(id, s, action, isLong ? Side.Long : Side.Short, orderId, size, worst);
        } catch {
            if (gasleft() <= gasBefore / 16) revert InsufficientGas();
            _refused(id, c, s, action);
        }
    }

    function _placed(uint256 id, State memory s, Action action, Side side, uint256 orderId, uint256 size, uint256 price)
        private
    {
        s.pendingOrder = uint64(orderId);
        s.pendingSince = uint64(block.timestamp);
        s.pendingAction = action;
        s.pendingSide = side;
        s.refusals = 0;
        if (s.actions < type(uint32).max) ++s.actions;
        emit OrderPlaced(id, action, orderId, size, price);
    }

    /// @dev The step is tried again after an interval; three refusals in a row pause the strategy.
    function _refused(uint256 id, Config memory c, State memory s, Action action) private {
        emit ActionRefused(id, action);
        s.actAt = uint64(block.timestamp) + c.interval;
        if (++s.refusals >= MAX_REFUSALS) {
            s.status = Status.Paused;
            emit StrategyPaused(id, true);
        }
    }

    /// @dev Cancels an open order of its own still on the book. If the account refuses (this contract's approval
    ///      revoked), the order stays and settles as usual. With the gas floor, a wallet's estimate cannot settle
    ///      on a cancel that fails for want of gas.
    function _dropOpenOrder(uint256 id, address account, State memory s) private {
        if (s.pendingOrder == 0 || (s.pendingAction != Action.Open && s.pendingAction != Action.Increase)) return;
        uint256 orderId = s.pendingOrder;
        if (engine.getOrder(orderId).trader == address(0)) return;
        uint256 gasBefore = gasleft();
        if (gasBefore < ACTION_GAS) revert InsufficientGas();
        try AgentAccount(account).cancelOrder(orderId) {
            emit OrderDropped(id, orderId);
            s.pendingOrder = 0;
            s.pendingSince = 0;
        } catch {
            if (gasleft() <= gasBefore / 16) revert InsufficientGas();
        }
    }

    // ───────────────────────────── Internal ─────────────────────────────

    /// @dev One EMA step in 1e18 fixed point: `alpha = 2 / (period + 1)`, rounded down, and
    ///      `ema' = (price * alpha + ema * (1 - alpha))`, rounded down. A price equal to the EMA leaves it exactly
    ///      where it is; otherwise a step comes out at most `|price - ema| / 1e18 + 1` wei away from the exact
    ///      value (alpha is short by under 1e-18), a relative error under 1e-18, far below any band.
    function _ema(uint256 ema, uint256 price, uint256 period) private pure returns (uint256) {
        uint256 alpha = (2 * WAD) / (period + 1);
        return (price * alpha + ema * (WAD - alpha)) / WAD;
    }

    function _sideOf(Position memory pos) private pure returns (Side) {
        if (pos.trader == address(0)) return Side.Flat;
        return pos.isLong ? Side.Long : Side.Short;
    }

    function _key(address account, bytes32 marketId) private pure returns (bytes32) {
        return keccak256(abi.encode(account, marketId));
    }

    function _validate(address account, bytes32 marketId, Config calldata c) private view {
        if (
            c.interval < MIN_INTERVAL || c.interval > MAX_INTERVAL || c.maxSlippageBps == 0
                || c.maxSlippageBps > MAX_SLIPPAGE_BPS || c.leverage == 0 || c.margin < engine.minMargin()
        ) revert InvalidStrategy();
        Market memory m = engine.getMarket(marketId);
        if (
            m.lastFundingTime == 0 || !m.enabled || c.leverage > m.maxLeverage
                || (m.expiry != 0 && block.timestamp >= m.expiry)
        ) revert InvalidStrategy();
        if (c.stopLossBps != 0 && (c.stopLossBps < MIN_BRACKET_BPS || c.stopLossBps > MAX_BRACKET_BPS)) {
            revert InvalidStrategy();
        }
        // A take-profit inside the slippage bound would sit on the wrong side of the order's own trigger.
        if (
            c.takeProfitBps != 0
                && (c.takeProfitBps <= c.maxSlippageBps
                    || c.takeProfitBps < MIN_BRACKET_BPS
                    || c.takeProfitBps > MAX_BRACKET_BPS)
        ) revert InvalidStrategy();
        if (c.kind == Kind.Trend) {
            if (
                c.period < MIN_PERIOD || c.slowPeriod > MAX_PERIOD || c.period >= c.slowPeriod
                    || c.bandBps > MAX_BAND_BPS || c.exitBps != 0 || c.ratioBps != 0 || c.leader != address(0)
                    || c.maxSize != 0
            ) revert InvalidStrategy();
        } else if (c.kind == Kind.MeanRevert) {
            if (
                c.period < MIN_PERIOD || c.period > MAX_PERIOD || c.slowPeriod != 0 || c.bandBps == 0
                    || c.bandBps > MAX_BAND_BPS || c.exitBps >= c.bandBps || c.ratioBps != 0 || c.leader != address(0)
                    || c.maxSize != 0
            ) revert InvalidStrategy();
        } else {
            if (
                c.leader == address(0) || c.leader == account || c.ratioBps == 0 || c.ratioBps > MAX_RATIO_BPS
                    || c.maxSize == 0 || c.period != 0 || c.slowPeriod != 0 || c.bandBps != 0 || c.exitBps != 0
            ) revert InvalidStrategy();
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
}
