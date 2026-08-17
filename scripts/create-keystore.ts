import { constants } from 'node:fs';
import { access, writeFile } from 'node:fs/promises';
import type { Wallet } from 'ethers';
import { network } from './lib/hardhat-runtime';
import {
  keystorePathFor,
  readHiddenInput,
  resolveDeploymentNetwork,
} from './lib/deployer';
import { validateNewKeystorePassword, walletFromPrivateKey } from './lib/keystore';

async function assertKeystoreDoesNotExist(filePath: string, fileName: string): Promise<void> {
  try {
    await access(filePath, constants.F_OK);
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return;
    throw new Error(`Unable to check whether ${fileName} already exists.`);
  }

  throw new Error(`${fileName} already exists. Move it elsewhere before creating a replacement.`);
}

async function main() {
  const deploymentNetwork = resolveDeploymentNetwork(network.name, network.config.chainId);
  const keystorePath = keystorePathFor(deploymentNetwork);
  await assertKeystoreDoesNotExist(keystorePath, deploymentNetwork.keystoreFile);

  let privateKey = await readHiddenInput('Private key: ');
  let wallet: Wallet;
  try {
    wallet = walletFromPrivateKey(privateKey);
  } finally {
    privateKey = '';
  }

  let password = await readHiddenInput(`New password for ${deploymentNetwork.keystoreFile}: `);
  let passwordConfirmation = await readHiddenInput('Confirm password: ');
  let encryptedKeystore: string;
  try {
    validateNewKeystorePassword(password);
    if (password !== passwordConfirmation) throw new Error('The keystore passwords do not match.');

    process.stderr.write('Encrypting keystore...\n');
    encryptedKeystore = await wallet.encrypt(password);
  } finally {
    password = '';
    passwordConfirmation = '';
  }

  try {
    await writeFile(keystorePath, `${encryptedKeystore}\n`, { encoding: 'utf8', mode: 0o600, flag: 'wx' });
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(`${deploymentNetwork.keystoreFile} was created by another process and was not overwritten.`);
    }
    throw new Error(`Unable to write ${deploymentNetwork.keystoreFile}.`);
  }

  process.stdout.write(`${JSON.stringify({
    schema: 'precommunity.keystore.v1',
    network: deploymentNetwork.manifestName,
    chainId: deploymentNetwork.chainId,
    keystoreFile: deploymentNetwork.keystoreFile,
    address: wallet.address,
  }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
});
