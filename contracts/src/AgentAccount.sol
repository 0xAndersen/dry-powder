// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Multicall} from "@openzeppelin/contracts/utils/Multicall.sol";
import {IEngine} from "./interfaces/IEngine.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {OpenParams, LimitParams, OrderType, Position} from "./Types.sol";

/// @title AgentAccount
/// @notice A trading account owned by one wallet that AI agents (or any bot) can trade from but never withdraw
///         from. The owner funds it with USDC and approves agent keys with a policy: expiry, maximum leverage and
///         maximum margin per call, optionally a daily margin budget and a list of markets. Agents can open and add
///         to positions, close them in whole or in part, add or take out margin, place, expire and cancel orders
///         and set take-profit/stop-loss. Everything the engine pays goes back to this account, and only the owner
///         can move tokens out.
/// @dev Idea taken from Nexus (agent keys may place and cancel orders, never withdraw), rebuilt for Dry Powder's
///      on-chain engine as a thin forwarding account: the engine sees this contract as the trader.
///      {multicall} batches calls atomically (a ladder of orders, cancel-all, close-all). Each call is a
///      delegatecall to this contract, so it runs with the original caller as `msg.sender` and passes the same
///      access and policy checks as when made on its own; `multicall` is not payable, so no call in a batch
///      can spend `msg.value`.
///      What an agent can still do with a bad policy: lose the account's money trading, build a position larger
///      than its per-call margin cap through several calls, and earn the engine's execution fee by executing the
///      account's own triggered orders from its own address. Size the policy for that.
contract AgentAccount is Multicall {
    using SafeERC20 for IERC20;

    /// @param expiry Unix time after which the agent can no longer trade; 0 means not approved.
    /// @param maxLeverage Largest `size / margin` the agent may open, in whole multiples.
    /// @param maxMargin Largest margin per call (an open, an order, or margin added), in 6-decimal USDC.
    struct Policy {
        uint64 expiry;
        uint16 maxLeverage;
        uint128 maxMargin;
    }

    IERC20 public immutable usdc;
    IEngine public immutable engine;
    address public immutable owner;
    /// @dev Whoever deployed the account (the factory): it alone may call {initAgent}, and only while
    ///      `_initOpen` is set, which is in the deployment transaction.
    address private immutable _deployer;
    bool private transient _initOpen;

    /// @param perDay Most margin (6-decimal USDC) the agent may commit per UTC day, summed over opens, orders and
    ///               margin added; 0 means no daily limit. Margin coming back from closes does not refill it, so it
    ///               bounds what the agent can lose in a day.
    /// @param day The UTC day `spent` counts (days since 1970-01-01).
    /// @param spent Margin committed so far that day.
    struct Budget {
        uint128 perDay;
        uint32 day;
        uint96 spent;
    }

    mapping(address agent => Policy) public agents;
    mapping(address agent => Budget) public budgets;
    /// @notice When true, agents may only open in markets marked in {marketAllowed}. The owner is never restricted.
    bool public restrictMarkets;
    mapping(bytes32 marketId => bool) public marketAllowed;

    event AgentSet(address indexed agent, uint64 expiry, uint16 maxLeverage, uint128 maxMargin);
    event AgentRevoked(address indexed agent);
    event AgentBudgetSet(address indexed agent, uint128 perDay);
    event MarketsRestricted(bool restricted);
    event MarketAllowed(bytes32 indexed marketId, bool allowed);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error NotOwner();
    error NotAuthorized();
    error ZeroAddress();
    error InvalidPolicy();
    error LeverageCapExceeded();
    error MarginCapExceeded();
    error DailyBudgetExceeded();
    error MarketNotAllowed();
    error GasTopUpFailed();

    constructor(IERC20 usdc_, IEngine engine_, address owner_) {
        if (address(usdc_) == address(0) || address(engine_) == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        usdc = usdc_;
        engine = engine_;
        owner = owner_;
        _deployer = msg.sender;
        _initOpen = true;
        usdc_.forceApprove(address(engine_), type(uint256).max);
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    /// @dev Owner, or an agent whose approval has not expired.
    modifier onlyTrader() {
        if (msg.sender != owner && agents[msg.sender].expiry <= block.timestamp) revert NotAuthorized();
        _;
    }

    // ───────────────────────────── Owner ─────────────────────────────

    /// @notice Approves `agent` (or replaces its policy) and forwards any `msg.value` to it as gas, so a session
    ///         key can be approved and funded in one transaction. Use {revokeAgent} to remove it.
    function setAgent(address agent, uint64 expiry, uint16 maxLeverage, uint128 maxMargin) external payable onlyOwner {
        _setAgent(agent, expiry, maxLeverage, maxMargin);
    }

    /// @notice {setAgent} for the deploying factory, in the deployment transaction only, so an account and its
    ///         first agent are set up in one transaction ({AgentAccountFactory.createAccountWithAgent}). Nobody
    ///         but the owner can set a policy afterwards.
    function initAgent(address agent, uint64 expiry, uint16 maxLeverage, uint128 maxMargin) external payable {
        if (msg.sender != _deployer || !_initOpen) revert NotOwner();
        _initOpen = false;
        _setAgent(agent, expiry, maxLeverage, maxMargin);
    }

    /// @notice Removes `agent` at once. Its open positions and orders stay; the owner can manage them.
    function revokeAgent(address agent) external onlyOwner {
        delete agents[agent];
        delete budgets[agent];
        emit AgentRevoked(agent);
    }

    /// @notice Caps the margin `agent` may commit per UTC day (0: no daily cap). Takes effect at once; what the
    ///         agent already committed today counts.
    function setAgentBudget(address agent, uint128 perDay) external onlyOwner {
        budgets[agent].perDay = perDay;
        emit AgentBudgetSet(agent, perDay);
    }

    /// @notice Records who referred this account on the engine (once): its fees get the referral discount and the
    ///         referrer earns a share of them. Owner only, since it is a lasting choice.
    function setReferrer(address referrer) external onlyOwner {
        engine.setReferrer(referrer);
    }

    function setRestrictMarkets(bool restricted) external onlyOwner {
        restrictMarkets = restricted;
        emit MarketsRestricted(restricted);
    }

    function setMarketAllowed(bytes32 marketId, bool allowed) external onlyOwner {
        marketAllowed[marketId] = allowed;
        emit MarketAllowed(marketId, allowed);
    }

    /// @notice Sends `amount` of `token` (USDC, the DRY loss rebates the engine mints here, anything else) to `to`.
    function withdraw(IERC20 token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        emit Withdrawn(address(token), to, amount);
        token.safeTransfer(to, amount);
    }

    // ───────────────────────────── Trading (owner or agent) ─────────────────────────────

    /// @notice {IEngine.openPosition} for this account, within the caller's policy. Adds to a position on the
    ///         same side; the policy applies to this call's margin and leverage.
    function openPosition(OpenParams calldata p, bytes[] calldata priceUpdate)
        external
        payable
        onlyTrader
        returns (bytes32 key)
    {
        _checkPolicy(p.priceId, p.margin, p.size);
        key = engine.openPosition{value: msg.value}(p, priceUpdate);
    }

    /// @notice {IEngine.createLimitOrder} for this account, within the caller's policy. A trigger at or through
    ///         the current price is a keeper-filled market order; `stopEntry` makes it a breakout order.
    function createLimitOrder(LimitParams calldata p) external onlyTrader returns (uint256 orderId) {
        _checkPolicy(p.priceId, p.margin, p.size);
        orderId = engine.createLimitOrder(p);
    }

    /// @notice {IEngine.createLimitOrderUntil}: {createLimitOrder} that stops being executable after `expiresAt`.
    function createLimitOrderUntil(LimitParams calldata p, uint64 expiresAt)
        external
        onlyTrader
        returns (uint256 orderId)
    {
        _checkPolicy(p.priceId, p.margin, p.size);
        orderId = engine.createLimitOrderUntil(p, expiresAt);
    }

    /// @notice {IEngine.setOrderExpiry} for one of this account's orders (0: never expires).
    function setOrderExpiry(uint256 orderId, uint64 expiresAt) external onlyTrader {
        engine.setOrderExpiry(orderId, expiresAt);
    }

    /// @notice {IEngine.closePosition} for this account: `size` 0 closes everything.
    function closePosition(bytes32 marketId, uint256 size, uint256 acceptablePrice, bytes[] calldata priceUpdate)
        external
        payable
        onlyTrader
    {
        engine.closePosition{value: msg.value}(marketId, size, acceptablePrice, priceUpdate);
    }

    /// @notice {IEngine.addMargin} for this account. For an agent, `amount` counts against its margin cap, its
    ///         daily budget and the market list.
    function addMargin(bytes32 marketId, uint256 amount) external onlyTrader {
        _checkPolicy(marketId, amount, 0);
        engine.addMargin(marketId, amount);
    }

    /// @notice {IEngine.removeMargin} for this account: the margin comes back here. For an agent, the position must
    ///         stay within its leverage cap afterwards.
    function removeMargin(bytes32 marketId, uint256 amount, bytes[] calldata priceUpdate) external payable onlyTrader {
        if (msg.sender != owner) {
            Position memory pos = engine.getPosition(address(this), marketId);
            if (pos.size > (pos.margin - Math.min(amount, pos.margin)) * agents[msg.sender].maxLeverage) {
                revert LeverageCapExceeded();
            }
        }
        engine.removeMargin{value: msg.value}(marketId, amount, priceUpdate);
    }

    /// @notice Take-profit, stop-loss or keeper-executed close of `size` (0: all) of this account's position in
    ///         `marketId`.
    function setTriggerOrder(bytes32 marketId, OrderType orderType, uint256 triggerPrice, uint256 size)
        external
        onlyTrader
        returns (uint256 orderId)
    {
        orderId = engine.setTriggerOrder(marketId, orderType, triggerPrice, size);
    }

    function cancelOrder(uint256 orderId) external onlyTrader {
        engine.cancelOrder(orderId);
    }

    /// @notice Pulls payouts the engine could not deliver earlier into this account (never anywhere else).
    function claim() external onlyTrader {
        engine.claim();
    }

    // ───────────────────────────── Internal ─────────────────────────────

    function _setAgent(address agent, uint64 expiry, uint16 maxLeverage, uint128 maxMargin) private {
        if (agent == address(0)) revert ZeroAddress();
        if (agent == owner || expiry <= block.timestamp || maxLeverage == 0 || maxMargin == 0) revert InvalidPolicy();
        agents[agent] = Policy(expiry, maxLeverage, maxMargin);
        emit AgentSet(agent, expiry, maxLeverage, maxMargin);
        if (msg.value != 0) {
            (bool ok,) = agent.call{value: msg.value}("");
            if (!ok) revert GasTopUpFailed();
        }
    }

    /// @dev Agents only: `margin` within the cap and the day's budget, `size` within the leverage cap, the market
    ///      allowed. Counts `margin` against the budget.
    function _checkPolicy(bytes32 marketId, uint256 margin, uint256 size) internal {
        if (msg.sender == owner) return;
        Policy memory p = agents[msg.sender];
        if (margin > p.maxMargin) revert MarginCapExceeded();
        if (size > margin * p.maxLeverage) revert LeverageCapExceeded();
        if (restrictMarkets && !marketAllowed[marketId]) revert MarketNotAllowed();
        Budget storage b = budgets[msg.sender];
        uint256 perDay = b.perDay;
        if (perDay == 0) return;
        uint32 today = uint32(block.timestamp / 1 days);
        uint256 spent = b.day == today ? b.spent + margin : margin;
        if (spent > perDay) revert DailyBudgetExceeded();
        b.day = today;
        b.spent = SafeCast.toUint96(spent);
    }
}

/// @title AgentAccountFactory
/// @notice Deploys one {AgentAccount} per owner at a predictable address.
contract AgentAccountFactory {
    IERC20 public immutable usdc;
    IEngine public immutable engine;

    mapping(address owner => address account) public accountOf;

    event AccountCreated(address indexed owner, address indexed account);

    error AccountExists();

    constructor(IERC20 usdc_, IEngine engine_) {
        usdc = usdc_;
        engine = engine_;
    }

    /// @notice Creates the account of `owner`. Anyone may call it for anyone; the owner is fixed at creation.
    function createAccount(address owner) external returns (address account) {
        account = _create(owner);
    }

    /// @notice Creates the caller's account (at the address `createAccount(msg.sender)` would give it) with
    ///         `agent` already approved under the given policy, and forwards `msg.value` to `agent` as gas: the
    ///         whole set-up of a session key in one transaction. The policy is validated as {AgentAccount.setAgent}
    ///         validates it.
    function createAccountWithAgent(address agent, uint64 expiry, uint16 maxLeverage, uint128 maxMargin)
        external
        payable
        returns (address account)
    {
        account = _create(msg.sender);
        AgentAccount(account).initAgent{value: msg.value}(agent, expiry, maxLeverage, maxMargin);
    }

    /// @notice Address the account of `owner` has, or will have once created.
    function predictAccount(address owner) external view returns (address) {
        bytes32 hash = keccak256(
            abi.encodePacked(
                bytes1(0xff),
                address(this),
                bytes32(uint256(uint160(owner))),
                keccak256(abi.encodePacked(type(AgentAccount).creationCode, abi.encode(usdc, engine, owner)))
            )
        );
        return address(uint160(uint256(hash)));
    }

    function _create(address owner) private returns (address account) {
        if (accountOf[owner] != address(0)) revert AccountExists();
        account = address(new AgentAccount{salt: bytes32(uint256(uint160(owner)))}(usdc, engine, owner));
        accountOf[owner] = account;
        emit AccountCreated(owner, account);
    }
}
