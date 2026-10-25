// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {EnumerableSet} from "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";
import {AgentAccount, AgentAccountFactory} from "./AgentAccount.sol";

/// @title AgentRegistry
/// @notice A directory of trading agents: the owner of an {AgentAccount} lists it as an agent with a name, a short
///         description, a kind label ("trend", "copy", "llm", …) and optionally a URI with more about it, so the
///         app can show who is trading and what they run. Listing is a label, not a permission: it gives nobody any
///         power over the account, and the account trades the same whether listed or not.
/// @dev Only accounts the factory deployed can be listed, and only by their owner (fixed at creation), so a
///      listing cannot be made for someone else's account or for a look-alike contract.
///      The URI can point to an ERC-8004 agent card. Arc Testnet has the ERC-8004 identity registry at
///      0x8004A818BFB912233c491871b3d84c89A494BD9e (docs/ARC_NOTES.md); registering there as well is optional and
///      nothing here checks or depends on it.
contract AgentRegistry {
    using EnumerableSet for EnumerableSet.AddressSet;

    struct Agent {
        address owner;
        uint64 registeredAt;
        uint64 updatedAt;
        string name;
        string description;
        string kind;
        string uri;
    }

    uint256 public constant MAX_NAME_BYTES = 48;
    uint256 public constant MAX_DESCRIPTION_BYTES = 280;
    uint256 public constant MAX_KIND_BYTES = 32;
    uint256 public constant MAX_URI_BYTES = 256;

    AgentAccountFactory public immutable factory;

    mapping(address account => Agent) private _agents;
    EnumerableSet.AddressSet private _accounts;

    event AgentRegistered(
        address indexed account, address indexed owner, string name, string description, string kind, string uri
    );
    event AgentUpdated(address indexed account, string name, string description, string kind, string uri);
    event AgentUnregistered(address indexed account);

    error NotOwner();
    /// @notice Name empty or over 48 bytes, description over 280, kind empty or over 32, or URI over 256.
    error InvalidAgent();
    error AlreadyRegistered();
    error NotRegistered();

    constructor(AgentAccountFactory factory_) {
        factory = factory_;
    }

    /// @notice Lists `account` as an agent. Its owner only.
    function register(
        AgentAccount account,
        string calldata name,
        string calldata description,
        string calldata kind,
        string calldata uri
    ) external {
        address owner = _owner(account);
        if (_accounts.contains(address(account))) revert AlreadyRegistered();
        _check(name, description, kind, uri);
        _accounts.add(address(account));
        _agents[address(account)] = Agent({
            owner: owner,
            registeredAt: uint64(block.timestamp),
            updatedAt: uint64(block.timestamp),
            name: name,
            description: description,
            kind: kind,
            uri: uri
        });
        emit AgentRegistered(address(account), owner, name, description, kind, uri);
    }

    /// @notice Replaces the listing's name, description, kind and URI. Its owner only.
    function update(
        AgentAccount account,
        string calldata name,
        string calldata description,
        string calldata kind,
        string calldata uri
    ) external {
        _owner(account);
        if (!_accounts.contains(address(account))) revert NotRegistered();
        _check(name, description, kind, uri);
        Agent storage a = _agents[address(account)];
        a.updatedAt = uint64(block.timestamp);
        a.name = name;
        a.description = description;
        a.kind = kind;
        a.uri = uri;
        emit AgentUpdated(address(account), name, description, kind, uri);
    }

    /// @notice Removes the listing. Its owner only.
    function unregister(AgentAccount account) external {
        _owner(account);
        if (!_accounts.remove(address(account))) revert NotRegistered();
        delete _agents[address(account)];
        emit AgentUnregistered(address(account));
    }

    function isAgent(address account) external view returns (bool) {
        return _accounts.contains(account);
    }

    /// @notice The listing of `account` (all fields empty when it has none).
    function getAgent(address account) external view returns (Agent memory) {
        return _agents[account];
    }

    function agentCount() external view returns (uint256) {
        return _accounts.length();
    }

    /// @notice A page of listings. The order is not stable across unregistrations.
    function getAgents(uint256 offset, uint256 limit)
        external
        view
        returns (address[] memory accounts, Agent[] memory agents)
    {
        uint256 n = _accounts.length();
        uint256 end = offset + limit > n ? n : offset + limit;
        uint256 len = end > offset ? end - offset : 0;
        accounts = new address[](len);
        agents = new Agent[](len);
        for (uint256 i; i < len; ++i) {
            address a = _accounts.at(offset + i);
            accounts[i] = a;
            agents[i] = _agents[a];
        }
    }

    /// @dev The caller must be the owner of `account`, an account the factory deployed.
    function _owner(AgentAccount account) private view returns (address owner) {
        owner = account.owner();
        if (msg.sender != owner || factory.accountOf(owner) != address(account)) revert NotOwner();
    }

    function _check(string calldata name, string calldata description, string calldata kind, string calldata uri)
        private
        pure
    {
        uint256 nameLen = bytes(name).length;
        uint256 kindLen = bytes(kind).length;
        if (
            nameLen == 0 || nameLen > MAX_NAME_BYTES || bytes(description).length > MAX_DESCRIPTION_BYTES
                || kindLen == 0 || kindLen > MAX_KIND_BYTES || bytes(uri).length > MAX_URI_BYTES
        ) revert InvalidAgent();
    }
}
