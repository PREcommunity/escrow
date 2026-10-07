// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

contract PREKeywordMarketV1 is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant UNSTAKE_DELAY = 1 days;
    IERC20 public immutable PRE;
    address public operator;
    uint256 public minimumStake;
    uint256 public totalStaked;
    uint256 public accruedFees;

    struct Position {
        uint256 amount;
        uint256 bidUsd;
        uint256 version;
        uint256 withdrawAvailableAt;
        uint256 requiredCoveragePre;
    }

    struct StakingDetails {
        address staker;
        uint256 amount;
        uint256 bidUsd;
        uint256 positionVersion;
        uint256 requiredCoveragePre;
    }

    mapping(bytes32 keywordId => address[] stakers) private _stakers;
    mapping(bytes32 chargeId => bool processed) public chargeProcessed;
    mapping(bytes32 keywordId => StakingDetails details) private _topStakes;
    mapping(bytes32 keywordId => mapping(address staker => Position position)) private _positions;
    mapping(bytes32 keywordId => mapping(address staker => uint256 indexPlusOne)) private _heapIndex;

    error ZeroAmount();
    error ZeroAddress();
    error ZeroKeyword();
    error UnstakePending();
    error InvalidChargeId();
    error InvalidOperator();
    error PositionMissing();
    error UnstakeNotRequested();
    error TransferAmountMismatch();
    error UnstakeAlreadyRequested();
    error OwnershipRenunciationDisabled();
    error UnstakeNotReady(uint256 availableAt);
    error UnauthorizedOperator(address account);
    error StakeBelowMinimum(uint256 amount,uint256 minimum);
    error PositionVersionMismatch(uint256 expected,uint256 actual);
    error CoverageNotMet(uint256 amount,uint256 requiredCoveragePre);
    error InsufficientAccruedFees(uint256 requested,uint256 available);

    event AccruedWithdrawn(address indexed recipient,uint256 amountPre);
    event MinimumStakeUpdated(uint256 previousMinimum,uint256 newMinimum);
    event Unstaked(bytes32 indexed keywordId,address indexed staker,uint256 amountPre);
    event OperatorUpdated(address indexed previousOperator,address indexed newOperator);
    event UnstakeRequested(bytes32 indexed keywordId,address indexed staker,uint256 availableAt);
    event Staked(bytes32 indexed keywordId,address indexed staker,uint256 depositedPre,uint256 amountPre);
    event BidUpdated(
        bytes32 indexed keywordId,
        address indexed staker,
        uint256 previousBidUsd,
        uint256 newBidUsd
    );
    event StakeCharged(
        bytes32 indexed keywordId,
        address indexed staker,
        bytes32 indexed chargeId,
        uint256 requestedPre,
        uint256 chargedPre,
        uint256 remainingPre
    );
    event PositionChanged(
        bytes32 indexed keywordId,
        address indexed staker,
        uint256 bidUsd,
        bool eligible,
        uint256 newStake,
        uint256 positionVersion,
        uint256 previousStake,
        uint256 requiredCoveragePre,
        uint256 withdrawAvailableAt
    );
    event TopStakeChanged(
        bytes32 indexed keywordId,
        address indexed staker,
        uint256 bidUsd,
        address previousStaker,
        uint256 previousBidUsd
    );

    constructor(address initialOwner, address preToken, uint256 initialMinimumStake, bool startPaused)
        Ownable(initialOwner)
    {
        if (initialOwner == address(0) || preToken == address(0)) revert ZeroAddress();
        if (initialMinimumStake == 0) revert ZeroAmount();
        PRE = IERC20(preToken);
        minimumStake = initialMinimumStake;
        if (startPaused) _pause();
    }

    modifier onlyOperator() {
        if (msg.sender != operator) revert UnauthorizedOperator(msg.sender);
        _;
    }

    /// @notice Opens or tops up a position with a user-selected bid.
    function stake(
        bytes32 keywordId,
        uint256 amountPre,
        uint256 bidUsd
    ) external whenNotPaused nonReentrant {
        if (keywordId == bytes32(0)) revert ZeroKeyword();
        if (bidUsd == 0) revert ZeroAmount();

        Position storage position = _positions[keywordId][msg.sender];
        uint256 previousStake = position.amount;
        uint256 previousBidUsd = position.bidUsd;
        if (position.withdrawAvailableAt != 0) revert UnstakePending();
        if (previousStake == 0) {
            if (amountPre < minimumStake) revert StakeBelowMinimum(amountPre, minimumStake);
            position.version += 1;
            position.requiredCoveragePre = minimumStake;
        }
        uint256 newAmount = previousStake + amountPre;
        if (amountPre != 0) _receiveExact(amountPre);

        position.amount = newAmount;
        position.bidUsd = bidUsd;
        position.withdrawAvailableAt = 0;
        totalStaked += amountPre;

        _syncStakers(keywordId, msg.sender, position);
        _refreshTop(keywordId);
        if (amountPre != 0) emit Staked(keywordId, msg.sender, amountPre, newAmount);
        if (previousStake != 0 && previousBidUsd != bidUsd) {
            emit BidUpdated(keywordId, msg.sender, previousBidUsd, bidUsd);
        }
        _emitPositionChanged(keywordId, msg.sender, previousStake, position);
    }

    /// @notice Stops competing immediately and starts the 24-hour withdrawal delay.
    function requestUnstake(bytes32 keywordId) external {
        Position storage position = _positions[keywordId][msg.sender];
        if (position.amount == 0) revert PositionMissing();
        if (position.withdrawAvailableAt != 0) revert UnstakeAlreadyRequested();

        position.withdrawAvailableAt = block.timestamp + UNSTAKE_DELAY;
        _removeStaker(keywordId, msg.sender);
        _refreshTop(keywordId);
        emit UnstakeRequested(keywordId, msg.sender, position.withdrawAvailableAt);
        _emitPositionChanged(keywordId, msg.sender, position.amount, position);
    }

    /// @notice Returns remaining PRE after the delay, including while paused.
    function unstake(bytes32 keywordId) external nonReentrant {
        Position storage position = _positions[keywordId][msg.sender];
        uint256 amountPre = position.amount;
        if (amountPre == 0) revert PositionMissing();
        uint256 availableAt = position.withdrawAvailableAt;
        if (availableAt == 0) revert UnstakeNotRequested();
        if (block.timestamp < availableAt) revert UnstakeNotReady(availableAt);

        _clearPosition(position);
        totalStaked -= amountPre;
        PRE.safeTransfer(msg.sender, amountPre);
        emit Unstaked(keywordId, msg.sender, amountPre);
        _emitPositionChanged(keywordId, msg.sender, amountPre, position);
    }

    /// @notice Bills raw PRE, capped at the position balance. Repeating a charge ID is a no-op.
    function chargeStake(
        bytes32 keywordId,
        address staker,
        uint256 positionVersion,
        uint256 requestedPre,
        bytes32 chargeId
    ) external onlyOperator returns (uint256 chargedPre) {
        if (chargeId == bytes32(0)) revert InvalidChargeId();
        if (chargeProcessed[chargeId]) return 0;
        if (requestedPre == 0) revert ZeroAmount();
        Position storage position = _positions[keywordId][staker];
        if (position.amount == 0) revert PositionMissing();
        if (position.version != positionVersion) {
            revert PositionVersionMismatch(positionVersion, position.version);
        }

        uint256 previousStake = position.amount;
        chargedPre = requestedPre > previousStake ? previousStake : requestedPre;
        chargeProcessed[chargeId] = true;
        position.amount = previousStake - chargedPre;
        totalStaked -= chargedPre;
        accruedFees += chargedPre;
        if (position.amount == 0) _clearPosition(position);
        _syncStakers(keywordId, staker, position);
        _refreshTop(keywordId);

        emit StakeCharged(keywordId, staker, chargeId, requestedPre, chargedPre, position.amount);
        _emitPositionChanged(keywordId, staker, previousStake, position);
    }

    function withdrawAccrued(address recipient, uint256 amountPre) external onlyOwner nonReentrant {
        if (recipient == address(0)) revert ZeroAddress();
        if (amountPre == 0) revert ZeroAmount();
        uint256 available = accruedFees;
        if (amountPre > available) revert InsufficientAccruedFees(amountPre, available);
        accruedFees = available - amountPre;
        PRE.safeTransfer(recipient, amountPre);
        emit AccruedWithdrawn(recipient, amountPre);
    }

    function positionOf(bytes32 keywordId, address staker) external view returns (uint256) {
        return _positions[keywordId][staker].amount;
    }

    function stakeDetailsOf(bytes32 keywordId, address staker)
        external
        view
        returns (
            uint256 amount,
            uint256 bidUsd,
            uint256 requiredCoveragePre,
            bool eligible,
            uint256 withdrawAvailableAt,
            uint256 positionVersion
        )
    {
        Position storage position = _positions[keywordId][staker];
        return (
            position.amount,
            position.bidUsd,
            position.requiredCoveragePre,
            _isEligible(position),
            position.withdrawAvailableAt,
            position.version
        );
    }

    function topStakeOf(bytes32 keywordId) external view returns (StakingDetails memory) {
        return _topStakes[keywordId];
    }

    function setOperator(address newOperator) external onlyOwner {
        if (newOperator != address(0) && newOperator.code.length != 0) revert InvalidOperator();
        address previousOperator = operator;
        operator = newOperator;
        emit OperatorUpdated(previousOperator, newOperator);
    }

    function setMinimumStake(uint256 newMinimumStake) external onlyOwner {
        if (newMinimumStake == 0) revert ZeroAmount();
        uint256 previousMinimum = minimumStake;
        minimumStake = newMinimumStake;
        emit MinimumStakeUpdated(previousMinimum, newMinimumStake);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    function _isEligible(Position storage position) private view returns (bool) {
        return position.amount != 0 && position.withdrawAvailableAt == 0
            && position.amount >= position.requiredCoveragePre;
    }

    function _clearPosition(Position storage position) private {
        position.amount = 0;
        position.bidUsd = 0;
        position.requiredCoveragePre = 0;
        position.withdrawAvailableAt = 0;
    }

    function _emitPositionChanged(bytes32 keywordId, address staker, uint256 previousStake, Position storage position)
        private
    {
        emit PositionChanged(
            keywordId,
            staker,
            position.bidUsd,
            _isEligible(position),
            position.amount,
            position.version,
            previousStake,
            position.requiredCoveragePre,
            position.withdrawAvailableAt
        );
    }

    function _receiveExact(uint256 amount) private {
        uint256 beforeBalance = PRE.balanceOf(address(this));
        PRE.safeTransferFrom(msg.sender, address(this), amount);
        if (PRE.balanceOf(address(this)) - beforeBalance != amount) revert TransferAmountMismatch();
    }

    function _syncStakers(bytes32 keywordId, address staker, Position storage position) private {
        if (!_isEligible(position)) {
            _removeStaker(keywordId, staker);
            return;
        }

        uint256 indexPlusOne = _heapIndex[keywordId][staker];
        if (indexPlusOne == 0) {
            _stakers[keywordId].push(staker);
            indexPlusOne = _stakers[keywordId].length;
            _heapIndex[keywordId][staker] = indexPlusOne;
        }
        _repairHeap(keywordId, indexPlusOne - 1);
    }

    function _removeStaker(bytes32 keywordId, address staker) private {
        uint256 indexPlusOne = _heapIndex[keywordId][staker];
        if (indexPlusOne == 0) return;
        address[] storage stakers = _stakers[keywordId];
        uint256 index = indexPlusOne - 1;
        uint256 lastIndex = stakers.length - 1;
        if (index != lastIndex) {
            address replacement = stakers[lastIndex];
            stakers[index] = replacement;
            _heapIndex[keywordId][replacement] = indexPlusOne;
        }
        stakers.pop();
        delete _heapIndex[keywordId][staker];
        if (index < stakers.length) _repairHeap(keywordId, index);
    }

    /// @dev Only eligible positions enter the heap; each mutation repairs one O(log n) path.
    function _repairHeap(bytes32 keywordId, uint256 index) private {
        address[] storage stakers = _stakers[keywordId];
        if (index != 0 && _higher(keywordId, stakers[index], stakers[(index - 1) / 2])) {
            while (index != 0) {
                uint256 parent = (index - 1) / 2;
                if (!_higher(keywordId, stakers[index], stakers[parent])) break;
                _swapHeap(keywordId, index, parent);
                index = parent;
            }
            return;
        }

        while (index * 2 + 1 < stakers.length) {
            uint256 child = index * 2 + 1;
            uint256 right = child + 1;
            if (right < stakers.length && _higher(keywordId, stakers[right], stakers[child])) child = right;
            if (!_higher(keywordId, stakers[child], stakers[index])) break;
            _swapHeap(keywordId, index, child);
            index = child;
        }
    }

    function _swapHeap(bytes32 keywordId, uint256 first, uint256 second) private {
        address[] storage stakers = _stakers[keywordId];
        address firstStaker = stakers[first];
        address secondStaker = stakers[second];
        stakers[first] = secondStaker;
        stakers[second] = firstStaker;
        _heapIndex[keywordId][firstStaker] = second + 1;
        _heapIndex[keywordId][secondStaker] = first + 1;
    }

    function _higher(bytes32 keywordId, address first, address second) private view returns (bool) {
        uint256 firstBid = _positions[keywordId][first].bidUsd;
        uint256 secondBid = _positions[keywordId][second].bidUsd;
        return firstBid > secondBid || (firstBid == secondBid && uint160(first) < uint160(second));
    }

    function _refreshTop(bytes32 keywordId) private {
        StakingDetails memory previousTop = _topStakes[keywordId];
        address[] storage stakers = _stakers[keywordId];
        address bestStaker = stakers.length == 0 ? address(0) : stakers[0];

        if (bestStaker == address(0)) {
            delete _topStakes[keywordId];
        } else {
            Position storage position = _positions[keywordId][bestStaker];
            _topStakes[keywordId] = StakingDetails({
                staker: bestStaker,
                amount: position.amount,
                bidUsd: position.bidUsd,
                requiredCoveragePre: position.requiredCoveragePre,
                positionVersion: position.version
            });
        }

        StakingDetails memory currentTop = _topStakes[keywordId];
        if (previousTop.staker != currentTop.staker || previousTop.bidUsd != currentTop.bidUsd) {
            emit TopStakeChanged(
                keywordId,
                currentTop.staker,
                currentTop.bidUsd,
                previousTop.staker,
                previousTop.bidUsd
            );
        }
    }
}
