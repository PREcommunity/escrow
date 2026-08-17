import { ethers, network } from './lib/hardhat-runtime';
import type { MockPRE, MockUSDC } from '../typechain-types';
import { assertConnectedChainId, loadDeployer, resolveDeploymentNetwork } from './lib/deployer';
import {
  PRE_TEST_TOKEN_MINT_UNITS,
  TEST_TOKEN_MINT_AMOUNT,
  USDC_TEST_TOKEN_MINT_UNITS,
} from './lib/test-token-mint';

async function main() {
  const deploymentNetwork = resolveDeploymentNetwork(network.name, network.config.chainId);
  if (deploymentNetwork.chainId !== 84532) {
    throw new Error('This script is restricted to Base Sepolia (chain ID 84532).');
  }
  const connectedNetwork = await ethers.provider.getNetwork();
  assertConnectedChainId(deploymentNetwork, connectedNetwork.chainId);

  const deployer = await loadDeployer(deploymentNetwork);

  const preFactory = await ethers.getContractFactory('MockPRE', deployer);
  const pre = await preFactory.deploy() as unknown as MockPRE;
  const preReceipt = await pre.deploymentTransaction()?.wait();
  if (!preReceipt) throw new Error('MockPRE deployment transaction was not confirmed.');

  const usdcFactory = await ethers.getContractFactory('MockUSDC', deployer);
  const usdc = await usdcFactory.deploy() as unknown as MockUSDC;
  const usdcReceipt = await usdc.deploymentTransaction()?.wait();
  if (!usdcReceipt) throw new Error('MockUSDC deployment transaction was not confirmed.');

  const preMintReceipt = await (await pre.mint(deployer.address, PRE_TEST_TOKEN_MINT_UNITS)).wait();
  if (!preMintReceipt) throw new Error('MockPRE mint transaction was not confirmed.');

  const usdcMintReceipt = await (await usdc.mint(deployer.address, USDC_TEST_TOKEN_MINT_UNITS)).wait();
  if (!usdcMintReceipt) throw new Error('MockUSDC mint transaction was not confirmed.');

  if (await pre.balanceOf(deployer.address) !== PRE_TEST_TOKEN_MINT_UNITS) {
    throw new Error('MockPRE deployer balance does not match the expected initial mint.');
  }
  if (await usdc.balanceOf(deployer.address) !== USDC_TEST_TOKEN_MINT_UNITS) {
    throw new Error('MockUSDC deployer balance does not match the expected initial mint.');
  }

  process.stdout.write(`${JSON.stringify({
    schema: 'precommunity.test-token-deployment.v1',
    network: deploymentNetwork.manifestName,
    chainId: deploymentNetwork.chainId,
    owner: deployer.address,
    mintRecipient: deployer.address,
    mintAmount: TEST_TOKEN_MINT_AMOUNT,
    preAddress: await pre.getAddress(),
    preDeploymentBlock: preReceipt.blockNumber,
    preMintedUnits: PRE_TEST_TOKEN_MINT_UNITS.toString(),
    preMintBlock: preMintReceipt.blockNumber,
    usdcAddress: await usdc.getAddress(),
    usdcDeploymentBlock: usdcReceipt.blockNumber,
    usdcMintedUnits: USDC_TEST_TOKEN_MINT_UNITS.toString(),
    usdcMintBlock: usdcMintReceipt.blockNumber,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
