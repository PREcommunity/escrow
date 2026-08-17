// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

interface IEscrowContribution {
    function contribute(bytes32 goalId, address token, uint256 amount, bool profileVisible) external;

    function createGoal(
        bytes32 goalId,
        address recipient,
        uint256 preTarget,
        uint256 usdcTarget,
        uint64 deadline,
        string calldata title,
        string calldata description,
        string calldata metadataURI
    ) external;

    function closeGoal(bytes32 goalId) external;
}

contract MockReentrantERC20 is ERC20 {
    enum AttackMode {
        None,
        Contribute,
        CloseGoal
    }

    IEscrowContribution public escrow;
    bytes32 public goalId;
    AttackMode public attackMode;
    bool private attacking;

    constructor() ERC20("Reentrant PRE", "rPRE") {}

    function configure(address escrowAddress, bytes32 targetGoal) external {
        escrow = IEscrowContribution(escrowAddress);
        goalId = targetGoal;
        attackMode = AttackMode.Contribute;
    }

    function configureCloseGoal(address escrowAddress, bytes32 targetGoal) external {
        escrow = IEscrowContribution(escrowAddress);
        goalId = targetGoal;
        attackMode = AttackMode.CloseGoal;
    }

    function createManagedGoal(address recipient, uint64 deadline) external {
        escrow.createGoal(goalId, recipient, 100, 0, deadline, "Cross-function reentrancy", "", "");
    }

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        bool result = super.transferFrom(from, to, value);
        if (!attacking && address(escrow) != address(0)) {
            attacking = true;
            if (attackMode == AttackMode.Contribute) {
                escrow.contribute(goalId, address(this), 1, false);
            } else if (attackMode == AttackMode.CloseGoal) {
                escrow.closeGoal(goalId);
            }
            attacking = false;
        }
        return result;
    }
}
