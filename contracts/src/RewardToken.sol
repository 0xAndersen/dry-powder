// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IHouseVault} from "./interfaces/IHouseVault.sol";
import {IRewardToken} from "./interfaces/IRewardToken.sol";

/// @title RewardToken (HOUSE)
/// @notice Loss-rebate token. PerpEngine mints 100 HOUSE per 1 USDC a trader loses. Staked HOUSE earns a pro-rata
///         share of the 15% of house inflows that HouseVault sets aside, claimable in USDC.
///
/// @dev Yield uses a cumulative yield-per-staked-token accumulator. The USDC itself stays in the vault
///      (`pendingStakerYield`); this contract only keeps the ledger and instructs the vault to pay on claim.
///      Rounding always favours the pool, so the sum of all claims can never exceed what was notified.
contract RewardToken is ERC20, IRewardToken {
    /// @notice HOUSE minted per whole USDC lost.
    uint256 public constant REBATE_RATE = 100;
    /// @dev 6-decimal USDC amount -> 18-decimal HOUSE amount at REBATE_RATE.
    uint256 internal constant USDC_TO_HOUSE = REBATE_RATE * 1e12;
    /// @dev Accumulator scale. Large enough that 1 micro-USDC over 100bn staked HOUSE still registers.
    uint256 internal constant ACC_PRECISION = 1e36;

    /// @notice The only minter.
    address public immutable engine;
    /// @notice Custodian and source of staker yield.
    IHouseVault public immutable vault;

    /// @notice Total HOUSE currently staked.
    uint256 public totalStaked;
    /// @notice Cumulative USDC yield per staked HOUSE unit, scaled by ACC_PRECISION.
    uint256 public accYieldPerToken;
    /// @notice Lifetime HOUSE minted as loss rebates.
    uint256 public totalRebatesMinted;
    /// @notice Lifetime USDC yield registered for stakers.
    uint256 public totalYieldNotified;
    /// @notice Lifetime USDC yield claimed by stakers.
    uint256 public totalYieldClaimed;

    /// @notice HOUSE staked by `account`.
    mapping(address account => uint256) public stakedBalance;
    mapping(address account => uint256) private _yieldPerTokenPaid;
    mapping(address account => uint256) private _accruedYield;

    event LossRebateMinted(address indexed trader, uint256 usdcLost, uint256 minted);
    event YieldNotified(uint256 amount, uint256 accYieldPerToken);
    event Staked(address indexed account, uint256 amount);
    event Unstaked(address indexed account, uint256 amount);
    event YieldClaimed(address indexed account, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error OnlyEngine();
    error OnlyVault();
    error NoStakers();
    error InsufficientStake();
    error NothingToClaim();

    constructor(address vault_, address engine_) ERC20("Arc House", "HOUSE") {
        if (vault_ == address(0) || engine_ == address(0)) revert ZeroAddress();
        vault = IHouseVault(vault_);
        engine = engine_;
    }

    // ───────────────────────────── Protocol hooks ─────────────────────────────

    /// @inheritdoc IRewardToken
    function mintLossRebate(address trader, uint256 usdcLost) external returns (uint256 minted) {
        if (msg.sender != engine) revert OnlyEngine();
        minted = usdcLost * USDC_TO_HOUSE;
        totalRebatesMinted += minted;
        _mint(trader, minted);
        emit LossRebateMinted(trader, usdcLost, minted);
    }

    /// @inheritdoc IRewardToken
    function notifyYield(uint256 amount) external {
        if (msg.sender != address(vault)) revert OnlyVault();
        uint256 staked = totalStaked;
        if (staked == 0) revert NoStakers();
        accYieldPerToken += Math.mulDiv(amount, ACC_PRECISION, staked);
        totalYieldNotified += amount;
        emit YieldNotified(amount, accYieldPerToken);
    }

    // ───────────────────────────── Staking ─────────────────────────────

    /// @notice Stake `amount` HOUSE to start earning USDC yield.
    function stake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        _settle(msg.sender);
        stakedBalance[msg.sender] += amount;
        totalStaked += amount;
        _transfer(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    /// @notice Unstake `amount` HOUSE. Yield earned so far stays claimable.
    function unstake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        if (amount > stakedBalance[msg.sender]) revert InsufficientStake();
        _settle(msg.sender);
        stakedBalance[msg.sender] -= amount;
        totalStaked -= amount;
        _transfer(address(this), msg.sender, amount);
        emit Unstaked(msg.sender, amount);
    }

    /// @notice Claim all USDC yield earned by the caller.
    function claimYield() external returns (uint256 amount) {
        _settle(msg.sender);
        amount = _accruedYield[msg.sender];
        if (amount == 0) revert NothingToClaim();
        _accruedYield[msg.sender] = 0;
        totalYieldClaimed += amount;
        emit YieldClaimed(msg.sender, amount);
        vault.payStakerYield(msg.sender, amount);
    }

    /// @notice USDC yield `account` could claim right now.
    function earned(address account) public view returns (uint256) {
        return _accruedYield[account]
            + Math.mulDiv(stakedBalance[account], accYieldPerToken - _yieldPerTokenPaid[account], ACC_PRECISION);
    }

    function _settle(address account) private {
        _accruedYield[account] = earned(account);
        _yieldPerTokenPaid[account] = accYieldPerToken;
    }
}
