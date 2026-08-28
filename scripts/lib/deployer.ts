import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { Wallet, type HDNodeWallet } from 'ethers';
import { ethers } from './hardhat-runtime';

const projectRootPath = fileURLToPath(new URL('../../', import.meta.url));

const deploymentNetworks = {
  testnet: {
    chainId: 84532,
    manifestName: 'base-sepolia',
    keystoreFile: '.keystore-testnet',
  },
  mainnet: {
    chainId: 8453,
    manifestName: 'base',
    keystoreFile: '.keystore-mainnet',
  },
} as const;

export type DeploymentNetwork = (typeof deploymentNetworks)[keyof typeof deploymentNetworks];

export function resolveDeploymentNetwork(networkName: string, chainId: number | undefined): DeploymentNetwork {
  if (networkName !== 'testnet' && networkName !== 'mainnet') {
    throw new Error('Select a deployment network with --network testnet or --network mainnet.');
  }

  const deploymentNetwork = deploymentNetworks[networkName];
  if (chainId !== deploymentNetwork.chainId) {
    throw new Error(
      `Configured chain ID ${chainId ?? 'unknown'} does not match ${networkName} (${deploymentNetwork.chainId}).`,
    );
  }

  return deploymentNetwork;
}

export function assertConnectedChainId(
  deploymentNetwork: DeploymentNetwork,
  connectedChainId: bigint,
): void {
  if (connectedChainId !== BigInt(deploymentNetwork.chainId)) {
    throw new Error(
      `Connected chain ID ${connectedChainId} does not match ${deploymentNetwork.manifestName} (${deploymentNetwork.chainId}).`,
    );
  }
}

export function validateControllerCode(
  deploymentNetwork: DeploymentNetwork,
  environmentKey: 'OWNER_ADDRESS' | 'TREASURY_ADDRESS',
  code: string,
): void {
  if (
    environmentKey === 'TREASURY_ADDRESS'
    && deploymentNetwork.chainId === deploymentNetworks.mainnet.chainId
    && code === '0x'
  ) {
    throw new Error('TREASURY_ADDRESS must be a deployed contract on Base mainnet, preferably a verified Safe multisig.');
  }
}

export async function readHiddenInput(prompt: string): Promise<string> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error('An interactive terminal is required for hidden input.');
  }

  let muted = false;
  const hiddenOutput = new Writable({
    write(chunk, _encoding, callback) {
      if (!muted) process.stdout.write(chunk);
      callback();
    },
  });
  const readline = createInterface({ input: process.stdin, output: hiddenOutput, terminal: true });

  return new Promise<string>((resolve, reject) => {
    let settled = false;

    readline.once('SIGINT', () => {
      if (settled) return;
      settled = true;
      muted = false;
      process.stdout.write('\n');
      readline.close();
      reject(new Error('Hidden input prompt was cancelled.'));
    });
    readline.once('close', () => {
      if (settled) return;
      settled = true;
      reject(new Error('Hidden input prompt was closed.'));
    });

    readline.question(prompt, (password) => {
      if (settled) return;
      settled = true;
      muted = false;
      process.stdout.write('\n');
      readline.close();
      resolve(password);
    });
    muted = true;
  });
}

export function keystorePathFor(deploymentNetwork: DeploymentNetwork): string {
  return path.resolve(projectRootPath, deploymentNetwork.keystoreFile);
}

export async function loadDeployer(deploymentNetwork: DeploymentNetwork): Promise<Wallet | HDNodeWallet> {
  const keystorePath = keystorePathFor(deploymentNetwork);
  let encryptedKeystore: string;

  try {
    encryptedKeystore = await readFile(keystorePath, 'utf8');
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new Error(`Keystore file ${deploymentNetwork.keystoreFile} was not found in the project root.`);
    }
    throw new Error(`Unable to read keystore file ${deploymentNetwork.keystoreFile}.`);
  }

  const password = await readHiddenInput(`Password for ${deploymentNetwork.keystoreFile}: `);

  try {
    const wallet = await Wallet.fromEncryptedJson(encryptedKeystore, password);
    return wallet.connect(ethers.provider);
  } catch {
    throw new Error(`Unable to decrypt ${deploymentNetwork.keystoreFile}. Check the password and keystore format.`);
  }
}
