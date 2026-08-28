import { expect } from 'chai';
import { getAddress } from 'ethers';
import path from 'node:path';
import {
  keystorePathFor,
  resolveDeploymentNetwork,
  validateControllerCode,
} from '../scripts/lib/deployer';
import {
  DEPLOYMENT_RELEASE,
  deploymentManifestPathFor,
} from '../scripts/lib/deployment-manifest';
import {
  assertInitialOwnerIsDeployer,
  readDeploymentAddresses,
  readSafeAddress,
  validateCanonicalTokenAddresses,
} from '../scripts/lib/deployment-validation';
import { validateNewKeystorePassword, walletFromPrivateKey } from '../scripts/lib/keystore';
import { normalizeImmutableReferences } from '../scripts/lib/runtime-bytecode';
import { buildSafeTransactionPayload } from '../scripts/lib/safe-transaction';

describe('deployment network selection', () => {
  it('maps Base Sepolia and Base mainnet to separate keystore files', () => {
    expect(resolveDeploymentNetwork('testnet', 84532)).to.deep.equal({
      chainId: 84532,
      manifestName: 'base-sepolia',
      keystoreFile: '.keystore-testnet',
    });
    expect(resolveDeploymentNetwork('mainnet', 8453)).to.deep.equal({
      chainId: 8453,
      manifestName: 'base',
      keystoreFile: '.keystore-mainnet',
    });
  });

  it('resolves keystore and manifest paths from the project root under ESM', () => {
    const mainnet = resolveDeploymentNetwork('mainnet', 8453);

    expect(keystorePathFor(mainnet)).to.equal(path.resolve('.keystore-mainnet'));
    expect(DEPLOYMENT_RELEASE).to.equal('escrow');
    expect(deploymentManifestPathFor(mainnet)).to.equal(path.resolve('.deployments/base.escrow.json'));
  });

  it('requires an explicit supported --network value and matching chain ID', () => {
    expect(() => resolveDeploymentNetwork('hardhat', 31337))
      .to.throw('Select a deployment network with --network testnet or --network mainnet.');
    expect(() => resolveDeploymentNetwork('testnet', 8453))
      .to.throw('Configured chain ID 8453 does not match testnet (84532).');
  });

  it('allows an EOA initial owner but requires a contract treasury on mainnet', () => {
    const testnet = resolveDeploymentNetwork('testnet', 84532);
    const mainnet = resolveDeploymentNetwork('mainnet', 8453);

    expect(() => validateControllerCode(testnet, 'OWNER_ADDRESS', '0x')).not.to.throw();
    expect(() => validateControllerCode(mainnet, 'OWNER_ADDRESS', '0x')).not.to.throw();
    expect(() => validateControllerCode(mainnet, 'TREASURY_ADDRESS', '0x1234')).not.to.throw();
    expect(() => validateControllerCode(mainnet, 'TREASURY_ADDRESS', '0x'))
      .to.throw('TREASURY_ADDRESS must be a deployed contract on Base mainnet, preferably a verified Safe multisig.');
  });

  it('accepts only the canonical PRE and USDC addresses on Base mainnet', () => {
    const mainnet = resolveDeploymentNetwork('mainnet', 8453);
    const canonical = {
      PRE_ADDRESS: getAddress('0x3816dd4bd44c8830c2fa020a5605bac72fa3de7a'),
      USDC_ADDRESS: getAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
    };

    expect(() => validateCanonicalTokenAddresses(mainnet, canonical)).not.to.throw();
  });

  it('rejects a non-canonical PRE address on Base mainnet', () => {
    const mainnet = resolveDeploymentNetwork('mainnet', 8453);
    const canonicalPre = getAddress('0x3816dd4bd44c8830c2fa020a5605bac72fa3de7a');

    expect(() => validateCanonicalTokenAddresses(mainnet, {
      PRE_ADDRESS: '0x0000000000000000000000000000000000000001',
      USDC_ADDRESS: getAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913'),
    })).to.throw(`PRE_ADDRESS must be the canonical Base mainnet token ${canonicalPre}.`);
  });

  it('rejects a non-canonical USDC address on Base mainnet', () => {
    const mainnet = resolveDeploymentNetwork('mainnet', 8453);
    const canonicalUsdc = getAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913');

    expect(() => validateCanonicalTokenAddresses(mainnet, {
      PRE_ADDRESS: getAddress('0x3816dd4bd44c8830c2fa020a5605bac72fa3de7a'),
      USDC_ADDRESS: '0x0000000000000000000000000000000000000002',
    })).to.throw(`USDC_ADDRESS must be the canonical Base mainnet token ${canonicalUsdc}.`);
  });

  it('allows dynamic token addresses on Base Sepolia', () => {
    const testnet = resolveDeploymentNetwork('testnet', 84532);

    expect(() => validateCanonicalTokenAddresses(testnet, {
      PRE_ADDRESS: '0x0000000000000000000000000000000000000001',
      USDC_ADDRESS: '0x0000000000000000000000000000000000000002',
    })).not.to.throw();
  });

  it('selects separate token environment variables for Base Sepolia and Base mainnet', () => {
    const environment = {
      PRE_ADDRESS: '0x3816dd4bd44c8830c2fa020a5605bac72fa3de7a',
      USDC_ADDRESS: '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913',
      PRE_ADDRESS_TESTNET: '0x5471386EA2022e724A234A7690E338aA0A6689aD',
      USDC_ADDRESS_TESTNET: '0xA6f4b70F3502d097424b4a4C1699ad6AEA13b360',
      OWNER_ADDRESS: '0x0000000000000000000000000000000000000001',
      OWNER_ADDRESS_TESTNET: '0x0000000000000000000000000000000000000003',
      TREASURY_ADDRESS: '0x0000000000000000000000000000000000000002',
      TREASURY_ADDRESS_TESTNET: '0x0000000000000000000000000000000000000004',
      SAFE_ADDRESS: '0x0000000000000000000000000000000000000005',
      SAFE_ADDRESS_TESTNET: '0x0000000000000000000000000000000000000006',
    };

    const testnet = readDeploymentAddresses(resolveDeploymentNetwork('testnet', 84532), environment);
    const mainnet = readDeploymentAddresses(resolveDeploymentNetwork('mainnet', 8453), environment);

    expect(testnet.PRE_ADDRESS).to.equal(getAddress(environment.PRE_ADDRESS_TESTNET));
    expect(testnet.USDC_ADDRESS).to.equal(getAddress(environment.USDC_ADDRESS_TESTNET));
    expect(testnet.OWNER_ADDRESS).to.equal(getAddress(environment.OWNER_ADDRESS_TESTNET));
    expect(testnet.TREASURY_ADDRESS).to.equal(getAddress(environment.TREASURY_ADDRESS_TESTNET));
    expect(readSafeAddress(resolveDeploymentNetwork('testnet', 84532), environment))
      .to.equal(getAddress(environment.SAFE_ADDRESS_TESTNET));
    expect(mainnet.PRE_ADDRESS).to.equal(getAddress(environment.PRE_ADDRESS));
    expect(mainnet.USDC_ADDRESS).to.equal(getAddress(environment.USDC_ADDRESS));
    expect(mainnet.OWNER_ADDRESS).to.equal(getAddress(environment.OWNER_ADDRESS));
    expect(mainnet.TREASURY_ADDRESS).to.equal(getAddress(environment.TREASURY_ADDRESS));
    expect(readSafeAddress(resolveDeploymentNetwork('mainnet', 8453), environment))
      .to.equal(getAddress(environment.SAFE_ADDRESS));
  });

  it('fails with the selected testnet variable name when a test token address is missing', () => {
    expect(() => readDeploymentAddresses(resolveDeploymentNetwork('testnet', 84532), {
      USDC_ADDRESS_TESTNET: '0xA6f4b70F3502d097424b4a4C1699ad6AEA13b360',
      OWNER_ADDRESS_TESTNET: '0x0000000000000000000000000000000000000001',
      TREASURY_ADDRESS_TESTNET: '0x0000000000000000000000000000000000000002',
    })).to.throw('PRE_ADDRESS_TESTNET must be a non-zero public address.');
  });

  it('requires the initial owner to be the selected deployer', () => {
    const deployer = '0x0000000000000000000000000000000000000001';
    const differentOwner = '0x0000000000000000000000000000000000000002';

    expect(() => assertInitialOwnerIsDeployer(deployer, deployer)).not.to.throw();
    expect(() => assertInitialOwnerIsDeployer(deployer, differentOwner))
      .to.throw(`OWNER_ADDRESS ${differentOwner} must equal the selected deployer keystore address ${deployer}.`);
    expect(() => assertInitialOwnerIsDeployer(deployer, differentOwner, 'OWNER_ADDRESS_TESTNET'))
      .to.throw(`OWNER_ADDRESS_TESTNET ${differentOwner} must equal the selected deployer keystore address ${deployer}.`);
  });

  it('builds a zero-value Safe transaction payload for an ownership or admin call', () => {
    const safeAddress = '0x0000000000000000000000000000000000000001';
    const targetAddress = '0x0000000000000000000000000000000000000002';

    expect(buildSafeTransactionPayload(safeAddress, 8453, targetAddress, '0x1234')).to.deep.equal({
      schema: 'precommunity.safe-transaction.v1',
      safeAddress,
      chainId: '8453',
      to: targetAddress,
      value: '0',
      data: '0x1234',
      operation: 0,
    });
  });

  it('normalizes only compiler-marked immutable bytes before runtime comparison', () => {
    expect(normalizeImmutableReferences('0x112233445566', {
      first: [{ start: 1, length: 2 }],
      second: [{ start: 5, length: 1 }],
    })).to.equal('0x110000445500');
  });

  it('rejects an immutable reference outside runtime bytecode', () => {
    expect(() => normalizeImmutableReferences('0x112233445566', {
      invalid: [{ start: 5, length: 2 }],
    })).to.throw('Compiler immutable reference is outside runtime bytecode.');
  });

  it('accepts prefixed and unprefixed private keys without exposing them in errors', () => {
    const privateKey = '1'.padStart(64, '0');
    const prefixedWallet = walletFromPrivateKey(`0x${privateKey}`);
    const unprefixedWallet = walletFromPrivateKey(privateKey);

    expect(unprefixedWallet.address).to.equal(prefixedWallet.address);
    expect(() => walletFromPrivateKey('not-a-private-key'))
      .to.throw('The private key must contain exactly 32 bytes of hexadecimal data.');
    expect(() => walletFromPrivateKey('0'.repeat(64)))
      .to.throw('The private key is not a valid secp256k1 private key.');
  });

  it('requires a new keystore password of at least twelve characters', () => {
    const error = 'The keystore password must contain at least 12 characters.';

    expect(() => validateNewKeystorePassword('')).to.throw(error);
    expect(() => validateNewKeystorePassword('x'.repeat(11))).to.throw(error);
    expect(() => validateNewKeystorePassword('x'.repeat(12))).not.to.throw();
  });
});
