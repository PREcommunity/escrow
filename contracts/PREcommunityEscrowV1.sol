// SPDX-License-Identifier: MIT
pragma solidity 0.8.36;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PREcommunityEscrowV1
/// @notice Base escrow for transparent, non-refundable PRE and USDC community goals.
/// @dev GoalCreated and the monthly lifecycle events contain the fields required to rebuild the public ledger.
contract PREcommunityEscrowV1 is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_TITLE_BYTES = 96;
    uint256 public constant MAX_DESCRIPTION_BYTES = 512;
    uint256 public constant MAX_METADATA_URI_BYTES = 200;
    uint256 public constant MAX_PROFILE_NAME_BYTES = 80;
    uint256 public constant MAX_PROFILE_URL_BYTES = 200;
    uint256 public constant MAX_PROFILE_BIO_BYTES = 500;
    uint256 public constant MAX_PROFILE_AVATAR_URI_BYTES = 200;
    uint8 public constant MAX_MONTHLY_PERIODS_PER_SETTLEMENT = 24;
    uint8 public constant MONTHLY_SCHEDULE_VERSION = 1;
    uint64 public constant MIN_FIRST_SETTLEMENT_DELAY = 7 days;
    uint64 public constant MAX_FIRST_SETTLEMENT_DELAY = 60 days;

    uint256 private constant _SECONDS_PER_DAY = 24 hours;
    int256 private constant _OFFSET_19700101 = 2_440_588;

    uint256 public maxOpenGoalsPerManager = 3;

    enum GoalStatus {
        None,
        Open,
        Closed,
        Cancelled
    }

    enum GoalType {
        OneTime,
        Monthly
    }

    enum SurplusPolicy {
        PayoutAll,
        RollOver
    }

    struct Goal {
        address creator;
        address recipient;
        address payoutRecipient;
        uint64 deadline;
        GoalType goalType;
        GoalStatus status;
        uint256 preTarget;
        uint256 usdcTarget;
        uint256 preContributed;
        uint256 usdcContributed;
        uint256 preRecipientEntitlement;
        uint256 usdcRecipientEntitlement;
        uint256 preReleasedExpense;
        uint256 usdcReleasedExpense;
        uint256 preTreasuryEntitlement;
        uint256 usdcTreasuryEntitlement;
        uint256 preReleasedCancelledFunds;
        uint256 usdcReleasedCancelledFunds;
        string title;
        string description;
        string metadataURI;
    }

    struct MonthlyGoal {
        uint64 periodStart;
        uint32 periodsSettled;
        uint8 settlementDay;
        SurplusPolicy surplusPolicy;
        bool stopRequested;
        uint256 preCurrentContributed;
        uint256 usdcCurrentContributed;
        uint256 preCarry;
        uint256 usdcCarry;
    }

    struct CommunityProfile {
        bool active;
        uint64 revision;
        string displayName;
        string websiteUrl;
        string bio;
        string avatarURI;
        bool defaultPublic;
    }

    IERC20 public immutable PRE;
    IERC20 public immutable USDC;
    address public immutable TREASURY;

    address public treasuryPayout;
    mapping(address token => uint256) public accountedByToken;
    mapping(address account => bool) public goalManagers;
    mapping(address creator => uint256) public openGoalCountByCreator;

    mapping(bytes32 goalId => Goal) private _goals;
    mapping(bytes32 goalId => MonthlyGoal) private _monthlyGoals;
    mapping(address account => CommunityProfile) private _profiles;

    error ZeroAmount();
    error GoalExpired();
    error GoalNotOpen();
    error InvalidGoal();
    error ZeroAddress();
    error InvalidTitle();
    error GoalNotClosed();
    error GoalNotCancelled();
    error InvalidDeadline();
    error UnsupportedToken();
    error GoalAlreadyExists();
    error ProfileBioTooLong();
    error DescriptionTooLong();
    error InvalidMetadataURI();
    error UnauthorizedRelease();
    error ExpenseLimitExceeded();
    error InvalidPayoutAddress();
    error InvalidTokenContract();
    error CancelledFundsLimitExceeded();
    error FundingChannelDisabled();
    error TransferAmountMismatch();
    error InvalidProfileAvatarURI();
    error ExcessBalanceUnavailable();
    error InvalidProfileWebsiteURL();
    error InvalidProfileDisplayName();
    error UnauthorizedPayoutController();
    error OwnershipRenunciationDisabled();
    error InvalidGoalType(GoalType expected, GoalType actual);
    error FirstSettlementNotUtcMidnight(uint64 firstSettlementAt);
    error FirstSettlementOutOfRange(uint64 firstSettlementAt, uint256 minimum, uint256 maximum);
    error MonthlySettlementRequired(uint64 endedAt);
    error MonthlyPeriodNotEnded(uint64 endsAt);
    error InvalidSettlementLimit(uint8 requested, uint8 maximum);
    error MonthlyGoalStopping();
    error UnauthorizedGoalManager(address account);
    error InvalidControllerAddress(address controller);
    error GoalManagerLimitReached(address manager, uint256 limit);
    error UnauthorizedGoalController(bytes32 goalId, address account);
    error InvalidTokenDecimals(address token, uint8 expected, uint8 actual);

    event GoalCancelled(bytes32 indexed goalId);
    event GoalManagerUpdated(address indexed account, bool enabled);
    event ProfileCleared(address indexed account, uint64 indexed revision);
    event MaxOpenGoalsPerManagerUpdated(uint256 previousLimit, uint256 newLimit);
    event TreasuryPayoutUpdated(address indexed previousPayout, address indexed newPayout);
    event ExcessTokenRecovered(address indexed token, address indexed recipient, uint256 amount);
    event GoalClosed(bytes32 indexed goalId, uint256 preRecipientEntitlement, uint256 usdcRecipientEntitlement);
    event GoalPayoutUpdated(bytes32 indexed goalId, address indexed previousPayout, address indexed newPayout);
    event CancelledFundsReleased(
        bytes32 indexed goalId,
        address indexed token,
        address indexed treasury,
        address payoutRecipient,
        uint256 amount
    );
    event ExpenseReleased(
        bytes32 indexed goalId,
        address indexed token,
        address indexed recipient,
        address payoutRecipient,
        uint256 amount
    );
    event ContributionReceived(
        bytes32 indexed goalId,
        address indexed contributor,
        address indexed token,
        uint256 amount,
        bool profileVisible
    );
    event ProfileUpdated(
        address indexed account,
        uint64 indexed revision,
        string displayName,
        string websiteUrl,
        string bio,
        string avatarURI,
        bool defaultPublic
    );
    event GoalCreated(
        bytes32 indexed goalId,
        address indexed creator,
        address indexed recipient,
        address payoutRecipient,
        uint256 preTarget,
        uint256 usdcTarget,
        uint64 deadline,
        string title,
        string description,
        string metadataURI
    );
    event MonthlyGoalCreated(
        bytes32 indexed goalId,
        uint64 indexed periodStart,
        uint64 periodEnd,
        uint8 settlementDay,
        SurplusPolicy surplusPolicy
    );
    event MonthlySurplusPolicyUpdated(
        bytes32 indexed goalId,
        SurplusPolicy previousPolicy,
        SurplusPolicy newPolicy
    );
    event MonthlyGoalStopRequested(bytes32 indexed goalId, uint64 indexed periodEnd);
    event MonthlyGoalCancelled(
        bytes32 indexed goalId,
        uint256 preTreasuryEntitlementAdded,
        uint256 usdcTreasuryEntitlementAdded
    );
    event MonthlyPeriodSettled(
        bytes32 indexed goalId,
        uint32 indexed periodIndex,
        uint64 periodStart,
        uint64 periodEnd,
        SurplusPolicy surplusPolicy,
        bool finalPeriod
    );
    event MonthlyTokenSettled(
        bytes32 indexed goalId,
        uint32 indexed periodIndex,
        address indexed token,
        uint256 periodContributed,
        uint256 carryIn,
        uint256 recipientEntitlementAdded,
        uint256 carryOut
    );

    modifier onlyGoalManager() {
        if (msg.sender != owner() && !goalManagers[msg.sender]) revert UnauthorizedGoalManager(msg.sender);
        _;
    }

    modifier onlyGoalController(bytes32 goalId) {
        if (msg.sender != owner()) {
            if (!goalManagers[msg.sender]) revert UnauthorizedGoalManager(msg.sender);
            if (_goals[goalId].creator != msg.sender) revert UnauthorizedGoalController(goalId, msg.sender);
        }
        _;
    }

    constructor(address initialOwner, address pre, address usdc, address projectTreasury) Ownable(initialOwner) {
        if (
            initialOwner == address(0) ||
            pre == address(0) ||
            usdc == address(0) ||
            projectTreasury == address(0)
        ) revert ZeroAddress();
        if (pre == usdc) revert UnsupportedToken();
        if (projectTreasury == address(this)) revert InvalidPayoutAddress();
        if (initialOwner == address(this) || initialOwner == pre || initialOwner == usdc) {
            revert InvalidControllerAddress(initialOwner);
        }
        if (projectTreasury == pre || projectTreasury == usdc) revert InvalidControllerAddress(projectTreasury);
        _validateToken(pre, 18);
        _validateToken(usdc, 6);
        PRE = IERC20(pre);
        USDC = IERC20(usdc);
        TREASURY = projectTreasury;
        treasuryPayout = projectTreasury;
    }

    function createGoal(
        bytes32 goalId,
        address recipient,
        uint256 preTarget,
        uint256 usdcTarget,
        uint64 deadline,
        string calldata title,
        string calldata description,
        string calldata metadataURI
    ) external onlyGoalManager whenNotPaused {
        if (deadline <= block.timestamp) revert InvalidDeadline();
        _validateNewGoal(goalId, recipient, preTarget, usdcTarget, title, description, metadataURI);
        _storeGoal(
            goalId,
            recipient,
            preTarget,
            usdcTarget,
            deadline,
            GoalType.OneTime,
            title,
            description,
            metadataURI
        );
    }

    function createMonthlyGoal(
        bytes32 goalId,
        address recipient,
        uint256 preMonthlyTarget,
        uint256 usdcMonthlyTarget,
        uint64 firstSettlementAt,
        SurplusPolicy surplusPolicy,
        string calldata title,
        string calldata description,
        string calldata metadataURI
    ) external onlyGoalManager whenNotPaused {
        _validateNewGoal(
            goalId,
            recipient,
            preMonthlyTarget,
            usdcMonthlyTarget,
            title,
            description,
            metadataURI
        );

        uint64 periodStart = uint64(block.timestamp);
        uint8 settlementDay;
        uint64 periodEnd;
        if (firstSettlementAt == 0) {
            (,, uint256 creationDay) = _daysToDate(block.timestamp / _SECONDS_PER_DAY);
            settlementDay = uint8(creationDay);
            periodEnd = _nextMonthlySettlement(periodStart, settlementDay);
        } else {
            uint256 minimum = block.timestamp + MIN_FIRST_SETTLEMENT_DELAY;
            uint256 maximum = block.timestamp + MAX_FIRST_SETTLEMENT_DELAY;
            if (firstSettlementAt < minimum || firstSettlementAt > maximum) {
                revert FirstSettlementOutOfRange(firstSettlementAt, minimum, maximum);
            }
            if (firstSettlementAt % _SECONDS_PER_DAY != 0) {
                revert FirstSettlementNotUtcMidnight(firstSettlementAt);
            }
            (,, uint256 selectedDay) = _daysToDate(uint256(firstSettlementAt) / _SECONDS_PER_DAY);
            settlementDay = uint8(selectedDay);
            periodEnd = firstSettlementAt;
        }
        _storeGoal(
            goalId,
            recipient,
            preMonthlyTarget,
            usdcMonthlyTarget,
            periodEnd,
            GoalType.Monthly,
            title,
            description,
            metadataURI
        );

        MonthlyGoal storage monthlyData = _monthlyGoals[goalId];
        monthlyData.periodStart = periodStart;
        monthlyData.settlementDay = settlementDay;
        monthlyData.surplusPolicy = surplusPolicy;
        emit MonthlyGoalCreated(goalId, periodStart, periodEnd, settlementDay, surplusPolicy);
    }

    /// @notice Contributes to an open goal. Reaching or exceeding a target does not close the goal.
    function contribute(bytes32 goalId, address token, uint256 amount, bool profileVisible)
        external
        nonReentrant
        whenNotPaused
    {
        Goal storage goalData = _goals[goalId];
        if (goalData.status != GoalStatus.Open) revert GoalNotOpen();

        if (goalData.goalType == GoalType.Monthly) {
            if (block.timestamp >= goalData.deadline) revert MonthlySettlementRequired(goalData.deadline);
        } else if (block.timestamp >= goalData.deadline) {
            revert GoalExpired();
        }

        if (amount == 0) revert ZeroAmount();
        IERC20 asset = _asset(token);
        if (token == address(PRE) ? goalData.preTarget == 0 : goalData.usdcTarget == 0) {
            revert FundingChannelDisabled();
        }

        uint256 beforeBalance = asset.balanceOf(address(this));
        asset.safeTransferFrom(msg.sender, address(this), amount);
        if (asset.balanceOf(address(this)) - beforeBalance != amount) revert TransferAmountMismatch();

        if (token == address(PRE)) {
            goalData.preContributed += amount;
            if (goalData.goalType == GoalType.Monthly) {
                _monthlyGoals[goalId].preCurrentContributed += amount;
            }
        } else {
            goalData.usdcContributed += amount;
            if (goalData.goalType == GoalType.Monthly) {
                _monthlyGoals[goalId].usdcCurrentContributed += amount;
            }
        }
        accountedByToken[token] += amount;
        emit ContributionReceived(goalId, msg.sender, token, amount, profileVisible);
    }

    /// @notice Creates or replaces the caller's public community profile.
    /// @dev Profile fields are byte-length bounded only. Clients must validate and safely render their contents.
    ///      Profile writes are independent from escrow accounting and remain available while paused.
    function setProfile(
        string calldata displayName,
        string calldata websiteUrl,
        string calldata bio,
        string calldata avatarURI,
        bool defaultPublic
    ) external {
        bytes calldata displayNameBytes = bytes(displayName);
        bytes calldata websiteUrlBytes = bytes(websiteUrl);
        bytes calldata bioBytes = bytes(bio);
        bytes calldata avatarURIBytes = bytes(avatarURI);

        if (displayNameBytes.length == 0 || displayNameBytes.length > MAX_PROFILE_NAME_BYTES) {
            revert InvalidProfileDisplayName();
        }
        if (websiteUrlBytes.length > MAX_PROFILE_URL_BYTES) revert InvalidProfileWebsiteURL();
        if (bioBytes.length > MAX_PROFILE_BIO_BYTES) revert ProfileBioTooLong();
        if (avatarURIBytes.length > MAX_PROFILE_AVATAR_URI_BYTES) revert InvalidProfileAvatarURI();

        CommunityProfile storage profile = _profiles[msg.sender];
        uint64 revision = profile.revision + 1;
        profile.active = true;
        profile.revision = revision;
        profile.displayName = displayName;
        profile.websiteUrl = websiteUrl;
        profile.bio = bio;
        profile.avatarURI = avatarURI;
        profile.defaultPublic = defaultPublic;

        emit ProfileUpdated(msg.sender, revision, displayName, websiteUrl, bio, avatarURI, defaultPublic);
    }

    /// @notice Clears the caller's current profile without removing its historical events.
    function clearProfile() external {
        CommunityProfile storage profile = _profiles[msg.sender];
        uint64 revision = profile.revision + 1;
        profile.active = false;
        profile.revision = revision;
        delete profile.displayName;
        delete profile.websiteUrl;
        delete profile.bio;
        delete profile.avatarURI;
        profile.defaultPublic = false;

        emit ProfileCleared(msg.sender, revision);
    }

    /// @notice Manually closes a one-time goal and assigns every contribution to its beneficiary.
    function closeGoal(bytes32 goalId) external nonReentrant onlyGoalController(goalId) whenNotPaused {
        Goal storage goalData = _goals[goalId];
        if (goalData.status != GoalStatus.Open) revert GoalNotOpen();
        _requireGoalType(goalData, GoalType.OneTime);

        goalData.preRecipientEntitlement = goalData.preContributed;
        goalData.usdcRecipientEntitlement = goalData.usdcContributed;
        _closeGoal(goalId, goalData);
    }

    function cancelGoal(bytes32 goalId) external nonReentrant onlyGoalController(goalId) whenNotPaused {
        Goal storage goalData = _goals[goalId];
        if (goalData.status != GoalStatus.Open) revert GoalNotOpen();
        _requireGoalType(goalData, GoalType.OneTime);

        goalData.preTreasuryEntitlement = goalData.preContributed;
        goalData.usdcTreasuryEntitlement = goalData.usdcContributed;
        _cancelGoal(goalId, goalData);
    }

    function setMonthlySurplusPolicy(bytes32 goalId, SurplusPolicy newPolicy)
        external
        nonReentrant
        onlyGoalController(goalId)
        whenNotPaused
    {
        Goal storage goalData = _goals[goalId];
        if (goalData.status != GoalStatus.Open) revert GoalNotOpen();
        _requireGoalType(goalData, GoalType.Monthly);
        if (block.timestamp >= goalData.deadline) revert MonthlySettlementRequired(goalData.deadline);

        MonthlyGoal storage monthlyData = _monthlyGoals[goalId];
        if (monthlyData.stopRequested) revert MonthlyGoalStopping();
        SurplusPolicy previousPolicy = monthlyData.surplusPolicy;
        monthlyData.surplusPolicy = newPolicy;
        emit MonthlySurplusPolicyUpdated(goalId, previousPolicy, newPolicy);
    }

    function requestMonthlyGoalStop(bytes32 goalId)
        external
        nonReentrant
        onlyGoalController(goalId)
        whenNotPaused
    {
        Goal storage goalData = _goals[goalId];
        if (goalData.status != GoalStatus.Open) revert GoalNotOpen();
        _requireGoalType(goalData, GoalType.Monthly);
        if (block.timestamp >= goalData.deadline) revert MonthlySettlementRequired(goalData.deadline);

        MonthlyGoal storage monthlyData = _monthlyGoals[goalId];
        if (monthlyData.stopRequested) revert MonthlyGoalStopping();
        monthlyData.stopRequested = true;
        emit MonthlyGoalStopRequested(goalId, goalData.deadline);
    }

    /// @notice Settles up to maxPeriods elapsed calendar months without transferring tokens.
    function settleMonthlyGoal(bytes32 goalId, uint8 maxPeriods)
        external
        nonReentrant
        whenNotPaused
        returns (uint8 periodsProcessed)
    {
        if (maxPeriods == 0 || maxPeriods > MAX_MONTHLY_PERIODS_PER_SETTLEMENT) {
            revert InvalidSettlementLimit(maxPeriods, MAX_MONTHLY_PERIODS_PER_SETTLEMENT);
        }

        Goal storage goalData = _goals[goalId];
        if (goalData.status != GoalStatus.Open) revert GoalNotOpen();
        _requireGoalType(goalData, GoalType.Monthly);
        if (block.timestamp < goalData.deadline) revert MonthlyPeriodNotEnded(goalData.deadline);

        MonthlyGoal storage monthlyData = _monthlyGoals[goalId];
        uint64 periodStart = monthlyData.periodStart;
        uint64 periodEnd = goalData.deadline;
        uint32 periodIndex = monthlyData.periodsSettled;
        uint256 preCurrent = monthlyData.preCurrentContributed;
        uint256 usdcCurrent = monthlyData.usdcCurrentContributed;
        uint256 preCarry = monthlyData.preCarry;
        uint256 usdcCarry = monthlyData.usdcCarry;
        uint256 preEntitlementAdded;
        uint256 usdcEntitlementAdded;
        bool goalClosed;

        while (periodsProcessed < maxPeriods && block.timestamp >= periodEnd) {
            bool finalPeriod = monthlyData.stopRequested;
            uint256 preCarryIn = preCarry;
            uint256 usdcCarryIn = usdcCarry;
            uint256 preAdded;
            uint256 usdcAdded;
            (preAdded, preCarry) = _monthlyAllocation(
                preCurrent + preCarryIn,
                goalData.preTarget,
                monthlyData.surplusPolicy,
                finalPeriod
            );
            (usdcAdded, usdcCarry) = _monthlyAllocation(
                usdcCurrent + usdcCarryIn,
                goalData.usdcTarget,
                monthlyData.surplusPolicy,
                finalPeriod
            );

            periodIndex += 1;
            periodsProcessed += 1;
            preEntitlementAdded += preAdded;
            usdcEntitlementAdded += usdcAdded;
            emit MonthlyPeriodSettled(
                goalId,
                periodIndex,
                periodStart,
                periodEnd,
                monthlyData.surplusPolicy,
                finalPeriod
            );
            emit MonthlyTokenSettled(
                goalId,
                periodIndex,
                address(PRE),
                preCurrent,
                preCarryIn,
                preAdded,
                preCarry
            );
            emit MonthlyTokenSettled(
                goalId,
                periodIndex,
                address(USDC),
                usdcCurrent,
                usdcCarryIn,
                usdcAdded,
                usdcCarry
            );

            preCurrent = 0;
            usdcCurrent = 0;
            if (finalPeriod) {
                goalClosed = true;
                break;
            }
            periodStart = periodEnd;
            periodEnd = _nextMonthlySettlement(periodEnd, monthlyData.settlementDay);
        }

        goalData.preRecipientEntitlement += preEntitlementAdded;
        goalData.usdcRecipientEntitlement += usdcEntitlementAdded;
        monthlyData.periodStart = periodStart;
        monthlyData.periodsSettled = periodIndex;
        monthlyData.preCurrentContributed = preCurrent;
        monthlyData.usdcCurrentContributed = usdcCurrent;
        monthlyData.preCarry = preCarry;
        monthlyData.usdcCarry = usdcCarry;

        if (goalClosed) {
            _closeGoal(goalId, goalData);
        } else {
            goalData.deadline = periodEnd;
        }
    }

    /// @notice Immediately cancels a monthly goal and routes only its unallocated balance to treasury.
    function cancelMonthlyGoal(bytes32 goalId) external onlyOwner nonReentrant whenNotPaused {
        Goal storage goalData = _goals[goalId];
        if (goalData.status != GoalStatus.Open) revert GoalNotOpen();
        _requireGoalType(goalData, GoalType.Monthly);
        if (block.timestamp >= goalData.deadline) revert MonthlySettlementRequired(goalData.deadline);

        MonthlyGoal storage monthlyData = _monthlyGoals[goalId];
        uint256 preTreasuryAdded = monthlyData.preCurrentContributed + monthlyData.preCarry;
        uint256 usdcTreasuryAdded = monthlyData.usdcCurrentContributed + monthlyData.usdcCarry;
        goalData.preTreasuryEntitlement += preTreasuryAdded;
        goalData.usdcTreasuryEntitlement += usdcTreasuryAdded;
        monthlyData.preCurrentContributed = 0;
        monthlyData.usdcCurrentContributed = 0;
        monthlyData.preCarry = 0;
        monthlyData.usdcCarry = 0;

        _cancelGoal(goalId, goalData);
        emit MonthlyGoalCancelled(goalId, preTreasuryAdded, usdcTreasuryAdded);
    }

    /// @notice Releases vested funds to a beneficiary while preserving monthly carry accounting.
    function releaseExpense(bytes32 goalId, address token, uint256 amount) external nonReentrant whenNotPaused {
        Goal storage goalData = _goals[goalId];
        if (goalData.status == GoalStatus.None) revert InvalidGoal();
        if (goalData.goalType == GoalType.OneTime && goalData.status != GoalStatus.Closed) revert GoalNotClosed();
        if (msg.sender != owner() && msg.sender != goalData.recipient) revert UnauthorizedRelease();
        if (amount == 0) revert ZeroAmount();
        IERC20 asset = _asset(token);

        if (token == address(PRE)) {
            uint256 available = goalData.preRecipientEntitlement - goalData.preReleasedExpense;
            if (amount > available) revert ExpenseLimitExceeded();
            goalData.preReleasedExpense += amount;
        } else {
            uint256 available = goalData.usdcRecipientEntitlement - goalData.usdcReleasedExpense;
            if (amount > available) revert ExpenseLimitExceeded();
            goalData.usdcReleasedExpense += amount;
        }
        accountedByToken[token] -= amount;

        address payoutRecipient = goalData.payoutRecipient;
        _transferExact(asset, payoutRecipient, amount);
        emit ExpenseReleased(goalId, token, goalData.recipient, payoutRecipient, amount);
    }

    /// @notice Releases treasury-entitled funds from a cancelled goal.
    function releaseCancelledFunds(bytes32 goalId, address token, uint256 amount)
        external
        nonReentrant
        whenNotPaused
    {
        Goal storage goalData = _goals[goalId];
        if (goalData.status != GoalStatus.Cancelled) revert GoalNotCancelled();
        if (msg.sender != owner() && msg.sender != TREASURY) revert UnauthorizedRelease();
        if (amount == 0) revert ZeroAmount();
        IERC20 asset = _asset(token);

        if (token == address(PRE)) {
            uint256 available = goalData.preTreasuryEntitlement - goalData.preReleasedCancelledFunds;
            if (amount > available) revert CancelledFundsLimitExceeded();
            goalData.preReleasedCancelledFunds += amount;
        } else {
            uint256 available = goalData.usdcTreasuryEntitlement - goalData.usdcReleasedCancelledFunds;
            if (amount > available) revert CancelledFundsLimitExceeded();
            goalData.usdcReleasedCancelledFunds += amount;
        }
        accountedByToken[token] -= amount;

        address payoutRecipient = treasuryPayout;
        _transferExact(asset, payoutRecipient, amount);
        emit CancelledFundsReleased(goalId, token, TREASURY, payoutRecipient, amount);
    }

    function recoverExcessToken(address token, address recipient, uint256 amount)
        external
        onlyOwner
        nonReentrant
        whenNotPaused
    {
        if (recipient == address(0)) revert ZeroAddress();
        _validatePayoutAddress(recipient);
        if (amount == 0) revert ZeroAmount();
        IERC20 asset = _asset(token);
        uint256 accounted = accountedByToken[token];
        uint256 balance = asset.balanceOf(address(this));
        uint256 available = balance > accounted ? balance - accounted : 0;
        if (amount > available) revert ExcessBalanceUnavailable();

        _transferExact(asset, recipient, amount);
        emit ExcessTokenRecovered(token, recipient, amount);
    }

    function setGoalManager(address account, bool enabled) external onlyOwner {
        if (account == address(0)) revert ZeroAddress();
        goalManagers[account] = enabled;
        emit GoalManagerUpdated(account, enabled);
    }

    function setMaxOpenGoalsPerManager(uint256 newLimit) external onlyOwner {
        uint256 previousLimit = maxOpenGoalsPerManager;
        maxOpenGoalsPerManager = newLimit;
        emit MaxOpenGoalsPerManagerUpdated(previousLimit, newLimit);
    }

    /// @notice Changes only the payment destination; the goal beneficiary remains immutable.
    /// @dev The beneficiary can rotate away from an address rejected by a supported token.
    function setGoalPayout(bytes32 goalId, address newPayout) external nonReentrant {
        Goal storage goalData = _goals[goalId];
        if (goalData.status == GoalStatus.None) revert InvalidGoal();
        if (msg.sender != goalData.recipient) revert UnauthorizedPayoutController();
        _validatePayoutAddress(newPayout);

        address previousPayout = goalData.payoutRecipient;
        goalData.payoutRecipient = newPayout;
        emit GoalPayoutUpdated(goalId, previousPayout, newPayout);
    }

    /// @notice Changes only the treasury payment destination; treasury control remains immutable.
    function setTreasuryPayout(address newPayout) external nonReentrant {
        if (msg.sender != TREASURY) revert UnauthorizedPayoutController();
        _validatePayoutAddress(newPayout);

        address previousPayout = treasuryPayout;
        treasuryPayout = newPayout;
        emit TreasuryPayoutUpdated(previousPayout, newPayout);
    }

    function pause() external onlyOwner { _pause(); }
    function unpause() external onlyOwner { _unpause(); }

    function renounceOwnership() public view override onlyOwner {
        revert OwnershipRenunciationDisabled();
    }

    function goal(bytes32 goalId) external view returns (Goal memory) { return _goals[goalId]; }
    function monthlyGoal(bytes32 goalId) external view returns (MonthlyGoal memory) {
        Goal storage goalData = _goals[goalId];
        if (goalData.status == GoalStatus.None) revert InvalidGoal();
        _requireGoalType(goalData, GoalType.Monthly);
        return _monthlyGoals[goalId];
    }
    function getProfile(address account) external view returns (CommunityProfile memory) { return _profiles[account]; }

    function _validateNewGoal(
        bytes32 goalId,
        address recipient,
        uint256 preTarget,
        uint256 usdcTarget,
        string calldata title,
        string calldata description,
        string calldata metadataURI
    ) private view {
        if (goalId == bytes32(0) || recipient == address(0)) revert InvalidGoal();
        _validatePayoutAddress(recipient);
        if (_goals[goalId].status != GoalStatus.None) revert GoalAlreadyExists();
        if (preTarget == 0 && usdcTarget == 0) revert ZeroAmount();
        if (bytes(title).length == 0 || bytes(title).length > MAX_TITLE_BYTES) revert InvalidTitle();
        if (bytes(description).length > MAX_DESCRIPTION_BYTES) revert DescriptionTooLong();
        if (bytes(metadataURI).length > MAX_METADATA_URI_BYTES) revert InvalidMetadataURI();
        if (msg.sender != owner() && openGoalCountByCreator[msg.sender] >= maxOpenGoalsPerManager) {
            revert GoalManagerLimitReached(msg.sender, maxOpenGoalsPerManager);
        }
    }

    function _storeGoal(
        bytes32 goalId,
        address recipient,
        uint256 preTarget,
        uint256 usdcTarget,
        uint64 deadline,
        GoalType goalType,
        string calldata title,
        string calldata description,
        string calldata metadataURI
    ) private {
        Goal storage goalData = _goals[goalId];
        goalData.creator = msg.sender;
        goalData.recipient = recipient;
        goalData.payoutRecipient = recipient;
        goalData.deadline = deadline;
        goalData.goalType = goalType;
        goalData.status = GoalStatus.Open;
        goalData.preTarget = preTarget;
        goalData.usdcTarget = usdcTarget;
        goalData.title = title;
        goalData.description = description;
        goalData.metadataURI = metadataURI;
        openGoalCountByCreator[msg.sender] += 1;
        emit GoalCreated(
            goalId,
            msg.sender,
            recipient,
            recipient,
            preTarget,
            usdcTarget,
            deadline,
            title,
            description,
            metadataURI
        );
    }

    function _closeGoal(bytes32 goalId, Goal storage goalData) private {
        goalData.status = GoalStatus.Closed;
        openGoalCountByCreator[goalData.creator] -= 1;
        emit GoalClosed(goalId, goalData.preRecipientEntitlement, goalData.usdcRecipientEntitlement);
    }

    function _cancelGoal(bytes32 goalId, Goal storage goalData) private {
        goalData.status = GoalStatus.Cancelled;
        openGoalCountByCreator[goalData.creator] -= 1;
        emit GoalCancelled(goalId);
    }

    function _monthlyAllocation(
        uint256 available,
        uint256 target,
        SurplusPolicy surplusPolicy,
        bool finalPeriod
    ) private pure returns (uint256 recipientEntitlement, uint256 carryOut) {
        if (finalPeriod || surplusPolicy == SurplusPolicy.PayoutAll || available <= target) {
            return (available, 0);
        }
        return (target, available - target);
    }

    function _requireGoalType(Goal storage goalData, GoalType expected) private view {
        if (goalData.goalType != expected) revert InvalidGoalType(expected, goalData.goalType);
    }

    function _asset(address token) private view returns (IERC20) {
        if (token != address(PRE) && token != address(USDC)) revert UnsupportedToken();
        return IERC20(token);
    }

    function _nextMonthlySettlement(uint64 currentBoundary, uint8 settlementDay) internal pure returns (uint64) {
        (uint256 year, uint256 month,) = _daysToDate(uint256(currentBoundary) / _SECONDS_PER_DAY);
        if (month == 12) {
            year += 1;
            month = 1;
        } else {
            month += 1;
        }
        uint256 day = settlementDay;
        uint256 lastDay = _daysInMonth(year, month);
        if (day > lastDay) day = lastDay;
        return uint64(_daysFromDate(year, month, day) * _SECONDS_PER_DAY);
    }

    function _daysInMonth(uint256 year, uint256 month) private pure returns (uint256) {
        if (month == 2) {
            bool leapYear = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
            return leapYear ? 29 : 28;
        }
        if (month == 4 || month == 6 || month == 9 || month == 11) return 30;
        return 31;
    }

    // Gregorian date conversion based on the Julian-day algorithms used by BokkyPooBah's DateTime library.
    function _daysFromDate(uint256 year, uint256 month, uint256 day) private pure returns (uint256 daysSinceEpoch) {
        int256 monthOffset = (int256(month) - 14) / 12;
        int256 daysValue = int256(day) - 32_075
            + (1_461 * (int256(year) + 4_800 + monthOffset)) / 4
            + (367 * (int256(month) - 2 - monthOffset * 12)) / 12
            - (3 * ((int256(year) + 4_900 + monthOffset) / 100)) / 4
            - _OFFSET_19700101;
        return uint256(daysValue);
    }

    function _daysToDate(uint256 daysSinceEpoch) private pure returns (uint256 year, uint256 month, uint256 day) {
        int256 value = int256(daysSinceEpoch) + 68_569 + _OFFSET_19700101;
        int256 century = (4 * value) / 146_097;
        value = value - (146_097 * century + 3) / 4;
        int256 yearInCentury = (4_000 * (value + 1)) / 1_461_001;
        value = value - (1_461 * yearInCentury) / 4 + 31;
        int256 monthValue = (80 * value) / 2_447;
        int256 dayValue = value - (2_447 * monthValue) / 80;
        value = monthValue / 11;
        monthValue = monthValue + 2 - 12 * value;
        yearInCentury = 100 * (century - 49) + yearInCentury + value;
        return (uint256(yearInCentury), uint256(monthValue), uint256(dayValue));
    }

    function _validateToken(address token, uint8 expectedDecimals) private view {
        if (token.code.length == 0) revert InvalidTokenContract();

        // Validate returndata before decoding because Solidity try/catch does not catch every ABI decoding failure.
        (bool balanceCallSucceeded, bytes memory balanceData) =
            token.staticcall(abi.encodeCall(IERC20.balanceOf, (address(this))));
        if (!balanceCallSucceeded || balanceData.length != 32) revert InvalidTokenContract();

        (bool decimalsCallSucceeded, bytes memory decimalsData) =
            token.staticcall(abi.encodeCall(IERC20Metadata.decimals, ()));
        if (!decimalsCallSucceeded || decimalsData.length != 32) revert InvalidTokenContract();

        uint256 rawDecimals = abi.decode(decimalsData, (uint256));
        if (rawDecimals > type(uint8).max) revert InvalidTokenContract();
        uint8 actualDecimals = uint8(rawDecimals);
        if (actualDecimals != expectedDecimals) {
            revert InvalidTokenDecimals(token, expectedDecimals, actualDecimals);
        }
    }

    function _validatePayoutAddress(address payout) private view {
        if (
            payout == address(0) ||
            payout == address(this) ||
            payout == address(PRE) ||
            payout == address(USDC)
        ) revert InvalidPayoutAddress();
    }

    function _transferExact(IERC20 asset, address recipient, uint256 amount) private {
        uint256 escrowBefore = asset.balanceOf(address(this));
        uint256 recipientBefore = asset.balanceOf(recipient);
        asset.safeTransfer(recipient, amount);
        uint256 escrowAfter = asset.balanceOf(address(this));
        uint256 recipientAfter = asset.balanceOf(recipient);

        if (
            escrowAfter > escrowBefore || escrowBefore - escrowAfter != amount ||
            recipientAfter < recipientBefore || recipientAfter - recipientBefore != amount
        ) revert TransferAmountMismatch();
    }
}
