// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {PerpEngine} from "./PerpEngine.sol";
import {OpenParams, LimitParams, OrderType} from "./Types.sol";

/// @title AgentAccount
/// @notice A trading account owned by one wallet that AI agents (or any bot) can trade from but never withdraw
///         from. The owner funds it with USDC and approves agent keys with a policy: expiry, maximum leverage and
///         maximum margin per order, optionally restricted to a list of markets. Agents can open, close, place and
///         cancel orders and set take-profit/stop-loss. Everything the engine pays goes back to this account, and
///         only the owner can move tokens out.
/// @dev Idea taken from Nexus (agent keys may place and cancel orders, never withdraw), rebuilt for Dry Powder's
///      on-chain engine as a thin forwarding account: the engine sees this contract as the trader.
///      What an agent can still do with a bad policy: lose the account's money trading, and earn the engine's
///      execution fee by executing the account's own triggered orders from its own address. Size the policy for
///      that.
contract AgentAccount {
    using SafeERC20 for IERC20;

    /// @param expiry Unix time after which the agent can no longer trade; 0 means not approved.
    /// @param maxLeverage Largest `size / margin` the agent may open, in whole multiples.
    /// @param maxMargin Largest margin per position or order, in 6-decimal USDC.
    struct Policy {
        uint64 expiry;
        uint16 maxLeverage;
        uint128 maxMargin;
    }

    IERC20 public immutable usdc;
    PerpEngine public immutable engine;
    address public immutable owner;

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

    constructor(IERC20 usdc_, PerpEngine engine_, address owner_) {
        if (address(usdc_) == address(0) || address(engine_) == address(0) || owner_ == address(0)) {
            revert ZeroAddress();
        }
        usdc = usdc_;
        engine = engine_;
        owner = owner_;
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

    /// @notice Approves `agent` (or replaces its policy). Use {revokeAgent} to remove it.
    function setAgent(address agent, uint64 expiry, uint16 maxLeverage, uint128 maxMargin) external onlyOwner {
        if (agent == address(0)) revert ZeroAddress();
        if (agent == owner || expiry <= block.timestamp || maxLeverage == 0 || maxMargin == 0) revert InvalidPolicy();
        agents[agent] = Policy(expiry, maxLeverage, maxMargin);
        emit AgentSet(agent, expiry, maxLeverage, maxMargin);
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

    /// @notice {PerpEngine.openPosition} for this account, within the caller's policy.
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
    ///         the current price is a keeper-filled market order.
    function createLimitOrder(LimitParams calldata p) external onlyTrader returns (uint256 orderId) {
        _checkPolicy(p.priceId, p.margin, p.size);
        orderId = engine.createLimitOrder(p);
    }

    function closePosition(bytes32 marketId, uint256 acceptablePrice, bytes[] calldata priceUpdate)
        external
        payable
        onlyTrader
    {
        engine.closePosition{value: msg.value}(marketId, acceptablePrice, priceUpdate);
    }

    /// @notice Take-profit, stop-loss or keeper-executed close for this account's position in `marketId`.
    function setTriggerOrder(bytes32 marketId, OrderType orderType, uint256 triggerPrice)
        external
        onlyTrader
        returns (uint256 orderId)
    {
        orderId = engine.setTriggerOrder(marketId, orderType, triggerPrice);
    }

    function cancelOrder(uint256 orderId) external onlyTrader {
        engine.cancelOrder(orderId);
    }

    /// @notice Pulls payouts the engine could not deliver earlier into this account (never anywhere else).
    function claim() external onlyTrader {
        engine.claim();
    }

    // ───────────────────────────── Internal ─────────────────────────────

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
        if (accountOf[owner] != address(0)) revert AccountExists();
        account = address(new AgentAccount{salt: bytes32(uint256(uint160(owner)))}(usdc, engine, owner));
        accountOf[owner] = account;
        emit AccountCreated(owner, account);
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
}
