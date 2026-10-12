import { expect } from 'chai';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import type { VerifyContractArgs } from '@nomicfoundation/hardhat-verify/verify';

describe('Keyword Market source verification', () => {
  it('passes exact bigint and boolean constructor values through the programmatic API', async () => {
    const source = await readFile(new URL('../scripts/verify-keyword-market.ts', import.meta.url), 'utf8');
    const { outputText } = transpileModule(source, {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022 },
    });
    const owner = '0x0000000000000000000000000000000000000001';
    const preAddress = '0x0000000000000000000000000000000000000002';
    const address = '0x0000000000000000000000000000000000000003';
    const minimum = 1000000000000000001n;

    for (const startPaused of [false, true, undefined]) {
      const runtime = {
        tasks: { getTask: () => { throw new Error('Use the programmatic verification API.'); } },
      };
      const manifest = {
        stage: 'confirmed', contractAddress: address, owner, preAddress,
        initialMinimumStakeRaw: minimum.toString(),
        ...(startPaused === undefined ? {} : { startPaused }),
      };
      const result = new Promise<VerifyContractArgs>((resolve, reject) => {
        const modules: Record<string, unknown> = {
          '@nomicfoundation/hardhat-verify/verify': {
            verifyContract: async (args: VerifyContractArgs, hre: unknown) => {
              try {
                expect(hre).to.equal(runtime);
                resolve(args);
                return true;
              } catch (error) {
                reject(error);
                throw error;
              }
            },
          },
          './lib/hardhat-runtime': {
            hardhatRuntime: runtime,
            network: { name: 'testnet', config: { chainId: 84532 } },
            ethers: { provider: { getNetwork: async () => ({ chainId: 84532n }) } },
          },
          './lib/deployer': {
            resolveDeploymentNetwork: () => ({ chainId: 84532, manifestName: 'base-sepolia' }),
            assertConnectedChainId: () => {},
          },
          './lib/deployment-validation': { readRequiredDeploymentAddress: () => address },
          './lib/keyword-market-deployment': {
            readKeywordMarketDeploymentInputs: () => ({
              owner, preAddress, initialMinimumStakeRaw: 2000000000000000000n, startPaused: true,
            }),
            keywordMarketManifestPath: () => 'unused-test-manifest',
            readKeywordMarketManifest: async () => manifest,
            assertKeywordMarketManifestNetwork: () => {},
          },
        };
        runInNewContext(outputText, {
          exports: {},
          require: (name: string) => {
            if (!(name in modules)) throw new Error(`Unexpected module: ${name}`);
            return modules[name];
          },
          process: {
            env: { ETHERSCAN_API_KEY: 'offline-test-key' },
            stderr: { write: (message: string) => { reject(new Error(message)); } },
          },
        }, { timeout: 1000 });
      });
      const args = await result;
      expect(args.address).to.equal(address);
      expect(args.contract).to.equal('contracts/PREKeywordMarketV1.sol:PREKeywordMarketV1');
      expect(args.constructorArgs).to.deep.equal([
        owner, preAddress, minimum, ...(startPaused === undefined ? [] : [startPaused]),
      ]);
      expect(typeof args.constructorArgs![2]).to.equal('bigint');
      if (startPaused !== undefined) expect(typeof args.constructorArgs![3]).to.equal('boolean');
    }
  });
});
