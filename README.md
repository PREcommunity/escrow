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

`PREKeywordMarketV1` is a separate deployment on Base Sepolia (84532) or Base (8453). The constructor gives ownership directly to the configured Safe. Its fourth argument chooses the initial pause state; deployment defaults to active on both networks, and staking does not require a billing operator. The default operator is zero. PRE funds an offer's deposit and the USD bid determines rank. Withdrawal requests leave the ranking immediately and the remaining PRE is withdrawable after 24 hours.

For Base Sepolia configure `PRE_ADDRESS_TESTNET`, `SAFE_ADDRESS_TESTNET`, `KEYWORD_MARKET_MINIMUM_PRE_TESTNET`, the testnet RPC and deployer keystore. `KEYWORD_MARKET_START_PAUSED[_TESTNET]` accepts only `0` (default, active) or `1` (paused until the Safe calls `unpause`). For Base configure the same keys without `_TESTNET`, the mainnet RPC and keystore, and explicitly set `KEYWORD_MARKET_ALLOW_MAINNET=1` in the repository `.env`. Base deployment accepts only the canonical PRE token; both networks require PRE with 18 decimals and a deployed Safe with a valid owner list and threshold. The opt-in gate applies to deployment; checks and source verification remain read-only.

```bash
pnpm deploy:keyword-market --network testnet
pnpm check:keyword-market --network testnet
pnpm verify:keyword-market --network testnet
# Reviewed Base deployment uses --network mainnet with KEYWORD_MARKET_ALLOW_MAINNET=1.
```

The output supplies `ADS_CONTRACT_ADDRESS[_TESTNET]` and `ADS_CONTRACT_DEPLOYMENT_BLOCK[_TESTNET]`. Manifests are `.deployments/base-sepolia.keyword-market-v1.json` and `.deployments/base.keyword-market-v1.json`. An existing pending transaction is resumed without broadcasting another deployment; changed network, constructor inputs, deployer, init code or confirmation policy are rejected. If RPC submission may have succeeded before its manifest was saved, the deployment lock remains: reconcile the sender nonce and transaction on the selected chain before removing it.

`KEYWORD_MARKET_CHECK_STAGE` defaults to the confirmed manifest constructor state: `active` for an active deployment, or `rollout` for a paused one. An explicit override checks the requested current state. Active deployments require no initial Safe transaction. For a deliberately paused deployment, the Safe calls `unpause` after readiness and checks then use `active`. Both modes expect a zero operator unless `ADS_OPERATOR_ADDRESS[_TESTNET]` explicitly selects another address. The check validates chain identity, Safe ownership, PRE, constructor ownership logs, positive minimum, runtime bytecode, and deposits plus accrued charges against the token balance. Operator charging is an optional future capability; click collection and charge submission are outside this repository.

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
