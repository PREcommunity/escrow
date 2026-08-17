// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

/// @dev Constructor-validation mock that can return malformed metadata-call data.
contract MockInvalidTokenCalls {
    uint8 private immutable _MODE;

    constructor(uint8 mode) {
        _MODE = mode;
    }

    function balanceOf(address) external view returns (uint256) {
        if (_MODE == 0) {
            assembly ("memory-safe") {
                return(0, 0)
            }
        }
        return 0;
    }

    function decimals() external view returns (uint8) {
        if (_MODE == 1) {
            assembly ("memory-safe") {
                return(0, 0)
            }
        }
        return 18;
    }
}
