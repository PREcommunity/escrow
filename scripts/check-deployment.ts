import { ethers, network } from './lib/hardhat-runtime';
import { readCompiledContract } from './lib/build-info';
import { DEPLOYMENT_RELEASE } from './lib/deployment-manifest';
import { assertConnectedChainId, resolveDeploymentNetwork } from './lib/deployer';
import {
  parseDeploymentCheckStage,
  deploymentEnvironmentKey,
  readDeploymentAddresses,
  readRequiredDeploymentAddress,
  readSafeAddress,
  validateDeploymentAddresses,
  validateSafeAddress,
} from './lib/deployment-validation';
import { type ImmutableReferences, normalizeImmutableReferences } from './lib/runtime-bytecode';

const initialMaxOpenGoalsPerManager = 3n;

function expectedTreasuryPayout(
  deploymentNetwork: ReturnType<typeof resolveDeploymentNetwork>,
  treasuryAddress: string,
): string {
  const environmentKey = deploymentEnvironmentKey(deploymentNetwork, 'TREASURY_PAYOUT_ADDRESS');
  const value = process.env[environmentKey]?.trim();
  if (!value) return treasuryAddress;
  if (!ethers.isAddress(value) || value === ethers.ZeroAddress) {
    throw new Error(`${environmentKey} must be a non-zero public address when set.`);
  }
  return ethers.getAddress(value);
}

async function assertRuntimeBytecodeMatches(onchainBytecode: string): Promise<void> {
  const sourceName = 'contracts/PREcommunityEscrowV1.sol';
  const contractName = 'PREcommunityEscrowV1';
  const compiledContract = await readCompiledContract(sourceName, contractName);

  const localBytecode = `0x${compiledContract.evm.deployedBytecode.object}`;
  const immutableReferences = compiledContract.evm.deployedBytecode.immutableReferences as ImmutableReferences;
  if (
    normalizeImmutableReferences(onchainBytecode, immutableReferences)
    !== normalizeImmutableReferences(localBytecode, immutableReferences)
  ) {
    throw new Error('ESCROW_ADDRESS runtime bytecode does not match the locally compiled contract.');
  }
}

async function main() {
  const deploymentNetwork = resolveDeploymentNetwork(network.name, network.config.chainId);
  const connectedNetwork = await ethers.provider.getNetwork();
  assertConnectedChainId(deploymentNetwork, connectedNetwork.chainId);
  const checkStage = parseDeploymentCheckStage(process.env.DEPLOYMENT_CHECK_STAGE?.trim());
  const values = readDeploymentAddresses(deploymentNetwork);
  const safeAddress = readSafeAddress(deploymentNetwork);
  const escrowAddress = readRequiredDeploymentAddress(deploymentNetwork, 'ESCROW_ADDRESS');
  const treasuryPayoutAddress = expectedTreasuryPayout(deploymentNetwork, values.TREASURY_ADDRESS);
  const [tokenValidation] = await Promise.all([
    validateDeploymentAddresses(deploymentNetwork, values),
    validateSafeAddress(
      values.OWNER_ADDRESS,
      safeAddress,
      [values.PRE_ADDRESS, values.USDC_ADDRESS, escrowAddress],
    ),
  ]);

  const code = await ethers.provider.getCode(escrowAddress);
  if (code === '0x') throw new Error('ESCROW_ADDRESS does not contain deployed contract code.');
  await assertRuntimeBytecodeMatches(code);

  const escrow = await ethers.getContractAt('PREcommunityEscrowV1', escrowAddress);
  const [
    owner,
    pendingOwner,
    pre,
    usdc,
    treasury,
    treasuryPayout,
    paused,
    maxOpenGoalsPerManager,
    maxMonthlyPeriodsPerSettlement,
    profile,
  ] = await Promise.all([
    escrow.getFunction('owner').staticCall() as Promise<string>,
    escrow.getFunction('pendingOwner').staticCall() as Promise<string>,
    escrow.getFunction('PRE').staticCall() as Promise<string>,
    escrow.getFunction('USDC').staticCall() as Promise<string>,
    escrow.getFunction('TREASURY').staticCall() as Promise<string>,
    escrow.getFunction('treasuryPayout').staticCall() as Promise<string>,
    escrow.getFunction('paused').staticCall() as Promise<boolean>,
    escrow.getFunction('maxOpenGoalsPerManager').staticCall() as Promise<bigint>,
    escrow.getFunction('MAX_MONTHLY_PERIODS_PER_SETTLEMENT').staticCall() as Promise<bigint>,
    escrow.getFunction('getProfile').staticCall(values.OWNER_ADDRESS) as Promise<{
      active: boolean;
      revision: bigint;
      displayName: string;
      websiteUrl: string;
      bio: string;
      avatarURI: string;
      defaultPublic: boolean;
    }>,
  ]);

  const actual = {
    owner: ethers.getAddress(owner),
    pendingOwner: ethers.getAddress(pendingOwner),
    preAddress: ethers.getAddress(pre),
    usdcAddress: ethers.getAddress(usdc),
    treasury: ethers.getAddress(treasury),
    treasuryPayout: ethers.getAddress(treasuryPayout),
    paused,
    maxOpenGoalsPerManager,
    maxMonthlyPeriodsPerSettlement,
  };
  const expected = {
    preAddress: values.PRE_ADDRESS,
    usdcAddress: values.USDC_ADDRESS,
    treasury: values.TREASURY_ADDRESS,
    treasuryPayout: treasuryPayoutAddress,
  };
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    if (actual[key] !== expected[key]) throw new Error(`${key} does not match the deployment configuration.`);
  }

  let ownershipHandoffComplete: boolean | null;
  if (checkStage === 'pre-handoff') {
    if (actual.owner !== values.OWNER_ADDRESS || actual.pendingOwner !== ethers.ZeroAddress) {
      throw new Error(
        'pre-handoff check requires OWNER_ADDRESS to remain owner and pendingOwner to be zero.',
      );
    }
    ownershipHandoffComplete = false;
  } else {
    const expectedOwner = safeAddress ?? values.OWNER_ADDRESS;
    if (actual.owner !== expectedOwner) {
      if (safeAddress && actual.owner === values.OWNER_ADDRESS && actual.pendingOwner === safeAddress) {
        throw new Error(
          `Ownership handoff is awaiting SAFE_ADDRESS ${safeAddress} to execute acceptOwnership(). Contributions must remain disabled.`,
        );
      }
      if (safeAddress && actual.owner === values.OWNER_ADDRESS && actual.pendingOwner === ethers.ZeroAddress) {
        throw new Error(
          `Ownership handoff to SAFE_ADDRESS ${safeAddress} has not been initiated. Contributions must remain disabled.`,
        );
      }
      throw new Error(`owner does not match the expected final owner ${expectedOwner}.`);
    }
    if (actual.pendingOwner !== ethers.ZeroAddress) {
      throw new Error(`pendingOwner must be zero after ownership handoff, got ${actual.pendingOwner}.`);
    }
    ownershipHandoffComplete = safeAddress ? true : null;
  }

  if (actual.paused) throw new Error('Escrow must be unpaused for deployment readiness.');
  if (actual.maxOpenGoalsPerManager !== initialMaxOpenGoalsPerManager) {
    throw new Error(
      `maxOpenGoalsPerManager must retain its reviewed initial value ${initialMaxOpenGoalsPerManager}, got ${actual.maxOpenGoalsPerManager}.`,
    );
  }
  if (actual.maxMonthlyPeriodsPerSettlement !== 24n) {
    throw new Error(
      `MAX_MONTHLY_PERIODS_PER_SETTLEMENT must be 24, got ${actual.maxMonthlyPeriodsPerSettlement}.`,
    );
  }

  const deploymentBlockKey = deploymentEnvironmentKey(deploymentNetwork, 'DEPLOYMENT_BLOCK');
  const deploymentBlock = process.env[deploymentBlockKey]?.trim();
  if (!deploymentBlock && deploymentNetwork.manifestName === 'base') {
    throw new Error('DEPLOYMENT_BLOCK is required for the Base mainnet readiness check.');
  }
  let deploymentEvidence: {
    blockNumber: string;
    codePresent: true;
    constructorOwnershipEventPresent: true;
    rawLogCount: number;
    events: string[];
  } | undefined;
  if (deploymentBlock) {
    if (!/^\d+$/.test(deploymentBlock)) {
      throw new Error(`${deploymentBlockKey} must be an unsigned decimal block number.`);
    }
    const blockNumber = BigInt(deploymentBlock);
    if (blockNumber === 0n) throw new Error(`${deploymentBlockKey} must be greater than zero.`);
    const latestBlockNumber = BigInt(await ethers.provider.getBlockNumber());
    if (blockNumber > latestBlockNumber) {
      throw new Error(`DEPLOYMENT_BLOCK ${deploymentBlock} is above the latest block ${latestBlockNumber}.`);
    }
    const [codeAtBlock, logs] = await Promise.all([
      ethers.provider.getCode(escrowAddress, blockNumber),
      ethers.provider.getLogs({ address: escrowAddress, fromBlock: blockNumber, toBlock: blockNumber }),
    ]);
    if (codeAtBlock === '0x') {
      throw new Error(`ESCROW_ADDRESS had no deployed code at DEPLOYMENT_BLOCK ${deploymentBlock}.`);
    }

    const parsedLogs = logs.flatMap((log) => {
      try {
        const parsed = escrow.interface.parseLog(log);
        return parsed ? [parsed] : [];
      } catch {
        return [];
      }
    });
    const constructorOwnershipEventPresent = parsedLogs.some((event) => (
      event.name === 'OwnershipTransferred'
      && ethers.getAddress(event.args.previousOwner) === ethers.ZeroAddress
      && ethers.getAddress(event.args.newOwner) === values.OWNER_ADDRESS
    ));
    if (!constructorOwnershipEventPresent) {
      throw new Error(
        `DEPLOYMENT_BLOCK ${deploymentBlock} does not contain the escrow constructor ownership event.`,
      );
    }

    deploymentEvidence = {
      blockNumber: deploymentBlock,
      codePresent: true,
      constructorOwnershipEventPresent: true,
      rawLogCount: logs.length,
      events: parsedLogs.map((event) => event.name),
    };
  }

  process.stdout.write(`${JSON.stringify({
    network: deploymentNetwork.manifestName,
    release: DEPLOYMENT_RELEASE,
    chainId: deploymentNetwork.chainId,
    checkStage,
    escrowAddress,
    bytecodeBytes: (code.length - 2) / 2,
    initialOwner: values.OWNER_ADDRESS,
    ownershipHandoffTarget: safeAddress ?? null,
    ...actual,
    maxOpenGoalsPerManager: actual.maxOpenGoalsPerManager.toString(),
    maxMonthlyPeriodsPerSettlement: actual.maxMonthlyPeriodsPerSettlement.toString(),
    tokenDecimals: {
      PRE: Number(tokenValidation.preDecimals),
      USDC: Number(tokenValidation.usdcDecimals),
    },
    profileInterface: {
      active: profile.active,
      revision: profile.revision.toString(),
      defaultPublic: profile.defaultPublic,
    },
    deploymentEvidence,
    checks: {
      configurationMatches: true,
      runtimeBytecodeMatches: true,
      pausedIsExpected: true,
      maxOpenGoalsPerManagerIsExpected: true,
      ownershipHandoffRequired: safeAddress !== undefined,
      ownershipHandoffComplete,
      deploymentBlockProvided: deploymentEvidence !== undefined,
      deploymentBlockVerified: deploymentEvidence !== undefined,
      contributionsAllowed: checkStage === 'final',
    },
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
