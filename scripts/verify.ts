import { ethers, hardhatRuntime, network } from './lib/hardhat-runtime';
import { assertConnectedChainId, resolveDeploymentNetwork } from './lib/deployer';

const required = ['ESCROW_ADDRESS', 'PRE_ADDRESS', 'USDC_ADDRESS', 'OWNER_ADDRESS', 'TREASURY_ADDRESS'] as const;

async function main() {
  const deploymentNetwork = resolveDeploymentNetwork(network.name, network.config.chainId);
  const connectedNetwork = await ethers.provider.getNetwork();
  assertConnectedChainId(deploymentNetwork, connectedNetwork.chainId);
  const values = Object.fromEntries(required.map((key) => {
    const value = process.env[key];
    if (!value || !ethers.isAddress(value) || value === ethers.ZeroAddress) {
      throw new Error(`${key} must be a non-zero public address.`);
    }
    return [key, ethers.getAddress(value)];
  })) as Record<(typeof required)[number], string>;
  if (!process.env.ETHERSCAN_API_KEY?.trim()) throw new Error('ETHERSCAN_API_KEY is required for source verification.');

  await hardhatRuntime.tasks.getTask(['verify', 'etherscan']).run({
    address: values.ESCROW_ADDRESS,
    constructorArgs: [values.OWNER_ADDRESS, values.PRE_ADDRESS, values.USDC_ADDRESS, values.TREASURY_ADDRESS],
    contract: 'contracts/PREcommunityEscrowV1.sol:PREcommunityEscrowV1',
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
