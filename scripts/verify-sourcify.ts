import { ethers, hardhatRuntime, network } from './lib/hardhat-runtime';
import { assertConnectedChainId, resolveDeploymentNetwork } from './lib/deployer';
import {
  readVerificationAddresses,
  verificationConstructorArguments,
} from './lib/verification-config';

async function main() {
  const deploymentNetwork = resolveDeploymentNetwork(network.name, network.config.chainId);
  const connectedNetwork = await ethers.provider.getNetwork();
  assertConnectedChainId(deploymentNetwork, connectedNetwork.chainId);
  const values = readVerificationAddresses(deploymentNetwork);

  await hardhatRuntime.tasks.getTask(['verify', 'sourcify']).run({
    address: values.ESCROW_ADDRESS,
    constructorArgs: verificationConstructorArguments(values),
    contract: 'contracts/PREcommunityEscrowV1.sol:PREcommunityEscrowV1',
  });
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
