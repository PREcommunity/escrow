import { expect } from 'chai';
import fc from 'fast-check';
import { ethers } from '../scripts/lib/hardhat-runtime';
import type { MockERC20, MockReentrantERC20, MockRestrictedERC20, PREcommunityEscrowV1 } from '../typechain-types';

describe('PREcommunityEscrowV1', () => {
  async function futureDeadline(offset = 7 * 24 * 60 * 60) {
    const block = await ethers.provider.getBlock('latest');
    return BigInt((block?.timestamp ?? 0) + offset);
  }

  async function fixture() {
    const signers = await ethers.getSigners();
    const owner = signers[0]!;
    const sponsor = signers[1]!;
    const recipient = signers[2]!;
    const treasury = signers[3]!;
    const stranger = signers[4]!;
    const Token = await ethers.getContractFactory('MockERC20');
    const pre = await Token.deploy('Presearch', 'PRE', 18) as unknown as MockERC20;
    const usdc = await Token.deploy('USD Coin', 'USDC', 6) as unknown as MockERC20;
    const Escrow = await ethers.getContractFactory('PREcommunityEscrowV1');
    const escrow = await Escrow.deploy(
      owner.address,
      await pre.getAddress(),
      await usdc.getAddress(),
      treasury.address,
    ) as unknown as PREcommunityEscrowV1;
    const goalId = ethers.keccak256(ethers.toUtf8Bytes('precommunity:goal:1'));
    const deadline = await futureDeadline();
    const title = 'Public infrastructure';
    const description = 'Fund verifiable community infrastructure.';
    const metadataURI = 'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3g5lxy4t5c7hr4zy2m4ot6owe';
    await escrow.createGoal(
      goalId,
      recipient.address,
      ethers.parseEther('100'),
      100_000_000n,
      deadline,
      title,
      description,
      metadataURI,
    );
    await pre.mint(sponsor.address, ethers.parseEther('1000'));
    await usdc.mint(sponsor.address, 1_000_000_000n);
    await pre.connect(sponsor).approve(await escrow.getAddress(), ethers.MaxUint256);
    await usdc.connect(sponsor).approve(await escrow.getAddress(), ethers.MaxUint256);
    return { owner, sponsor, recipient, treasury, stranger, pre, usdc, escrow, goalId, deadline, title, description, metadataURI };
  }

  it('emits and stores every core field required to rebuild a goal', async () => {
    const { owner, recipient, escrow } = await fixture();
    const id = ethers.keccak256(ethers.toUtf8Bytes('complete-event'));
    const deadline = await futureDeadline();
    await expect(escrow.createGoal(id, recipient.address, 1n, 2n, deadline, 'Title', 'Description', 'ipfs://metadata'))
      .to.emit(escrow, 'GoalCreated')
      .withArgs(
        id,
        owner.address,
        recipient.address,
        recipient.address,
        1n,
        2n,
        deadline,
        'Title',
        'Description',
        'ipfs://metadata',
      );
    const state = await escrow.goal(id);
    expect(state.creator).to.equal(owner.address);
    expect(state.recipient).to.equal(recipient.address);
    expect(state.payoutRecipient).to.equal(recipient.address);
    expect(state.deadline).to.equal(deadline);
    expect(state.title).to.equal('Title');
    expect(state.description).to.equal('Description');
    expect(state.metadataURI).to.equal('ipfs://metadata');
    expect(await escrow.openGoalCountByCreator(owner.address)).to.equal(2n);
  });

  it('lets only the owner manage goal managers and the shared open-goal limit', async () => {
    const { owner, stranger, escrow } = await fixture();
    const manager = (await ethers.getSigners())[5]!;

    expect(await escrow.maxOpenGoalsPerManager()).to.equal(3n);
    expect(await escrow.goalManagers(manager.address)).to.equal(false);
    await expect(escrow.setGoalManager(manager.address, true))
      .to.emit(escrow, 'GoalManagerUpdated')
      .withArgs(manager.address, true);
    expect(await escrow.goalManagers(manager.address)).to.equal(true);

    await expect(escrow.connect(stranger).setGoalManager(manager.address, false))
      .to.be.revertedWithCustomError(escrow, 'OwnableUnauthorizedAccount')
      .withArgs(stranger.address);
    await expect(escrow.setGoalManager(ethers.ZeroAddress, true))
      .to.be.revertedWithCustomError(escrow, 'ZeroAddress');

    await expect(escrow.setMaxOpenGoalsPerManager(0n))
      .to.emit(escrow, 'MaxOpenGoalsPerManagerUpdated')
      .withArgs(3n, 0n);
    expect(await escrow.maxOpenGoalsPerManager()).to.equal(0n);
    await expect(escrow.connect(stranger).setMaxOpenGoalsPerManager(3n))
      .to.be.revertedWithCustomError(escrow, 'OwnableUnauthorizedAccount')
      .withArgs(stranger.address);

    await expect(escrow.connect(owner).setGoalManager(manager.address, false))
      .to.emit(escrow, 'GoalManagerUpdated')
      .withArgs(manager.address, false);
    expect(await escrow.goalManagers(manager.address)).to.equal(false);
  });

  it('hands ownership over only after the nominated owner accepts it', async () => {
    const { owner, stranger, escrow } = await fixture();
    const nextOwner = (await ethers.getSigners())[5]!;

    await expect(escrow.connect(stranger).transferOwnership(nextOwner.address))
      .to.be.revertedWithCustomError(escrow, 'OwnableUnauthorizedAccount')
      .withArgs(stranger.address);

    await escrow.connect(owner).transferOwnership(nextOwner.address);
    expect(await escrow.owner()).to.equal(owner.address);
    expect(await escrow.pendingOwner()).to.equal(nextOwner.address);

    await expect(escrow.connect(stranger).acceptOwnership())
      .to.be.revertedWithCustomError(escrow, 'OwnableUnauthorizedAccount')
      .withArgs(stranger.address);

    await escrow.connect(nextOwner).acceptOwnership();
    expect(await escrow.owner()).to.equal(nextOwner.address);
    expect(await escrow.pendingOwner()).to.equal(ethers.ZeroAddress);
    await expect(escrow.connect(owner).pause())
      .to.be.revertedWithCustomError(escrow, 'OwnableUnauthorizedAccount')
      .withArgs(owner.address);
    await expect(escrow.connect(nextOwner).pause()).to.emit(escrow, 'Paused').withArgs(nextOwner.address);
  });

  it('lets active managers control only goals they created', async () => {
    const { owner, recipient, stranger, pre, escrow } = await fixture();
    const signers = await ethers.getSigners();
    const firstManager = signers[5]!;
    const secondManager = signers[6]!;
    const firstGoal = ethers.id('first-manager-goal');
    const secondGoal = ethers.id('second-manager-goal');
    const deadline = await futureDeadline();

    await escrow.setGoalManager(firstManager.address, true);
    await escrow.setGoalManager(secondManager.address, true);
    await escrow.connect(firstManager).createGoal(firstGoal, recipient.address, 10n, 0n, deadline, 'First manager', '', '');
    await escrow.connect(secondManager).createGoal(secondGoal, recipient.address, 10n, 0n, deadline, 'Second manager', '', '');

    expect((await escrow.goal(firstGoal)).creator).to.equal(firstManager.address);
    expect((await escrow.goal(secondGoal)).creator).to.equal(secondManager.address);
    expect(await escrow.openGoalCountByCreator(firstManager.address)).to.equal(1n);
    expect(await escrow.openGoalCountByCreator(secondManager.address)).to.equal(1n);

    await expect(escrow.connect(secondManager).closeGoal(firstGoal))
      .to.be.revertedWithCustomError(escrow, 'UnauthorizedGoalController')
      .withArgs(firstGoal, secondManager.address);
    await expect(escrow.connect(stranger).closeGoal(firstGoal))
      .to.be.revertedWithCustomError(escrow, 'UnauthorizedGoalManager')
      .withArgs(stranger.address);
    await expect(escrow.connect(firstManager).closeGoal(firstGoal))
      .to.emit(escrow, 'GoalClosed')
      .withArgs(firstGoal, 0n, 0n);
    expect(await escrow.openGoalCountByCreator(firstManager.address)).to.equal(0n);
    await expect(escrow.connect(firstManager).releaseExpense(firstGoal, await pre.getAddress(), 1n))
      .to.be.revertedWithCustomError(escrow, 'UnauthorizedRelease');

    await expect(escrow.connect(firstManager).cancelGoal(secondGoal))
      .to.be.revertedWithCustomError(escrow, 'UnauthorizedGoalController')
      .withArgs(secondGoal, firstManager.address);
    await expect(escrow.connect(owner).cancelGoal(secondGoal)).to.emit(escrow, 'GoalCancelled').withArgs(secondGoal);
    expect(await escrow.openGoalCountByCreator(secondManager.address)).to.equal(0n);
    await expect(escrow.connect(firstManager).pause())
      .to.be.revertedWithCustomError(escrow, 'OwnableUnauthorizedAccount')
      .withArgs(firstManager.address);
  });

  it('enforces an independent three-open-goal limit and releases slots on settlement', async () => {
    const { recipient, escrow } = await fixture();
    const signers = await ethers.getSigners();
    const firstManager = signers[5]!;
    const secondManager = signers[6]!;
    const deadline = await futureDeadline();
    const firstManagerGoals = [0, 1, 2, 3].map((index) => ethers.id(`limited-manager-a-${index}`));
    const secondManagerGoal = ethers.id('limited-manager-b-0');

    await escrow.setGoalManager(firstManager.address, true);
    await escrow.setGoalManager(secondManager.address, true);
    for (const id of firstManagerGoals.slice(0, 3)) {
      await escrow.connect(firstManager).createGoal(id, recipient.address, 1n, 0n, deadline, 'Limited goal', '', '');
    }
    expect(await escrow.openGoalCountByCreator(firstManager.address)).to.equal(3n);

    await expect(escrow.connect(firstManager).createGoal(
      firstManagerGoals[3]!,
      recipient.address,
      1n,
      0n,
      deadline,
      'Over limit',
      '',
      '',
    )).to.be.revertedWithCustomError(escrow, 'GoalManagerLimitReached')
      .withArgs(firstManager.address, 3n);
    expect((await escrow.goal(firstManagerGoals[3]!)).status).to.equal(0n);

    await escrow.connect(secondManager).createGoal(
      secondManagerGoal,
      recipient.address,
      1n,
      0n,
      deadline,
      'Independent limit',
      '',
      '',
    );
    expect(await escrow.openGoalCountByCreator(secondManager.address)).to.equal(1n);

    await escrow.connect(firstManager).closeGoal(firstManagerGoals[0]!);
    expect(await escrow.openGoalCountByCreator(firstManager.address)).to.equal(2n);
    await escrow.connect(firstManager).createGoal(
      firstManagerGoals[3]!,
      recipient.address,
      1n,
      0n,
      deadline,
      'Reused slot',
      '',
      '',
    );
    expect(await escrow.openGoalCountByCreator(firstManager.address)).to.equal(3n);
    await escrow.connect(firstManager).cancelGoal(firstManagerGoals[1]!);
    expect(await escrow.openGoalCountByCreator(firstManager.address)).to.equal(2n);
  });

  it('applies limit changes prospectively while keeping the owner unlimited', async () => {
    const { owner, recipient, escrow } = await fixture();
    const manager = (await ethers.getSigners())[5]!;
    const deadline = await futureDeadline();
    const managerGoals = [0, 1, 2, 3, 4].map((index) => ethers.id(`changing-limit-${index}`));

    await escrow.setGoalManager(manager.address, true);
    for (const id of managerGoals.slice(0, 3)) {
      await escrow.connect(manager).createGoal(id, recipient.address, 1n, 0n, deadline, 'Changing limit', '', '');
    }
    await escrow.setMaxOpenGoalsPerManager(2n);
    expect(await escrow.openGoalCountByCreator(manager.address)).to.equal(3n);
    await expect(escrow.connect(manager).createGoal(
      managerGoals[3]!,
      recipient.address,
      1n,
      0n,
      deadline,
      'Still blocked',
      '',
      '',
    )).to.be.revertedWithCustomError(escrow, 'GoalManagerLimitReached')
      .withArgs(manager.address, 2n);

    await escrow.connect(manager).closeGoal(managerGoals[0]!);
    await expect(escrow.connect(manager).createGoal(
      managerGoals[3]!,
      recipient.address,
      1n,
      0n,
      deadline,
      'At limit',
      '',
      '',
    )).to.be.revertedWithCustomError(escrow, 'GoalManagerLimitReached')
      .withArgs(manager.address, 2n);
    await escrow.connect(manager).cancelGoal(managerGoals[1]!);
    await escrow.connect(manager).createGoal(
      managerGoals[3]!,
      recipient.address,
      1n,
      0n,
      deadline,
      'Now allowed',
      '',
      '',
    );
    expect(await escrow.openGoalCountByCreator(manager.address)).to.equal(2n);

    await escrow.setMaxOpenGoalsPerManager(0n);
    await expect(escrow.connect(manager).createGoal(
      managerGoals[4]!,
      recipient.address,
      1n,
      0n,
      deadline,
      'Frozen manager',
      '',
      '',
    )).to.be.revertedWithCustomError(escrow, 'GoalManagerLimitReached')
      .withArgs(manager.address, 0n);

    for (let index = 0; index < 4; index += 1) {
      await escrow.createGoal(
        ethers.id(`unlimited-owner-${index}`),
        recipient.address,
        1n,
        0n,
        deadline,
        'Unlimited owner',
        '',
        '',
      );
    }
    expect(await escrow.openGoalCountByCreator(owner.address)).to.equal(5n);
  });

  it('removes manager control immediately without orphaning their open goals', async () => {
    const { recipient, escrow } = await fixture();
    const manager = (await ethers.getSigners())[5]!;
    const firstGoal = ethers.id('revoked-manager-first');
    const secondGoal = ethers.id('revoked-manager-second');
    const blockedGoal = ethers.id('revoked-manager-blocked');
    const deadline = await futureDeadline();

    await escrow.setGoalManager(manager.address, true);
    await escrow.connect(manager).createGoal(firstGoal, recipient.address, 1n, 0n, deadline, 'First', '', '');
    await escrow.connect(manager).createGoal(secondGoal, recipient.address, 1n, 0n, deadline, 'Second', '', '');
    await escrow.setGoalManager(manager.address, false);

    await expect(escrow.connect(manager).createGoal(blockedGoal, recipient.address, 1n, 0n, deadline, 'Blocked', '', ''))
      .to.be.revertedWithCustomError(escrow, 'UnauthorizedGoalManager')
      .withArgs(manager.address);
    await expect(escrow.connect(manager).closeGoal(firstGoal))
      .to.be.revertedWithCustomError(escrow, 'UnauthorizedGoalManager')
      .withArgs(manager.address);
    expect(await escrow.openGoalCountByCreator(manager.address)).to.equal(2n);

    await escrow.setGoalManager(manager.address, true);
    await escrow.connect(manager).closeGoal(firstGoal);
    expect(await escrow.openGoalCountByCreator(manager.address)).to.equal(1n);
    await escrow.setGoalManager(manager.address, false);
    await escrow.cancelGoal(secondGoal);
    expect(await escrow.openGoalCountByCreator(manager.address)).to.equal(0n);
  });

  it('accepts arbitrary metadata formats and enforces the metadata byte limit', async () => {
    const { recipient, escrow } = await fixture();
    const deadline = await futureDeadline();
    await expect(escrow.createGoal(ethers.id('no-metadata'), recipient.address, 1n, 0n, deadline, 'Core data only', '', ''))
      .to.emit(escrow, 'GoalCreated');
    await expect(escrow.createGoal(
      ethers.id('https-metadata'),
      recipient.address,
      1n,
      0n,
      deadline,
      'HTTPS metadata',
      '',
      'https://example.com/metadata.json',
    )).to.emit(escrow, 'GoalCreated');
    await expect(escrow.createGoal(
      ethers.id('opaque-metadata'),
      recipient.address,
      1n,
      0n,
      deadline,
      'Opaque metadata',
      '',
      'not a URI',
    )).to.emit(escrow, 'GoalCreated');

    const metadataLimit = Number(await escrow.MAX_METADATA_URI_BYTES());
    const maximumMetadata = 'a'.repeat(metadataLimit);
    const oversizedMetadata = `${maximumMetadata}a`;
    await expect(escrow.createGoal(
      ethers.id('maximum-metadata'),
      recipient.address,
      1n,
      0n,
      deadline,
      'Maximum metadata',
      '',
      maximumMetadata,
    )).to.emit(escrow, 'GoalCreated');
    await expect(escrow.createGoal(
      ethers.id('oversized-metadata'),
      recipient.address,
      1n,
      0n,
      deadline,
      'Oversized metadata',
      '',
      oversizedMetadata,
    )).to.be.revertedWithCustomError(escrow, 'InvalidMetadataURI');
  });

  it('enforces title and description byte limits', async () => {
    const { recipient, escrow } = await fixture();
    const deadline = await futureDeadline();
    await expect(escrow.createGoal(
      ethers.id('valid-unicode-text'),
      recipient.address,
      1n,
      0n,
      deadline,
      'Cel społeczności 🙂',
      'Zażółć gęślą jaźń.',
      '',
    )).to.emit(escrow, 'GoalCreated');
    await expect(escrow.createGoal(ethers.id('empty-title'), recipient.address, 1n, 0n, deadline, '', '', ''))
      .to.be.revertedWithCustomError(escrow, 'InvalidTitle');
    await expect(escrow.createGoal(ethers.id('long-title'), recipient.address, 1n, 0n, deadline, 'a'.repeat(97), '', ''))
      .to.be.revertedWithCustomError(escrow, 'InvalidTitle');
    await expect(escrow.createGoal(ethers.id('unicode-title'), recipient.address, 1n, 0n, deadline, 'ą'.repeat(49), '', ''))
      .to.be.revertedWithCustomError(escrow, 'InvalidTitle');
    await expect(escrow.createGoal(ethers.id('long-description'), recipient.address, 1n, 0n, deadline, 'Title', 'a'.repeat(513), ''))
      .to.be.revertedWithCustomError(escrow, 'DescriptionTooLong');
  });

  it('accepts non-UTF-8 goal fields within their byte limits', async () => {
    const { owner, recipient, escrow } = await fixture();
    const selector = escrow.interface.getFunction('createGoal')!.selector;
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes32', 'address', 'uint256', 'uint256', 'uint64', 'bytes', 'bytes', 'bytes'],
      [
        ethers.id('opaque-goal-fields'),
        recipient.address,
        1n,
        0n,
        await futureDeadline(),
        '0xff',
        '0xfe',
        '0xfd',
      ],
    );

    await expect(owner.sendTransaction({
      to: await escrow.getAddress(),
      data: `${selector}${encoded.slice(2)}`,
    })).not.to.revert(ethers);
  });

  it('sets, updates, reads and clears only the caller profile with monotonic revisions', async () => {
    const { owner, sponsor, stranger, escrow } = await fixture();
    const initial = await escrow.getProfile(sponsor.address);
    expect(initial.active).to.equal(false);
    expect(initial.revision).to.equal(0n);

    await expect(escrow.connect(sponsor).setProfile(
      'Presearch Builder',
      'https://presearch.com/community',
      'Building public infrastructure.',
      'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3g5lxy4t5c7hr4zy2m4ot6owe/avatar.webp',
      true,
    )).to.emit(escrow, 'ProfileUpdated').withArgs(
      sponsor.address,
      1n,
      'Presearch Builder',
      'https://presearch.com/community',
      'Building public infrastructure.',
      'ipfs://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3g5lxy4t5c7hr4zy2m4ot6owe/avatar.webp',
      true,
    );

    const created = await escrow.getProfile(sponsor.address);
    expect(created.active).to.equal(true);
    expect(created.revision).to.equal(1n);
    expect(created.displayName).to.equal('Presearch Builder');
    expect(created.websiteUrl).to.equal('https://presearch.com/community');
    expect(created.bio).to.equal('Building public infrastructure.');
    expect(created.avatarURI).to.include('ipfs://');
    expect(created.defaultPublic).to.equal(true);

    await escrow.connect(sponsor).setProfile('Updated', '', '', '', false);
    const updated = await escrow.getProfile(sponsor.address);
    expect(updated.revision).to.equal(2n);
    expect(updated.displayName).to.equal('Updated');
    expect(updated.websiteUrl).to.equal('');
    expect(updated.defaultPublic).to.equal(false);

    const unrelated = await escrow.getProfile(stranger.address);
    expect(unrelated.active).to.equal(false);
    expect(unrelated.revision).to.equal(0n);
    expect((await escrow.getProfile(owner.address)).revision).to.equal(0n);

    await expect(escrow.connect(sponsor).clearProfile())
      .to.emit(escrow, 'ProfileCleared')
      .withArgs(sponsor.address, 3n);
    const cleared = await escrow.getProfile(sponsor.address);
    expect(cleared.active).to.equal(false);
    expect(cleared.revision).to.equal(3n);
    expect(cleared.displayName).to.equal('');
    expect(cleared.websiteUrl).to.equal('');
    expect(cleared.bio).to.equal('');
    expect(cleared.avatarURI).to.equal('');
    expect(cleared.defaultPublic).to.equal(false);
  });

  it('stores profile URLs and avatar references without validating their format', async () => {
    const { sponsor, escrow } = await fixture();

    await escrow.connect(sponsor).setProfile(
      'Opaque profile',
      'http://example.com/a path',
      '<b>render me safely</b>',
      'not a URI',
      false,
    );

    const profile = await escrow.getProfile(sponsor.address);
    expect(profile.websiteUrl).to.equal('http://example.com/a path');
    expect(profile.bio).to.equal('<b>render me safely</b>');
    expect(profile.avatarURI).to.equal('not a URI');
  });

  it('enforces only byte limits and a non-empty profile name', async () => {
    const { sponsor, escrow } = await fixture();
    const nameLimit = Number(await escrow.MAX_PROFILE_NAME_BYTES());
    const websiteLimit = Number(await escrow.MAX_PROFILE_URL_BYTES());
    const bioLimit = Number(await escrow.MAX_PROFILE_BIO_BYTES());
    const avatarLimit = Number(await escrow.MAX_PROFILE_AVATAR_URI_BYTES());

    await escrow.connect(sponsor).setProfile(
      'n'.repeat(nameLimit),
      'w'.repeat(websiteLimit),
      'b'.repeat(bioLimit),
      'a'.repeat(avatarLimit),
      true,
    );

    await expect(escrow.connect(sponsor).setProfile('', '', '', '', false))
      .to.be.revertedWithCustomError(escrow, 'InvalidProfileDisplayName');
    await expect(escrow.connect(sponsor).setProfile('n'.repeat(nameLimit + 1), '', '', '', false))
      .to.be.revertedWithCustomError(escrow, 'InvalidProfileDisplayName');
    await expect(escrow.connect(sponsor).setProfile('Name', 'w'.repeat(websiteLimit + 1), '', '', false))
      .to.be.revertedWithCustomError(escrow, 'InvalidProfileWebsiteURL');
    await expect(escrow.connect(sponsor).setProfile('Name', '', 'b'.repeat(bioLimit + 1), '', false))
      .to.be.revertedWithCustomError(escrow, 'ProfileBioTooLong');
    await expect(escrow.connect(sponsor).setProfile('Name', '', '', 'a'.repeat(avatarLimit + 1), false))
      .to.be.revertedWithCustomError(escrow, 'InvalidProfileAvatarURI');
  });

  it('accepts non-UTF-8 profile fields within their byte limits', async () => {
    const { sponsor, escrow } = await fixture();
    const selector = escrow.interface.getFunction('setProfile')!.selector;
    const encoded = ethers.AbiCoder.defaultAbiCoder().encode(
      ['bytes', 'bytes', 'bytes', 'bytes', 'bool'],
      ['0xff', '0xfe', '0xfd', '0xfc', false],
    );

    await expect(sponsor.sendTransaction({
      to: await escrow.getAddress(),
      data: `${selector}${encoded.slice(2)}`,
    })).not.to.revert(ethers);
  });

  it('keeps profile management available while escrow funding is paused', async () => {
    const { sponsor, pre, escrow, goalId } = await fixture();
    await escrow.pause();
    await escrow.connect(sponsor).setProfile('Available while paused', '', '', '', true);
    expect((await escrow.getProfile(sponsor.address)).active).to.equal(true);
    await escrow.connect(sponsor).clearProfile();
    expect((await escrow.getProfile(sponsor.address)).revision).to.equal(2n);
    await expect(escrow.connect(sponsor).contribute(goalId, await pre.getAddress(), 1n, true))
      .to.be.revertedWithCustomError(escrow, 'EnforcedPause');
  });

  it('requires a future deadline and at least one positive target', async () => {
    const { recipient, escrow, goalId } = await fixture();
    const block = await ethers.provider.getBlock('latest');
    const now = BigInt(block?.timestamp ?? 0);
    await expect(escrow.createGoal(ethers.ZeroHash, recipient.address, 1n, 0n, await futureDeadline(), 'Zero ID', '', ''))
      .to.be.revertedWithCustomError(escrow, 'InvalidGoal');
    await expect(escrow.createGoal(ethers.id('zero-recipient'), ethers.ZeroAddress, 1n, 0n, await futureDeadline(), 'Zero recipient', '', ''))
      .to.be.revertedWithCustomError(escrow, 'InvalidGoal');
    await expect(escrow.createGoal(goalId, recipient.address, 1n, 0n, await futureDeadline(), 'Duplicate', '', ''))
      .to.be.revertedWithCustomError(escrow, 'GoalAlreadyExists');
    await expect(escrow.createGoal(ethers.id('past'), recipient.address, 1n, 0n, now, 'Past', '', ''))
      .to.be.revertedWithCustomError(escrow, 'InvalidDeadline');
    await expect(escrow.createGoal(ethers.id('zero-target'), recipient.address, 0n, 0n, await futureDeadline(), 'No target', '', ''))
      .to.be.revertedWithCustomError(escrow, 'ZeroAmount');
  });

  it('accepts a contribution before the deadline and rejects it at the deadline', async () => {
    const { sponsor, pre, escrow, goalId, deadline } = await fixture();
    await expect(escrow.connect(sponsor).contribute(goalId, await pre.getAddress(), 10n, true))
      .to.emit(escrow, 'ContributionReceived')
      .withArgs(goalId, sponsor.address, await pre.getAddress(), 10n, true);
    expect((await escrow.goal(goalId)).preContributed).to.equal(10n);
    expect(await escrow.accountedByToken(await pre.getAddress())).to.equal(10n);
    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(deadline)]);
    await ethers.provider.send('evm_mine', []);
    await expect(escrow.connect(sponsor).contribute(goalId, await pre.getAddress(), 1n, false))
      .to.be.revertedWithCustomError(escrow, 'GoalExpired');
  });

  it('lets the owner close or cancel an expired goal', async () => {
    const { recipient, escrow, goalId, deadline } = await fixture();
    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(deadline)]);
    await ethers.provider.send('evm_mine', []);
    await expect(escrow.closeGoal(goalId)).to.emit(escrow, 'GoalClosed');
    await expect(escrow.closeGoal(goalId)).to.be.revertedWithCustomError(escrow, 'GoalNotOpen');

    const second = ethers.id('expired-cancel');
    const secondDeadline = await futureDeadline(60);
    await escrow.createGoal(second, recipient.address, 1n, 0n, secondDeadline, 'Cancel later', '', '');
    await ethers.provider.send('evm_setNextBlockTimestamp', [Number(secondDeadline)]);
    await ethers.provider.send('evm_mine', []);
    await expect(escrow.cancelGoal(second)).to.emit(escrow, 'GoalCancelled');
    await expect(escrow.cancelGoal(second)).to.be.revertedWithCustomError(escrow, 'GoalNotOpen');
  });

  it('accepts only configured tokens and rejects disabled funding channels', async () => {
    const { sponsor, recipient, stranger, pre, escrow } = await fixture();
    await expect(escrow.connect(sponsor).contribute(ethers.ZeroHash, await pre.getAddress(), 1n, false))
      .to.be.revertedWithCustomError(escrow, 'GoalNotOpen');
    const id = ethers.id('usdc-only');
    await escrow.createGoal(id, recipient.address, 0n, 1_000_000n, await futureDeadline(), 'USDC only', '', '');
    await expect(escrow.connect(sponsor).contribute(id, await pre.getAddress(), 0n, false))
      .to.be.revertedWithCustomError(escrow, 'ZeroAmount');
    await expect(escrow.connect(sponsor).contribute(id, stranger.address, 1n, false))
      .to.be.revertedWithCustomError(escrow, 'UnsupportedToken');
    await expect(escrow.connect(sponsor).contribute(id, await pre.getAddress(), 1n, false))
      .to.be.revertedWithCustomError(escrow, 'FundingChannelDisabled');
  });

  it('rejects unauthorized goal closure and lets the owner or recipient release every contribution', async () => {
    const { sponsor, stranger, recipient, pre, escrow, goalId } = await fixture();
    await escrow.connect(sponsor).contribute(goalId, await pre.getAddress(), ethers.parseEther('140'), false);
    await expect(escrow.connect(stranger).closeGoal(goalId))
      .to.be.revertedWithCustomError(escrow, 'UnauthorizedGoalManager')
      .withArgs(stranger.address);
    await expect(escrow.closeGoal(goalId))
      .to.emit(escrow, 'GoalClosed')
      .withArgs(goalId, ethers.parseEther('140'), 0n);
    await expect(escrow.connect(stranger).releaseExpense(goalId, await pre.getAddress(), 1n))
      .to.be.revertedWithCustomError(escrow, 'UnauthorizedRelease');
    await expect(escrow.connect(recipient).releaseExpense(goalId, await pre.getAddress(), 0n))
      .to.be.revertedWithCustomError(escrow, 'ZeroAmount');
    await escrow.connect(recipient).releaseExpense(goalId, await pre.getAddress(), ethers.parseEther('140'));
    expect(await pre.balanceOf(recipient.address)).to.equal(ethers.parseEther('140'));
    await expect(escrow.releaseExpense(goalId, await pre.getAddress(), 1n))
      .to.be.revertedWithCustomError(escrow, 'ExpenseLimitExceeded');
  });

  it('keeps over-target funds with the beneficiary and routes only cancelled goals to treasury', async () => {
    const { sponsor, treasury, recipient, pre, usdc, escrow, goalId } = await fixture();
    await escrow.connect(sponsor).contribute(goalId, await pre.getAddress(), ethers.parseEther('100'), false);
    expect((await escrow.goal(goalId)).status).to.equal(1n);
    await escrow.connect(sponsor).contribute(goalId, await pre.getAddress(), ethers.parseEther('40'), false);
    expect((await escrow.goal(goalId)).preContributed).to.equal(ethers.parseEther('140'));
    expect((await escrow.goal(goalId)).status).to.equal(1n);
    await escrow.closeGoal(goalId);
    await escrow.connect(recipient).releaseExpense(goalId, await pre.getAddress(), ethers.parseEther('140'));
    await expect(escrow.releaseSurplus(goalId, await pre.getAddress(), 1n))
      .to.be.revertedWithCustomError(escrow, 'GoalNotClosed');

    const cancelled = ethers.id('cancelled');
    await escrow.createGoal(cancelled, recipient.address, 10n, 0n, await futureDeadline(), 'Cancelled', '', '');
    await escrow.connect(sponsor).contribute(cancelled, await pre.getAddress(), 10n, false);
    await escrow.cancelGoal(cancelled);
    await expect(escrow.releaseSurplus(cancelled, await pre.getAddress(), 0n))
      .to.be.revertedWithCustomError(escrow, 'ZeroAmount');
    await expect(escrow.releaseSurplus(cancelled, await pre.getAddress(), 11n))
      .to.be.revertedWithCustomError(escrow, 'SurplusLimitExceeded');
    await expect(escrow.releaseExpense(cancelled, await pre.getAddress(), 10n))
      .to.be.revertedWithCustomError(escrow, 'GoalNotClosed');
    await escrow.releaseSurplus(cancelled, await pre.getAddress(), 10n);

    const cancelledUsdc = ethers.id('cancelled-usdc');
    await escrow.createGoal(
      cancelledUsdc,
      recipient.address,
      0n,
      1_000_000n,
      await futureDeadline(),
      'Cancelled USDC',
      '',
      '',
    );
    await escrow.connect(sponsor).contribute(cancelledUsdc, await usdc.getAddress(), 2_000_000n, false);
    await escrow.cancelGoal(cancelledUsdc);
    await expect(escrow.releaseSurplus(cancelledUsdc, await usdc.getAddress(), 2_000_001n))
      .to.be.revertedWithCustomError(escrow, 'SurplusLimitExceeded');
    await escrow.releaseSurplus(cancelledUsdc, await usdc.getAddress(), 2_000_000n);

    expect(await pre.balanceOf(recipient.address)).to.equal(ethers.parseEther('140'));
    expect(await pre.balanceOf(treasury.address)).to.equal(10n);
    expect(await usdc.balanceOf(treasury.address)).to.equal(2_000_000n);
  });

  it('rejects surplus release by an account that is neither owner nor treasury', async () => {
    const { sponsor, stranger, pre, escrow, goalId } = await fixture();
    await escrow.connect(sponsor).contribute(goalId, await pre.getAddress(), 10n, false);
    await escrow.cancelGoal(goalId);

    await expect(escrow.connect(stranger).releaseSurplus(goalId, await pre.getAddress(), 1n))
      .to.be.revertedWithCustomError(escrow, 'UnauthorizedRelease');
    expect(await escrow.accountedByToken(await pre.getAddress())).to.equal(10n);
  });

  it('settles partial USDC beneficiary releases without mixing token accounting', async () => {
    const { sponsor, recipient, pre, usdc, escrow, goalId } = await fixture();
    const contributed = 140_000_000n;

    await escrow.connect(sponsor).contribute(goalId, await usdc.getAddress(), contributed, false);
    await escrow.closeGoal(goalId);
    await escrow.connect(recipient).releaseExpense(goalId, await usdc.getAddress(), 40_000_000n);
    await expect(escrow.connect(recipient).releaseExpense(goalId, await usdc.getAddress(), 100_000_001n))
      .to.be.revertedWithCustomError(escrow, 'ExpenseLimitExceeded');
    await escrow.connect(recipient).releaseExpense(goalId, await usdc.getAddress(), 100_000_000n);

    const state = await escrow.goal(goalId);
    expect(state.usdcReleasedExpense).to.equal(contributed);
    expect(state.usdcReleasedSurplus).to.equal(0n);
    expect(await usdc.balanceOf(recipient.address)).to.equal(contributed);
    expect(await escrow.accountedByToken(await usdc.getAddress())).to.equal(0n);
    expect(await escrow.accountedByToken(await pre.getAddress())).to.equal(0n);
  });

  it('recovers only PRE and USDC sent directly beyond escrow obligations', async () => {
    const { sponsor, stranger, recipient, pre, escrow, goalId } = await fixture();
    const contribution = ethers.parseEther('10');
    const accidentalTransfer = ethers.parseEther('3');
    await escrow.connect(sponsor).contribute(goalId, await pre.getAddress(), contribution, false);
    await pre.connect(sponsor).transfer(await escrow.getAddress(), accidentalTransfer);

    await expect(escrow.recoverExcessToken(await pre.getAddress(), stranger.address, contribution))
      .to.be.revertedWithCustomError(escrow, 'ExcessBalanceUnavailable');
    await expect(escrow.recoverExcessToken(await pre.getAddress(), stranger.address, accidentalTransfer))
      .to.emit(escrow, 'ExcessTokenRecovered')
      .withArgs(await pre.getAddress(), stranger.address, accidentalTransfer);
    expect(await pre.balanceOf(stranger.address)).to.equal(accidentalTransfer);
    expect(await escrow.accountedByToken(await pre.getAddress())).to.equal(contribution);

    await escrow.closeGoal(goalId);
    await escrow.releaseExpense(goalId, await pre.getAddress(), contribution);
    expect(await pre.balanceOf(recipient.address)).to.equal(contribution);
    expect(await escrow.accountedByToken(await pre.getAddress())).to.equal(0n);
  });

  it('rejects excess-token recovery by a non-owner', async () => {
    const { sponsor, stranger, pre, escrow } = await fixture();
    await pre.connect(sponsor).transfer(await escrow.getAddress(), 1n);

    await expect(escrow.connect(stranger).recoverExcessToken(await pre.getAddress(), stranger.address, 1n))
      .to.be.revertedWithCustomError(escrow, 'OwnableUnauthorizedAccount')
      .withArgs(stranger.address);
    expect(await pre.balanceOf(await escrow.getAddress())).to.equal(1n);
  });

  it('exposes no ABI function that can change immutable token addresses', async () => {
    const { escrow } = await fixture();
    const tokenSetter = escrow.interface.fragments.find(
      (fragment) => fragment.type === 'function' && fragment.format('sighash') === 'setSupportedTokens(address,address)',
    );

    expect(tokenSetter).to.equal(undefined);
  });

  it('exposes the immutable treasury through the case-sensitive TREASURY ABI getter', async () => {
    const { treasury, escrow } = await fixture();
    const lowercaseTreasuryGetter = escrow.interface.fragments.find(
      (fragment) => fragment.type === 'function' && fragment.format('sighash') === 'treasury()',
    );

    expect(escrow.interface.getFunction('TREASURY')).not.to.equal(null);
    expect(lowercaseTreasuryGetter).to.equal(undefined);
    expect(await escrow.TREASURY()).to.equal(treasury.address);
  });

  it('lets a beneficiary rotate a blocked payout address and claim every contribution', async () => {
    const signers = await ethers.getSigners();
    const owner = signers[0]!;
    const sponsor = signers[1]!;
    const recipient = signers[2]!;
    const treasury = signers[3]!;
    const alternatePayout = signers[4]!;
    const stranger = signers[5]!;
    const Restricted = await ethers.getContractFactory('MockRestrictedERC20');
    const pre = await Restricted.deploy('Restricted PRE', 'rPRE', 18) as unknown as MockRestrictedERC20;
    const Token = await ethers.getContractFactory('MockERC20');
    const usdc = await Token.deploy('USD Coin', 'USDC', 6) as unknown as MockERC20;
    const Escrow = await ethers.getContractFactory('PREcommunityEscrowV1');
    const escrow = await Escrow.deploy(
      owner.address,
      await pre.getAddress(),
      await usdc.getAddress(),
      treasury.address,
    ) as unknown as PREcommunityEscrowV1;
    const id = ethers.id('blocked-beneficiary');

    await escrow.createGoal(id, recipient.address, 100n, 0n, await futureDeadline(), 'Blocked beneficiary', '', '');
    await pre.mint(sponsor.address, 100n);
    await pre.connect(sponsor).approve(await escrow.getAddress(), 100n);
    await escrow.connect(sponsor).contribute(id, await pre.getAddress(), 100n, false);
    await escrow.closeGoal(id);
    await pre.setBlocked(recipient.address, true);

    await expect(escrow.releaseExpense(id, await pre.getAddress(), 100n))
      .to.be.revertedWithCustomError(pre, 'BlockedAddress');
    expect((await escrow.goal(id)).preReleasedExpense).to.equal(0n);
    expect(await escrow.accountedByToken(await pre.getAddress())).to.equal(100n);
    await expect(escrow.connect(stranger).setGoalPayout(id, alternatePayout.address))
      .to.be.revertedWithCustomError(escrow, 'UnauthorizedPayoutController');
    await expect(escrow.connect(recipient).setGoalPayout(id, alternatePayout.address))
      .to.emit(escrow, 'GoalPayoutUpdated')
      .withArgs(id, recipient.address, alternatePayout.address);
    await expect(escrow.connect(recipient).releaseExpense(id, await pre.getAddress(), 100n))
      .to.emit(escrow, 'ExpenseReleased')
      .withArgs(id, await pre.getAddress(), recipient.address, alternatePayout.address, 100n);
    expect(await pre.balanceOf(alternatePayout.address)).to.equal(100n);
    expect(await escrow.accountedByToken(await pre.getAddress())).to.equal(0n);
  });

  it('lets treasury rotate a blocked payout address and claim surplus', async () => {
    const signers = await ethers.getSigners();
    const owner = signers[0]!;
    const sponsor = signers[1]!;
    const recipient = signers[2]!;
    const treasury = signers[3]!;
    const alternatePayout = signers[4]!;
    const stranger = signers[5]!;
    const Restricted = await ethers.getContractFactory('MockRestrictedERC20');
    const pre = await Restricted.deploy('Restricted PRE', 'rPRE', 18) as unknown as MockRestrictedERC20;
    const Token = await ethers.getContractFactory('MockERC20');
    const usdc = await Token.deploy('USD Coin', 'USDC', 6) as unknown as MockERC20;
    const Escrow = await ethers.getContractFactory('PREcommunityEscrowV1');
    const escrow = await Escrow.deploy(
      owner.address,
      await pre.getAddress(),
      await usdc.getAddress(),
      treasury.address,
    ) as unknown as PREcommunityEscrowV1;
    const id = ethers.id('blocked-treasury');

    await escrow.createGoal(id, recipient.address, 100n, 0n, await futureDeadline(), 'Blocked treasury', '', '');
    await pre.mint(sponsor.address, 100n);
    await pre.connect(sponsor).approve(await escrow.getAddress(), 100n);
    await escrow.connect(sponsor).contribute(id, await pre.getAddress(), 100n, false);
    await escrow.cancelGoal(id);
    await pre.setBlocked(treasury.address, true);

    await expect(escrow.releaseSurplus(id, await pre.getAddress(), 100n))
      .to.be.revertedWithCustomError(pre, 'BlockedAddress');
    await expect(escrow.connect(stranger).setTreasuryPayout(alternatePayout.address))
      .to.be.revertedWithCustomError(escrow, 'UnauthorizedPayoutController');
    await expect(escrow.connect(treasury).setTreasuryPayout(alternatePayout.address))
      .to.emit(escrow, 'TreasuryPayoutUpdated')
      .withArgs(treasury.address, alternatePayout.address);
    await expect(escrow.connect(treasury).releaseSurplus(id, await pre.getAddress(), 100n))
      .to.emit(escrow, 'SurplusReleased')
      .withArgs(id, await pre.getAddress(), treasury.address, alternatePayout.address, 100n);
    expect(await pre.balanceOf(alternatePayout.address)).to.equal(100n);
    expect(await escrow.accountedByToken(await pre.getAddress())).to.equal(0n);
  });

  it('rejects an inbound fee-on-transfer contribution and rolls the transfer back', async () => {
    const signers = await ethers.getSigners();
    const owner = signers[0]!;
    const sponsor = signers[1]!;
    const recipient = signers[2]!;
    const treasury = signers[3]!;
    const feeCollector = signers[4]!;
    const Restricted = await ethers.getContractFactory('MockRestrictedERC20');
    const pre = await Restricted.deploy('Fee PRE', 'fPRE', 18) as unknown as MockRestrictedERC20;
    const Token = await ethers.getContractFactory('MockERC20');
    const usdc = await Token.deploy('USD Coin', 'USDC', 6) as unknown as MockERC20;
    const Escrow = await ethers.getContractFactory('PREcommunityEscrowV1');
    const escrow = await Escrow.deploy(
      owner.address,
      await pre.getAddress(),
      await usdc.getAddress(),
      treasury.address,
    ) as unknown as PREcommunityEscrowV1;
    const id = ethers.id('fee-on-contribution');

    await escrow.createGoal(id, recipient.address, 100n, 0n, await futureDeadline(), 'Exact contribution', '', '');
    await pre.mint(sponsor.address, 100n);
    await pre.connect(sponsor).approve(await escrow.getAddress(), 100n);
    await pre.setTransferFee(1n, feeCollector.address);

    await expect(escrow.connect(sponsor).contribute(id, await pre.getAddress(), 100n, false))
      .to.be.revertedWithCustomError(escrow, 'TransferAmountMismatch');
    expect((await escrow.goal(id)).preContributed).to.equal(0n);
    expect(await escrow.accountedByToken(await pre.getAddress())).to.equal(0n);
    expect(await pre.balanceOf(sponsor.address)).to.equal(100n);
    expect(await pre.balanceOf(await escrow.getAddress())).to.equal(0n);
    expect(await pre.balanceOf(feeCollector.address)).to.equal(0n);
  });

  it('rejects an outbound transfer unless sender and recipient balances move by the exact amount', async () => {
    const signers = await ethers.getSigners();
    const owner = signers[0]!;
    const sponsor = signers[1]!;
    const recipient = signers[2]!;
    const treasury = signers[3]!;
    const feeCollector = signers[4]!;
    const Restricted = await ethers.getContractFactory('MockRestrictedERC20');
    const pre = await Restricted.deploy('Fee PRE', 'fPRE', 18) as unknown as MockRestrictedERC20;
    const Token = await ethers.getContractFactory('MockERC20');
    const usdc = await Token.deploy('USD Coin', 'USDC', 6) as unknown as MockERC20;
    const Escrow = await ethers.getContractFactory('PREcommunityEscrowV1');
    const escrow = await Escrow.deploy(
      owner.address,
      await pre.getAddress(),
      await usdc.getAddress(),
      treasury.address,
    ) as unknown as PREcommunityEscrowV1;
    const id = ethers.id('fee-on-release');

    await escrow.createGoal(id, recipient.address, 100n, 0n, await futureDeadline(), 'Exact release', '', '');
    await pre.mint(sponsor.address, 100n);
    await pre.connect(sponsor).approve(await escrow.getAddress(), 100n);
    await escrow.connect(sponsor).contribute(id, await pre.getAddress(), 100n, false);
    await escrow.closeGoal(id);
    await pre.setTransferFee(1n, feeCollector.address);

    await expect(escrow.releaseExpense(id, await pre.getAddress(), 100n))
      .to.be.revertedWithCustomError(escrow, 'TransferAmountMismatch');
    expect((await escrow.goal(id)).preReleasedExpense).to.equal(0n);
    expect(await escrow.accountedByToken(await pre.getAddress())).to.equal(100n);
    expect(await pre.balanceOf(recipient.address)).to.equal(0n);
    expect(await pre.balanceOf(feeCollector.address)).to.equal(0n);

    await pre.setTransferFee(0n, ethers.ZeroAddress);
    await escrow.connect(recipient).releaseExpense(id, await pre.getAddress(), 100n);
    expect(await pre.balanceOf(recipient.address)).to.equal(100n);
  });

  it('validates payout destinations', async () => {
    const { recipient, treasury, pre, usdc, escrow, goalId } = await fixture();
    const escrowAddress = await escrow.getAddress();
    const preAddress = await pre.getAddress();
    const usdcAddress = await usdc.getAddress();

    await expect(escrow.connect(recipient).setGoalPayout(ethers.id('unknown-goal'), recipient.address))
      .to.be.revertedWithCustomError(escrow, 'InvalidGoal');
    await expect(escrow.recoverExcessToken(preAddress, ethers.ZeroAddress, 1n))
      .to.be.revertedWithCustomError(escrow, 'ZeroAddress');
    await expect(escrow.recoverExcessToken(preAddress, recipient.address, 0n))
      .to.be.revertedWithCustomError(escrow, 'ZeroAmount');

    await expect(escrow.createGoal(
      ethers.id('self-payout'),
      escrowAddress,
      1n,
      0n,
      await futureDeadline(),
      'Invalid payout',
      '',
      '',
    )).to.be.revertedWithCustomError(escrow, 'InvalidPayoutAddress');
    await expect(escrow.connect(recipient).setGoalPayout(goalId, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(escrow, 'InvalidPayoutAddress');
    await expect(escrow.connect(recipient).setGoalPayout(goalId, escrowAddress))
      .to.be.revertedWithCustomError(escrow, 'InvalidPayoutAddress');
    await expect(escrow.connect(treasury).setTreasuryPayout(ethers.ZeroAddress))
      .to.be.revertedWithCustomError(escrow, 'InvalidPayoutAddress');
    await expect(escrow.recoverExcessToken(preAddress, escrowAddress, 1n))
      .to.be.revertedWithCustomError(escrow, 'InvalidPayoutAddress');

    for (const [index, tokenAddress] of [preAddress, usdcAddress].entries()) {
      await expect(escrow.createGoal(
        ethers.id(`token-recipient-${index}`),
        tokenAddress,
        1n,
        0n,
        await futureDeadline(),
        'Invalid token recipient',
        '',
        '',
      )).to.be.revertedWithCustomError(escrow, 'InvalidPayoutAddress');
      await expect(escrow.connect(recipient).setGoalPayout(goalId, tokenAddress))
        .to.be.revertedWithCustomError(escrow, 'InvalidPayoutAddress');
      await expect(escrow.connect(treasury).setTreasuryPayout(tokenAddress))
        .to.be.revertedWithCustomError(escrow, 'InvalidPayoutAddress');
      await expect(escrow.recoverExcessToken(preAddress, tokenAddress, 1n))
        .to.be.revertedWithCustomError(escrow, 'InvalidPayoutAddress');
    }
  });

  it('rejects token contracts as controllers while allowing one address to own and control treasury', async () => {
    const { owner, treasury, pre, usdc, escrow } = await fixture();
    const Escrow = await ethers.getContractFactory('PREcommunityEscrowV1');
    const preAddress = await pre.getAddress();
    const usdcAddress = await usdc.getAddress();

    await expect(Escrow.deploy(owner.address, preAddress, usdcAddress, ethers.ZeroAddress))
      .to.be.revertedWithCustomError(escrow, 'ZeroAddress');
    await expect(Escrow.deploy(owner.address, preAddress, preAddress, treasury.address))
      .to.be.revertedWithCustomError(escrow, 'UnsupportedToken');

    for (const tokenAddress of [preAddress, usdcAddress]) {
      await expect(Escrow.deploy(tokenAddress, preAddress, usdcAddress, treasury.address))
        .to.be.revertedWithCustomError(escrow, 'InvalidControllerAddress')
        .withArgs(tokenAddress);
      await expect(Escrow.deploy(owner.address, preAddress, usdcAddress, tokenAddress))
        .to.be.revertedWithCustomError(escrow, 'InvalidControllerAddress')
        .withArgs(tokenAddress);
    }

    const selfOwnedAddress = ethers.getCreateAddress({
      from: owner.address,
      nonce: await ethers.provider.getTransactionCount(owner.address),
    });
    await expect(Escrow.deploy(selfOwnedAddress, preAddress, usdcAddress, treasury.address))
      .to.be.revertedWithCustomError(escrow, 'InvalidControllerAddress')
      .withArgs(selfOwnedAddress);

    const selfTreasuryAddress = ethers.getCreateAddress({
      from: owner.address,
      nonce: await ethers.provider.getTransactionCount(owner.address),
    });
    await expect(Escrow.deploy(owner.address, preAddress, usdcAddress, selfTreasuryAddress))
      .to.be.revertedWithCustomError(escrow, 'InvalidPayoutAddress');

    const sharedController = await Escrow.deploy(
      owner.address,
      preAddress,
      usdcAddress,
      owner.address,
    ) as unknown as PREcommunityEscrowV1;
    expect(await sharedController.owner()).to.equal(owner.address);
    expect(await sharedController.TREASURY()).to.equal(owner.address);
  });

  for (const tokenRole of ['PRE', 'USDC'] as const) {
    it(`rejects incorrect decimals for the ${tokenRole} token role`, async () => {
      const { owner, treasury, pre, usdc, escrow } = await fixture();
      const actualDecimals = tokenRole === 'PRE' ? 6 : 18;
      const expectedDecimals = tokenRole === 'PRE' ? 18 : 6;
      const Token = await ethers.getContractFactory('MockERC20');
      const wrongToken = await Token.deploy(
        `Wrong ${tokenRole} decimals`,
        `W${tokenRole}`,
        actualDecimals,
      ) as unknown as MockERC20;
      const wrongTokenAddress = await wrongToken.getAddress();
      const Escrow = await ethers.getContractFactory('PREcommunityEscrowV1');
      const preAddress = tokenRole === 'PRE' ? wrongTokenAddress : await pre.getAddress();
      const usdcAddress = tokenRole === 'USDC' ? wrongTokenAddress : await usdc.getAddress();

      await expect(Escrow.deploy(owner.address, preAddress, usdcAddress, treasury.address))
        .to.be.revertedWithCustomError(escrow, 'InvalidTokenDecimals')
        .withArgs(wrongTokenAddress, expectedDecimals, actualDecimals);
    });
  }

  it('rejects a token whose decimals call returns malformed data', async () => {
    const { owner, treasury, usdc, escrow } = await fixture();
    const MalformedToken = await ethers.getContractFactory('MockMalformedDecimalsERC20');
    const malformedToken = await MalformedToken.deploy();
    const Escrow = await ethers.getContractFactory('PREcommunityEscrowV1');

    await expect(Escrow.deploy(owner.address, await malformedToken.getAddress(), await usdc.getAddress(), treasury.address))
      .to.be.revertedWithCustomError(escrow, 'InvalidTokenContract');

    const InvalidCalls = await ethers.getContractFactory('MockInvalidTokenCalls');
    const malformedBalance = await InvalidCalls.deploy(0);
    await expect(Escrow.deploy(owner.address, await malformedBalance.getAddress(), await usdc.getAddress(), treasury.address))
      .to.be.revertedWithCustomError(escrow, 'InvalidTokenContract');

    const malformedDecimals = await InvalidCalls.deploy(1);
    await expect(Escrow.deploy(owner.address, await malformedDecimals.getAddress(), await usdc.getAddress(), treasury.address))
      .to.be.revertedWithCustomError(escrow, 'InvalidTokenContract');
  });

  it('blocks reentrancy during token transfer', async () => {
    const signers = await ethers.getSigners();
    const owner = signers[0]!;
    const sponsor = signers[1]!;
    const recipient = signers[2]!;
    const treasury = signers[3]!;
    const Reentrant = await ethers.getContractFactory('MockReentrantERC20');
    const pre = await Reentrant.deploy() as unknown as MockReentrantERC20;
    const Token = await ethers.getContractFactory('MockERC20');
    const usdc = await Token.deploy('USD Coin', 'USDC', 6) as unknown as MockERC20;
    const Escrow = await ethers.getContractFactory('PREcommunityEscrowV1');
    const escrow = await Escrow.deploy(owner.address, await pre.getAddress(), await usdc.getAddress(), treasury.address) as unknown as PREcommunityEscrowV1;
    const id = ethers.id('reentrant');
    await escrow.createGoal(id, recipient.address, 100n, 0n, await futureDeadline(), 'Reentrancy test', '', '');
    await pre.configure(await escrow.getAddress(), id);
    await pre.mint(sponsor.address, 100n);
    await pre.connect(sponsor).approve(await escrow.getAddress(), 100n);
    await expect(escrow.connect(sponsor).contribute(id, await pre.getAddress(), 10n, false))
      .to.be.revertedWithCustomError(escrow, 'ReentrancyGuardReentrantCall');
  });

  it('blocks a token callback from closing a goal during contribution', async () => {
    const signers = await ethers.getSigners();
    const owner = signers[0]!;
    const sponsor = signers[1]!;
    const recipient = signers[2]!;
    const treasury = signers[3]!;
    const Reentrant = await ethers.getContractFactory('MockReentrantERC20');
    const pre = await Reentrant.deploy() as unknown as MockReentrantERC20;
    const Token = await ethers.getContractFactory('MockERC20');
    const usdc = await Token.deploy('USD Coin', 'USDC', 6) as unknown as MockERC20;
    const Escrow = await ethers.getContractFactory('PREcommunityEscrowV1');
    const escrow = await Escrow.deploy(
      owner.address,
      await pre.getAddress(),
      await usdc.getAddress(),
      treasury.address,
    ) as unknown as PREcommunityEscrowV1;
    const id = ethers.id('cross-function-reentrant');

    await pre.configureCloseGoal(await escrow.getAddress(), id);
    await escrow.setGoalManager(await pre.getAddress(), true);
    await pre.createManagedGoal(recipient.address, await futureDeadline());
    await pre.mint(sponsor.address, 100n);
    await pre.connect(sponsor).approve(await escrow.getAddress(), 100n);

    await expect(escrow.connect(sponsor).contribute(id, await pre.getAddress(), 100n, false))
      .to.be.revertedWithCustomError(escrow, 'ReentrancyGuardReentrantCall');
    const state = await escrow.goal(id);
    expect(state.status).to.equal(1n);
    expect(state.preContributed).to.equal(0n);
    expect(await escrow.accountedByToken(await pre.getAddress())).to.equal(0n);
    expect(await pre.balanceOf(sponsor.address)).to.equal(100n);
    expect(await pre.balanceOf(await escrow.getAddress())).to.equal(0n);
  });

  it('settles every contribution for the beneficiary regardless of the target', async () => {
    await fc.assert(fc.asyncProperty(fc.bigInt({ min: 1n, max: ethers.parseEther('250') }), async (amount) => {
      const { sponsor, recipient, pre, escrow, goalId } = await fixture();
      await escrow.connect(sponsor).contribute(goalId, await pre.getAddress(), amount, false);
      await escrow.closeGoal(goalId);
      await escrow.connect(recipient).releaseExpense(goalId, await pre.getAddress(), amount);
      const state = await escrow.goal(goalId);
      expect(state.preReleasedExpense).to.equal(amount);
      expect(state.preReleasedSurplus).to.equal(0n);
      expect(await pre.balanceOf(recipient.address)).to.equal(amount);
      expect(await escrow.accountedByToken(await pre.getAddress())).to.equal(0n);
    }), { numRuns: 40 });
  });

  it('pauses every goal settlement and token recovery path without changing accounting', async () => {
    const { sponsor, stranger, recipient, pre, escrow, goalId } = await fixture();
    const openGoalId = ethers.id('paused-open-goal');
    const tokenAddress = await pre.getAddress();

    await escrow.connect(sponsor).contribute(goalId, tokenAddress, 20n, false);
    await escrow.closeGoal(goalId);
    await escrow.createGoal(
      openGoalId,
      recipient.address,
      10n,
      0n,
      await futureDeadline(),
      'Paused settlement',
      '',
      '',
    );
    await escrow.connect(sponsor).contribute(openGoalId, tokenAddress, 10n, false);
    await pre.connect(sponsor).transfer(await escrow.getAddress(), 5n);
    await escrow.pause();

    await expect(escrow.connect(sponsor).contribute(openGoalId, tokenAddress, 1n, false))
      .to.be.revertedWithCustomError(escrow, 'EnforcedPause');
    await expect(escrow.closeGoal(openGoalId))
      .to.be.revertedWithCustomError(escrow, 'EnforcedPause');
    await expect(escrow.cancelGoal(openGoalId))
      .to.be.revertedWithCustomError(escrow, 'EnforcedPause');
    await expect(escrow.releaseExpense(goalId, tokenAddress, 1n))
      .to.be.revertedWithCustomError(escrow, 'EnforcedPause');
    await expect(escrow.releaseSurplus(goalId, tokenAddress, 1n))
      .to.be.revertedWithCustomError(escrow, 'EnforcedPause');
    await expect(escrow.recoverExcessToken(tokenAddress, stranger.address, 1n))
      .to.be.revertedWithCustomError(escrow, 'EnforcedPause');

    expect((await escrow.goal(goalId)).preReleasedExpense).to.equal(0n);
    expect((await escrow.goal(goalId)).preReleasedSurplus).to.equal(0n);
    expect((await escrow.goal(openGoalId)).status).to.equal(1n);
    expect(await escrow.accountedByToken(tokenAddress)).to.equal(30n);
    expect(await pre.balanceOf(await escrow.getAddress())).to.equal(35n);
  });

  it('pauses operations, validates token contracts and disables ownership renunciation', async () => {
    const { owner, sponsor, recipient, treasury, pre, usdc, escrow, goalId } = await fixture();
    await escrow.pause();
    await expect(escrow.connect(sponsor).contribute(goalId, await pre.getAddress(), 1n, false)).to.be.revertedWithCustomError(escrow, 'EnforcedPause');
    await expect(escrow.createGoal(ethers.id('paused'), recipient.address, 1n, 0n, await futureDeadline(), 'Paused', '', ''))
      .to.be.revertedWithCustomError(escrow, 'EnforcedPause');
    await escrow.unpause();
    await expect(escrow.renounceOwnership()).to.be.revertedWithCustomError(escrow, 'OwnershipRenunciationDisabled');
    const Escrow = await ethers.getContractFactory('PREcommunityEscrowV1');
    await expect(Escrow.deploy(owner.address, sponsor.address, await usdc.getAddress(), treasury.address))
      .to.be.revertedWithCustomError(escrow, 'InvalidTokenContract');
  });
});
