import { ethers, network } from './lib/hardhat-runtime';
import type { TransactionReceipt, TransactionResponse } from 'ethers';
import {
  assertConnectedChainId,
  loadDeployer,
  resolveDeploymentNetwork,
} from './lib/deployer';
import { estimateDeploymentGasBudget } from './lib/deployment-gas';
import {
  acquireDeploymentLock,
  assertDeploymentManifestMatches,
  DEPLOYMENT_MANIFEST_SCHEMA,
  DEPLOYMENT_RELEASE,
  deploymentManifestPathFor,
  type DeploymentIntent,
  type DeploymentManifest,
  readDeploymentManifest,
  writeDeploymentManifest,
} from './lib/deployment-manifest';
import {
  assertInitialOwnerIsDeployer,
  deploymentEnvironmentKey,
  readDeploymentAddresses,
  readSafeAddress,
  validateDeploymentAddresses,
  validateSafeAddress,
} from './lib/deployment-validation';
import { readRpcValueWithRetry } from './lib/rpc-read-retry';

const requiredConfirmationsByNetwork = {
  'base-sepolia': 2,
  base: 5,
} as const;

const confirmationPollIntervalMs = 4_000;
const transactionVisibilityAttempts = 30;

async function observedConfirmations(receipt: TransactionReceipt): Promise<number> {
  const latestBlock = await ethers.provider.getBlockNumber();
  return Math.max(0, latestBlock - receipt.blockNumber + 1);
}

async function waitForDeploymentReceipt(
  transactionHash: string,
  requiredConfirmations: number,
): Promise<{ receipt: TransactionReceipt; confirmations: number }> {
  for (;;) {
    const receipt = await ethers.provider.getTransactionReceipt(transactionHash);
    if (receipt) {
      const confirmations = await observedConfirmations(receipt);
      if (confirmations >= requiredConfirmations) return { receipt, confirmations };
    }
    await new Promise((resolve) => setTimeout(resolve, confirmationPollIntervalMs));
  }
}

function assertDeploymentTransactionMatches(
  transaction: TransactionResponse,
  manifest: DeploymentManifest,
): void {
  if (transaction.hash !== manifest.transactionHash) {
    throw new Error('RPC transaction hash does not match the deployment manifest.');
  }
  if (transaction.to !== null) {
    throw new Error('Recorded deployment transaction is not a contract-creation transaction.');
  }
  if (transaction.chainId !== BigInt(manifest.chainId) || transaction.value !== 0n) {
    throw new Error('Recorded deployment transaction chain or value does not match the deployment intent.');
  }
  if (ethers.getAddress(transaction.from) !== manifest.deployer) {
    throw new Error('Recorded deployment transaction sender does not match the deployment manifest.');
  }
  if (transaction.nonce !== manifest.transactionNonce) {
    throw new Error('Recorded deployment transaction nonce does not match the deployment manifest.');
  }
  if (ethers.keccak256(transaction.data) !== manifest.initCodeHash) {
    throw new Error('Recorded deployment transaction init code does not match the deployment manifest.');
  }
  const derivedAddress = ethers.getCreateAddress({ from: transaction.from, nonce: transaction.nonce });
  if (derivedAddress !== manifest.escrowAddress) {
    throw new Error('Recorded deployment address is inconsistent with the transaction sender and nonce.');
  }
}

async function markFailed(
  filePath: string,
  manifest: DeploymentManifest,
  receipt: TransactionReceipt,
  confirmations: number,
): Promise<never> {
  const failedManifest: DeploymentManifest = {
    ...manifest,
    stage: 'failed',
    deploymentBlock: receipt.blockNumber,
    transactionStatus: receipt.status,
    confirmations,
    updatedAt: new Date().toISOString(),
    failureReason: 'The deployment transaction was mined without a successful status.',
  };
  await writeDeploymentManifest(filePath, failedManifest);
  throw new Error(
    `Deployment transaction ${manifest.transactionHash} failed. The failed manifest was retained; refusing to redeploy automatically.`,
  );
}

async function confirmDeployment(
  filePath: string,
  manifest: DeploymentManifest,
): Promise<DeploymentManifest> {
  if (manifest.stage === 'failed') {
    throw new Error(
      `Deployment manifest records a failed transaction ${manifest.transactionHash}; refusing to redeploy automatically.`,
    );
  }

  const transaction = await readRpcValueWithRetry(
    () => ethers.provider.getTransaction(manifest.transactionHash),
    {
      attempts: transactionVisibilityAttempts,
      intervalMs: confirmationPollIntervalMs,
      onMiss: (attempt) => {
        if (attempt === 1) {
          process.stderr.write(
            `Recorded deployment transaction ${manifest.transactionHash} is not visible through this RPC yet; waiting for propagation.\n`,
          );
        }
      },
    },
  );
  if (!transaction) {
    throw new Error(
      `RPC did not expose recorded deployment transaction ${manifest.transactionHash} after the propagation wait. The pending manifest was retained and no second deployment transaction was sent.`,
    );
  }
  assertDeploymentTransactionMatches(transaction, manifest);

  const { receipt, confirmations } = await waitForDeploymentReceipt(
    manifest.transactionHash,
    manifest.requiredConfirmations,
  );
  if (receipt.status !== 1) await markFailed(filePath, manifest, receipt, confirmations);
  if (
    receipt.hash !== manifest.transactionHash
    || receipt.to !== null
    || ethers.getAddress(receipt.from) !== manifest.deployer
  ) {
    throw new Error('Deployment receipt identity does not match the deployment manifest.');
  }
  if (!receipt.contractAddress || ethers.getAddress(receipt.contractAddress) !== manifest.escrowAddress) {
    throw new Error('Deployment receipt contract address does not match the deployment manifest.');
  }
  if (await ethers.provider.getCode(manifest.escrowAddress, receipt.blockNumber) === '0x') {
    throw new Error('Confirmed deployment address had no runtime bytecode at the receipt block.');
  }

  const confirmedManifest: DeploymentManifest = {
    ...manifest,
    stage: 'confirmed',
    deploymentBlock: receipt.blockNumber,
    transactionStatus: receipt.status,
    confirmations,
    updatedAt: new Date().toISOString(),
  };
  delete confirmedManifest.failureReason;
  await writeDeploymentManifest(filePath, confirmedManifest);
  return confirmedManifest;
}

async function main() {
  const deploymentNetwork = resolveDeploymentNetwork(network.name, network.config.chainId);
  const connectedNetwork = await ethers.provider.getNetwork();
  assertConnectedChainId(deploymentNetwork, connectedNetwork.chainId);

  const values = readDeploymentAddresses(deploymentNetwork);
  const safeAddress = readSafeAddress(deploymentNetwork);
  const [tokenValidation] = await Promise.all([
    validateDeploymentAddresses(deploymentNetwork, values),
    validateSafeAddress(values.OWNER_ADDRESS, safeAddress, [values.PRE_ADDRESS, values.USDC_ADDRESS]),
  ]);

  const deployer = await loadDeployer(deploymentNetwork);
  assertInitialOwnerIsDeployer(
    deployer.address,
    values.OWNER_ADDRESS,
    deploymentEnvironmentKey(deploymentNetwork, 'OWNER_ADDRESS'),
  );
  const factory = await ethers.getContractFactory('PREcommunityEscrowV1', deployer);
  const constructorArguments = [
    values.OWNER_ADDRESS,
    values.PRE_ADDRESS,
    values.USDC_ADDRESS,
    values.TREASURY_ADDRESS,
  ] as const;
  const deploymentRequest = await factory.getDeployTransaction(...constructorArguments);
  if (typeof deploymentRequest.data !== 'string') {
    throw new Error('Unable to construct escrow deployment init code.');
  }

  const requiredConfirmations = requiredConfirmationsByNetwork[deploymentNetwork.manifestName];
  const intent: DeploymentIntent = {
    release: DEPLOYMENT_RELEASE,
    network: deploymentNetwork.manifestName,
    chainId: deploymentNetwork.chainId,
    requiredConfirmations,
    deployer: ethers.getAddress(deployer.address),
    preAddress: values.PRE_ADDRESS,
    usdcAddress: values.USDC_ADDRESS,
    owner: values.OWNER_ADDRESS,
    ownershipHandoffTarget: safeAddress ?? null,
    treasury: values.TREASURY_ADDRESS,
    initCodeHash: ethers.keccak256(deploymentRequest.data),
  };

  const manifestPath = deploymentManifestPathFor(deploymentNetwork);
  const releaseLock = await acquireDeploymentLock(manifestPath);
  let deploymentSendAttempted = false;
  let deploymentBroadcast = false;
  let durablePendingManifest = false;
  let manifest: DeploymentManifest;

  try {
    const existingManifest = await readDeploymentManifest(manifestPath);
    if (existingManifest) {
      assertDeploymentManifestMatches(existingManifest, intent);
      manifest = existingManifest;
      durablePendingManifest = true;
    } else {
      const [deployerBalance, gasBudget] = await Promise.all([
        ethers.provider.getBalance(deployer.address),
        estimateDeploymentGasBudget(ethers.provider, deploymentRequest, deployer.address),
      ]);
      if (deployerBalance < gasBudget.maximumCost) {
        throw new Error(
          `Deployer balance ${deployerBalance} wei is below the maximum deployment cost ${gasBudget.maximumCost} wei.`,
        );
      }

      deploymentSendAttempted = true;
      const escrow = await factory.deploy(...constructorArguments, {
        gasLimit: gasBudget.gasLimit,
        ...gasBudget.feeOverrides,
      });
      const deploymentTransaction = escrow.deploymentTransaction();
      if (!deploymentTransaction) throw new Error('Deployment transaction was not created.');
      deploymentBroadcast = true;
      process.stderr.write(`Deployment transaction broadcast: ${deploymentTransaction.hash}\n`);

      const escrowAddress = ethers.getAddress(await escrow.getAddress());
      const now = new Date().toISOString();
      manifest = {
        schema: DEPLOYMENT_MANIFEST_SCHEMA,
        stage: 'pending',
        ...intent,
        escrowAddress,
        transactionHash: deploymentTransaction.hash,
        transactionNonce: deploymentTransaction.nonce,
        deploymentBlock: null,
        transactionStatus: null,
        confirmations: 0,
        tokenDecimals: {
          PRE: Number(tokenValidation.preDecimals),
          USDC: Number(tokenValidation.usdcDecimals),
        },
        gasEstimate: gasBudget.gasEstimate.toString(),
        gasLimit: gasBudget.gasLimit.toString(),
        maximumFeePerGasWei: gasBudget.maximumFeePerGas.toString(),
        maximumDeploymentCostWei: gasBudget.maximumCost.toString(),
        createdAt: now,
        updatedAt: now,
      };
      assertDeploymentTransactionMatches(deploymentTransaction, manifest);
      await writeDeploymentManifest(manifestPath, manifest);
      durablePendingManifest = true;
      process.stderr.write(
        `Pending deployment recorded at ${manifestPath} before confirmation wait (${deploymentTransaction.hash}).\n`,
      );
    }
  } finally {
    if (!deploymentSendAttempted || durablePendingManifest) {
      await releaseLock();
    } else {
      process.stderr.write(
        `Deployment submission may have reached the RPC but its manifest could not be persisted. The deployment lock was retained for manual reconciliation.\n`,
      );
    }
  }

  const confirmedManifest = await confirmDeployment(manifestPath, manifest);
  process.stdout.write(`${JSON.stringify({
    ...confirmedManifest,
    manifestPath,
    resumed: manifest.stage !== 'pending' || !deploymentBroadcast,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
