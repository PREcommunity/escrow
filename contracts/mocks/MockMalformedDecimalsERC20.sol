// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @dev Constructor-validation mock: balanceOf is valid, while decimals returns a non-canonical uint8 value.
contract MockMalformedDecimalsERC20 {
    function balanceOf(address) external pure returns (uint256) {
        return 0;
    }

    function decimals() external pure returns (uint256) {
        return 256;
    }
}
