import { expect } from 'chai';
import { getAddress } from 'ethers';
import { resolveDeploymentNetwork, validateControllerCode } from '../scripts/lib/deployer';
import {
  assertInitialOwnerIsDeployer,
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

  it('requires the initial owner to be the selected deployer', () => {
    const deployer = '0x0000000000000000000000000000000000000001';
    const differentOwner = '0x0000000000000000000000000000000000000002';

    expect(() => assertInitialOwnerIsDeployer(deployer, deployer)).not.to.throw();
    expect(() => assertInitialOwnerIsDeployer(deployer, differentOwner))
      .to.throw(`OWNER_ADDRESS ${differentOwner} must equal the selected deployer keystore address ${deployer}.`);
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
