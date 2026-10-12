// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Surface of the HouseVault used by PerpEngine and RewardToken.
interface IHouseVault {
    function totalAssets() external view returns (uint256);

    /// @notice Pulls `amount` USDC of realised trader loss from the engine and splits it house/stakers.
    function receiveTraderLoss(address trader, uint256 amount) external;

    /// @notice Pulls `amount` USDC of trading fees from the engine and splits it house/stakers.
    function receiveFees(uint256 amount) external;

    /// @notice Pays up to `amount` USDC of trader profit out of the house balance. Returns the amount actually paid.
    function payoutTraderProfit(address trader, uint256 amount) external returns (uint256 paid);

    /// @notice Transfers `amount` of already-allocated staker yield to `to`. RewardToken only.
    function payStakerYield(address to, uint256 amount) external;
}
