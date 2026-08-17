## Summary

Describe the change and why it is needed.

## Security and compatibility

- [ ] I described any ABI, storage, optimized runtime bytecode, dependency, or deployment-workflow impact.
- [ ] I did not commit secrets, keystores, deployment manifests, generated artifacts, coverage reports, or local metadata.
- [ ] This is not a vulnerability report; security issues were submitted privately under `SECURITY.md`.

## Verification

- [ ] `pnpm install --frozen-lockfile`
- [ ] `pnpm build`
- [ ] `pnpm typecheck`
- [ ] `pnpm lint:sol`
- [ ] `pnpm test`
- [ ] `pnpm coverage`
- [ ] `pnpm audit --audit-level high`
