import { ethers, hardhatRuntime, network } from "./lib/hardhat-runtime";
import {
  assertConnectedChainId,
  resolveDeploymentNetwork,
} from "./lib/deployer";
import { readRequiredDeploymentAddress } from "./lib/deployment-validation";
import {
  assertKeywordMarketManifestNetwork,
  keywordMarketManifestPath,
  readKeywordMarketDeploymentInputs,
  readKeywordMarketManifest,
} from "./lib/keyword-market-deployment";

async function main() {
  const deploymentNetwork = resolveDeploymentNetwork(
    network.name,
    network.config.chainId,
  );
  const connectedNetwork = await ethers.provider.getNetwork();
  assertConnectedChainId(deploymentNetwork, connectedNetwork.chainId);
  if (!process.env.ETHERSCAN_API_KEY?.trim()) {
    throw new Error(
      "ETHERSCAN_API_KEY is required for Keyword Market source verification.",
    );
  }
  const values = readKeywordMarketDeploymentInputs(deploymentNetwork);
  const address = readRequiredDeploymentAddress(
    deploymentNetwork,
    "ADS_CONTRACT_ADDRESS",
  );
  const manifest = await readKeywordMarketManifest(
    keywordMarketManifestPath(deploymentNetwork),
  );
  const initialMinimumStake = manifest
    ? BigInt(manifest.initialMinimumStakeRaw)
    : values.initialMinimumStakeRaw;
  if (manifest) {
    assertKeywordMarketManifestNetwork(manifest, deploymentNetwork);
    if (
      manifest.stage !== "confirmed" ||
      manifest.contractAddress !== address ||
      manifest.preAddress !== values.preAddress ||
      manifest.owner !== values.owner
    ) {
      throw new Error(
        "Keyword Market constructor inputs or address do not match the confirmed deployment manifest.",
      );
    }
  }

  await hardhatRuntime.tasks.getTask(["verify", "etherscan"]).run({
    address,
    constructorArgs: [
      values.owner,
      values.preAddress,
      initialMinimumStake,
      ...(manifest && manifest.startPaused === undefined
        ? []
        : [manifest?.startPaused ?? values.startPaused]),
    ],
    contract: "contracts/PREKeywordMarketV1.sol:PREKeywordMarketV1",
  });
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? error.message : String(error)}\n`,
  );
  process.exitCode = 1;
});
