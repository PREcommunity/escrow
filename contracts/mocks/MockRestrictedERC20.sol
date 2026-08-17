// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

contract MockRestrictedERC20 is ERC20 {
    uint8 private immutable _TOKEN_DECIMALS;
    mapping(address account => bool) public blocked;
    uint256 public transferFee;
    address public feeCollector;

    error BlockedAddress();
    error InvalidFee();

    constructor(string memory name, string memory symbol, uint8 tokenDecimals) ERC20(name, symbol) {
        _TOKEN_DECIMALS = tokenDecimals;
    }

    function decimals() public view override returns (uint8) {
        return _TOKEN_DECIMALS;
    }

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function setBlocked(address account, bool value) external {
        blocked[account] = value;
    }

    function setTransferFee(uint256 fee, address collector) external {
        if (fee != 0 && collector == address(0)) revert InvalidFee();
        transferFee = fee;
        feeCollector = collector;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (blocked[from] || blocked[to]) revert BlockedAddress();

        uint256 fee = from != address(0) && to != address(0) ? transferFee : 0;
        if (fee > value) revert InvalidFee();
        if (fee == 0) {
            super._update(from, to, value);
            return;
        }

        super._update(from, to, value - fee);
        super._update(from, feeCollector, fee);
    }
}
