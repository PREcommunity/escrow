import hre from 'hardhat';

export const hardhatRuntime = hre;
export const hardhatConnection = await hre.network.create();
export const ethers = hardhatConnection.ethers;
export const artifacts = hre.artifacts;
export const network = {
  name: hardhatConnection.networkName,
  config: hardhatConnection.networkConfig,
};
