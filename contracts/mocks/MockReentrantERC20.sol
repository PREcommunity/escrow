// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

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
        CloseGoal,
        CustomCall
    }

    IEscrowContribution public escrow;
    bytes32 public goalId;
    AttackMode public attackMode;
    /// @notice Encoded escrow call to attempt during a token transfer.
    bytes public callbackData;
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

    /// @notice Selects an arbitrary escrow callback for reentrancy tests.
    /// @param escrowAddress Escrow contract to call during transfers.
    /// @param data ABI-encoded callback including its arguments.
    function configureCall(address escrowAddress, bytes calldata data) external {
        escrow = IEscrowContribution(escrowAddress);
        callbackData = data;
        attackMode = AttackMode.CustomCall;
    }

    /// @notice Calls escrow as the token contract to set up and validate callback permissions.
    /// @param escrowAddress Escrow contract to call.
    /// @param data ABI-encoded escrow call including its arguments.
    /// @return result Escrow return data, with failures propagated to the caller.
    function executeEscrow(address escrowAddress, bytes calldata data) external returns (bytes memory result) {
        return Address.functionCall(escrowAddress, data);
    }

    function createManagedGoal(address recipient, uint64 deadline) external {
        escrow.createGoal(goalId, recipient, 100, 0, deadline, "Cross-function reentrancy", "", "");
    }

    function mint(address account, uint256 amount) external {
        _mint(account, amount);
    }

    function transfer(address to, uint256 value) public override returns (bool) {
        bool result = super.transfer(to, value);
        _attack();
        return result;
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        bool result = super.transferFrom(from, to, value);
        _attack();
        return result;
    }

    function _attack() private {
        if (attacking || address(escrow) == address(0) || attackMode == AttackMode.None) return;

        attacking = true;
        if (attackMode == AttackMode.Contribute) {
            escrow.contribute(goalId, address(this), 1, false);
        } else if (attackMode == AttackMode.CloseGoal) {
            escrow.closeGoal(goalId);
        } else {
            Address.functionCall(address(escrow), callbackData);
        }
        attacking = false;
    }
}
