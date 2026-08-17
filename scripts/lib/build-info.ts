import { readFile } from 'node:fs/promises';
import { artifacts } from './hardhat-runtime';

type CompiledContract = {
  evm: {
    deployedBytecode: {
      object: string;
      immutableReferences: unknown;
    };
  };
};

type BuildInfoOutput = {
  output: {
    contracts: Record<string, Record<string, CompiledContract | undefined> | undefined>;
  };
};

export async function readCompiledContract(
  sourceName: string,
  contractName: string,
): Promise<CompiledContract> {
  const fullyQualifiedName = `${sourceName}:${contractName}`;
  const buildInfoId = await artifacts.getBuildInfoId(fullyQualifiedName);
  if (!buildInfoId) throw new Error(`Build info ID for ${fullyQualifiedName} is unavailable.`);

  const outputPath = await artifacts.getBuildInfoOutputPath(buildInfoId);
  if (!outputPath) throw new Error(`Build info output for ${fullyQualifiedName} is unavailable.`);

  const buildInfo = JSON.parse(await readFile(outputPath, 'utf8')) as BuildInfoOutput;
  const compiledContract = (
    buildInfo.output.contracts[sourceName]
    ?? buildInfo.output.contracts[`project/${sourceName}`]
  )?.[contractName];
  if (!compiledContract) throw new Error(`Compiled output for ${fullyQualifiedName} is unavailable.`);
  return compiledContract;
}
