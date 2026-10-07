import type { TransactionReceipt, TransactionResponse } from "ethers";
import { ethers, network } from "./lib/hardhat-runtime";
import {
  assertConnectedChainId,
  loadDeployer,
  resolveDeploymentNetwork,
} from "./lib/deployer";
import { estimateDeploymentGasBudget } from "./lib/deployment-gas";
import { acquireDeploymentLock } from "./lib/deployment-manifest";
import { deploymentEnvironmentKey } from "./lib/deployment-validation";
import {
  assertKeywordMarketManifestMatches,
  assertKeywordMarketDeploymentAllowed,
  validateKeywordMarketDeploymentContracts,
  KEYWORD_MARKET_MANIFEST_SCHEMA,
  keywordMarketManifestPath,
  readKeywordMarketDeploymentInputs,
  readKeywordMarketManifest,
  type KeywordMarketDeploymentManifest,
  writeKeywordMarketManifest,
  waitForKeywordMarketDeploymentTransaction,
} from "./lib/keyword-market-deployment";

const requiredConfirmationsByNetwork = { "base-sepolia": 2, base: 6 } as const;

function assertDeploymentTransaction(
  transaction: TransactionResponse,
  manifest: KeywordMarketDeploymentManifest,
) {
  if (
    transaction.hash !== manifest.transactionHash ||
    transaction.to !== null ||
    transaction.chainId !== BigInt(manifest.chainId) ||
    transaction.value !== 0n ||
    ethers.getAddress(transaction.from) !== manifest.deployer ||
    transaction.nonce !== manifest.transactionNonce ||
    ethers.keccak256(transaction.data) !== manifest.initCodeHash
  ) {
    throw new Error(
      "Deployment transaction does not match the Keyword Market manifest.",
    );
  }
  if (
    ethers.getCreateAddress({
      from: transaction.from,
      nonce: transaction.nonce,
    }) !== manifest.contractAddress
  ) {
    throw new Error(
      "Deployment address does not match the Keyword Market manifest.",
    );
  }
}

async function confirmDeployment(
  filePath: string,
  manifest: KeywordMarketDeploymentManifest,
) {
  if (manifest.stage === "failed") {
    throw new Error(
      "The existing Keyword Market manifest records a failed deployment.",
    );
  }
  const transaction = await waitForKeywordMarketDeploymentTransaction(
    ethers.provider,
    manifest.transactionHash,
    {
      onMiss: (attempt) => {
        if (attempt === 1) {
          process.stderr.write(
            `Recorded Keyword Market deployment transaction ${manifest.transactionHash} is not visible through this RPC yet; waiting for propagation.\n`,
          );
        }
      },
    },
  );
  assertDeploymentTransaction(transaction, manifest);
  const receipt = (await ethers.provider.waitForTransaction(
    manifest.transactionHash,
    manifest.requiredConfirmations,
  )) as TransactionReceipt | null;
  if (!receipt)
    throw new Error("Keyword Market deployment receipt is unavailable.");
  const confirmations = await receipt.confirmations();
  if (receipt.status !== 1) {
    const failed = {
      ...manifest,
      stage: "failed" as const,
      deploymentBlock: receipt.blockNumber,
      transactionStatus: receipt.status,
      confirmations,
      updatedAt: new Date().toISOString(),
      failureReason: "The deployment transaction reverted.",
    };
    await writeKeywordMarketManifest(filePath, failed);
    throw new Error(
      `Keyword Market deployment transaction ${receipt.hash} reverted.`,
    );
  }
  if (
    receipt.hash !== manifest.transactionHash ||
    receipt.to !== null ||
    ethers.getAddress(receipt.from) !== manifest.deployer ||
    !receipt.contractAddress ||
    ethers.getAddress(receipt.contractAddress) !== manifest.contractAddress ||
    (await ethers.provider.getCode(
      manifest.contractAddress,
      receipt.blockNumber,
    )) === "0x"
  ) {
    throw new Error(
      "Keyword Market deployment receipt or bytecode does not match the manifest.",
    );
  }
  const confirmed = {
    ...manifest,
    stage: "confirmed" as const,
    deploymentBlock: receipt.blockNumber,
    transactionStatus: receipt.status,
    confirmations,
    updatedAt: new Date().toISOString(),
  };
  delete confirmed.failureReason;
  await writeKeywordMarketManifest(filePath, confirmed);
  return confirmed;
}

async function main() {
  const deploymentNetwork = resolveDeploymentNetwork(
    network.name,
    network.config.chainId,
  );
  assertKeywordMarketDeploymentAllowed(deploymentNetwork);
  const connectedNetwork = await ethers.provider.getNetwork();
  assertConnectedChainId(deploymentNetwork, connectedNetwork.chainId);
  const values = readKeywordMarketDeploymentInputs(deploymentNetwork);
  await validateKeywordMarketDeploymentContracts(deploymentNetwork, values);
  const requiredConfirmations =
    requiredConfirmationsByNetwork[deploymentNetwork.manifestName];

  const deployer = await loadDeployer(deploymentNetwork);
  const factory = await ethers.getContractFactory(
    "PREKeywordMarketV1",
    deployer,
  );
  const constructorArguments = [
    values.owner,
    values.preAddress,
    values.initialMinimumStakeRaw,
    values.startPaused,
  ] as const;
  const deploymentRequest = await factory.getDeployTransaction(
    ...constructorArguments,
  );
  if (typeof deploymentRequest.data !== "string") {
    throw new Error("Unable to construct Keyword Market deployment init code.");
  }
  const intent = {
    network: deploymentNetwork.manifestName,
    requiredConfirmations,
    chainId: deploymentNetwork.chainId,
    deployer: ethers.getAddress(deployer.address),
    preAddress: values.preAddress,
    owner: values.owner,
    initialMinimumStakeRaw: values.initialMinimumStakeRaw,
    startPaused: values.startPaused,
    initCodeHash: ethers.keccak256(deploymentRequest.data),
  };
  const manifestPath = keywordMarketManifestPath(deploymentNetwork);
  const releaseLock = await acquireDeploymentLock(manifestPath);
  let manifest: KeywordMarketDeploymentManifest;
  let durableManifest = false;
  let deploymentSendAttempted = false;
  try {
    const existing = await readKeywordMarketManifest(manifestPath);
    if (existing) {
      assertKeywordMarketManifestMatches(existing, intent);
      manifest = existing;
      durableManifest = true;
    } else {
      const [balance, gas] = await Promise.all([
        ethers.provider.getBalance(deployer.address),
        estimateDeploymentGasBudget(
          ethers.provider,
          deploymentRequest,
          deployer.address,
        ),
      ]);
      if (balance < gas.maximumCost) {
        throw new Error(
          `Deployer balance ${balance} wei is below the maximum deployment cost ${gas.maximumCost} wei.`,
        );
      }
      // A send may reach RPC even when the response fails. Keep the lock until its manifest is durable.
      deploymentSendAttempted = true;
      const contract = await factory.deploy(...constructorArguments, {
        gasLimit: gas.gasLimit,
        ...gas.feeOverrides,
      });
      const transaction = contract.deploymentTransaction();
      if (!transaction)
        throw new Error(
          "Keyword Market deployment transaction was not created.",
        );
      const now = new Date().toISOString();
      manifest = {
        schema: KEYWORD_MARKET_MANIFEST_SCHEMA,
        stage: "pending",
        network: deploymentNetwork.manifestName,
        chainId: deploymentNetwork.chainId,
        contractAddress: ethers.getAddress(await contract.getAddress()),
        transactionHash: transaction.hash,
        transactionNonce: transaction.nonce,
        deploymentBlock: null,
        transactionStatus: null,
        requiredConfirmations,
        confirmations: 0,
        deployer: intent.deployer,
        preAddress: intent.preAddress,
        owner: intent.owner,
        initialMinimumStakeRaw: values.initialMinimumStakeRaw.toString(),
        startPaused: values.startPaused,
        initCodeHash: intent.initCodeHash,
        gasEstimate: gas.gasEstimate.toString(),
        gasLimit: gas.gasLimit.toString(),
        maximumFeePerGasWei: gas.maximumFeePerGas.toString(),
        maximumDeploymentCostWei: gas.maximumCost.toString(),
        createdAt: now,
        updatedAt: now,
      };
      assertDeploymentTransaction(transaction, manifest);
      await writeKeywordMarketManifest(manifestPath, manifest);
      durableManifest = true;
      process.stderr.write(
        `Keyword Market deployment broadcast: ${transaction.hash}\n`,
      );
    }
  } finally {
    if (!deploymentSendAttempted || durableManifest) {
      await releaseLock();
    } else {
      process.stderr.write(
        "Deployment submission may have reached the RPC but its manifest could not be persisted. The deployment lock was retained for manual reconciliation.\n",
      );
    }
  }

  const confirmed = await confirmDeployment(manifestPath, manifest);
  process.stdout.write(
    `${JSON.stringify(
      {
        ...confirmed,
        manifestPath,
        appEnvironment: {
          [deploymentEnvironmentKey(deploymentNetwork, "ADS_CONTRACT_ADDRESS")]:
            confirmed.contractAddress,
          [deploymentEnvironmentKey(
            deploymentNetwork,
            "ADS_CONTRACT_DEPLOYMENT_BLOCK",
          )]: String(confirmed.deploymentBlock),
        },
      },
      null,
      2,
    )}\n`,
  );
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
