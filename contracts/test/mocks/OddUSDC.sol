// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice 6-decimal token with the two non-standard `transfer` behaviours found in the wild: signalling a
///         refused transfer by returning `false` instead of reverting, and returning no data at all.
contract OddUSDC is ERC20 {
    mapping(address => bool) public refused;
    bool public noReturnData;

    constructor() ERC20("Odd USD", "oUSD") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setRefused(address account, bool status) external {
        refused[account] = status;
    }

    function setNoReturnData(bool status) external {
        noReturnData = status;
    }

    function transfer(address to, uint256 amount) public override returns (bool) {
        if (refused[to]) return false;
        super.transfer(to, amount);
        if (noReturnData) {
            assembly {
                return(0, 0)
            }
        }
        return true;
    }
}
