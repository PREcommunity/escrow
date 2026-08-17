import { readFile } from 'node:fs/promises';

const productionContract = 'contracts/PREcommunityEscrowV1.sol';
const report = await readFile(new URL('../coverage/lcov.info', import.meta.url), 'utf8');
const record = report
  .split('end_of_record')
  .find((entry) => entry.split('\n').some((line) => line === `SF:${productionContract}`));

if (!record) throw new Error(`Coverage record for ${productionContract} is missing.`);

const metric = (name) => {
  const line = record.split('\n').find((entry) => entry.startsWith(`${name}:`));
  if (!line) throw new Error(`Coverage metric ${name} for ${productionContract} is missing.`);
  return Number.parseInt(line.slice(name.length + 1), 10);
};

const totalLines = metric('LF');
const coveredLines = metric('LH');
if (coveredLines !== totalLines) {
  throw new Error(`${productionContract} line coverage is ${coveredLines}/${totalLines}; 100% is required.`);
}

process.stdout.write(`${productionContract}: 100% native Hardhat line coverage (${coveredLines}/${totalLines}).\n`);
