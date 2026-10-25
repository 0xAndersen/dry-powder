// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Surface of the RewardToken used by PerpEngine and HouseVault.
interface IRewardToken {
    function totalStaked() external view returns (uint256);

    /// @notice Records the result of one close or liquidation of `trader` (6-decimal USDC; negative for a loss)
    ///         and mints the DRY rebate on whatever part of it takes the trader's running result to a new low.
    ///         PerpEngine only.
    function recordResult(address trader, int256 result) external returns (uint256 minted);

    /// @notice Registers `amount` USDC of new yield, streamed to stakers over the stream period. HouseVault only.
    function notifyYield(uint256 amount) external;
}
