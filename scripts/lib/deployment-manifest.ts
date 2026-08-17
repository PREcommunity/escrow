import path from 'node:path';
import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import type { DeploymentNetwork } from './deployer';

export type DeploymentManifestStage = 'pending' | 'confirmed' | 'failed';

export interface DeploymentManifest {
  schema: 'precommunity.deployment.v2';
  stage: DeploymentManifestStage;
  network: string;
  chainId: number;
  escrowAddress: string;
  transactionHash: string;
  transactionNonce: number;
  deploymentBlock: number | null;
  transactionStatus: number | null;
  requiredConfirmations: number;
  confirmations: number;
  deployer: string;
  preAddress: string;
  usdcAddress: string;
  owner: string;
  ownershipHandoffTarget: string | null;
  treasury: string;
  tokenDecimals: {
    PRE: number;
    USDC: number;
  };
  initCodeHash: string;
  gasEstimate: string;
  gasLimit: string;
  maximumFeePerGasWei: string;
  maximumDeploymentCostWei: string;
  createdAt: string;
  updatedAt: string;
  failureReason?: string;
}

export type DeploymentIntent = Pick<
  DeploymentManifest,
  | 'network'
  | 'chainId'
  | 'requiredConfirmations'
  | 'deployer'
  | 'preAddress'
  | 'usdcAddress'
  | 'owner'
  | 'ownershipHandoffTarget'
  | 'treasury'
  | 'initCodeHash'
>;

export function deploymentManifestPathFor(deploymentNetwork: DeploymentNetwork): string {
  return path.resolve(__dirname, '..', '..', '.deployments', `${deploymentNetwork.manifestName}.json`);
}

function isFileNotFound(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export async function readDeploymentManifest(filePath: string): Promise<DeploymentManifest | undefined> {
  let contents: string;
  try {
    contents = await readFile(filePath, 'utf8');
  } catch (error: unknown) {
    if (isFileNotFound(error)) return undefined;
    throw new Error(`Unable to read deployment manifest ${filePath}.`);
  }

  let manifest: unknown;
  try {
    manifest = JSON.parse(contents);
  } catch {
    throw new Error(`Deployment manifest ${filePath} is not valid JSON; refusing to deploy again.`);
  }

  if (
    typeof manifest !== 'object'
    || manifest === null
    || !('schema' in manifest)
    || manifest.schema !== 'precommunity.deployment.v2'
    || !('stage' in manifest)
    || !['pending', 'confirmed', 'failed'].includes(String(manifest.stage))
  ) {
    throw new Error(`Deployment manifest ${filePath} has an unsupported format; refusing to deploy again.`);
  }

  return manifest as DeploymentManifest;
}

export function assertDeploymentManifestMatches(
  manifest: DeploymentManifest,
  intent: DeploymentIntent,
): void {
  for (const key of Object.keys(intent) as Array<keyof DeploymentIntent>) {
    if (manifest[key] !== intent[key]) {
      throw new Error(
        `Existing deployment manifest ${key} does not match the current deployment; refusing to send another transaction.`,
      );
    }
  }
}

export async function writeDeploymentManifest(filePath: string, manifest: DeploymentManifest): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await mkdir(directory, { recursive: true });

  try {
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: 'utf8',
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
  } catch (error: unknown) {
    try {
      await unlink(temporaryPath);
    } catch (cleanupError: unknown) {
      if (!isFileNotFound(cleanupError)) {
        // Preserve the original write error; the uniquely named temporary file is safe to inspect manually.
      }
    }
    throw new Error(`Unable to atomically write deployment manifest ${filePath}.`);
  }
}

export async function acquireDeploymentLock(filePath: string): Promise<() => Promise<void>> {
  const directory = path.dirname(filePath);
  const lockPath = `${filePath}.lock`;
  await mkdir(directory, { recursive: true });

  try {
    await writeFile(lockPath, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`, {
      encoding: 'utf8',
      mode: 0o600,
      flag: 'wx',
    });
  } catch (error: unknown) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      throw new Error(
        `Deployment lock ${lockPath} already exists. Confirm no deployment process is running and reconcile its transaction before removing the lock.`,
      );
    }
    throw new Error(`Unable to create deployment lock ${lockPath}.`);
  }

  return async () => {
    try {
      await unlink(lockPath);
    } catch (error: unknown) {
      if (!isFileNotFound(error)) throw new Error(`Unable to remove deployment lock ${lockPath}.`);
    }
  };
}
