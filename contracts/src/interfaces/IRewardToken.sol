// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Surface of the RewardToken used by PerpEngine and HouseVault.
interface IRewardToken {
    function totalStaked() external view returns (uint256);

    /// @notice Mints the loss rebate for `usdcLost` (6 decimals) to `trader`. PerpEngine only.
    function mintLossRebate(address trader, uint256 usdcLost) external returns (uint256 minted);

    /// @notice Registers `amount` USDC of new yield, streamed to stakers over the stream period. HouseVault only.
    function notifyYield(uint256 amount) external;
}
