// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockERC20 is ERC20 {
    uint8 private immutable _TOKEN_DECIMALS;

    constructor(string memory name, string memory symbol, uint8 tokenDecimals) ERC20(name, symbol) {
        _TOKEN_DECIMALS = tokenDecimals;
    }

    function decimals() public view override returns (uint8) {
        return _TOKEN_DECIMALS;
    }

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }
}
