// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice 6-decimal USDC stand-in with Circle-style blocklisting: transfers from or to a blocklisted
///         account revert, as they do for native USDC on Arc.
contract MockUSDC is ERC20 {
    mapping(address => bool) public blocklisted;

    error Blocklisted(address account);

    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setBlocklisted(address account, bool status) external {
        blocklisted[account] = status;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocklisted[from]) revert Blocklisted(from);
        if (blocklisted[to]) revert Blocklisted(to);
        super._update(from, to, value);
    }
}
