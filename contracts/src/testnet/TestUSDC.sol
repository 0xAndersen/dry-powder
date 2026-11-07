// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title TestUSDC
/// @notice Freely mintable 6-decimal stand-in for USDC, used as trading collateral on testnets where the
///         faucet cannot supply enough real testnet USDC for load tests. It has no value. Never deploy the
///         protocol against it on a network that matters.
contract TestUSDC is ERC20 {
    /// @notice Largest amount one call may mint.
    uint256 public constant MAX_MINT = 1_000_000e6;

    error MintTooLarge();

    constructor() ERC20("Test USDC (Dry Powder)", "tUSDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    /// @notice Anyone can mint test collateral to anyone.
    function mint(address to, uint256 amount) external {
        if (amount > MAX_MINT) revert MintTooLarge();
        _mint(to, amount);
    }
}
