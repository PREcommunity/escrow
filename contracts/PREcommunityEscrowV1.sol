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
/// @dev GoalCreated contains every core field required to rebuild the public ledger.
contract PREcommunityEscrowV1 is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    uint256 public constant MAX_TITLE_BYTES = 96;
    uint256 public constant MAX_DESCRIPTION_BYTES = 512;
    uint256 public constant MAX_METADATA_URI_BYTES = 200;
    uint256 public constant MAX_PROFILE_NAME_BYTES = 80;
    uint256 public constant MAX_PROFILE_URL_BYTES = 200;
    uint256 public constant MAX_PROFILE_BIO_BYTES = 500;
    uint256 public constant MAX_PROFILE_AVATAR_URI_BYTES = 200;

    uint256 public maxOpenGoalsPerManager = 3;

    enum GoalStatus {
        None,
        Open,
        Closed,
        Cancelled
    }

    struct Goal {
        address creator;
        address recipient;
        address payoutRecipient;
        uint64 deadline;
        uint256 preTarget;
        uint256 usdcTarget;
        uint256 preContributed;
        uint256 usdcContributed;
        uint256 preReleasedExpense;
        uint256 usdcReleasedExpense;
        uint256 preReleasedSurplus;
        uint256 usdcReleasedSurplus;
        GoalStatus status;
        string title;
        string description;
        string metadataURI;
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
    mapping(address account => CommunityProfile) private _profiles;

    error ZeroAmount();
    error GoalExpired();
    error GoalNotOpen();
    error InvalidGoal();
    error ZeroAddress();
    error InvalidTitle();
    error GoalNotClosed();
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
    error SurplusLimitExceeded();
    error FundingChannelDisabled();
    error TransferAmountMismatch();
    error InvalidProfileAvatarURI();
    error ExcessBalanceUnavailable();
    error InvalidProfileWebsiteURL();
    error InvalidProfileDisplayName();
    error UnauthorizedPayoutController();
    error OwnershipRenunciationDisabled();
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
    event SurplusReleased(
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
        bytes calldata titleBytes = bytes(title);
        bytes calldata descriptionBytes = bytes(description);
        bytes calldata metadataURIBytes = bytes(metadataURI);

        if (goalId == bytes32(0) || recipient == address(0)) revert InvalidGoal();
        _validatePayoutAddress(recipient);
        if (_goals[goalId].status != GoalStatus.None) revert GoalAlreadyExists();
        if (preTarget == 0 && usdcTarget == 0) revert ZeroAmount();
        if (deadline <= block.timestamp) revert InvalidDeadline();
        if (titleBytes.length == 0 || titleBytes.length > MAX_TITLE_BYTES) {
            revert InvalidTitle();
        }
        if (descriptionBytes.length > MAX_DESCRIPTION_BYTES) revert DescriptionTooLong();
        if (metadataURIBytes.length > MAX_METADATA_URI_BYTES) revert InvalidMetadataURI();
        if (msg.sender != owner() && openGoalCountByCreator[msg.sender] >= maxOpenGoalsPerManager) {
            revert GoalManagerLimitReached(msg.sender, maxOpenGoalsPerManager);
        }

        Goal storage goalData = _goals[goalId];
        goalData.creator = msg.sender;
        goalData.recipient = recipient;
        goalData.payoutRecipient = recipient;
        goalData.deadline = deadline;
        goalData.preTarget = preTarget;
        goalData.usdcTarget = usdcTarget;
        goalData.status = GoalStatus.Open;
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

    /// @notice Contributes to an open goal. Reaching or exceeding a target does not close the goal.
    function contribute(bytes32 goalId, address token, uint256 amount, bool profileVisible)
        external
        nonReentrant
        whenNotPaused
    {
        Goal storage goalData = _goals[goalId];
        if (goalData.status != GoalStatus.Open) revert GoalNotOpen();
        if (block.timestamp >= goalData.deadline) revert GoalExpired();
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
            accountedByToken[token] += amount;
        } else {
            goalData.usdcContributed += amount;
            accountedByToken[token] += amount;
        }
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

        if (websiteUrlBytes.length > MAX_PROFILE_URL_BYTES) {
            revert InvalidProfileWebsiteURL();
        }

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

    /// @notice Manually closes a goal and assigns every contributed token to its beneficiary.
    /// @dev May be called before or after the deadline. Targets never cap the beneficiary's entitlement.
    function closeGoal(bytes32 goalId) external nonReentrant onlyGoalController(goalId) whenNotPaused {
        Goal storage goalData = _goals[goalId];
        if (goalData.status != GoalStatus.Open) revert GoalNotOpen();
        goalData.status = GoalStatus.Closed;
        openGoalCountByCreator[goalData.creator] -= 1;
        emit GoalClosed(goalId, goalData.preContributed, goalData.usdcContributed);
    }

    function cancelGoal(bytes32 goalId) external nonReentrant onlyGoalController(goalId) whenNotPaused {
        Goal storage goalData = _goals[goalId];
        if (goalData.status != GoalStatus.Open) revert GoalNotOpen();
        goalData.status = GoalStatus.Cancelled;
        openGoalCountByCreator[goalData.creator] -= 1;
        emit GoalCancelled(goalId);
    }

    /// @notice Releases contributed funds from a closed goal to its beneficiary payout.
    function releaseExpense(bytes32 goalId, address token, uint256 amount) external nonReentrant whenNotPaused {
        Goal storage goalData = _goals[goalId];
        if (goalData.status != GoalStatus.Closed) revert GoalNotClosed();
        if (msg.sender != owner() && msg.sender != goalData.recipient) revert UnauthorizedRelease();
        if (amount == 0) revert ZeroAmount();
        IERC20 asset = _asset(token);

        if (token == address(PRE)) {
            uint256 available = goalData.preContributed - goalData.preReleasedExpense;
            if (amount > available) revert ExpenseLimitExceeded();
            goalData.preReleasedExpense += amount;
            accountedByToken[token] -= amount;
        } else {
            uint256 available = goalData.usdcContributed - goalData.usdcReleasedExpense;
            if (amount > available) revert ExpenseLimitExceeded();
            goalData.usdcReleasedExpense += amount;
            accountedByToken[token] -= amount;
        }

        address payoutRecipient = goalData.payoutRecipient;
        _transferExact(asset, payoutRecipient, amount);
        emit ExpenseReleased(goalId, token, goalData.recipient, payoutRecipient, amount);
    }

    /// @notice Releases contributed funds from a cancelled goal to the treasury payout.
    function releaseSurplus(bytes32 goalId, address token, uint256 amount) external nonReentrant whenNotPaused {
        Goal storage goalData = _goals[goalId];
        if (goalData.status != GoalStatus.Cancelled) revert GoalNotClosed();
        if (msg.sender != owner() && msg.sender != TREASURY) revert UnauthorizedRelease();
        if (amount == 0) revert ZeroAmount();
        IERC20 asset = _asset(token);

        if (token == address(PRE)) {
            uint256 available = goalData.preContributed - goalData.preReleasedSurplus;
            if (amount > available) revert SurplusLimitExceeded();
            goalData.preReleasedSurplus += amount;
            accountedByToken[token] -= amount;
        } else {
            uint256 available = goalData.usdcContributed - goalData.usdcReleasedSurplus;
            if (amount > available) revert SurplusLimitExceeded();
            goalData.usdcReleasedSurplus += amount;
            accountedByToken[token] -= amount;
        }

        address payoutRecipient = treasuryPayout;
        _transferExact(asset, payoutRecipient, amount);
        emit SurplusReleased(goalId, token, TREASURY, payoutRecipient, amount);
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
    function getProfile(address account) external view returns (CommunityProfile memory) { return _profiles[account]; }
    function _asset(address token) private view returns (IERC20) {
        if (token != address(PRE) && token != address(USDC)) revert UnsupportedToken();
        return IERC20(token);
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
