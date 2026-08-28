import type { DeploymentNetwork } from './deployer';
import { readRequiredDeploymentAddress } from './deployment-validation';

const verificationAddressKeys = [
  'ESCROW_ADDRESS',
  'PRE_ADDRESS',
  'USDC_ADDRESS',
  'OWNER_ADDRESS',
  'TREASURY_ADDRESS',
] as const;

export type VerificationAddresses = Record<(typeof verificationAddressKeys)[number], string>;

export function readVerificationAddresses(
  deploymentNetwork: DeploymentNetwork,
  environment: NodeJS.ProcessEnv = process.env,
): VerificationAddresses {
  return Object.fromEntries(verificationAddressKeys.map((key) => {
    return [key, readRequiredDeploymentAddress(deploymentNetwork, key, environment)];
  })) as VerificationAddresses;
}

export function verificationConstructorArguments(values: VerificationAddresses) {
  return [
    values.OWNER_ADDRESS,
    values.PRE_ADDRESS,
    values.USDC_ADDRESS,
    values.TREASURY_ADDRESS,
  ] as const;
}
