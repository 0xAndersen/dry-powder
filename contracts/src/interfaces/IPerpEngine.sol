// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Surface of the PerpEngine used by HouseVault.
interface IPerpEngine {
    /// @notice USDC the vault must keep on hand to back the current net exposure.
    function reservedLiquidity() external view returns (uint256);

    /// @notice Aggregate unrealised price PnL of all traders at the last known oracle prices (positive:
    ///         traders are winning, i.e. the house owes).
    function unrealizedTraderPnl() external view returns (int256);
}
