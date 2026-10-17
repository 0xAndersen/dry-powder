// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC4626} from "@openzeppelin/contracts/token/ERC20/extensions/ERC4626.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

import {IHouseVault} from "./interfaces/IHouseVault.sol";
import {IPerpEngine} from "./interfaces/IPerpEngine.sol";
import {IRewardToken} from "./interfaces/IRewardToken.sol";

/// @title HouseVault
/// @notice ERC-4626 USDC vault that is the counterparty to every trade on PerpEngine. Trader losses and fees
///         flow in, trader profits flow out, and DRY stakers receive a performance share of what the house
///         actually earns.
///
/// @dev Accounting
///  - The asset is Arc's native USDC through its 6-decimal ERC-20 interface. Shares (`dpUSDC`) have 18 decimals
///    via a 12-digit virtual offset, which also makes share-price inflation attacks uneconomic.
///  - `totalHouseBalance` is the realised balance owned by share holders, tracked internally and never read
///    from `balanceOf` (on Arc a native value transfer also changes the ERC-20 balance).
///  - The vault also knows the engine's unrealised trader PnL at the last oracle prices, which gives a
///    mark-to-market value. Shares are always priced on the side that protects existing holders:
///    deposits buy in at the HIGHER of realised and marked value, withdrawals cash out at the LOWER. Nobody
///    can therefore deposit just before a loss is realised, or leave just before a winner is paid.
///  - `totalAssets()` reports the lower (exit) value.
///
/// @dev Staker yield
///  Once per epoch anyone may call {settleEpoch}. If the exit value per share is above its previous high-water
///  mark, 15% of that gain is moved out of the house balance and streamed to DRY stakers. Losses must be
///  recovered before stakers earn again, and offsetting trades that leave the house flat earn them nothing.
contract HouseVault is ERC4626, IHouseVault {
    using SafeERC20 for IERC20;

    /// @notice Share of house profit above the high-water mark that goes to DRY stakers, in basis points.
    uint256 public constant STAKER_SHARE_BPS = 1_500;
    uint256 internal constant BPS = 10_000;
    /// @dev Scale of the per-share high-water mark (assets per share unit).
    uint256 internal constant HWM_PRECISION = 1e30;

    /// @notice The only contract allowed to push losses/fees in and pull profits out.
    address public immutable engine;
    /// @notice DRY token; receives yield notifications and authorises yield payouts.
    IRewardToken public immutable rewardToken;
    /// @notice Seconds a depositor must wait after their latest deposit before withdrawing or transferring shares.
    uint256 public immutable withdrawLockPeriod;
    /// @notice Minimum seconds between two epoch settlements.
    uint256 public immutable epochLength;
    /// @notice Deployment timestamp, used by front-ends to annualise share-price growth.
    uint256 public immutable deployedAt;

    /// @notice Realised USDC owned by share holders.
    uint256 public totalHouseBalance;
    /// @notice USDC allocated to DRY stakers and not yet claimed.
    uint256 public pendingStakerYield;
    /// @notice Highest exit value per share at which staker yield has been settled, scaled by 1e30.
    uint256 public highWaterMark = HWM_PRECISION / 1e12;
    /// @notice Timestamp of the last epoch settlement.
    uint256 public lastEpochTime;

    /// @notice Lifetime realised trader losses received.
    uint256 public totalTraderLosses;
    /// @notice Lifetime trader profits actually paid out.
    uint256 public totalTraderProfits;
    /// @notice Lifetime trading fees received.
    uint256 public totalFeesCollected;
    /// @notice Lifetime USDC allocated to stakers.
    uint256 public totalStakerYieldAllocated;
    /// @notice Lifetime trader profit that could not be paid because the house balance was exhausted.
    uint256 public totalShortfall;

    /// @notice Timestamp after which `account` may withdraw or transfer its shares.
    mapping(address account => uint256) public withdrawUnlockTime;

    event TraderLossReceived(address indexed trader, uint256 amount);
    event FeesReceived(uint256 amount);
    event TraderProfitPaid(address indexed trader, uint256 requested, uint256 paid);
    event PayoutShortfall(address indexed trader, uint256 shortfall);
    event EpochSettled(uint256 profit, uint256 toStakers, uint256 highWaterMark);
    event StakerYieldPaid(address indexed to, uint256 amount);

    error ZeroAddress();
    error OnlyEngine();
    error OnlyRewardToken();
    error ReceiverMustBeCaller();
    error SharesLocked(uint256 unlockTime);
    error EpochNotOver(uint256 nextSettlement);

    modifier onlyEngine() {
        if (msg.sender != engine) revert OnlyEngine();
        _;
    }

    constructor(IERC20 usdc, address engine_, address rewardToken_, uint256 withdrawLockPeriod_, uint256 epochLength_)
        ERC4626(usdc)
        ERC20("Dry Powder USDC", "dpUSDC")
    {
        if (engine_ == address(0) || rewardToken_ == address(0)) revert ZeroAddress();
        engine = engine_;
        rewardToken = IRewardToken(rewardToken_);
        withdrawLockPeriod = withdrawLockPeriod_;
        epochLength = epochLength_;
        deployedAt = block.timestamp;
        lastEpochTime = block.timestamp;
    }

    // ───────────────────────────── Valuation ─────────────────────────────

    /// @notice Realised balance adjusted for the engine's unrealised trader PnL at the last oracle prices.
    function markedValue() public view returns (uint256) {
        int256 traderPnl = IPerpEngine(engine).unrealizedTraderPnl();
        if (traderPnl <= 0) return totalHouseBalance + uint256(-traderPnl);
        uint256 owed = uint256(traderPnl);
        return totalHouseBalance > owed ? totalHouseBalance - owed : 0;
    }

    /// @notice Value at which shares are redeemed: the lower of realised and marked.
    function exitValue() public view returns (uint256) {
        return Math.min(totalHouseBalance, markedValue());
    }

    /// @notice Value at which shares are issued: the higher of realised and marked.
    function entryValue() public view returns (uint256) {
        return Math.max(totalHouseBalance, markedValue());
    }

    /// @inheritdoc ERC4626
    function totalAssets() public view override(ERC4626, IHouseVault) returns (uint256) {
        return exitValue();
    }

    /// @notice USDC that can leave through withdrawals right now without under-collateralising net exposure.
    function freeLiquidity() public view returns (uint256) {
        uint256 reserved = IPerpEngine(engine).reservedLiquidity();
        uint256 value = exitValue();
        return value > reserved ? value - reserved : 0;
    }

    /// @notice USDC a holder would receive for one whole share (1e18 share units), in 6 decimals.
    function sharePrice() external view returns (uint256) {
        return convertToAssets(10 ** decimals());
    }

    /// @inheritdoc ERC4626
    function maxWithdraw(address owner) public view override returns (uint256) {
        if (block.timestamp < withdrawUnlockTime[owner]) return 0;
        return Math.min(super.maxWithdraw(owner), freeLiquidity());
    }

    /// @inheritdoc ERC4626
    function maxRedeem(address owner) public view override returns (uint256) {
        if (block.timestamp < withdrawUnlockTime[owner]) return 0;
        return Math.min(balanceOf(owner), _convertToShares(freeLiquidity(), Math.Rounding.Ceil));
    }

    /// @dev 6-decimal asset, 18-decimal shares.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 12;
    }

    /// @dev OpenZeppelin rounds down when issuing shares for a deposit and up when burning them for a
    ///      withdrawal, so the rounding direction identifies the flow: entering uses the entry value,
    ///      leaving uses the exit value.
    function _convertToShares(uint256 assets, Math.Rounding rounding) internal view override returns (uint256) {
        uint256 value = rounding == Math.Rounding.Floor ? entryValue() : exitValue();
        return Math.mulDiv(assets, totalSupply() + 10 ** _decimalsOffset(), value + 1, rounding);
    }

    /// @dev Mirror of {_convertToShares}: rounding up prices a mint (entering), rounding down a redeem (leaving).
    function _convertToAssets(uint256 shares, Math.Rounding rounding) internal view override returns (uint256) {
        uint256 value = rounding == Math.Rounding.Ceil ? entryValue() : exitValue();
        return Math.mulDiv(shares, value + 1, totalSupply() + 10 ** _decimalsOffset(), rounding);
    }

    /// @dev Deposits must be for the caller: crediting a third party would either let the caller bypass the
    ///      lock (if the receiver is not locked) or grief the receiver (if it is).
    ///
    ///      New shares enter the high-water mark at the price they were bought at. {settleEpoch} measures
    ///      profit as (value per share - mark) * supply, so shares issued above the mark would otherwise be
    ///      charged the staker share on a gain that was made before they existed. With the last holders gone
    ///      the leftover rounding dust (or fees that arrived meanwhile) prices the next shares far above the
    ///      old mark, and close to 15% of the newcomer's own deposit would go to stakers. Blending the mark
    ///      with the issue price, weighted by shares, keeps the profit still to be settled exactly what it was
    ///      before the deposit. The mark is only ever raised here: shares bought below it wait for the old
    ///      mark like everyone else.
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        if (receiver != caller) revert ReceiverMustBeCaller();
        totalHouseBalance += assets;
        withdrawUnlockTime[receiver] = block.timestamp + withdrawLockPeriod;
        super._deposit(caller, receiver, assets, shares);
        if (shares != 0) {
            uint256 mark = highWaterMark;
            uint256 paid = Math.mulDiv(assets, HWM_PRECISION, shares);
            if (paid > mark) highWaterMark = mark + Math.mulDiv(paid - mark, shares, totalSupply());
        }
    }

    function _withdraw(address caller, address receiver, address owner, uint256 assets, uint256 shares)
        internal
        override
    {
        totalHouseBalance -= assets;
        super._withdraw(caller, receiver, owner, assets, shares);
    }

    /// @dev Locked shares cannot be moved to another account (which would sidestep the lock).
    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 unlockTime = withdrawUnlockTime[from];
            if (block.timestamp < unlockTime) revert SharesLocked(unlockTime);
        }
        super._update(from, to, value);
    }

    // ───────────────────────────── Staker yield ─────────────────────────────

    /// @notice Settles the epoch: if the exit value per share is above the high-water mark, 15% of the gain
    ///         is set aside for DRY stakers. Anyone may call once `epochLength` has passed.
    /// @return toStakers USDC moved from the house balance to staker yield.
    function settleEpoch() external returns (uint256 toStakers) {
        uint256 next = lastEpochTime + epochLength;
        if (block.timestamp < next) revert EpochNotOver(next);
        lastEpochTime = block.timestamp;

        uint256 supply = totalSupply();
        if (supply == 0) return 0;
        uint256 value = exitValue();
        uint256 perShare = Math.mulDiv(value, HWM_PRECISION, supply);
        uint256 mark = highWaterMark;
        if (perShare <= mark) {
            emit EpochSettled(0, 0, mark);
            return 0;
        }

        uint256 profit = Math.mulDiv(perShare - mark, supply, HWM_PRECISION);
        // With nobody staked there is no one to pay; the house keeps the gain and the mark still moves up,
        // so a later staker cannot claim profit earned before they arrived.
        if (rewardToken.totalStaked() != 0) toStakers = (profit * STAKER_SHARE_BPS) / BPS;
        if (toStakers != 0) {
            totalHouseBalance -= toStakers;
            pendingStakerYield += toStakers;
            totalStakerYieldAllocated += toStakers;
            rewardToken.notifyYield(toStakers);
        }
        mark = Math.mulDiv(value - toStakers, HWM_PRECISION, supply);
        highWaterMark = mark;
        emit EpochSettled(profit, toStakers, mark);
    }

    /// @inheritdoc IHouseVault
    function payStakerYield(address to, uint256 amount) external {
        if (msg.sender != address(rewardToken)) revert OnlyRewardToken();
        pendingStakerYield -= amount;
        emit StakerYieldPaid(to, amount);
        IERC20(asset()).safeTransfer(to, amount);
    }

    // ───────────────────────────── Engine flows ─────────────────────────────

    /// @inheritdoc IHouseVault
    function receiveTraderLoss(address trader, uint256 amount) external onlyEngine {
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
        totalTraderLosses += amount;
        totalHouseBalance += amount;
        emit TraderLossReceived(trader, amount);
    }

    /// @inheritdoc IHouseVault
    function receiveFees(uint256 amount) external onlyEngine {
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
        totalFeesCollected += amount;
        totalHouseBalance += amount;
        emit FeesReceived(amount);
    }

    /// @inheritdoc IHouseVault
    /// @dev Never reverts for lack of funds: it pays what the house has and records the rest as shortfall, so a
    ///      drained vault cannot trap positions open. The engine forwards the payment to the trader.
    function payoutTraderProfit(address trader, uint256 amount) external onlyEngine returns (uint256 paid) {
        paid = Math.min(amount, totalHouseBalance);
        totalHouseBalance -= paid;
        totalTraderProfits += paid;
        emit TraderProfitPaid(trader, amount, paid);
        if (paid < amount) {
            uint256 shortfall = amount - paid;
            totalShortfall += shortfall;
            emit PayoutShortfall(trader, shortfall);
        }
        if (paid != 0) IERC20(asset()).safeTransfer(msg.sender, paid);
    }
}
