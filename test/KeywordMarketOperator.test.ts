import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { expect } from 'chai';
import { ModuleKind, ScriptTarget, transpileModule } from 'typescript';
import { ethers } from '../scripts/lib/hardhat-runtime';
import type { MockERC20, PREKeywordMarketV1 } from '../typechain-types';

describe('Keyword Market operator smoke test', () => {
  async function runSmoke(incorrectCharge = false) {
    const [owner, operator, other] = await ethers.getSigners();
    assert(owner && operator && other);
    const minimum = ethers.parseEther('1');
    const payment = await ethers.deployContract('MockERC20', ['Presearch', 'PRE', 18]) as unknown as MockERC20;
    const market = await ethers.deployContract('PREKeywordMarketV1', [
      owner.address, await payment.getAddress(), minimum, false,
    ]) as unknown as PREKeywordMarketV1;
    const marketAddress = await market.getAddress();
    await market.setOperator(operator.address);
    await market.setPriceUpdater(owner.address);
    await market.updatePreUsdPrice(ethers.parseEther('1'), (await ethers.provider.getBlock('latest'))!.timestamp);
    for (const signer of [operator, other]) await payment.mint(signer.address, minimum * 100n);
    await payment.connect(other).approve(marketAddress, ethers.MaxUint256);
    const otherKeyword = ethers.id('unrelated operator smoke activity');
    let otherCharges = 0;

    const scriptMarket = new Proxy(market, {
      get(target, property) {
        if (property !== 'connect') return Reflect.get(target, property, target);
        return (runner: Parameters<typeof market.connect>[0]) => {
          const connected = target.connect(runner);
          if (runner !== operator) return connected;
          return new Proxy(connected, {
            get(contract, method) {
              if (method !== 'chargeStake') return Reflect.get(contract, method, contract);
              return async (keyword: string, staker: string, version: bigint, requested: bigint, chargeId: string) => {
                await market.connect(other).stake(otherKeyword, minimum * 3n, 1n);
                await market.connect(operator).chargeStake(
                  otherKeyword, other.address, 1n, minimum * 2n, ethers.id(`other charge ${++otherCharges}`),
                );
                await market.withdrawAccrued(operator.address, minimum);
                return contract.chargeStake(keyword, staker, version, incorrectCharge ? minimum : requested, chargeId);
              };
            },
          });
        };
      },
    });
    const provider = new Proxy(ethers.provider, {
      get(target, property) {
        if (property === 'getNetwork') return async () => ({ chainId: 84532n });
        // Safe existence is a deployment guard; all accounting and receipts use local contracts.
        if (property === 'getCode') return async () => '0x01';
        if (property === 'call') return async (...args: Parameters<typeof target.call>) => {
          try { return await target.call(...args); }
          catch (error) {
            const data = (error as { data?: { data?: string } }).data?.data;
            if (!data) throw error;
            // EDR wraps revert data differently from the live ethers JSON-RPC provider.
            throw Object.assign(new Error('Local contract call reverted.'), { code: 'CALL_EXCEPTION', data });
          }
        };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const source = await readFile(new URL('../scripts/test-keyword-market-operator.ts', import.meta.url), 'utf8');
    const { outputText } = transpileModule(source, {
      compilerOptions: { module: ModuleKind.CommonJS, target: ScriptTarget.ES2022, esModuleInterop: true },
    });
    await new Promise<void>((resolve, reject) => {
      const modules: Record<string, unknown> = {
        'node:assert/strict': assert,
        'node:crypto': { randomUUID },
        'node:fs/promises': { readFile: async () => JSON.stringify({ address: operator.address }) },
        './lib/hardhat-runtime': {
          ethers: { ...ethers, provider, getContractAt: async () => scriptMarket },
          network: { name: 'testnet', config: { chainId: 84532 } },
        },
        './lib/deployer': {
          resolveDeploymentNetwork: () => ({ chainId: 84532 }),
          assertConnectedChainId: () => {},
          keystorePathFor: () => 'offline-keystore',
          loadDeployer: async () => {
            await market.connect(other).stake(otherKeyword, minimum * 4n, 1n);
            return operator;
          },
        },
        './lib/deployment-validation': {
          readRequiredDeploymentAddress: (_network: unknown, key: string) => ({
            ADS_CONTRACT_ADDRESS: marketAddress,
            PRE_ADDRESS: payment.target,
            SAFE_ADDRESS: owner.address,
          })[key],
        },
      };
      runInNewContext(outputText, {
        exports: {},
        Error,
        require: (name: string) => {
          if (!(name in modules)) throw new Error(`Unexpected module: ${name}`);
          return modules[name];
        },
        process: {
          stdout: { write: (message: string) => { if (message.startsWith('PASS:')) resolve(); } },
          stderr: { write: (message: string) => reject(new Error(message)) },
        },
      }, { timeout: 1000 });
    });
    expect(await market.totalStaked()).to.equal(minimum * 7n);
    expect(await market.accruedFees()).to.equal(minimum * 13n);
    expect(await payment.balanceOf(marketAddress)).to.equal(minimum * 20n);
    return otherCharges;
  }

  it('accepts unrelated deposits, charges and fee withdrawals between its transactions', async () => {
    expect(await runSmoke()).to.equal(3);
  });

  it('still rejects an incorrect charge of its own position', async () => {
    await assert.rejects(runSmoke(true), /9000000000000000000n/);
  });
});
