// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title Mock PRE
/// @notice Owner-minted PRE imitation intended only for public test networks.
contract MockPRE is ERC20, Ownable {
    constructor() ERC20("Presearch", "PRE") Ownable(msg.sender) {}

    function mint(address account, uint256 amount) external onlyOwner {
        _mint(account, amount);
    }
}
