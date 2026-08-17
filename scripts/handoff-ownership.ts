import { ethers, network } from './lib/hardhat-runtime';
import type { PREcommunityEscrowV1 } from '../typechain-types';
import { assertConnectedChainId, loadDeployer, resolveDeploymentNetwork } from './lib/deployer';
import { assertInitialOwnerIsDeployer, readSafeAddress, validateSafeAddress } from './lib/deployment-validation';
import { buildSafeTransactionPayload } from './lib/safe-transaction';

function requiredAddress(key: 'ESCROW_ADDRESS' | 'OWNER_ADDRESS'): string {
  const value = process.env[key];
  if (!value || !ethers.isAddress(value) || value === ethers.ZeroAddress) {
    throw new Error(`${key} must be a non-zero public address.`);
  }
  return ethers.getAddress(value);
}

async function main() {
  const deploymentNetwork = resolveDeploymentNetwork(network.name, network.config.chainId);
  const connectedNetwork = await ethers.provider.getNetwork();
  assertConnectedChainId(deploymentNetwork, connectedNetwork.chainId);
  const escrowAddress = requiredAddress('ESCROW_ADDRESS');
  const initialOwner = requiredAddress('OWNER_ADDRESS');
  const safeAddress = readSafeAddress(deploymentNetwork);
  if (!safeAddress) throw new Error('SAFE_ADDRESS is required for an ownership handoff.');

  if (await ethers.provider.getCode(escrowAddress) === '0x') {
    throw new Error('ESCROW_ADDRESS does not contain deployed contract code.');
  }

  const escrow = await ethers.getContractAt(
    'PREcommunityEscrowV1',
    escrowAddress,
  ) as unknown as PREcommunityEscrowV1;
  const [preAddress, usdcAddress] = await Promise.all([
    escrow.PRE().then(ethers.getAddress),
    escrow.USDC().then(ethers.getAddress),
  ]);
  await validateSafeAddress(initialOwner, safeAddress, [preAddress, usdcAddress, escrowAddress]);
  let owner = ethers.getAddress(await escrow.owner());
  let pendingOwner = ethers.getAddress(await escrow.pendingOwner());
  const acceptanceCalldata = escrow.interface.encodeFunctionData('acceptOwnership');
  const safeTransaction = buildSafeTransactionPayload(
    safeAddress,
    deploymentNetwork.chainId,
    escrowAddress,
    acceptanceCalldata,
  );

  if (owner === safeAddress) {
    if (pendingOwner !== ethers.ZeroAddress) {
      throw new Error(`Safe is the current owner but pendingOwner is unexpectedly set to ${pendingOwner}.`);
    }
    process.stdout.write(`${JSON.stringify({
      schema: 'precommunity.ownership-handoff.v1',
      network: deploymentNetwork.manifestName,
      chainId: deploymentNetwork.chainId,
      escrowAddress,
      initialOwner,
      safeAddress,
      owner,
      pendingOwner,
      stage: 'complete',
      initiationTransactionHash: null,
      initiationBlockNumber: null,
      safeTransaction: null,
      ownershipHandoffComplete: true,
      deploymentReadinessNotChecked: true,
    }, null, 2)}\n`);
    return;
  }

  if (owner !== initialOwner) {
    throw new Error(`Escrow owner ${owner} is neither OWNER_ADDRESS ${initialOwner} nor SAFE_ADDRESS ${safeAddress}.`);
  }
  if (pendingOwner !== ethers.ZeroAddress && pendingOwner !== safeAddress) {
    throw new Error(`Escrow pendingOwner ${pendingOwner} does not match SAFE_ADDRESS ${safeAddress}.`);
  }

  let initiationTransactionHash: string | null = null;
  let initiationBlockNumber: number | null = null;
  let eventVerified = pendingOwner === safeAddress;

  if (pendingOwner === ethers.ZeroAddress) {
    const deployer = await loadDeployer(deploymentNetwork);
    assertInitialOwnerIsDeployer(deployer.address, initialOwner);
    const writableEscrow = escrow.connect(deployer) as PREcommunityEscrowV1;
    const transaction = await writableEscrow.transferOwnership(safeAddress);
    const receipt = await transaction.wait();
    if (!receipt || receipt.status !== 1) {
      throw new Error('Ownership handoff initiation transaction was not confirmed.');
    }

    eventVerified = receipt.logs.some((log) => {
      try {
        const parsed = escrow.interface.parseLog(log);
        return parsed?.name === 'OwnershipTransferStarted'
          && ethers.getAddress(parsed.args.previousOwner) === initialOwner
          && ethers.getAddress(parsed.args.newOwner) === safeAddress;
      } catch {
        return false;
      }
    });
    if (!eventVerified) {
      throw new Error('Confirmed transaction did not emit the expected OwnershipTransferStarted event.');
    }

    initiationTransactionHash = transaction.hash;
    initiationBlockNumber = receipt.blockNumber;
    pendingOwner = safeAddress;
    owner = initialOwner;
  }

  process.stdout.write(`${JSON.stringify({
    schema: 'precommunity.ownership-handoff.v1',
    network: deploymentNetwork.manifestName,
    chainId: deploymentNetwork.chainId,
    escrowAddress,
    initialOwner,
    safeAddress,
    owner,
    pendingOwner,
    stage: 'awaiting-safe-acceptance',
    initiationTransactionHash,
    initiationBlockNumber,
    initiationEventVerified: eventVerified,
    safeTransaction,
    ownershipHandoffComplete: false,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
