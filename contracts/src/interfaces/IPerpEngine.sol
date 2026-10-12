// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Surface of the PerpEngine used by HouseVault.
interface IPerpEngine {
    /// @notice USDC the vault must keep on hand to back current open interest.
    function reservedLiquidity() external view returns (uint256);
}
