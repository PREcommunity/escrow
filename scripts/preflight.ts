import { ethers, network } from './lib/hardhat-runtime';
import {
  assertConnectedChainId,
  loadDeployer,
  resolveDeploymentNetwork,
} from './lib/deployer';
import { estimateDeploymentGasBudget } from './lib/deployment-gas';
import { DEPLOYMENT_RELEASE } from './lib/deployment-manifest';
import {
  assertInitialOwnerIsDeployer,
  deploymentEnvironmentKey,
  readDeploymentAddresses,
  readSafeAddress,
  validateDeploymentAddresses,
  validateSafeAddress,
} from './lib/deployment-validation';

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
  const deploymentRequest = await factory.getDeployTransaction(
    values.OWNER_ADDRESS,
    values.PRE_ADDRESS,
    values.USDC_ADDRESS,
    values.TREASURY_ADDRESS,
  );
  const [deployerBalance, gasBudget] = await Promise.all([
    ethers.provider.getBalance(deployer.address),
    estimateDeploymentGasBudget(ethers.provider, deploymentRequest, deployer.address),
  ]);
  if (deployerBalance < gasBudget.maximumCost) {
    throw new Error(
      `Deployer balance ${deployerBalance} wei is below the maximum estimated deployment cost ${gasBudget.maximumCost} wei.`,
    );
  }

  process.stdout.write(`${JSON.stringify({
    network: deploymentNetwork.manifestName,
    release: DEPLOYMENT_RELEASE,
    chainId: deploymentNetwork.chainId,
    deployer: deployer.address,
    keystoreDecrypted: true,
    deployerBalanceEth: ethers.formatEther(deployerBalance),
    deployerBalanceWei: deployerBalance.toString(),
    deploymentGasEstimate: gasBudget.gasEstimate.toString(),
    deploymentGasLimitWith20PercentMargin: gasBudget.gasLimit.toString(),
    maximumFeePerGasWei: gasBudget.maximumFeePerGas.toString(),
    maximumDeploymentCostWei: gasBudget.maximumCost.toString(),
    balanceAfterMaximumDeploymentCostWei: (deployerBalance - gasBudget.maximumCost).toString(),
    preAddress: values.PRE_ADDRESS,
    usdcAddress: values.USDC_ADDRESS,
    owner: values.OWNER_ADDRESS,
    ownershipHandoffTarget: safeAddress ?? null,
    treasury: values.TREASURY_ADDRESS,
    tokenDecimals: {
      PRE: Number(tokenValidation.preDecimals),
      USDC: Number(tokenValidation.usdcDecimals),
    },
    ready: true,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
