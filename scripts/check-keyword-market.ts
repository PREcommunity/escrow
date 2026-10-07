import { ethers, network } from "./lib/hardhat-runtime";
import { readCompiledContract } from "./lib/build-info";
import {
  assertConnectedChainId,
  resolveDeploymentNetwork,
} from "./lib/deployer";
import {
  deploymentEnvironmentKey,
  readRequiredDeploymentAddress,
} from "./lib/deployment-validation";
import {
  assertKeywordMarketManifestNetwork,
  assertKeywordMarketRolloutState,
  parseKeywordMarketCheckStage,
  readKeywordMarketExpectedOperator,
  readKeywordMarketAccounting,
  validateKeywordMarketDeploymentContracts,
  keywordMarketManifestPath,
  readKeywordMarketDeploymentInputs,
  readKeywordMarketManifest,
} from "./lib/keyword-market-deployment";
import {
  type ImmutableReferences,
  normalizeImmutableReferences,
} from "./lib/runtime-bytecode";

async function assertRuntimeBytecodeMatches(onchainBytecode: string) {
  const sourceName = "contracts/PREKeywordMarketV1.sol";
  const contractName = "PREKeywordMarketV1";
  const compiled = await readCompiledContract(sourceName, contractName);
  const localBytecode = `0x${compiled.evm.deployedBytecode.object}`;
  const references = compiled.evm.deployedBytecode
    .immutableReferences as ImmutableReferences;
  if (
    normalizeImmutableReferences(onchainBytecode, references) !==
    normalizeImmutableReferences(localBytecode, references)
  ) {
    throw new Error(
      "Keyword Market runtime bytecode does not match the local reviewed build.",
    );
  }
}

async function main() {
  const deploymentNetwork = resolveDeploymentNetwork(
    network.name,
    network.config.chainId,
  );
  const connectedNetwork = await ethers.provider.getNetwork();
  assertConnectedChainId(deploymentNetwork, connectedNetwork.chainId);
  const values = readKeywordMarketDeploymentInputs(deploymentNetwork);
  await validateKeywordMarketDeploymentContracts(deploymentNetwork, values);
  const manifest = await readKeywordMarketManifest(
    keywordMarketManifestPath(deploymentNetwork),
  );
  const startPaused = manifest
    ? (manifest.startPaused ?? true)
    : values.startPaused;
  const stage = parseKeywordMarketCheckStage(
    process.env.KEYWORD_MARKET_CHECK_STAGE,
    startPaused,
  );
  const expectedOperator = readKeywordMarketExpectedOperator(deploymentNetwork);
  const contractAddress = readRequiredDeploymentAddress(
    deploymentNetwork,
    "ADS_CONTRACT_ADDRESS",
  );
  const deploymentBlockKey = deploymentEnvironmentKey(
    deploymentNetwork,
    "ADS_CONTRACT_DEPLOYMENT_BLOCK",
  );
  const deploymentBlockValue = process.env[deploymentBlockKey]?.trim();
  if (
    !deploymentBlockValue ||
    !/^\d+$/.test(deploymentBlockValue) ||
    deploymentBlockValue === "0"
  ) {
    throw new Error(`${deploymentBlockKey} must be a positive block number.`);
  }
  const deploymentBlock = BigInt(deploymentBlockValue);
  const latestBlock = BigInt(await ethers.provider.getBlockNumber());
  const readOverrides = { blockTag: latestBlock };
  if (deploymentBlock > latestBlock) {
    throw new Error(`${deploymentBlockKey} is above the current chain head.`);
  }

  const [code, codeAtDeployment] = await Promise.all([
    ethers.provider.getCode(contractAddress, latestBlock),
    ethers.provider.getCode(contractAddress, deploymentBlock),
  ]);
  if (code === "0x" || codeAtDeployment === "0x") {
    throw new Error(
      "Keyword Market bytecode is missing at the configured address or deployment block.",
    );
  }
  await assertRuntimeBytecodeMatches(code);

  const market = await ethers.getContractAt(
    "PREKeywordMarketV1",
    contractAddress,
  );
  const preToken = new ethers.Contract(
    values.preAddress,
    ["function balanceOf(address) view returns (uint256)"],
    ethers.provider,
  );
  const [
    owner,
    pendingOwner,
    pre,
    operator,
    minimumStake,
    paused,
    [totalStaked, accruedFees, preBalance],
    deploymentLogs,
  ] = await Promise.all([
    market.getFunction("owner").staticCall(readOverrides) as Promise<string>,
    market.getFunction("pendingOwner").staticCall(readOverrides) as Promise<string>,
    market.getFunction("PRE").staticCall(readOverrides) as Promise<string>,
    market.getFunction("operator").staticCall(readOverrides) as Promise<string>,
    market.getFunction("minimumStake").staticCall(readOverrides) as Promise<bigint>,
    market.getFunction("paused").staticCall(readOverrides) as Promise<boolean>,
    readKeywordMarketAccounting(market, preToken, contractAddress, latestBlock),
    ethers.provider.getLogs({
      address: contractAddress,
      fromBlock: deploymentBlock,
      toBlock: deploymentBlock,
    }),
  ]);
  if (
    ethers.getAddress(owner) !== values.owner ||
    ethers.getAddress(pendingOwner) !== ethers.ZeroAddress
  ) {
    throw new Error(
      "Keyword Market ownership is not finalized on the configured Safe.",
    );
  }
  if (ethers.getAddress(pre) !== values.preAddress) {
    throw new Error(
      `Keyword Market PRE token does not match ${deploymentEnvironmentKey(deploymentNetwork, "PRE_ADDRESS")}.`,
    );
  }
  assertKeywordMarketRolloutState(paused, operator, expectedOperator, stage);
  if (totalStaked + accruedFees > preBalance) {
    throw new Error(
      "Keyword Market PRE balance does not cover stakes and accrued charges.",
    );
  }
  if (minimumStake <= 0n)
    throw new Error("Keyword Market minimum stake must remain positive.");

  const constructorOwnershipEvent = deploymentLogs.some((log) => {
    try {
      const event = market.interface.parseLog(log);
      return (
        event?.name === "OwnershipTransferred" &&
        ethers.getAddress(event.args.previousOwner) === ethers.ZeroAddress &&
        ethers.getAddress(event.args.newOwner) === values.owner
      );
    } catch {
      return false;
    }
  });
  if (!constructorOwnershipEvent) {
    throw new Error(
      "Deployment block does not contain the expected Safe ownership event.",
    );
  }

  const constructorPauseEvent = deploymentLogs.some((log) => {
    try {
      return market.interface.parseLog(log)?.name === "Paused";
    } catch {
      return false;
    }
  });
  if (constructorPauseEvent !== startPaused)
    throw new Error(
      "Keyword Market initial pause state does not match its constructor configuration.",
    );
  if (manifest) {
    assertKeywordMarketManifestNetwork(manifest, deploymentNetwork);
    if (
      manifest.stage !== "confirmed" ||
      manifest.contractAddress !== contractAddress ||
      manifest.preAddress !== values.preAddress ||
      manifest.owner !== values.owner ||
      manifest.deploymentBlock !== Number(deploymentBlock)
    ) {
      throw new Error(
        "Keyword Market manifest does not match the configured deployment.",
      );
    }
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        network: deploymentNetwork.manifestName,
        chainId: deploymentNetwork.chainId,
        stage,
        contractAddress,
        deploymentBlock: deploymentBlock.toString(),
        preAddress: ethers.getAddress(pre),
        owner: ethers.getAddress(owner),
        pendingOwner: ethers.getAddress(pendingOwner),
        operator: ethers.getAddress(operator),
        minimumStakeRaw: minimumStake.toString(),
        totalStakedRaw: totalStaked.toString(),
        accruedFeesRaw: accruedFees.toString(),
        preBalanceRaw: preBalance.toString(),
        paused,
        startPaused,
        bytecodeBytes: (code.length - 2) / 2,
        manifestPresent: Boolean(manifest),
        checks: {
          chainId: true,
          deploymentBlock: true,
          preToken: true,
          safeOwner: true,
          minimumStake: true,
          runtimeBytecode: true,
          constructorOwnershipEvent: true,
          constructorPauseState: true,
          operatorMatchesExpected: true,
          stakesAndAccruedCovered: true,
          pausedMatchesStage: true,
          stakeEnabled: !paused,
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
