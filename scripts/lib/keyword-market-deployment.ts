import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { BaseContract } from "ethers";
import { ethers } from "./hardhat-runtime";
import type { DeploymentNetwork } from "./deployer";
import {
  readRpcValueWithRetry,
  type RpcReadRetryOptions,
} from "./rpc-read-retry";
import {
  deploymentEnvironmentKey,
  readRequiredDeploymentAddress,
  validateCanonicalPreTokenAddress,
} from "./deployment-validation";

const projectRootPath = fileURLToPath(new URL("../../", import.meta.url));

export const KEYWORD_MARKET_MANIFEST_SCHEMA =
  "precommunity.keyword-market-deployment.v1" as const;

export interface KeywordMarketDeploymentManifest {
  schema: typeof KEYWORD_MARKET_MANIFEST_SCHEMA;
  stage: "pending" | "confirmed" | "failed";
  network: DeploymentNetwork["manifestName"];
  chainId: DeploymentNetwork["chainId"];
  contractAddress: string;
  transactionHash: string;
  transactionNonce: number;
  deploymentBlock: number | null;
  transactionStatus: number | null;
  requiredConfirmations: number;
  confirmations: number;
  deployer: string;
  preAddress: string;
  owner: string;
  initialMinimumStakeRaw: string;
  startPaused?: boolean; // Legacy three-argument deployments always started paused.
  initCodeHash: string;
  gasEstimate: string;
  gasLimit: string;
  maximumFeePerGasWei: string;
  maximumDeploymentCostWei: string;
  createdAt: string;
  updatedAt: string;
  failureReason?: string;
}

export interface KeywordMarketDeploymentInputs {
  preAddress: string;
  owner: string;
  initialMinimumStakeRaw: bigint;
  startPaused: boolean;
}

export type KeywordMarketCheckStage = "rollout" | "active";

export async function readKeywordMarketAccounting(
  market: BaseContract,
  preToken: BaseContract,
  contractAddress: string,
  blockTag: bigint,
): Promise<[bigint, bigint, bigint]> {
  const overrides = { blockTag };
  return Promise.all([
    market.getFunction("totalStaked").staticCall(overrides) as Promise<bigint>,
    market.getFunction("accruedFees").staticCall(overrides) as Promise<bigint>,
    preToken.getFunction("balanceOf").staticCall(contractAddress, overrides) as Promise<bigint>,
  ]);
}

export async function waitForKeywordMarketDeploymentTransaction<T>(
  provider: { getTransaction: (hash: string) => Promise<T | null> },
  transactionHash: string,
  options: Partial<RpcReadRetryOptions> = {},
): Promise<T> {
  const transaction = await readRpcValueWithRetry(
    () => provider.getTransaction(transactionHash),
    { attempts: 16, intervalMs: 2_000, ...options },
  );
  if (transaction === null) {
    throw new Error(
      `RPC did not expose recorded Keyword Market deployment transaction ${transactionHash} after the propagation wait. The durable manifest and any reconciliation lock were retained; no second transaction was sent. Rerun the same deployment command to resume this transaction; do not delete the manifest or deploy again.`,
    );
  }
  return transaction;
}

export function assertKeywordMarketDeploymentAllowed(
  deploymentNetwork: DeploymentNetwork,
  environment: NodeJS.ProcessEnv = process.env,
) {
  if (
    deploymentNetwork.manifestName === "base" &&
    environment.KEYWORD_MARKET_ALLOW_MAINNET !== "1"
  ) {
    throw new Error(
      "Base mainnet Keyword Market deployment requires KEYWORD_MARKET_ALLOW_MAINNET=1.",
    );
  }
}

export function parseKeywordMarketCheckStage(
  value: string | undefined,
  startPaused = false,
): KeywordMarketCheckStage {
  if (!value) return startPaused ? "rollout" : "active";
  if (value === "rollout") return "rollout";
  if (value === "active") return "active";
  throw new Error(
    "KEYWORD_MARKET_CHECK_STAGE must be exactly rollout or active.",
  );
}

export function readKeywordMarketExpectedOperator(
  deploymentNetwork: DeploymentNetwork,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const key = deploymentEnvironmentKey(
    deploymentNetwork,
    "ADS_OPERATOR_ADDRESS",
  );
  const value = environment[key]?.trim();
  if (!value) return ethers.ZeroAddress;
  if (!ethers.isAddress(value))
    throw new Error(`${key} must be a public address when set.`);
  return ethers.getAddress(value);
}

export function assertKeywordMarketRolloutState(
  paused: boolean,
  operator: string,
  expectedOperator: string,
  stage: KeywordMarketCheckStage,
) {
  if (ethers.getAddress(operator) !== ethers.getAddress(expectedOperator)) {
    throw new Error(
      "Keyword Market operator does not match the expected operator (zero by default).",
    );
  }
  if (paused !== (stage === "rollout")) {
    throw new Error(
      stage === "rollout"
        ? "Keyword Market must remain paused during rollout."
        : "Keyword Market is paused; staking is not active.",
    );
  }
}

export function readKeywordMarketDeploymentInputs(
  deploymentNetwork: DeploymentNetwork,
  environment: NodeJS.ProcessEnv = process.env,
): KeywordMarketDeploymentInputs {
  const minimumKey = deploymentEnvironmentKey(
    deploymentNetwork,
    "KEYWORD_MARKET_MINIMUM_PRE",
  );
  const minimumValue = environment[minimumKey]?.trim() || "1";
  let initialMinimumStakeRaw: bigint;
  try {
    initialMinimumStakeRaw = ethers.parseUnits(minimumValue, 18);
  } catch {
    throw new Error(
      `${minimumKey} must be a positive PRE amount with at most 18 decimals.`,
    );
  }
  if (initialMinimumStakeRaw <= 0n)
    throw new Error(`${minimumKey} must be greater than zero.`);
  const preAddress = readRequiredDeploymentAddress(
    deploymentNetwork,
    "PRE_ADDRESS",
    environment,
  );
  const owner = readRequiredDeploymentAddress(
    deploymentNetwork,
    "SAFE_ADDRESS",
    environment,
  );
  validateCanonicalPreTokenAddress(deploymentNetwork, preAddress);
  if (preAddress === owner)
    throw new Error("Keyword Market PRE token and Safe owner must differ.");
  const pausedKey = deploymentEnvironmentKey(
    deploymentNetwork,
    "KEYWORD_MARKET_START_PAUSED",
  );
  const pausedValue = environment[pausedKey]?.trim() || "0";
  if (!["0", "1"].includes(pausedValue))
    throw new Error(`${pausedKey} must be exactly 0 or 1.`);
  return {
    preAddress,
    owner,
    initialMinimumStakeRaw,
    startPaused: pausedValue === "1",
  };
}

export function assertKeywordMarketSafeConfiguration(
  owners: string[],
  threshold: bigint,
) {
  if (!owners.length || threshold <= 0n || threshold > BigInt(owners.length)) {
    throw new Error(
      "Keyword Market owner must expose a valid Safe owner list and threshold.",
    );
  }
  const normalized = owners.map((owner) => ethers.getAddress(owner));
  if (
    normalized.includes(ethers.ZeroAddress) ||
    new Set(normalized).size !== normalized.length
  ) {
    throw new Error(
      "Keyword Market Safe owners must be distinct non-zero addresses.",
    );
  }
}

export async function validateKeywordMarketDeploymentContracts(
  deploymentNetwork: DeploymentNetwork,
  values: KeywordMarketDeploymentInputs,
) {
  validateCanonicalPreTokenAddress(deploymentNetwork, values.preAddress);
  if (values.preAddress === values.owner)
    throw new Error("Keyword Market PRE token and Safe owner must differ.");
  const [preCode, ownerCode] = await Promise.all([
    ethers.provider.getCode(values.preAddress),
    ethers.provider.getCode(values.owner),
  ]);
  if (preCode === "0x")
    throw new Error(
      `${deploymentEnvironmentKey(deploymentNetwork, "PRE_ADDRESS")} does not contain contract code.`,
    );
  if (ownerCode === "0x")
    throw new Error(
      `${deploymentEnvironmentKey(deploymentNetwork, "SAFE_ADDRESS")} does not contain contract code.`,
    );
  const token = new ethers.Contract(
    values.preAddress,
    ["function decimals() view returns (uint8)"],
    ethers.provider,
  );
  const safe = new ethers.Contract(
    values.owner,
    [
      "function getOwners() view returns (address[])",
      "function getThreshold() view returns (uint256)",
    ],
    ethers.provider,
  );
  let decimals: bigint;
  let owners: string[];
  let threshold: bigint;
  try {
    [decimals, owners, threshold] = await Promise.all([
      token.getFunction("decimals").staticCall() as Promise<bigint>,
      safe.getFunction("getOwners").staticCall() as Promise<string[]>,
      safe.getFunction("getThreshold").staticCall() as Promise<bigint>,
    ]);
  } catch {
    throw new Error(
      "Keyword Market PRE metadata and Safe owner/threshold calls must succeed on the selected chain.",
    );
  }
  if (decimals !== 18n)
    throw new Error("Keyword Market PRE token must expose 18 decimals.");
  assertKeywordMarketSafeConfiguration(owners, threshold);
}

export function keywordMarketManifestPath(
  deploymentNetwork: DeploymentNetwork,
  environment: NodeJS.ProcessEnv = process.env,
) {
  const key = deploymentEnvironmentKey(
    deploymentNetwork,
    "KEYWORD_MARKET_DEPLOYMENT_NAME",
  );
  const name = environment[key]?.trim() || "";
  if (name && !/^[a-z0-9][a-z0-9-]{0,63}$/.test(name))
    throw new Error(
      `${key} must use 1-64 lowercase letters, digits or hyphens.`,
    );
  return path.resolve(
    projectRootPath,
    ".deployments",
    `${deploymentNetwork.manifestName}.keyword-market-v1${name ? `.${name}` : ""}.json`,
  );
}

function isFileNotFound(error: unknown) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function validManifest(
  value: unknown,
): value is KeywordMarketDeploymentManifest {
  if (!value || typeof value !== "object") return false;
  const item = value as Record<string, unknown>;
  if (item.startPaused !== undefined && typeof item.startPaused !== "boolean")
    return false;
  if (
    item.schema !== KEYWORD_MARKET_MANIFEST_SCHEMA ||
    !["pending", "confirmed", "failed"].includes(String(item.stage))
  )
    return false;
  if (!(
    (item.network === "base" && item.chainId === 8453) ||
    (item.network === "base-sepolia" && item.chainId === 84532)
  ))
    return false;
  for (const key of ["contractAddress", "deployer", "preAddress", "owner"]) {
    const address = item[key];
    if (
      typeof address !== "string" ||
      !ethers.isAddress(address) ||
      address === ethers.ZeroAddress ||
      address !== ethers.getAddress(address)
    )
      return false;
  }
  for (const key of ["transactionHash", "initCodeHash"]) {
    if (
      typeof item[key] !== "string" ||
      !/^0x[0-9a-fA-F]{64}$/.test(item[key] as string)
    )
      return false;
  }
  for (const key of [
    "transactionNonce",
    "confirmations",
    "requiredConfirmations",
  ]) {
    if (
      !Number.isSafeInteger(item[key]) ||
      Number(item[key]) < (key === "requiredConfirmations" ? 1 : 0)
    )
      return false;
  }
  const deploymentBlock = item.deploymentBlock;
  if (
    deploymentBlock !== null &&
    (!Number.isSafeInteger(deploymentBlock) || Number(deploymentBlock) <= 0)
  )
    return false;
  if (![null, 0, 1].includes(item.transactionStatus as number | null))
    return false;
  if (
    item.stage === "pending" &&
    (deploymentBlock !== null || item.transactionStatus !== null)
  )
    return false;
  if (
    item.stage === "confirmed" &&
    (deploymentBlock === null ||
      item.transactionStatus !== 1 ||
      Number(item.confirmations) < Number(item.requiredConfirmations))
  )
    return false;
  if (
    item.stage === "failed" &&
    (deploymentBlock === null || item.transactionStatus !== 0)
  )
    return false;
  for (const key of [
    "initialMinimumStakeRaw",
    "gasEstimate",
    "gasLimit",
    "maximumFeePerGasWei",
    "maximumDeploymentCostWei",
  ]) {
    if (
      typeof item[key] !== "string" ||
      !/^\d+$/.test(item[key] as string) ||
      BigInt(item[key] as string) <= 0n
    )
      return false;
  }
  for (const key of ["createdAt", "updatedAt"]) {
    if (
      typeof item[key] !== "string" ||
      !Number.isFinite(Date.parse(item[key] as string))
    )
      return false;
  }
  return (
    ethers.getCreateAddress({
      from: item.deployer as string,
      nonce: item.transactionNonce as number,
    }) === item.contractAddress
  );
}

export async function readKeywordMarketManifest(filePath: string) {
  let contents: string;
  try {
    contents = await readFile(filePath, "utf8");
  } catch (error) {
    if (isFileNotFound(error)) return undefined;
    throw new Error(
      `Unable to read Keyword Market deployment manifest ${filePath}.`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(contents);
  } catch {
    throw new Error(
      `Keyword Market deployment manifest ${filePath} is not valid JSON; refusing to redeploy.`,
    );
  }
  if (!validManifest(value))
    throw new Error(
      `Keyword Market deployment manifest ${filePath} has an unsupported format; refusing to redeploy.`,
    );
  return value;
}

export async function writeKeywordMarketManifest(
  filePath: string,
  manifest: KeywordMarketDeploymentManifest,
) {
  if (!validManifest(manifest))
    throw new Error(
      "Refusing to persist an invalid Keyword Market deployment manifest.",
    );
  const temporaryPath = `${filePath}.${process.pid}.tmp`;
  await mkdir(path.dirname(filePath), { recursive: true });
  try {
    await writeFile(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(temporaryPath, filePath);
  } catch {
    try {
      await unlink(temporaryPath);
    } catch {
      /* Preserve the manifest write failure. */
    }
    throw new Error(
      `Unable to atomically write Keyword Market deployment manifest ${filePath}.`,
    );
  }
}

export function assertKeywordMarketManifestNetwork(
  manifest: KeywordMarketDeploymentManifest,
  deploymentNetwork: DeploymentNetwork,
) {
  if (
    manifest.network !== deploymentNetwork.manifestName ||
    manifest.chainId !== deploymentNetwork.chainId
  ) {
    throw new Error(
      "Keyword Market manifest network and chain ID do not match the selected deployment.",
    );
  }
}

export function assertKeywordMarketManifestMatches(
  manifest: KeywordMarketDeploymentManifest,
  input: {
    network: DeploymentNetwork["manifestName"];
    chainId: number;
    requiredConfirmations: number;
    deployer: string;
    preAddress: string;
    owner: string;
    initialMinimumStakeRaw: bigint;
    startPaused: boolean;
    initCodeHash: string;
  },
) {
  const expected = {
    network: input.network,
    chainId: input.chainId,
    requiredConfirmations: input.requiredConfirmations,
    deployer: ethers.getAddress(input.deployer),
    preAddress: ethers.getAddress(input.preAddress),
    owner: ethers.getAddress(input.owner),
    initialMinimumStakeRaw: input.initialMinimumStakeRaw.toString(),
    startPaused: input.startPaused,
    initCodeHash: input.initCodeHash,
  } as const;
  for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
    const actual =
      key === "startPaused" ? (manifest.startPaused ?? true) : manifest[key];
    if (actual !== expected[key])
      throw new Error(
        `Existing Keyword Market deployment manifest ${key} does not match the current deployment; refusing to send another transaction.`,
      );
  }
}
