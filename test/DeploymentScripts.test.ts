import { expect } from 'chai';
import { ethers } from '../scripts/lib/hardhat-runtime';
import type { PREcommunityEscrowV1 } from '../typechain-types';
import {
  type DeploymentAddresses,
  parseDeploymentCheckStage,
  validateDeploymentAddresses,
  validateSafeAddress,
} from '../scripts/lib/deployment-validation';
import {
  addGasMargin,
  maximumDeploymentCost,
  selectMaximumFeePerGas,
} from '../scripts/lib/deployment-gas';
import {
  assertDeploymentManifestMatches,
  type DeploymentIntent,
  type DeploymentManifest,
} from '../scripts/lib/deployment-manifest';
import { assertConnectedChainId, resolveDeploymentNetwork } from '../scripts/lib/deployer';
import {
  type ImmutableReferences,
  normalizeImmutableReferences,
} from '../scripts/lib/runtime-bytecode';
import { buildSafeTransactionPayload } from '../scripts/lib/safe-transaction';
import { readCompiledContract } from '../scripts/lib/build-info';

describe('local deployment script checks', () => {
  async function localDeploymentFixture() {
    const signers = await ethers.getSigners();
    const owner = signers[0]!;
    const treasury = signers[1]!;
    const pendingOwner = signers[2]!;
    const Token = await ethers.getContractFactory('MockERC20');
    const pre = await Token.deploy('Presearch', 'PRE', 18);
    const usdc = await Token.deploy('USD Coin', 'USDC', 6);
    const Escrow = await ethers.getContractFactory('PREcommunityEscrowV1');
    const escrow = await Escrow.deploy(
      owner.address,
      await pre.getAddress(),
      await usdc.getAddress(),
      treasury.address,
    ) as unknown as PREcommunityEscrowV1;

    return { owner, treasury, pendingOwner, pre, usdc, escrow };
  }

  async function rejectionMessage(promise: Promise<unknown>): Promise<string> {
    try {
      await promise;
      return '';
    } catch (error: unknown) {
      return error instanceof Error ? error.message : String(error);
    }
  }

  function deploymentIntent(): DeploymentIntent {
    return {
      network: 'base-sepolia',
      chainId: 84532,
      requiredConfirmations: 2,
      deployer: '0x0000000000000000000000000000000000000001',
      preAddress: '0x0000000000000000000000000000000000000002',
      usdcAddress: '0x0000000000000000000000000000000000000003',
      owner: '0x0000000000000000000000000000000000000001',
      ownershipHandoffTarget: '0x0000000000000000000000000000000000000004',
      treasury: '0x0000000000000000000000000000000000000005',
      initCodeHash: `0x${'11'.repeat(32)}`,
    };
  }

  function deploymentManifest(intent: DeploymentIntent): DeploymentManifest {
    return {
      schema: 'precommunity.deployment.v2',
      stage: 'pending',
      ...intent,
      escrowAddress: '0x0000000000000000000000000000000000000006',
      transactionHash: `0x${'22'.repeat(32)}`,
      transactionNonce: 7,
      deploymentBlock: null,
      transactionStatus: null,
      confirmations: 0,
      tokenDecimals: { PRE: 18, USDC: 6 },
      gasEstimate: '1000000',
      gasLimit: '1200000',
      maximumFeePerGasWei: '1000000000',
      maximumDeploymentCostWei: '1200000000000000',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
    };
  }

  it('fails closed when the connected RPC chain differs from the selected deployment network', () => {
    const testnet = resolveDeploymentNetwork('testnet', 84532);

    expect(() => assertConnectedChainId(testnet, 84532n)).not.to.throw();
    expect(() => assertConnectedChainId(testnet, 8453n))
      .to.throw('Connected chain ID 8453 does not match base-sepolia (84532).');
  });

  it('parses only the reviewed deployment readiness stages', () => {
    expect(parseDeploymentCheckStage(undefined)).to.equal('final');
    expect(parseDeploymentCheckStage('final')).to.equal('final');
    expect(parseDeploymentCheckStage('pre-handoff')).to.equal('pre-handoff');
    expect(() => parseDeploymentCheckStage('pending'))
      .to.throw('DEPLOYMENT_CHECK_STAGE must be exactly pre-handoff or final.');
  });

  it('adds a rounded-up deployment gas margin and computes a maximum cost', () => {
    expect(addGasMargin(1_000_000n)).to.equal(1_200_000n);
    expect(addGasMargin(1n)).to.equal(2n);
    expect(maximumDeploymentCost(1_200_000n, 1_000_000_000n)).to.equal(1_200_000_000_000_000n);
    expect(() => addGasMargin(0n)).to.throw('Deployment gas estimate must be greater than zero.');
  });

  it('prefers EIP-1559 maxFeePerGas and safely falls back to legacy gasPrice', () => {
    expect(selectMaximumFeePerGas(20n, 10n)).to.equal(20n);
    expect(selectMaximumFeePerGas(null, 10n)).to.equal(10n);
    expect(() => selectMaximumFeePerGas(null, null))
      .to.throw('RPC did not return a usable deployment gas price.');
    expect(() => selectMaximumFeePerGas(0n, 10n))
      .to.throw('RPC did not return a usable deployment gas price.');
  });

  it('resumes only when a durable deployment manifest matches the current intent', () => {
    const intent = deploymentIntent();
    const manifest = deploymentManifest(intent);

    expect(() => assertDeploymentManifestMatches(manifest, intent)).not.to.throw();
    expect(() => assertDeploymentManifestMatches(manifest, {
      ...intent,
      treasury: '0x0000000000000000000000000000000000000007',
    })).to.throw(
      'Existing deployment manifest treasury does not match the current deployment; refusing to send another transaction.',
    );
  });

  it('validates a local testnet deployment and reads both token precisions', async () => {
    const { owner, treasury, pre, usdc } = await localDeploymentFixture();
    const values: DeploymentAddresses = {
      PRE_ADDRESS: await pre.getAddress(),
      USDC_ADDRESS: await usdc.getAddress(),
      OWNER_ADDRESS: owner.address,
      TREASURY_ADDRESS: treasury.address,
    };

    expect(await validateDeploymentAddresses(resolveDeploymentNetwork('testnet', 84532), values)).to.deep.equal({
      preDecimals: 18n,
      usdcDecimals: 6n,
    });
  });

  it('requires a distinct deployed-contract target outside token and escrow roles for a Safe handoff', async () => {
    const { owner, pendingOwner, pre, usdc, escrow } = await localDeploymentFixture();
    const safeAddress = await escrow.getAddress();
    const preAddress = await pre.getAddress();
    const usdcAddress = await usdc.getAddress();

    await validateSafeAddress(owner.address, undefined);
    await validateSafeAddress(owner.address, safeAddress, [preAddress, usdcAddress]);
    expect(await rejectionMessage(validateSafeAddress(owner.address, owner.address)))
      .to.equal('SAFE_ADDRESS must differ from the initial OWNER_ADDRESS deployer EOA.');
    expect(await rejectionMessage(validateSafeAddress(owner.address, pendingOwner.address)))
      .to.equal('SAFE_ADDRESS must contain deployed contract code.');
    expect(await rejectionMessage(validateSafeAddress(owner.address, preAddress, [preAddress, usdcAddress])))
      .to.equal('SAFE_ADDRESS must not be a configured token or the escrow contract itself.');
    expect(await rejectionMessage(validateSafeAddress(owner.address, safeAddress, [safeAddress])))
      .to.equal('SAFE_ADDRESS must not be a configured token or the escrow contract itself.');
  });

  it('rejects controller and token role collisions before deployment', async () => {
    const { owner, pre, usdc } = await localDeploymentFixture();
    const preAddress = await pre.getAddress();

    expect(await rejectionMessage(validateDeploymentAddresses(resolveDeploymentNetwork('testnet', 84532), {
      PRE_ADDRESS: preAddress,
      USDC_ADDRESS: await usdc.getAddress(),
      OWNER_ADDRESS: owner.address,
      TREASURY_ADDRESS: preAddress,
    }))).to.equal('TREASURY_ADDRESS must differ from PRE_ADDRESS.');
  });

  it('matches a locally deployed escrow runtime after masking compiler immutable references', async () => {
    const { treasury, escrow } = await localDeploymentFixture();
    const sourceName = 'contracts/PREcommunityEscrowV1.sol';
    const contractName = 'PREcommunityEscrowV1';
    const compiledContract = await readCompiledContract(sourceName, contractName);

    const immutableReferences = compiledContract.evm.deployedBytecode.immutableReferences as ImmutableReferences;
    const localBytecode = `0x${compiledContract.evm.deployedBytecode.object}`;
    const onchainBytecode = await ethers.provider.getCode(await escrow.getAddress());

    expect(normalizeImmutableReferences(onchainBytecode, immutableReferences))
      .to.equal(normalizeImmutableReferences(localBytecode, immutableReferences));
    expect(await escrow.TREASURY()).to.equal(treasury.address);
  });

  it('builds acceptOwnership calldata and exercises the local two-step handoff', async () => {
    const { owner, pendingOwner, escrow } = await localDeploymentFixture();
    const escrowAddress = await escrow.getAddress();
    const acceptanceCalldata = escrow.interface.encodeFunctionData('acceptOwnership');
    const payload = buildSafeTransactionPayload(
      pendingOwner.address,
      84532,
      escrowAddress,
      acceptanceCalldata,
    );

    expect(payload.to).to.equal(escrowAddress);
    expect(payload.safeAddress).to.equal(pendingOwner.address);
    expect(payload.data).to.equal(acceptanceCalldata);
    expect(payload.value).to.equal('0');
    expect(payload.operation).to.equal(0);

    await escrow.connect(owner).transferOwnership(pendingOwner.address);
    expect(await escrow.pendingOwner()).to.equal(pendingOwner.address);
    await escrow.connect(pendingOwner).acceptOwnership();
    expect(await escrow.owner()).to.equal(pendingOwner.address);
    expect(await escrow.pendingOwner()).to.equal(ethers.ZeroAddress);
  });
});
