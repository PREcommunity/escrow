import { ethers } from './hardhat-runtime';
import type { DeploymentNetwork } from './deployer';
import { validateControllerCode } from './deployer';

export const deploymentAddressKeys = [
  'PRE_ADDRESS',
  'USDC_ADDRESS',
  'OWNER_ADDRESS',
  'TREASURY_ADDRESS',
] as const;

export type DeploymentAddressKey = (typeof deploymentAddressKeys)[number];
export type DeploymentAddresses = Record<DeploymentAddressKey, string>;
export type DeploymentCheckStage = 'pre-handoff' | 'final';

const erc20MetadataAbi = ['function decimals() view returns (uint8)'] as const;
const baseMainnetChainId = 8453;
// Sources used for the fail-closed Base mainnet allowlist:
// https://docs.presearch.io/presearch-project/tokenomics
// https://developers.circle.com/stablecoins/usdc-contract-addresses
const baseMainnetTokens = {
  PRE_ADDRESS: ethers.getAddress('0x3816dd4bd44c8830c2fa020a5605bac72fa3de7a'),
  USDC_ADDRESS: ethers.getAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
} as const;

export function parseDeploymentCheckStage(value: string | undefined): DeploymentCheckStage {
  if (!value || value === 'final') return 'final';
  if (value === 'pre-handoff') return 'pre-handoff';
  throw new Error('DEPLOYMENT_CHECK_STAGE must be exactly pre-handoff or final.');
}

export function deploymentEnvironmentKey(
  deploymentNetwork: DeploymentNetwork,
  key: string,
): string {
  return deploymentNetwork.manifestName === 'base-sepolia' ? `${key}_TESTNET` : key;
}

export function readRequiredDeploymentAddress(
  deploymentNetwork: DeploymentNetwork,
  key: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const environmentKey = deploymentEnvironmentKey(deploymentNetwork, key);
  const value = environment[environmentKey];
  if (!value || !ethers.isAddress(value) || value === ethers.ZeroAddress) {
    throw new Error(`${environmentKey} must be a non-zero public address.`);
  }
  return ethers.getAddress(value);
}

export function readDeploymentAddresses(
  deploymentNetwork: DeploymentNetwork,
  environment: NodeJS.ProcessEnv = process.env,
): DeploymentAddresses {
  return Object.fromEntries(deploymentAddressKeys.map((key) => {
    return [key, readRequiredDeploymentAddress(deploymentNetwork, key, environment)];
  })) as DeploymentAddresses;
}

export function readSafeAddress(
  deploymentNetwork: DeploymentNetwork,
  environment: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const environmentKey = deploymentEnvironmentKey(deploymentNetwork, 'SAFE_ADDRESS');
  const value = environment[environmentKey]?.trim();
  if (!value) {
    if (deploymentNetwork.manifestName === 'base') {
      throw new Error('SAFE_ADDRESS is required for the Base mainnet ownership handoff.');
    }
    return undefined;
  }
  if (!ethers.isAddress(value) || value === ethers.ZeroAddress) {
    throw new Error(`${environmentKey} must be a non-zero public address when set.`);
  }
  return ethers.getAddress(value);
}

export function assertInitialOwnerIsDeployer(
  deployerAddress: string,
  initialOwner: string,
  environmentKey = 'OWNER_ADDRESS',
): void {
  if (ethers.getAddress(deployerAddress) !== ethers.getAddress(initialOwner)) {
    throw new Error(
      `${environmentKey} ${initialOwner} must equal the selected deployer keystore address ${deployerAddress}.`,
    );
  }
}

export function validateCanonicalTokenAddresses(
  deploymentNetwork: DeploymentNetwork,
  values: Pick<DeploymentAddresses, 'PRE_ADDRESS' | 'USDC_ADDRESS'>,
): void {
  if (deploymentNetwork.chainId !== baseMainnetChainId) return;
  for (const key of ['PRE_ADDRESS', 'USDC_ADDRESS'] as const) {
    if (values[key] !== baseMainnetTokens[key]) {
      throw new Error(`${key} must be the canonical Base mainnet token ${baseMainnetTokens[key]}.`);
    }
  }
}

export async function validateSafeAddress(
  initialOwner: string,
  safeAddress: string | undefined,
  reservedAddresses: readonly string[] = [],
): Promise<void> {
  if (!safeAddress) return;
  const normalizedSafeAddress = ethers.getAddress(safeAddress);
  if (normalizedSafeAddress === ethers.getAddress(initialOwner)) {
    throw new Error('SAFE_ADDRESS must differ from the initial OWNER_ADDRESS deployer EOA.');
  }
  if (reservedAddresses.some((address) => ethers.getAddress(address) === normalizedSafeAddress)) {
    throw new Error('SAFE_ADDRESS must not be a configured token or the escrow contract itself.');
  }
  if (await ethers.provider.getCode(normalizedSafeAddress) === '0x') {
    throw new Error('SAFE_ADDRESS must contain deployed contract code.');
  }
}

export async function validateDeploymentAddresses(
  deploymentNetwork: DeploymentNetwork,
  values: DeploymentAddresses,
): Promise<{ preDecimals: bigint; usdcDecimals: bigint }> {
  if (values.PRE_ADDRESS === values.USDC_ADDRESS) {
    throw new Error('PRE_ADDRESS and USDC_ADDRESS must be different token contracts.');
  }
  for (const controllerKey of ['OWNER_ADDRESS', 'TREASURY_ADDRESS'] as const) {
    for (const tokenKey of ['PRE_ADDRESS', 'USDC_ADDRESS'] as const) {
      if (values[controllerKey] === values[tokenKey]) {
        throw new Error(`${controllerKey} must differ from ${tokenKey}.`);
      }
    }
  }
  validateCanonicalTokenAddresses(deploymentNetwork, values);

  const [treasuryCode, preCode, usdcCode] = await Promise.all([
    ethers.provider.getCode(values.TREASURY_ADDRESS),
    ethers.provider.getCode(values.PRE_ADDRESS),
    ethers.provider.getCode(values.USDC_ADDRESS),
  ]);

  validateControllerCode(deploymentNetwork, 'TREASURY_ADDRESS', treasuryCode);

  if (preCode === '0x') throw new Error('PRE_ADDRESS does not contain deployed contract code.');
  if (usdcCode === '0x') throw new Error('USDC_ADDRESS does not contain deployed contract code.');

  const preToken = new ethers.Contract(values.PRE_ADDRESS, erc20MetadataAbi, ethers.provider);
  const usdcToken = new ethers.Contract(values.USDC_ADDRESS, erc20MetadataAbi, ethers.provider);
  let preDecimals: bigint;
  let usdcDecimals: bigint;

  try {
    [preDecimals, usdcDecimals] = await Promise.all([
      preToken.getFunction('decimals').staticCall() as Promise<bigint>,
      usdcToken.getFunction('decimals').staticCall() as Promise<bigint>,
    ]);
  } catch {
    throw new Error('PRE_ADDRESS and USDC_ADDRESS must expose a working decimals() function.');
  }

  if (preDecimals !== 18n || usdcDecimals !== 6n) {
    throw new Error(`Unexpected token decimals: PRE=${preDecimals}, USDC=${usdcDecimals}.`);
  }

  return { preDecimals, usdcDecimals };
}
