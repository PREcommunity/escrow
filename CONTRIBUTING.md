# Contributing

Issues and pull requests are welcome. Security vulnerabilities must be reported privately as described in [SECURITY.md](SECURITY.md).

## Development setup

Use Node.js 22 and the pnpm version declared in `package.json`.

```bash
pnpm install --frozen-lockfile
pnpm build
pnpm typecheck
pnpm lint:sol
pnpm test
pnpm coverage
pnpm audit --audit-level high
```

All checks must pass without private infrastructure, deployment credentials, or committed `.env` files. Critical and high dependency advisories block merging and release.

## Pull requests

- Keep changes focused and explain their security and compatibility impact.
- Add or update tests for changed behavior.
- Do not change the `PREcommunityEscrowV1` ABI, storage layout, optimized runtime bytecode, or deployment workflow without calling it out explicitly and supplying a reviewed migration rationale.
- Never commit private keys, keystores, API keys, deployment manifests, generated artifacts, coverage reports, or machine-specific files.
- Preserve SPDX headers and the MIT licensing terms.

By contributing, you agree that your contribution is licensed under the repository's MIT License.
