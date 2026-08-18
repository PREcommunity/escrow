# PREcommunity Escrow

`PREcommunityEscrowV1` is a Base escrow for community goals funded in PRE and USDC.

- contributions are non-refundable;
- a manager creates a goal and may close or cancel it;
- closed-goal funds are released to the beneficiary;
- cancelled-goal funds are released to the treasury;
- the owner manages managers, can pause operations, and can recover only excess tokens;
- PRE, USDC, and treasury addresses are immutable after deployment.

The contract rejects fee-on-transfer tokens and transfers whose balance changes do not exactly match the requested amount.

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
