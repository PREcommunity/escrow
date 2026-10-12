import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { ContractTransactionReceipt, ContractTransactionResponse } from 'ethers';
import type { PREKeywordMarketV1 } from '../typechain-types';
import { ethers, network } from './lib/hardhat-runtime';
import {
  assertConnectedChainId,
  keystorePathFor,
  loadDeployer,
  resolveDeploymentNetwork,
} from './lib/deployer';
import { readRequiredDeploymentAddress } from './lib/deployment-validation';

async function confirmed(label: string, transaction: ContractTransactionResponse) {
  process.stdout.write(`${label}: https://sepolia.basescan.org/tx/${transaction.hash}\n`);
  const receipt = await transaction.wait();
  assert(receipt && receipt.status === 1, `${label} was not confirmed successfully.`);
  return receipt;
}

async function main() {
  const deploymentNetwork = resolveDeploymentNetwork(network.name, network.config.chainId);
  assert.equal(deploymentNetwork.chainId, 84532, 'This smoke test runs only on Base Sepolia.');
  assertConnectedChainId(deploymentNetwork, (await ethers.provider.getNetwork()).chainId);

  const marketAddress = readRequiredDeploymentAddress(deploymentNetwork, 'ADS_CONTRACT_ADDRESS');
  const preAddress = readRequiredDeploymentAddress(deploymentNetwork, 'PRE_ADDRESS');
  const safeAddress = readRequiredDeploymentAddress(deploymentNetwork, 'SAFE_ADDRESS');
  const keystore: unknown = JSON.parse(await readFile(keystorePathFor(deploymentNetwork), 'utf8'));
  assert(keystore && typeof keystore === 'object' && 'address' in keystore
    && typeof keystore.address === 'string', 'Testnet keystore has no public address.');
  const candidate = ethers.getAddress(
    keystore.address.startsWith('0x') ? keystore.address : `0x${keystore.address}`,
  );
  assert.notEqual(candidate, ethers.ZeroAddress, 'Testnet keystore address must be non-zero.');

  const market = (await ethers.getContractAt('PREKeywordMarketV1', marketAddress)) as unknown as PREKeywordMarketV1;
  const pre = new ethers.Contract(preAddress, [
    'function decimals() view returns (uint8)',
    'function balanceOf(address) view returns (uint256)',
    'function allowance(address,address) view returns (uint256)',
    'function approve(address,uint256) returns (bool)',
    'event Transfer(address indexed from,address indexed to,uint256 value)',
  ], ethers.provider);
  function preTransfers(receipt: ContractTransactionReceipt) {
    return receipt.logs
      .filter((log) => ethers.getAddress(log.address) === preAddress)
      .map((log) => pre.interface.parseLog(log))
      .filter((event) => event?.name === 'Transfer');
  }
  const preflightBlock = await ethers.provider.getBlockNumber();
  const overrides = { blockTag: preflightBlock };
  const [owner, operator, token, paused, minimum, priceE18, decimals, walletBalance, allowance, gasBalance, safeCode] =
    await Promise.all([
      market.owner(overrides),
      market.operator(overrides),
      market.PRE(overrides),
      market.paused(overrides),
      market.minimumStake(overrides),
      market.preUsdPriceE18(overrides),
      pre.getFunction('decimals').staticCall(overrides) as Promise<bigint>,
      pre.getFunction('balanceOf').staticCall(candidate, overrides) as Promise<bigint>,
      pre.getFunction('allowance').staticCall(candidate, marketAddress, overrides) as Promise<bigint>,
      ethers.provider.getBalance(candidate, preflightBlock),
      ethers.provider.getCode(safeAddress, preflightBlock),
    ]);
  assert.equal(ethers.getAddress(owner), safeAddress, 'Market owner does not match SAFE_ADDRESS_TESTNET.');
  assert.notEqual(safeCode, '0x', 'SAFE_ADDRESS_TESTNET must be a deployed Safe.');
  assert.equal(ethers.getAddress(operator), candidate,
    `The Safe must first set the operator to the testnet keystore address ${candidate}.`);
  assert.equal(ethers.getAddress(token), preAddress, 'Market PRE does not match PRE_ADDRESS_TESTNET.');
  assert.equal(decimals, 18n, 'Expected PRE with 18 decimals.');
  assert.equal(paused, false, 'Market must already be active; this test does not unpause it.');
  assert(minimum > 0n, 'Minimum stake must be positive.');
  assert(priceE18 > 0n, 'Publisher must store the first PRE/USD quote before this smoke test.');
  const bidUsd = 1n;
  const clickCost = bidUsd * 10n ** 30n / priceE18;
  const deposit = minimum * 10n > clickCost ? minimum * 10n : clickCost;
  assert(walletBalance >= deposit, `Testnet wallet needs ${ethers.formatEther(deposit)} PRE; this test mints nothing.`);
  assert(gasBalance > 0n, 'Testnet wallet needs ETH for transaction fees.');

  const session = randomUUID();
  const keywordId = ethers.id(`operator-smoke:${session}`);
  const firstId = ethers.id(`${session}:partial`);
  const capId = ethers.id(`${session}:cap`);
  async function readState(blockTag: number) {
    const readOverrides = { blockTag };
    const [details, totalStaked, accruedFees, preBalance] = await Promise.all([
      market.stakeDetailsOf(keywordId, candidate, readOverrides),
      market.totalStaked(readOverrides),
      market.accruedFees(readOverrides),
      pre.getFunction('balanceOf').staticCall(marketAddress, readOverrides) as Promise<bigint>,
    ]);
    assert(totalStaked + accruedFees <= preBalance, 'PRE does not cover deposits and accrued fees.');
    return { details };
  }
  const initial = await readState(preflightBlock);
  assert.equal(initial.details.amount, 0n, 'Test position must be fresh.');
  assert.equal(initial.details.positionVersion, 0n, 'Test position must never have been opened.');
  assert.equal(await market.chargeProcessed(firstId, overrides), false, 'Charge ID already exists.');
  assert.equal(await market.chargeProcessed(capId, overrides), false, 'Cap charge ID already exists.');

  const ownerView = market.connect(new ethers.VoidSigner(safeAddress, ethers.provider));
  await assert.rejects(
    ownerView.chargeStake.staticCall(keywordId, candidate, 1n, minimum, firstId),
    (error: unknown) => {
      assert(ethers.isError(error, 'CALL_EXCEPTION') && error.data, 'Expected an authorization revert.');
      const parsed = market.interface.parseError(error.data);
      assert(parsed, 'Expected a decoded authorization error.');
      assert.equal(parsed?.name, 'UnauthorizedOperator', 'Safe owner unexpectedly has charging permission.');
      assert.equal(ethers.getAddress(String(parsed.args[0])), safeAddress);
      return true;
    },
  );
  process.stdout.write(`Base Sepolia operator test: ${candidate}\nMarket: ${marketAddress}\n`
    + `Session: ${session}\nKeyword: ${keywordId}\nStake: ${ethers.formatEther(deposit)} PRE\n`
    + 'Safe owner charging permission: correctly rejected.\n');

  const wallet = await loadDeployer(deploymentNetwork);
  assert.equal(ethers.getAddress(wallet.address), candidate, 'Decrypted wallet differs from keystore public address.');
  const operatorMarket = market.connect(wallet);
  async function assertOperator() {
    assert.equal(ethers.getAddress(await market.operator()), candidate,
      'Test wallet is no longer the market operator; no further transaction was sent.');
  }
  if (allowance < deposit) {
    await assertOperator();
    const approval = await confirmed('Approve exact test stake',
      await pre.connect(wallet).getFunction('approve')(marketAddress, deposit));
    assert.equal(
      await pre.getFunction('allowance').staticCall(candidate, marketAddress, { blockTag: approval.blockNumber }),
      deposit,
      'PRE approval did not match the exact test amount.',
    );
  }
  await assertOperator();
  const stakeReceipt = await confirmed('Open test position',
    await operatorMarket.stake(keywordId, deposit, bidUsd));
  let verifiedBlock = stakeReceipt.blockNumber;
  let before = await readState(stakeReceipt.blockNumber);
  assert.equal(before.details.amount, deposit);
  assert.equal(before.details.positionVersion, 1n);
  assert.equal(before.details.eligible, true);
  // Other users can change balances between blocks; inspect only this transaction's transfers.
  const transfers = preTransfers(stakeReceipt);
  assert.equal(transfers.length, 1, 'Staking must transfer PRE exactly once.');
  const transfer = transfers[0];
  assert(transfer);
  assert.equal(ethers.getAddress(transfer.args.from), candidate);
  assert.equal(ethers.getAddress(transfer.args.to), marketAddress);
  assert.equal(transfer.args.value, deposit);

  for (const step of [
    { label: 'Charge 2 × minimum', id: firstId, requested: minimum * 2n, charged: minimum * 2n },
    { label: 'Replay charge ID (no-op)', id: firstId, requested: minimum * 2n, charged: 0n },
    { label: 'Overcharge capped to remaining balance', id: capId, requested: deposit * 2n, charged: deposit - minimum * 2n },
  ]) {
    await assertOperator();
    const receipt = await confirmed(step.label, await operatorMarket.chargeStake(
      keywordId, candidate, 1n, step.requested, step.id,
    ));
    const after = await readState(receipt.blockNumber);
    assert.equal(after.details.amount, before.details.amount - step.charged);
    assert.equal(preTransfers(receipt).length, 0, 'Charging must not transfer PRE.');
    assert.equal(await market.chargeProcessed(step.id, { blockTag: receipt.blockNumber }), true);
    const events = receipt.logs
      .filter((log) => ethers.getAddress(log.address) === marketAddress)
      .map((log) => market.interface.parseLog(log));
    const charges = events.filter((event) => event?.name === 'StakeCharged');
    const changes = events.filter((event) => event?.name === 'PositionChanged');
    if (step.charged === 0n) {
      assert.equal(charges.length, 0, 'Duplicate charge must emit no StakeCharged event.');
      assert.equal(changes.length, 0, 'Duplicate charge must emit no PositionChanged event.');
      assert.deepEqual([...after.details], [...before.details], 'Duplicate charge changed the position.');
    } else {
      assert.equal(charges.length, 1);
      assert.equal(changes.length, 1);
      const charge = charges[0]!;
      assert(charge);
      assert.equal(charge.args.keywordId, keywordId);
      assert.equal(ethers.getAddress(charge.args.staker), candidate);
      assert.equal(charge.args.chargeId, step.id);
      assert.equal(charge.args.requestedPre, step.requested);
      assert.equal(charge.args.chargedPre, step.charged);
      assert.equal(charge.args.remainingPre, after.details.amount);
    }
    process.stdout.write(`Verified at block ${receipt.blockNumber}: charged ${ethers.formatEther(step.charged)} PRE; `
      + `remaining ${ethers.formatEther(after.details.amount)} PRE.\n`);
    before = after;
    verifiedBlock = receipt.blockNumber;
  }
  assert.equal(before.details.amount, 0n);
  assert.equal(before.details.bidUsd, 0n);
  assert.equal(before.details.requiredCoveragePre, 0n);
  assert.equal(before.details.eligible, false);
  assert.equal(before.details.withdrawAvailableAt, 0n);
  assert.equal(before.details.positionVersion, 1n);
  assert.equal((await market.topStakeOf(keywordId, { blockTag: verifiedBlock })).staker, ethers.ZeroAddress);
  process.stdout.write('PASS: operator authorization, real charging, duplicate no-op, balance cap and solvency.\n'
    + `${ethers.formatEther(deposit)} test PRE was charged from the test position.\n`
    + 'Revoke the test operator using the prepared Safe setOperator(0x0000000000000000000000000000000000000000) payload.\n');
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`
    + 'If an operator was enabled, revoke it with the prepared Safe payload; review any transaction hashes above.\n');
  process.exitCode = 1;
});
