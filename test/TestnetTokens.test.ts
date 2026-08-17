import { expect } from 'chai';
import { ethers } from '../scripts/lib/hardhat-runtime';
import type { MockPRE, MockUSDC, PREcommunityEscrowV1 } from '../typechain-types';
import {
  PRE_TEST_TOKEN_MINT_UNITS,
  USDC_TEST_TOKEN_MINT_UNITS,
} from '../scripts/lib/test-token-mint';

describe('Base Sepolia test tokens', () => {
  async function fixture() {
    const [owner, recipient, nextOwner, treasury] = await ethers.getSigners();
    if (!owner || !recipient || !nextOwner || !treasury) throw new Error('Expected four test signers.');

    const Pre = await ethers.getContractFactory('MockPRE');
    const pre = await Pre.deploy() as unknown as MockPRE;
    const Usdc = await ethers.getContractFactory('MockUSDC');
    const usdc = await Usdc.deploy() as unknown as MockUSDC;

    return { owner, recipient, nextOwner, treasury, pre, usdc };
  }

  it('uses the production token identities and expected decimal precision with zero initial supply', async () => {
    const { owner, pre, usdc } = await fixture();

    expect(await pre.name()).to.equal('Presearch');
    expect(await pre.symbol()).to.equal('PRE');
    expect(await pre.decimals()).to.equal(18n);
    expect(await pre.owner()).to.equal(owner.address);
    expect(await pre.totalSupply()).to.equal(0n);

    expect(await usdc.name()).to.equal('USD Coin');
    expect(await usdc.symbol()).to.equal('USDC');
    expect(await usdc.decimals()).to.equal(6n);
    expect(await usdc.owner()).to.equal(owner.address);
    expect(await usdc.totalSupply()).to.equal(0n);
  });

  it('allows only each owner to mint and updates balances and total supply', async () => {
    const { recipient, nextOwner, pre, usdc } = await fixture();
    const preAmount = ethers.parseUnits('125', 18);
    const usdcAmount = ethers.parseUnits('250', 6);

    await expect(pre.connect(recipient).mint(recipient.address, preAmount))
      .to.be.revertedWithCustomError(pre, 'OwnableUnauthorizedAccount')
      .withArgs(recipient.address);
    await expect(usdc.connect(recipient).mint(recipient.address, usdcAmount))
      .to.be.revertedWithCustomError(usdc, 'OwnableUnauthorizedAccount')
      .withArgs(recipient.address);

    await pre.mint(recipient.address, preAmount);
    await usdc.mint(recipient.address, usdcAmount);
    expect(await pre.balanceOf(recipient.address)).to.equal(preAmount);
    expect(await pre.totalSupply()).to.equal(preAmount);
    expect(await usdc.balanceOf(recipient.address)).to.equal(usdcAmount);
    expect(await usdc.totalSupply()).to.equal(usdcAmount);

    await pre.transferOwnership(nextOwner.address);
    await usdc.transferOwnership(nextOwner.address);
    await expect(pre.mint(recipient.address, 1n))
      .to.be.revertedWithCustomError(pre, 'OwnableUnauthorizedAccount');
    await expect(usdc.mint(recipient.address, 1n))
      .to.be.revertedWithCustomError(usdc, 'OwnableUnauthorizedAccount');
    await pre.connect(nextOwner).mint(recipient.address, 1n);
    await usdc.connect(nextOwner).mint(recipient.address, 1n);
    expect(await pre.balanceOf(recipient.address)).to.equal(preAmount + 1n);
    expect(await usdc.balanceOf(recipient.address)).to.equal(usdcAmount + 1n);
  });

  it('supports minting the ten-million-token deployment allocation to the deployer', async () => {
    const { owner, pre, usdc } = await fixture();

    await pre.mint(owner.address, PRE_TEST_TOKEN_MINT_UNITS);
    await usdc.mint(owner.address, USDC_TEST_TOKEN_MINT_UNITS);

    expect(await pre.balanceOf(owner.address)).to.equal(10_000_000n * 10n ** 18n);
    expect(await pre.totalSupply()).to.equal(PRE_TEST_TOKEN_MINT_UNITS);
    expect(await usdc.balanceOf(owner.address)).to.equal(10_000_000n * 10n ** 6n);
    expect(await usdc.totalSupply()).to.equal(USDC_TEST_TOKEN_MINT_UNITS);
  });

  it('is accepted by the escrow and supports PRE and USDC contributions', async () => {
    const { owner, recipient, treasury, pre, usdc } = await fixture();
    const Escrow = await ethers.getContractFactory('PREcommunityEscrowV1');
    const escrow = await Escrow.deploy(
      owner.address,
      await pre.getAddress(),
      await usdc.getAddress(),
      treasury.address,
    ) as unknown as PREcommunityEscrowV1;

    const block = await ethers.provider.getBlock('latest');
    const deadline = BigInt((block?.timestamp ?? 0) + 3600);
    const goalId = ethers.id('testnet-token-compatibility');
    const preAmount = ethers.parseUnits('10', 18);
    const usdcAmount = ethers.parseUnits('10', 6);

    await escrow.createGoal(goalId, recipient.address, preAmount, usdcAmount, deadline, 'Test tokens', '', '');
    await pre.mint(recipient.address, preAmount);
    await usdc.mint(recipient.address, usdcAmount);
    await pre.connect(recipient).approve(await escrow.getAddress(), preAmount);
    await usdc.connect(recipient).approve(await escrow.getAddress(), usdcAmount);
    await escrow.connect(recipient).contribute(goalId, await pre.getAddress(), preAmount, true);
    await escrow.connect(recipient).contribute(goalId, await usdc.getAddress(), usdcAmount, false);

    const goal = await escrow.goal(goalId);
    expect(await escrow.PRE()).to.equal(await pre.getAddress());
    expect(await escrow.USDC()).to.equal(await usdc.getAddress());
    expect(goal.preContributed).to.equal(preAmount);
    expect(goal.usdcContributed).to.equal(usdcAmount);
  });
});
