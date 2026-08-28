import { config as loadEnvironment } from 'dotenv';
import hardhatToolboxMochaEthers from '@nomicfoundation/hardhat-toolbox-mocha-ethers';
import { defineConfig } from 'hardhat/config';

// Deployment configuration in the repository-local .env is authoritative. This prevents
// stale variables exported by an interactive shell from silently changing constructor inputs.
loadEnvironment({ override: true, quiet: true });

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  solidity: {
    version: '0.8.36',
    settings: {
      evmVersion: 'prague',
      optimizer: { enabled: true, runs: 500 },
      viaIR: true,
    },
  },
  typechain: {
    outDir: 'typechain-types',
  },
  networks: {
    testnet: {
      type: 'http',
      chainType: 'op',
      url: process.env.BASE_SEPOLIA_RPC_URL ?? process.env.BASE_RPC_URL ?? 'https://sepolia.base.org',
      chainId: 84532,
    },
    mainnet: {
      type: 'http',
      chainType: 'op',
      url: process.env.BASE_MAINNET_RPC_URL ?? process.env.BASE_RPC_URL ?? 'https://mainnet.base.org',
      chainId: 8453,
    },
  },
  verify: {
    // A single Etherscan V2 key verifies on Base and Base Sepolia by chain ID.
    etherscan: { apiKey: process.env.ETHERSCAN_API_KEY ?? '' },
    blockscout: { enabled: false },
    // Sourcify is opt-in through the dedicated script because it publicly uploads sources.
    sourcify: { enabled: false },
  },
});
