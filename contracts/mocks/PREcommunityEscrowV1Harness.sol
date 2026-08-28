// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {PREcommunityEscrowV1} from "../PREcommunityEscrowV1.sol";

/// @dev Test-only access to PREcommunityEscrowV1's calendar implementation.
contract PREcommunityEscrowV1Harness is PREcommunityEscrowV1 {
    constructor(address initialOwner, address pre, address usdc, address projectTreasury)
        PREcommunityEscrowV1(initialOwner, pre, usdc, projectTreasury)
    {}

    function nextMonthlySettlement(uint64 currentBoundary, uint8 settlementDay)
        external
        pure
        returns (uint64)
    {
        return _nextMonthlySettlement(currentBoundary, settlementDay);
    }
}
