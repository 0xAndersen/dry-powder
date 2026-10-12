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
/// @notice ERC-4626 USDC vault that is the counterparty to every trade on PerpEngine.
///         Trader losses and fees flow in (85% to the house, 15% to HOUSE stakers); trader profits flow out.
///
/// @dev Accounting notes
///  - The asset is Arc's native USDC through its 6-decimal ERC-20 interface. Shares (`rcUSDC`) have 18 decimals,
///    obtained with a 12-digit virtual offset, which also makes share-price inflation attacks uneconomic.
///  - `totalAssets()` is the internally tracked `totalHouseBalance`, never `balanceOf(this)`. On Arc a native
///    value transfer also changes the ERC-20 balance, so balance-based accounting would be donation-sensitive.
///  - The vault also custodies `pendingStakerYield`; it is owed to stakers and is not part of NAV.
///  - NAV only reflects realised PnL. To stop depositors timing realisation events, new deposits are locked for
///    `withdrawLockPeriod`, and withdrawals may never take NAV below what the engine needs to back open interest.
contract HouseVault is ERC4626, IHouseVault {
    using SafeERC20 for IERC20;

    /// @notice Share of every inflow routed to HOUSE stakers, in basis points.
    uint256 public constant STAKER_SHARE_BPS = 1_500;
    uint256 internal constant BPS = 10_000;

    /// @notice The only contract allowed to push losses/fees in and pull profits out.
    address public immutable engine;
    /// @notice HOUSE token; receives yield notifications and authorises yield payouts.
    IRewardToken public immutable rewardToken;
    /// @notice Seconds a depositor must wait after their latest deposit before withdrawing or transferring shares.
    uint256 public immutable withdrawLockPeriod;
    /// @notice Deployment timestamp, used by front-ends to annualise share-price growth.
    uint256 public immutable deployedAt;

    /// @notice USDC owned by share holders (the vault NAV).
    uint256 public totalHouseBalance;
    /// @notice USDC allocated to HOUSE stakers and not yet claimed.
    uint256 public pendingStakerYield;

    /// @notice Lifetime realised trader losses received (before the staker split).
    uint256 public totalTraderLosses;
    /// @notice Lifetime trader profits actually paid out.
    uint256 public totalTraderProfits;
    /// @notice Lifetime trading fees received (before the staker split).
    uint256 public totalFeesCollected;
    /// @notice Lifetime USDC allocated to stakers.
    uint256 public totalStakerYieldAllocated;
    /// @notice Lifetime trader profit that could not be paid because the house balance was exhausted.
    uint256 public totalShortfall;

    /// @notice Timestamp after which `account` may withdraw or transfer its shares.
    mapping(address account => uint256) public withdrawUnlockTime;

    event TraderLossReceived(address indexed trader, uint256 amount, uint256 toHouse, uint256 toStakers);
    event FeesReceived(uint256 amount, uint256 toHouse, uint256 toStakers);
    event TraderProfitPaid(address indexed trader, uint256 requested, uint256 paid);
    event PayoutShortfall(address indexed trader, uint256 shortfall);
    event StakerYieldPaid(address indexed to, uint256 amount);

    error ZeroAddress();
    error OnlyEngine();
    error OnlyRewardToken();
    error ReceiverMustBeCaller();
    error SharesLocked(uint256 unlockTime);

    modifier onlyEngine() {
        if (msg.sender != engine) revert OnlyEngine();
        _;
    }

    constructor(IERC20 usdc, address engine_, address rewardToken_, uint256 withdrawLockPeriod_)
        ERC4626(usdc)
        ERC20("Arc House USDC", "rcUSDC")
    {
        if (engine_ == address(0) || rewardToken_ == address(0)) revert ZeroAddress();
        engine = engine_;
        rewardToken = IRewardToken(rewardToken_);
        withdrawLockPeriod = withdrawLockPeriod_;
        deployedAt = block.timestamp;
    }

    // ───────────────────────────── ERC-4626 ─────────────────────────────

    /// @inheritdoc ERC4626
    function totalAssets() public view override(ERC4626, IHouseVault) returns (uint256) {
        return totalHouseBalance;
    }

    /// @notice USDC that can leave through withdrawals right now without under-collateralising open interest.
    function freeLiquidity() public view returns (uint256) {
        uint256 reserved = IPerpEngine(engine).reservedLiquidity();
        return totalHouseBalance > reserved ? totalHouseBalance - reserved : 0;
    }

    /// @notice USDC value of one whole share (1e18 share units), in 6 decimals.
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
        return Math.min(balanceOf(owner), convertToShares(freeLiquidity()));
    }

    /// @dev 6-decimal asset, 18-decimal shares.
    function _decimalsOffset() internal pure override returns (uint8) {
        return 12;
    }

    /// @dev Deposits must be for the caller: crediting a third party would either let the caller bypass the
    ///      lock (if the receiver is not locked) or grief the receiver (if it is).
    function _deposit(address caller, address receiver, uint256 assets, uint256 shares) internal override {
        if (receiver != caller) revert ReceiverMustBeCaller();
        totalHouseBalance += assets;
        withdrawUnlockTime[receiver] = block.timestamp + withdrawLockPeriod;
        super._deposit(caller, receiver, assets, shares);
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

    // ───────────────────────────── Engine flows ─────────────────────────────

    /// @inheritdoc IHouseVault
    function receiveTraderLoss(address trader, uint256 amount) external onlyEngine {
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
        totalTraderLosses += amount;
        (uint256 toHouse, uint256 toStakers) = _splitInflow(amount);
        emit TraderLossReceived(trader, amount, toHouse, toStakers);
    }

    /// @inheritdoc IHouseVault
    function receiveFees(uint256 amount) external onlyEngine {
        IERC20(asset()).safeTransferFrom(msg.sender, address(this), amount);
        totalFeesCollected += amount;
        (uint256 toHouse, uint256 toStakers) = _splitInflow(amount);
        emit FeesReceived(amount, toHouse, toStakers);
    }

    /// @inheritdoc IHouseVault
    /// @dev Never reverts for lack of funds: it pays what the house has and records the rest as shortfall, so a
    ///      drained vault cannot trap positions open.
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
        if (paid != 0) IERC20(asset()).safeTransfer(trader, paid);
    }

    /// @inheritdoc IHouseVault
    function payStakerYield(address to, uint256 amount) external {
        if (msg.sender != address(rewardToken)) revert OnlyRewardToken();
        pendingStakerYield -= amount;
        emit StakerYieldPaid(to, amount);
        IERC20(asset()).safeTransfer(to, amount);
    }

    /// @dev 85/15 split. With nobody staked there is no one to credit the 15% to, so the house keeps it all.
    function _splitInflow(uint256 amount) private returns (uint256 toHouse, uint256 toStakers) {
        if (rewardToken.totalStaked() != 0) toStakers = (amount * STAKER_SHARE_BPS) / BPS;
        toHouse = amount - toStakers;
        totalHouseBalance += toHouse;
        if (toStakers != 0) {
            pendingStakerYield += toStakers;
            totalStakerYieldAllocated += toStakers;
            rewardToken.notifyYield(toStakers);
        }
    }
}
