// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";

import {IHouseVault} from "./interfaces/IHouseVault.sol";
import {IRewardToken} from "./interfaces/IRewardToken.sol";

/// @title RewardToken (DRY)
/// @notice Loss-rebate token. Traders earn DRY on their NET losses: the engine reports every close and liquidation,
///         and DRY is minted only when a trader's running result reaches a new low, so winning back a loss and
///         losing it again earns nothing twice. The rate starts at 100 DRY per 1 USDC and decays as more loss is
///         rebated (half after 1,000,000 USDC, a tenth after 9,000,000). Staked DRY earns a pro-rata share of the
///         house's performance yield, claimable in USDC.
///
/// @dev Yield notified by the vault is streamed linearly over `streamPeriod` rather than credited at once, so
///      staking immediately before a settlement and leaving immediately after earns nothing. The USDC itself
///      stays in the vault (`pendingStakerYield`); this contract keeps the ledger and tells the vault to pay
///      on claim. Rounding always favours the pool, so claims can never exceed what was notified.
///
///      Why net and decaying: rebates on gross losses let a hedged pair (long on one account, short on another)
///      mint DRY on the losing leg while the winning leg is paid by the house, for the cost of fees (the M-level
///      finding in SECURITY.md). Net accounting removes the same-account version; the engine caps what one trade
///      can report at 1% of its notional, so a cross-account pair has to pay the house more in fees and spread
///      than the DRY is worth in staker yield; and the decay bounds total issuance.
contract RewardToken is ERC20, IRewardToken {
    /// @notice DRY per whole USDC of net loss before any loss has been rebated.
    uint256 public constant INITIAL_REBATE_RATE = 100;
    /// @notice Rebated net loss (6-decimal USDC) at which the rate has fallen to half. The rate at a rebated total
    ///         `x` is `INITIAL_REBATE_RATE * HALVING_LOSS / (HALVING_LOSS + x)`.
    uint256 public constant HALVING_LOSS = 1_000_000e6;
    /// @dev 6-decimal USDC amount -> 18-decimal DRY amount at the initial rate.
    uint256 internal constant USDC_TO_HOUSE = INITIAL_REBATE_RATE * 1e12;
    /// @dev Scale of the per-token accumulator. Large enough that 1 micro-USDC over 100bn staked DRY registers.
    uint256 internal constant ACC_PRECISION = 1e36;
    /// @dev Scale of the per-second stream rate, so small amounts over long periods are not rounded away.
    uint256 internal constant RATE_PRECISION = 1e18;

    /// @notice A trader's running result as reported by the engine (6-decimal USDC) and its lowest point so far.
    struct Result {
        int128 net;
        int128 low;
    }

    /// @notice The only minter.
    address public immutable engine;
    /// @notice Custodian and source of staker yield.
    IHouseVault public immutable vault;
    /// @notice Seconds over which each notified amount is streamed to stakers.
    uint256 public immutable streamPeriod;

    /// @notice Total DRY currently staked.
    uint256 public totalStaked;
    /// @notice Cumulative USDC yield per staked DRY unit, scaled by ACC_PRECISION, as of `lastUpdateTime`.
    uint256 public accYieldPerToken;
    /// @notice Current stream rate in USDC per second, scaled by RATE_PRECISION.
    uint256 public yieldRate;
    /// @notice When the current stream ends.
    uint256 public periodFinish;
    /// @notice Last time the accumulator was brought up to date.
    uint256 public lastUpdateTime;
    /// @dev Yield (scaled by RATE_PRECISION) that streamed while nobody was staked; rolled into the next stream.
    uint256 private _unassigned;

    /// @notice Lifetime DRY minted as loss rebates.
    uint256 public totalRebatesMinted;
    /// @notice Lifetime net loss rebated, in 6-decimal USDC: the position on the decay curve.
    uint256 public totalRebatedLoss;
    /// @notice Lifetime USDC yield registered for stakers.
    uint256 public totalYieldNotified;
    /// @notice Lifetime USDC yield claimed by stakers.
    uint256 public totalYieldClaimed;

    /// @notice DRY staked by `account`.
    mapping(address account => uint256) public stakedBalance;
    mapping(address account => uint256) private _yieldPerTokenPaid;
    mapping(address account => uint256) private _accruedYield;
    /// @notice Running result of `trader` and its low: DRY is minted on each new low, for the distance below the
    ///         previous one.
    mapping(address trader => Result) public results;

    event LossRebateMinted(address indexed trader, uint256 usdcLost, uint256 minted);
    event YieldNotified(uint256 amount, uint256 yieldRate, uint256 periodFinish);
    event Staked(address indexed account, uint256 amount);
    event Unstaked(address indexed account, uint256 amount);
    event YieldClaimed(address indexed account, uint256 amount);

    error ZeroAddress();
    error ZeroAmount();
    error OnlyEngine();
    error OnlyVault();
    error InsufficientStake();
    error NothingToClaim();

    constructor(address vault_, address engine_, uint256 streamPeriod_) ERC20("Dry Powder", "DRY") {
        if (vault_ == address(0) || engine_ == address(0)) revert ZeroAddress();
        if (streamPeriod_ == 0) revert ZeroAmount();
        vault = IHouseVault(vault_);
        engine = engine_;
        streamPeriod = streamPeriod_;
    }

    // ───────────────────────────── Protocol hooks ─────────────────────────────

    /// @inheritdoc IRewardToken
    function recordResult(address trader, int256 result) external returns (uint256 minted) {
        if (msg.sender != engine) revert OnlyEngine();
        if (result == 0) return 0;
        Result memory r = results[trader];
        int256 net = int256(r.net) + result;
        r.net = SafeCast.toInt128(net);
        if (net < r.low) {
            uint256 newLoss = uint256(int256(r.low) - net);
            r.low = r.net;
            minted = rebateFor(newLoss);
            totalRebatedLoss += newLoss;
            totalRebatesMinted += minted;
            _mint(trader, minted);
            emit LossRebateMinted(trader, newLoss, minted);
        }
        results[trader] = r;
    }

    /// @notice DRY that `loss` more USDC (6 decimals) of new net loss would mint right now.
    /// @dev The rate falls continuously with the rebated total; a loss is priced at the rate at its midpoint on the
    ///      curve, which slightly under-pays (by at most 4% for a single loss as large as `HALVING_LOSS`).
    function rebateFor(uint256 loss) public view returns (uint256) {
        uint256 midpoint = totalRebatedLoss + loss / 2;
        return Math.mulDiv(loss * USDC_TO_HOUSE, HALVING_LOSS, HALVING_LOSS + midpoint);
    }

    /// @notice Current rate: DRY (18 decimals) minted per whole USDC of new net loss.
    function rebateRate() external view returns (uint256) {
        return Math.mulDiv(USDC_TO_HOUSE * 1e6, HALVING_LOSS, HALVING_LOSS + totalRebatedLoss);
    }

    /// @inheritdoc IRewardToken
    /// @dev Whatever is left of the running stream, and anything that streamed while nobody was staked, is
    ///      merged into a new stream of `streamPeriod` starting now.
    function notifyYield(uint256 amount) external {
        if (msg.sender != address(vault)) revert OnlyVault();
        _accrue();
        uint256 scaled = amount * RATE_PRECISION + _unassigned;
        if (block.timestamp < periodFinish) scaled += (periodFinish - block.timestamp) * yieldRate;
        _unassigned = scaled % streamPeriod;
        yieldRate = scaled / streamPeriod;
        periodFinish = block.timestamp + streamPeriod;
        totalYieldNotified += amount;
        emit YieldNotified(amount, yieldRate, periodFinish);
    }

    // ───────────────────────────── Staking ─────────────────────────────

    /// @notice Stake `amount` DRY to start earning USDC yield.
    function stake(uint256 amount) external {
        if (amount == 0) revert ZeroAmount();
        _settle(msg.sender);
        stakedBalance[msg.sender] += amount;
        totalStaked += amount;
        _transfer(msg.sender, address(this), amount);
        emit Staked(msg.sender, amount);
    }

    /// @notice Unstake `amount` DRY. Yield earned so far stays claimable.
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
            + Math.mulDiv(stakedBalance[account], _currentAcc() - _yieldPerTokenPaid[account], ACC_PRECISION);
    }

    /// @dev Seconds of the stream that have elapsed since the accumulator was last updated.
    function _elapsed() private view returns (uint256) {
        uint256 until = Math.min(block.timestamp, periodFinish);
        return until > lastUpdateTime ? until - lastUpdateTime : 0;
    }

    function _currentAcc() private view returns (uint256) {
        uint256 staked = totalStaked;
        if (staked == 0) return accYieldPerToken;
        // elapsed * yieldRate is USDC scaled by RATE_PRECISION; rescale to ACC_PRECISION per staked token.
        return accYieldPerToken + Math.mulDiv(_elapsed() * yieldRate, ACC_PRECISION / RATE_PRECISION, staked);
    }

    function _accrue() private {
        if (totalStaked == 0) _unassigned += _elapsed() * yieldRate;
        else accYieldPerToken = _currentAcc();
        lastUpdateTime = block.timestamp;
    }

    function _settle(address account) private {
        _accrue();
        _accruedYield[account] = earned(account);
        _yieldPerTokenPaid[account] = accYieldPerToken;
    }
}
