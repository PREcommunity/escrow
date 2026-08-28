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

A monthly goal starts immediately. By default, its first settlement is at 00:00 UTC on the same calendar day of the next month. A manager may instead select a first settlement at 00:00 UTC from 7 through 60 days after creation. The selected day becomes the permanent settlement day.

Short months clamp the deadline to their final day without changing that permanent day. For example, a day-31 schedule runs `31 January -> 28/29 February -> 31 March`. Selecting 28 February explicitly creates a day-28 schedule. The full monthly target applies to the first period even when an override makes that period shorter than a calendar month.

Settlement is permissionless and accounting-only: `settleMonthlyGoal` vests funds for the beneficiary without sending tokens or accepting a payout address. The beneficiary or owner later calls `releaseExpense`. Up to 24 elapsed months can be settled per transaction; contributions remain blocked until every elapsed period has been caught up.

An active creator or the owner can change the surplus policy before the current deadline. A graceful stop finishes the current period and vests all remaining carry for the beneficiary. Before the current deadline, the owner may instead cancel a monthly goal in an emergency. Once a deadline has passed, the elapsed period must be settled first; only the new current-period funds and remaining carry then become treasury-entitled, while previously vested beneficiary funds remain claimable.

Smart contracts do not wake themselves at month boundaries. A caller must submit the settlement transaction; no keeper or bot is part of this repository.

Deployment manifests for this release use the `escrow` suffix: `.deployments/base-sepolia.escrow.json` and `.deployments/base.escrow.json`. Older deployment addresses and manifests are not used by this release.

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
