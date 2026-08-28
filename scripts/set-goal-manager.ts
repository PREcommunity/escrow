import { ethers, network } from './lib/hardhat-runtime';
import type { PREcommunityEscrowV1 } from '../typechain-types';
import { assertConnectedChainId, loadDeployer, resolveDeploymentNetwork } from './lib/deployer';
import { readRequiredDeploymentAddress, readSafeAddress } from './lib/deployment-validation';
import { buildSafeTransactionPayload } from './lib/safe-transaction';

function requiredEnabledState(): boolean {
  const value = process.env.GOAL_MANAGER_ENABLED;
  if (value === 'true') return true;
  if (value === 'false') return false;
  throw new Error('GOAL_MANAGER_ENABLED must be exactly true or false.');
}

async function main() {
  const deploymentNetwork = resolveDeploymentNetwork(network.name, network.config.chainId);
  const actualNetwork = await ethers.provider.getNetwork();
  assertConnectedChainId(deploymentNetwork, actualNetwork.chainId);

  const escrowAddress = readRequiredDeploymentAddress(deploymentNetwork, 'ESCROW_ADDRESS');
  const managerAddress = readRequiredDeploymentAddress(deploymentNetwork, 'GOAL_MANAGER_ADDRESS');
  const enabled = requiredEnabledState();
  if (await ethers.provider.getCode(escrowAddress) === '0x') {
    throw new Error('ESCROW_ADDRESS does not contain deployed contract code.');
  }

  const readOnlyEscrow = await ethers.getContractAt(
    'PREcommunityEscrowV1',
    escrowAddress,
  ) as unknown as PREcommunityEscrowV1;
  const owner = ethers.getAddress(await readOnlyEscrow.owner());
  const [pendingOwner, previousEnabled, ownerCode] = await Promise.all([
    readOnlyEscrow.pendingOwner().then(ethers.getAddress),
    readOnlyEscrow.goalManagers(managerAddress),
    ethers.provider.getCode(owner),
  ]);
  const configuredSafe = readSafeAddress(deploymentNetwork);
  if (ownerCode !== '0x') {
    if (!configuredSafe && deploymentNetwork.manifestName === 'base') {
      throw new Error('SAFE_ADDRESS is required for a Base mainnet Safe transaction payload.');
    }
    if (configuredSafe && ethers.getAddress(configuredSafe) !== owner) {
      throw new Error(`SAFE_ADDRESS must match the current escrow owner ${owner}.`);
    }
  }
  if (pendingOwner !== ethers.ZeroAddress) {
    throw new Error(
      `Escrow ownership transfer to ${pendingOwner} is still pending; complete or replace it before changing goal managers.`,
    );
  }
  if (ownerCode === '0x' && deploymentNetwork.manifestName === 'base') {
    throw new Error('Base mainnet ownership handoff is incomplete; the current owner is still an EOA.');
  }

  if (previousEnabled === enabled) {
    process.stdout.write(`${JSON.stringify({
      schema: 'precommunity.goal-manager-update.v1',
      network: deploymentNetwork.manifestName,
      chainId: deploymentNetwork.chainId,
      escrowAddress,
      owner,
      manager: managerAddress,
      previousEnabled,
      enabled,
      transactionHash: null,
      blockNumber: null,
      changed: false,
    }, null, 2)}\n`);
    return;
  }

  if (ownerCode !== '0x') {
    const calldata = readOnlyEscrow.interface.encodeFunctionData('setGoalManager', [managerAddress, enabled]);
    process.stdout.write(`${JSON.stringify({
      schema: 'precommunity.goal-manager-update.v1',
      network: deploymentNetwork.manifestName,
      chainId: deploymentNetwork.chainId,
      escrowAddress,
      owner,
      manager: managerAddress,
      previousEnabled,
      enabled,
      transactionHash: null,
      blockNumber: null,
      changed: false,
      submitted: false,
      execution: 'safe-required',
      safeTransaction: buildSafeTransactionPayload(
        owner,
        deploymentNetwork.chainId,
        escrowAddress,
        calldata,
      ),
    }, null, 2)}\n`);
    return;
  }

  const deployer = await loadDeployer(deploymentNetwork);
  if (ethers.getAddress(deployer.address) !== owner) {
    throw new Error(`Selected keystore address ${deployer.address} is not the escrow owner ${owner}.`);
  }

  const escrow = await ethers.getContractAt(
    'PREcommunityEscrowV1',
    escrowAddress,
    deployer,
  ) as unknown as PREcommunityEscrowV1;
  const transaction = await escrow.setGoalManager(managerAddress, enabled);
  const receipt = await transaction.wait();
  if (!receipt || receipt.status !== 1) throw new Error('Goal manager update transaction was not confirmed.');

  const expectedEventFound = receipt.logs.some((log) => {
    try {
      const parsed = escrow.interface.parseLog(log);
      return parsed?.name === 'GoalManagerUpdated'
        && ethers.getAddress(parsed.args.account) === managerAddress
        && parsed.args.enabled === enabled;
    } catch {
      return false;
    }
  });
  if (!expectedEventFound) throw new Error('Confirmed transaction did not emit the expected GoalManagerUpdated event.');

  // Public RPC load balancers can briefly serve a stale `latest` state even after returning
  // a successful receipt. Query the receipt block explicitly and treat the receipt event as
  // the authoritative confirmation if that replica has not indexed the block yet.
  let stateVerifiedAtReceiptBlock = false;
  try {
    stateVerifiedAtReceiptBlock = await escrow.goalManagers(
      managerAddress,
      { blockTag: receipt.blockNumber },
    ) === enabled;
  } catch {
    // The confirmed receipt and matching event still prove that the state-changing call succeeded.
  }

  process.stdout.write(`${JSON.stringify({
    schema: 'precommunity.goal-manager-update.v1',
    network: deploymentNetwork.manifestName,
    chainId: deploymentNetwork.chainId,
    escrowAddress,
    owner,
    manager: managerAddress,
    previousEnabled,
    enabled,
    transactionHash: transaction.hash,
    blockNumber: receipt.blockNumber,
    changed: true,
    eventVerified: true,
    stateVerifiedAtReceiptBlock,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
