// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Multicall} from "@openzeppelin/contracts/utils/Multicall.sol";
import {PerpEngine} from "./PerpEngine.sol";
import {OpenParams, LimitParams, OrderType} from "./Types.sol";

/// @title AgentAccount
/// @notice A trading account owned by one wallet that AI agents (or any bot) can trade from but never withdraw
///         from. The owner funds it with USDC and approves agent keys with a policy: expiry, maximum leverage and
///         maximum margin per call, optionally restricted to a list of markets. Agents can open and add to
///         positions, close them in whole or in part, add margin, place and cancel orders and set
///         take-profit/stop-loss. Everything the engine pays goes back to this account, and only the owner can
///         move tokens out.
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
    PerpEngine public immutable engine;
    address public immutable owner;
    /// @dev Whoever deployed the account (the factory): it alone may call {initAgent}, and only while
    ///      `_initOpen` is set, which is in the deployment transaction.
    address private immutable _deployer;
    bool private transient _initOpen;

    mapping(address agent => Policy) public agents;
    /// @notice When true, agents may only open in markets marked in {marketAllowed}. The owner is never restricted.
    bool public restrictMarkets;
    mapping(bytes32 marketId => bool) public marketAllowed;

    event AgentSet(address indexed agent, uint64 expiry, uint16 maxLeverage, uint128 maxMargin);
    event AgentRevoked(address indexed agent);
    event MarketsRestricted(bool restricted);
    event MarketAllowed(bytes32 indexed marketId, bool allowed);
    event Withdrawn(address indexed token, address indexed to, uint256 amount);

    error NotOwner();
    error NotAuthorized();
    error ZeroAddress();
    error InvalidPolicy();
    error LeverageCapExceeded();
    error MarginCapExceeded();
    error MarketNotAllowed();
    error GasTopUpFailed();

    constructor(IERC20 usdc_, PerpEngine engine_, address owner_) {
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
    function setAgent(address agent, uint64 expiry, uint16 maxLeverage, uint128 maxMargin)
        external
        payable
        onlyOwner
    {
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
        emit AgentRevoked(agent);
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

    /// @notice {PerpEngine.openPosition} for this account, within the caller's policy. Adds to a position on the
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

    /// @notice {PerpEngine.createLimitOrder} for this account, within the caller's policy. A trigger at or through
    ///         the current price is a keeper-filled market order; `stopEntry` makes it a breakout order.
    function createLimitOrder(LimitParams calldata p) external onlyTrader returns (uint256 orderId) {
        _checkPolicy(p.priceId, p.margin, p.size);
        orderId = engine.createLimitOrder(p);
    }

    /// @notice {PerpEngine.closePosition} for this account: `size` 0 closes everything.
    function closePosition(bytes32 marketId, uint256 size, uint256 acceptablePrice, bytes[] calldata priceUpdate)
        external
        payable
        onlyTrader
    {
        engine.closePosition{value: msg.value}(marketId, size, acceptablePrice, priceUpdate);
    }

    /// @notice {PerpEngine.addMargin} for this account. For an agent, `amount` counts against its margin cap and
    ///         the market list.
    function addMargin(bytes32 marketId, uint256 amount) external onlyTrader {
        _checkPolicy(marketId, amount, 0);
        engine.addMargin(marketId, amount);
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

    /// @dev Agents only: `margin` within the cap, `size` within the leverage cap, the market allowed.
    function _checkPolicy(bytes32 marketId, uint256 margin, uint256 size) internal view {
        if (msg.sender == owner) return;
        Policy memory p = agents[msg.sender];
        if (margin > p.maxMargin) revert MarginCapExceeded();
        if (size > margin * p.maxLeverage) revert LeverageCapExceeded();
        if (restrictMarkets && !marketAllowed[marketId]) revert MarketNotAllowed();
    }
}

/// @title AgentAccountFactory
/// @notice Deploys one {AgentAccount} per owner at a predictable address.
contract AgentAccountFactory {
    IERC20 public immutable usdc;
    PerpEngine public immutable engine;

    mapping(address owner => address account) public accountOf;

    event AccountCreated(address indexed owner, address indexed account);

    error AccountExists();

    constructor(IERC20 usdc_, PerpEngine engine_) {
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
