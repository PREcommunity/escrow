# PREcommunity Escrow

`PREcommunityEscrowV1` is a Base escrow for one-time and recurring monthly community goals funded in PRE and USDC.

- contributions are non-refundable;
- a manager creates a goal and may close or cancel it;
- closed one-time-goal funds are released to the beneficiary;
- cancelled-goal funds are released to the treasury with `releaseCancelledFunds`;
- monthly goals use a fixed PRE and/or USDC target and a per-goal surplus policy;
- `PayoutAll` vests every monthly contribution for the beneficiary;
- `RollOver` vests up to the monthly target and carries the remainder into later months;
- the owner manages managers, can pause operations, and can recover only excess tokens;
- PRE, USDC, and treasury addresses are immutable after deployment.

The contract rejects fee-on-transfer tokens and transfers whose balance changes do not exactly match the requested amount.

## Monthly goals

A monthly goal starts immediately and has fixed PRE and/or USDC targets. Its first settlement defaults to 00:00 UTC on the same calendar day of the next month, or a manager can select a UTC-midnight date 7–60 days after creation. That day remains fixed; shorter months use their final day.

At settlement, `PayoutAll` vests all contributions, while `RollOver` vests up to the target and carries the surplus forward. Anyone may settle up to 24 elapsed periods; settlement only updates accounting, and the beneficiary or owner later calls `releaseExpense`.

The active creator or owner may change the surplus policy or request a graceful stop before the deadline. Only the owner may cancel a monthly goal in an emergency. Settlement requires an external transaction; this repository includes no keeper or bot.

## Deployments

Deployment manifests for this release use the `escrow` suffix: `.deployments/base-sepolia.escrow.json` and `.deployments/base.escrow.json`. Older deployment addresses and manifests are not used by this release.

`PREKeywordMarketV1` is a separate deployment on Base Sepolia (84532) or Base (8453). The constructor gives ownership directly to the configured Safe. Its fourth argument chooses the initial pause state; deployment defaults to active on both networks, and staking does not require a billing operator. The default operator is zero. PRE funds an offer's deposit and the USD bid determines rank. Equal bids favor the earlier position opening, tracked by a per-keyword sequence that also orders stakes executed in the same block. Top-ups, bid updates and partial charges preserve that sequence; reopening a zero-balance position assigns a new one. Existing non-upgradeable deployments retain their original tie policy and admission checks; this rule requires a new deployment that preserves access to withdrawals from the old contract. Withdrawal requests leave the ranking immediately and the remaining PRE is withdrawable after 24 hours.

Every new stake, top-up, and bid-only change requires a stored PRE/USD quote and enough total PRE to cover one click: `floor(bidUsd × 10^30 / preUsdPriceE18)`, where bid USD uses six decimals and the USD price of one PRE uses eighteen. The opening minimum and stored `requiredCoveragePre` retain their original meanings. Updating the price does not rebuild the ranking, and a positive old quote remains usable. The Safe selects a separate publisher using `setPriceUpdater(address)`; address zero revokes that role. Only that publisher calls `updatePreUsdPrice(uint256,uint64)`. Quotes reject zero values, timestamps more than 60 seconds ahead, older timestamps, and a different price for the same timestamp. Replaying the same tuple has no effect. `PriceUpdaterUpdated` and `PreUsdPriceUpdated` supply the application index with publisher and quote changes. Charges and withdrawals do not require an available publisher or a recent quote.

For Base Sepolia configure `PRE_ADDRESS_TESTNET`, `SAFE_ADDRESS_TESTNET`, `KEYWORD_MARKET_MINIMUM_PRE_TESTNET`, the testnet RPC and deployer keystore. `KEYWORD_MARKET_START_PAUSED[_TESTNET]` accepts only `0` (default, active) or `1` (paused until the Safe calls `unpause`). For Base configure the same keys without `_TESTNET`, the mainnet RPC and keystore, and explicitly set `KEYWORD_MARKET_ALLOW_MAINNET=1` in the repository `.env`. Base deployment accepts only the canonical PRE token; both networks require PRE with 18 decimals and a deployed Safe with a valid owner list and threshold. The opt-in gate applies to deployment; checks and source verification remain read-only.

```bash
pnpm deploy:keyword-market --network testnet
KEYWORD_MARKET_CHECK_STAGE=bootstrap pnpm check:keyword-market --network testnet
# Safe: setPriceUpdater(updater); updater: updatePreUsdPrice(priceE18, providerTimestamp).
KEYWORD_MARKET_CHECK_STAGE=active pnpm check:keyword-market --network testnet
pnpm verify:keyword-market --network testnet
# Reviewed Base deployment uses --network mainnet with KEYWORD_MARKET_ALLOW_MAINNET=1.
```

The output supplies `ADS_CONTRACT_ADDRESS[_TESTNET]` and `ADS_CONTRACT_DEPLOYMENT_BLOCK[_TESTNET]`. Manifests are `.deployments/base-sepolia.keyword-market-v1.json` and `.deployments/base.keyword-market-v1.json`. An existing pending transaction is resumed without broadcasting another deployment; changed network, constructor inputs, deployer, init code or confirmation policy are rejected. If RPC submission may have succeeded before its manifest was saved, the deployment lock remains: reconcile the sender nonce and transaction on the selected chain before removing it.

`KEYWORD_MARKET_CHECK_STAGE` defaults to the confirmed manifest constructor state: `active` for an unpaused deployment, or `rollout` for a paused one. Use explicit `bootstrap` immediately after deployment: it checks structure and accounting while permitting either pause state and an uninitialized quote. The Safe then selects the publisher, the publisher stores the first quote, and for a paused deployment the Safe calls `unpause`. The `active` check requires a non-zero publisher and a positive stored price/timestamp; it intentionally imposes no quote freshness limit. `rollout` requires paused staking and permits a first quote to be pending. Every stage expects a zero operator unless `ADS_OPERATOR_ADDRESS[_TESTNET]` selects another address; optional `ADS_PRICE_UPDATER_ADDRESS[_TESTNET]` verifies the publisher against the reviewed keystore public address. The check validates chain identity, Safe ownership, PRE, constructor ownership logs, positive minimum, runtime bytecode, price state, and deposits plus accrued charges against the token balance. Publish the ABI from the new build to the application before preparing transactions. Keep the old address and history available for manual withdrawal; pausing the old contract blocks staking but does not block withdrawal requests, claims, or charging. This revision requires a new address and does not migrate funds. Operator charging, quote collection, and quote publication jobs are owned by the application repository.

## Development

Requires Node.js 22 and pnpm.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm test
pnpm typecheck
pnpm lint:sol
pnpm coverage
pnpm audit --audit-level high
```

## Security

This contract has not undergone an independent audit. Do not deploy it with valuable assets without independently reviewing the code, deployment configuration, and trust model. Report vulnerabilities through [SECURITY.md](SECURITY.md).

## License

MIT

To deploy a separate rehearsal without overwriting an earlier manifest, set `KEYWORD_MARKET_DEPLOYMENT_NAME_TESTNET=active-rehearsal-20261007`. The new manifest and lock are `.deployments/base-sepolia.keyword-market-v1.active-rehearsal-20261007.json` and its `.lock`; repeat the same command to resume that deployment. Mainnet uses the separate `KEYWORD_MARKET_DEPLOYMENT_NAME` key. Names contain 1–64 lowercase letters, digits or hyphens and start with a letter or digit. The original manifest and unresolved locks are retained. Scripts never install dependencies implicitly; CI installs explicitly with the frozen lockfile.
