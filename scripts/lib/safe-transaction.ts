import { ethers } from './hardhat-runtime';

export type SafeTransactionPayload = {
  schema: 'precommunity.safe-transaction.v1';
  safeAddress: string;
  chainId: string;
  to: string;
  value: '0';
  data: string;
  operation: 0;
};

export function buildSafeTransactionPayload(
  safeAddress: string,
  chainId: number,
  to: string,
  data: string,
): SafeTransactionPayload {
  return {
    schema: 'precommunity.safe-transaction.v1',
    safeAddress: ethers.getAddress(safeAddress),
    chainId: String(chainId),
    to: ethers.getAddress(to),
    value: '0',
    data,
    operation: 0,
  };
}
