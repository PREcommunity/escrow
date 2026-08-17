import { ethers, hardhatRuntime, network } from './lib/hardhat-runtime';
import { assertConnectedChainId, resolveDeploymentNetwork } from './lib/deployer';

async function main() {
  const deploymentNetwork = resolveDeploymentNetwork(network.name, network.config.chainId);
  const connectedNetwork = await ethers.provider.getNetwork();
  assertConnectedChainId(deploymentNetwork, connectedNetwork.chainId);
  const address = process.env.ESCROW_ADDRESS;
  if (!address || !ethers.isAddress(address) || address === ethers.ZeroAddress) {
    throw new Error('ESCROW_ADDRESS must be a non-zero public address.');
  }

  await hardhatRuntime.tasks.getTask(['verify', 'sourcify']).run({
    address: ethers.getAddress(address),
    contract: 'contracts/PREcommunityEscrowV1.sol:PREcommunityEscrowV1',
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
