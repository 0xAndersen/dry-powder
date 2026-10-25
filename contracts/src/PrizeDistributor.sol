// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/// @title PrizeDistributor
/// @notice Season prizes (roadmap item 81). Anyone can fund a season's pool in USDC; once the season is over the
///         owner publishes its results as a Merkle root of (account, amount) pairs, computed off-chain by the
///         indexer from the season's leaderboard, and each winner (or anyone on their behalf) claims with a
///         proof. Prizes always go to the account that won, so an agent account's prize lands in the account,
///         where only its owner can withdraw it. What is left unclaimed after the deadline can be moved on to
///         another season.
/// @dev Leaves are `keccak256(bytes.concat(keccak256(abi.encode(account, amount))))`, the double hash of
///      OpenZeppelin's StandardMerkleTree, with pairs sorted when hashing (MerkleProof). A season's results can be
///      published once; the total they allocate must be funded.
contract PrizeDistributor is Ownable2Step {
    using SafeERC20 for IERC20;

    struct Season {
        uint256 funded; // USDC put in, including what was rolled over into it
        uint256 allocated; // what the published results pay in total
        uint256 claimed;
        bytes32 root; // zero until the results are published
        uint64 claimDeadline;
        bool closed; // unclaimed prizes moved out after the deadline
    }

    IERC20 public immutable usdc;

    mapping(uint256 seasonId => Season) public seasons;
    mapping(uint256 seasonId => mapping(address account => bool)) public claimed;

    event SeasonFunded(uint256 indexed seasonId, address indexed from, uint256 amount);
    event ResultsPublished(uint256 indexed seasonId, bytes32 root, uint256 allocated, uint64 claimDeadline);
    event PrizeClaimed(uint256 indexed seasonId, address indexed account, uint256 amount);
    event SeasonClosed(uint256 indexed seasonId, uint256 unclaimed, uint256 toSeason);

    error ZeroAddress();
    error InvalidParam();
    error ResultsAlreadyPublished();
    error ResultsNotPublished();
    error Underfunded();
    error AlreadyClaimed();
    error InvalidProof();
    error ClaimWindowClosed();
    error ClaimWindowOpen();

    constructor(IERC20 usdc_, address owner_) Ownable(owner_) {
        if (address(usdc_) == address(0)) revert ZeroAddress();
        usdc = usdc_;
    }

    /// @notice Adds `amount` USDC (approve first) to season `seasonId`'s pool. Anyone may fund any open season.
    function fund(uint256 seasonId, uint256 amount) external {
        Season storage s = seasons[seasonId];
        if (amount == 0 || s.closed) revert InvalidParam();
        s.funded += amount;
        emit SeasonFunded(seasonId, msg.sender, amount);
        usdc.safeTransferFrom(msg.sender, address(this), amount);
    }

    /// @notice Publishes season `seasonId`'s results: `root` over (account, amount) leaves allocating `allocated`
    ///         in total, claimable until `claimDeadline`. Once per season.
    function publishResults(uint256 seasonId, bytes32 root, uint256 allocated, uint64 claimDeadline)
        external
        onlyOwner
    {
        Season storage s = seasons[seasonId];
        if (s.root != bytes32(0)) revert ResultsAlreadyPublished();
        if (root == bytes32(0) || allocated == 0 || claimDeadline <= block.timestamp || s.closed) {
            revert InvalidParam();
        }
        if (allocated > s.funded) revert Underfunded();
        s.root = root;
        s.allocated = allocated;
        s.claimDeadline = claimDeadline;
        emit ResultsPublished(seasonId, root, allocated, claimDeadline);
    }

    /// @notice Pays `account` its prize of `amount` for season `seasonId`. Anyone may submit the claim; the prize
    ///         goes to `account` only.
    function claim(uint256 seasonId, address account, uint256 amount, bytes32[] calldata proof) external {
        Season storage s = seasons[seasonId];
        if (s.root == bytes32(0)) revert ResultsNotPublished();
        if (block.timestamp > s.claimDeadline || s.closed) revert ClaimWindowClosed();
        if (claimed[seasonId][account]) revert AlreadyClaimed();
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, amount))));
        if (!MerkleProof.verifyCalldata(proof, s.root, leaf)) revert InvalidProof();
        claimed[seasonId][account] = true;
        s.claimed += amount;
        emit PrizeClaimed(seasonId, account, amount);
        usdc.safeTransfer(account, amount);
    }

    /// @notice After the claim deadline, moves what is left of season `seasonId` (unclaimed prizes and anything
    ///         funded beyond the results) into season `toSeason`. With no results ever published, the owner may do
    ///         it at any time (a season that was called off).
    function closeSeason(uint256 seasonId, uint256 toSeason) external onlyOwner {
        Season storage s = seasons[seasonId];
        if (s.closed || toSeason == seasonId) revert InvalidParam();
        if (s.root != bytes32(0) && block.timestamp <= s.claimDeadline) revert ClaimWindowOpen();
        Season storage next = seasons[toSeason];
        if (next.closed || next.root != bytes32(0)) revert InvalidParam();
        uint256 left = s.funded - s.claimed;
        s.closed = true;
        next.funded += left;
        emit SeasonClosed(seasonId, left, toSeason);
    }

    /// @notice Whether `account` can still claim `amount` for season `seasonId` with `proof`.
    function canClaim(uint256 seasonId, address account, uint256 amount, bytes32[] calldata proof)
        external
        view
        returns (bool)
    {
        Season storage s = seasons[seasonId];
        if (s.root == bytes32(0) || s.closed || block.timestamp > s.claimDeadline || claimed[seasonId][account]) {
            return false;
        }
        return
            MerkleProof.verifyCalldata(proof, s.root, keccak256(bytes.concat(keccak256(abi.encode(account, amount)))));
    }
}
