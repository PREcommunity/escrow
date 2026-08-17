import type { FeeData, TransactionRequest } from 'ethers';

export const DEPLOYMENT_GAS_MARGIN_BASIS_POINTS = 2_000n;
const BASIS_POINTS = 10_000n;

interface DeploymentGasProvider {
  estimateGas(transaction: TransactionRequest): Promise<bigint>;
  getFeeData(): Promise<FeeData>;
}

export interface DeploymentGasBudget {
  gasEstimate: bigint;
  gasLimit: bigint;
  maximumFeePerGas: bigint;
  maximumCost: bigint;
  feeOverrides: {
    maxFeePerGas?: bigint;
    maxPriorityFeePerGas?: bigint;
    gasPrice?: bigint;
  };
}

export function addGasMargin(
  estimatedGas: bigint,
  marginBasisPoints: bigint = DEPLOYMENT_GAS_MARGIN_BASIS_POINTS,
): bigint {
  if (estimatedGas <= 0n) throw new Error('Deployment gas estimate must be greater than zero.');
  if (marginBasisPoints < 0n) throw new Error('Deployment gas margin cannot be negative.');

  return (estimatedGas * (BASIS_POINTS + marginBasisPoints) + BASIS_POINTS - 1n) / BASIS_POINTS;
}

export function selectMaximumFeePerGas(
  maxFeePerGas: bigint | null,
  gasPrice: bigint | null,
): bigint {
  const feePerGas = maxFeePerGas ?? gasPrice;
  if (feePerGas === null || feePerGas <= 0n) {
    throw new Error('RPC did not return a usable deployment gas price.');
  }
  return feePerGas;
}

export function maximumDeploymentCost(gasLimit: bigint, maximumFeePerGas: bigint): bigint {
  if (gasLimit <= 0n || maximumFeePerGas <= 0n) {
    throw new Error('Deployment gas limit and maximum fee must be greater than zero.');
  }
  return gasLimit * maximumFeePerGas;
}

export async function estimateDeploymentGasBudget(
  provider: DeploymentGasProvider,
  transaction: TransactionRequest,
  deployerAddress: string,
): Promise<DeploymentGasBudget> {
  const [gasEstimate, feeData] = await Promise.all([
    provider.estimateGas({ ...transaction, from: deployerAddress }),
    provider.getFeeData(),
  ]);
  const gasLimit = addGasMargin(gasEstimate);
  const maximumFeePerGas = selectMaximumFeePerGas(feeData.maxFeePerGas, feeData.gasPrice);
  const feeOverrides = feeData.maxFeePerGas !== null
    ? {
        maxFeePerGas: feeData.maxFeePerGas,
        ...(feeData.maxPriorityFeePerGas !== null
          ? { maxPriorityFeePerGas: feeData.maxPriorityFeePerGas }
          : {}),
      }
    : { gasPrice: maximumFeePerGas };

  return {
    gasEstimate,
    gasLimit,
    maximumFeePerGas,
    maximumCost: maximumDeploymentCost(gasLimit, maximumFeePerGas),
    feeOverrides,
  };
}
