# precommunity escrow

`PREcommunityEscrowV1` is the Base escrow behind the independent precommunity public ledger. It accepts non-refundable PRE and USDC contributions, records complete goal definitions on-chain, stores each wallet's current community profile and per-contribution profile visibility, and assigns all contributions either to the goal beneficiary after closure or to treasury after cancellation.

> [!WARNING]
> This contract has not undergone an independent security audit. Publishing the source code does not make it production- or mainnet-ready and is not a statement that user funds are safe. Review the contract, deployment configuration, bytecode, governance, and operational controls independently before any deployment or use with assets of value.

Profiles are public on-chain data. Any wallet can set or clear only its own profile without holding PRE or receiving an owner role. Profile revisions and historical events remain permanently correlated with that wallet. Profile updates stay available while escrow operations are paused and never modify escrow accounting. Profile fields are stored as opaque, byte-bounded strings: the contract does not validate UTF-8, URL schemes, hostnames, or URI formats. Frontends are responsible for input validation and must encode and render every on-chain profile field as untrusted data.

The contract fixes its PRE and USDC addresses permanently at deployment. It stores each goal's immutable creator, title, short description, deadline, beneficiary, payout address, PRE and USDC targets, settlement state, and optional immutable metadata reference. Targets are informational and only enable their respective funding channels: reaching or exceeding a target never closes a goal, and contributions may continue above it until the deadline or an earlier manual close or cancellation. These text-like values are opaque to the contract and only byte-bounded: 96 bytes for the non-empty title, 512 for the description, and 200 for the metadata reference. The UI decides which encoding and metadata URI format to use. `GoalCreated` emits the complete initial public goal definition; an indexer reads the immutable `PRE()` and `USDC()` getters once to identify its two assets. Later payout-address changes are emitted separately.

Incoming and outgoing transfers must change the escrow and destination balances by the exact requested amount. Supported PRE tokens must expose 18 decimals and supported USDC tokens 6 decimals. Fee-on-transfer and other non-exact transfers are rejected. Rebasing tokens are unsupported: a balance change between escrow operations can make the global accounting insolvent even though each individual transfer passed its delta check.

The beneficiary is immutable but can change its payout address if the original address cannot receive a token. The immutable treasury controller has the same ability for cancelled-goal funds. Once a goal is closed, either the owner or beneficiary can release all contributions to the beneficiary payout. Only funds from cancelled goals can be released by the owner or treasury to the treasury payout.

## Trust model

Contributions are deliberately non-refundable. The owner appoints and removes goal managers through `setGoalManager`. An active manager may create goals and may close or cancel only goals whose immutable creator is that manager. Closing assigns every contribution, including amounts above target, to the beneficiary; cancelling assigns every contribution to treasury. Removing a manager immediately blocks new goals and control of its existing goals, while the owner retains emergency control of every goal.

Each manager may initially have at most three open goals. Closing or cancelling a goal releases one slot for its original creator. The owner can change the shared limit through `setMaxOpenGoalsPerManager`, including setting it to zero to freeze manager-created goals, and is itself exempt from the limit. Existing open goals are not changed when the limit is lowered. The creator is the direct contract caller: a call executed by a Safe records the Safe address, while individual attribution requires each manager address to call directly.

Goal IDs share one global namespace. A manager should derive each ID from at least its own address and a fresh, unpredictable salt (for example, `keccak256(abi.encode(manager, salt))`) and should not reveal the salt before submitting the transaction. This reduces accidental collisions and opportunistic ID squatting or front-running without changing the contract ABI.

Only the owner can manage goal managers, change the open-goal limit, pause settlement, or recover excess PRE or USDC. A goal manager receives none of those permissions. Token contracts cannot be changed after deployment.

Deployment starts with the selected keystore EOA as `OWNER_ADDRESS`, then uses the two-step Ownable handoff to a deployed `SAFE_ADDRESS`. The EOA only initiates `transferOwnership`; the Safe must separately execute `acceptOwnership`. Do not publish a contribution UI, announce the escrow as live, or accept contributions until `check:escrow` confirms that the Safe is the owner and `pendingOwner` is zero. Verify the Safe implementation, network, signer independence, owners, threshold, and recovery process manually before deployment.

The immutable `TREASURY_ADDRESS` must already be the final treasury controller at construction time. On Base mainnet it must contain deployed contract code and should be a separately reviewed, recoverable Safe, because only this address can rotate `treasuryPayout`. Ownership handoff does not change the treasury controller.

## Commands

```bash
nvm use
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint:sol
pnpm coverage
pnpm audit --audit-level high
pnpm goal-manager:set --network testnet
```

Hardhat verifies and caches the exact Solidity 0.8.36 compiler build, keeping compiler selection deterministic without carrying the npm `solc` wrapper in the dependency tree.

On a fresh checkout, `pnpm install --frozen-lockfile` must succeed before the verification commands above. Pull requests and releases are blocked by critical or high dependency advisories. Lower-severity development-only advisories must be reviewed, documented when accepted, and checked again regularly.

The `coverage` command uses Hardhat 3's native coverage and fails unless the production `PREcommunityEscrowV1` contract has 100% line coverage. Hardhat's native report currently exposes line and statement coverage rather than the branch/function metrics produced by the retired `solidity-coverage` instrumenter.

## Deployment credentials

Deployment uses password-encrypted Web3 JSON keystores. Private keys are not accepted through command arguments or environment variables. The expected files in the project root are:

- `.keystore-testnet` for `--network testnet` (Base Sepolia, chain ID 84532)
- `.keystore-mainnet` for `--network mainnet` (Base, chain ID 8453)

Create either file interactively from an existing private key:

```bash
pnpm keystore:create --network testnet
# Or, only when preparing a mainnet deployer:
pnpm keystore:create --network mainnet
```

The creation command asks for the private key, a password of at least 12 characters, and password confirmation without displaying any of them. It writes the selected keystore with permissions `600`, prints only the public address, and refuses to overwrite an existing file. Both keystore files are ignored by Git.

Each deploy command also asks for the selected keystore's password without displaying it. Secrets are processed only in memory and are never stored in `.env`, passed on the command line, or printed in a manifest.

Public RPC endpoints and escrow constructor inputs can be configured in `.env`:

```bash
BASE_SEPOLIA_RPC_URL=https://sepolia.base.org
BASE_MAINNET_RPC_URL=https://mainnet.base.org
ETHERSCAN_API_KEY=
PRE_ADDRESS=
USDC_ADDRESS=
OWNER_ADDRESS=
SAFE_ADDRESS=
TREASURY_ADDRESS=
TREASURY_PAYOUT_ADDRESS=
ESCROW_ADDRESS=
DEPLOYMENT_BLOCK=
DEPLOYMENT_CHECK_STAGE=final
GOAL_MANAGER_ADDRESS=
GOAL_MANAGER_ENABLED=
```

## Base Sepolia test tokens

Deploy the owner-minted test tokens with an explicit network flag:

```bash
pnpm deploy:test-tokens --network testnet
```

The command deploys `MockPRE` with 18 decimals and `MockUSDC` with 6 decimals, then mints `10,000,000 PRE` and `10,000,000 USDC` directly to the testnet keystore account. That account is also the initial owner and can issue additional balances through `mint(address,uint256)`; contract amounts are expressed in each token's smallest unit. The command waits for both mint transactions and prints their recipient, amounts, addresses, and confirmation blocks in the JSON manifest. This script rejects Base mainnet even when `--network mainnet` is supplied.

## Escrow deployment

Copy the test-token addresses into `PRE_ADDRESS` and `USDC_ADDRESS`, set `OWNER_ADDRESS` to the public address in the selected deployer keystore, set `SAFE_ADDRESS` to the deployed destination Safe, and add the treasury controller. Then deploy and complete the two-step handoff:

```bash
pnpm preflight:escrow --network testnet
pnpm deploy:escrow --network testnet
# Validate the deployed code and constructor state while the EOA is still owner.
DEPLOYMENT_CHECK_STAGE=pre-handoff pnpm check:escrow --network testnet
pnpm ownership:handoff --network testnet
# Submit the printed acceptOwnership payload through the destination Safe.
pnpm check:escrow --network testnet
```

`ownership:handoff` is idempotent. On its first run the configured owner EOA sends `transferOwnership(SAFE_ADDRESS)` and the command prints deterministic Safe transaction data for `acceptOwnership()`. If initiation already succeeded, it prints the same Safe payload without another EOA transaction. It never proposes, signs, or executes a Safe transaction. After the Safe executes the payload, a further run reports the handoff as complete.

`preflight:escrow` connects to the RPC, verifies its actual chain ID, decrypts the selected keystore, simulates the complete constructor with `estimateGas`, adds a 20% gas-limit margin, and requires enough deployer ETH for the resulting maximum fee budget. The deploy command repeats the chain, constructor, balance, and gas checks rather than trusting an earlier preflight.

Immediately after broadcasting, `deploy:escrow` atomically stores a `pending` manifest under `.deployments/<network>.json` before waiting for confirmations. Re-running the exact deployment resumes that transaction; it verifies the transaction is contract creation from the expected deployer, with the recorded nonce and init-code hash, then checks the successful receipt, derived contract address, and runtime code. A conflicting, failed, missing, or unverifiable recorded transaction fails closed instead of sending another deployment. Never delete or replace the manifest merely to silence a mismatch. A `.lock` file means submission may still be in progress or may have reached the RPC without a durable manifest; reconcile the deployer nonce and chain history before manually removing it.

The deploy command waits for at least two Base Sepolia confirmations or five Base mainnet confirmations and records both the required and observed counts in its durable manifest. These are explicit operational reorg buffers, not proof of L1 finality; production release procedures should additionally apply the project's current Base/L1 finality policy before publishing the address.

The same workflow supports Base mainnet and selects `.keystore-mainnet`. Mainnet requires `SAFE_ADDRESS` and `TREASURY_ADDRESS` to contain deployed contract code, while `OWNER_ADDRESS` must exactly match the deployer keystore EOA. The preflight and deploy commands both enforce distinct token contracts, controller/token role separation, deployed token code, PRE 18 decimals, USDC 6 decimals, the Safe target, and the mainnet treasury contract requirement, so skipping preflight does not bypass those checks. `SAFE_ADDRESS` may equal `TREASURY_ADDRESS`, but neither controller may be one of the configured token contracts. On Base mainnet the scripts also require canonical PRE `0x3816dD4bd44c8830c2FA020A5605bAC72FA3De7A` from [Presearch tokenomics](https://docs.presearch.io/presearch-project/tokenomics) and native USDC `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` from [Circle's contract-address registry](https://developers.circle.com/stablecoins/usdc-contract-addresses); testnet token addresses remain configurable.

Copy the deployment manifest's `escrowAddress` and `deploymentBlock` to `ESCROW_ADDRESS` and `DEPLOYMENT_BLOCK`. `DEPLOYMENT_BLOCK` is mandatory for the Base mainnet readiness check. Before initiating ownership transfer, run with `DEPLOYMENT_CHECK_STAGE=pre-handoff`; this mode requires the configured EOA owner and a zero `pendingOwner`, validates the deployment, and always reports `contributionsAllowed: false`. The default `final` mode requires the completed Safe handoff. Do not use pre-handoff output as launch approval.

`check:escrow` verifies the RPC's actual chain ID, exact constructor block, complete locally compiled runtime bytecode while normalizing compiler-declared immutable slots, each immutable value through its getter, token roles and decimals, immutable treasury controller, current `treasuryPayout`, current owner, `pendingOwner`, `paused == false`, and the reviewed initial `maxOpenGoalsPerManager == 3`. `TREASURY_PAYOUT_ADDRESS` is optional and defaults to `TREASURY_ADDRESS`; set it after an intentional payout rotation. A missing or wrong mainnet deployment block, incomplete Safe acceptance, unexpected pause/limit state, or mismatched payout makes the final check fail. Only a successful default post-acceptance check permits contributions.

After handoff, `goal-manager:set` detects the contract owner and prints deterministic `setGoalManager` calldata plus a Safe transaction payload without submitting it. Verify the network, Safe, escrow, method, manager, enabled flag, and calldata in the Safe UI before collecting approvals. Testnet escrows that intentionally remain EOA-owned can still submit this command directly through the matching testnet keystore.

After copying the new address to `ESCROW_ADDRESS`, publish the exact optimized source and constructor arguments:

```bash
pnpm verify:sourcify --network testnet
pnpm verify:escrow --network testnet
```

Sourcify verification does not require a secret. Explorer verification uses one Etherscan V2 API key for the selected chain ID. Do not place the key in command history.

The mock tokens under `contracts/testnet/` are for test networks only. Do not deploy the escrow until the token addresses, Safe configuration, signer independence, treasury controller, selected network, and keystore account have been independently verified.

## Verifying a deployment

Before treating any address as an instance of this contract:

1. Build from a fresh checkout with the frozen lockfile and run the complete command set above.
2. Compare the published optimized source, Solidity 0.8.36 settings, constructor arguments, and explorer bytecode with this repository.
3. Run `check:escrow` with the exact network, deployment block, token, owner, Safe, and treasury values used for that deployment.
4. Independently inspect the Safe implementation, owners, threshold, modules, guards, and recovery process.
5. Confirm the final Ownable2Step handoff and a zero `pendingOwner`; pre-handoff output is never launch approval.

See [SECURITY.md](SECURITY.md) for private vulnerability reporting and [CONTRIBUTING.md](CONTRIBUTING.md) for contribution checks.

## License

This project is licensed under the [MIT License](LICENSE). Copyright (c) 2026 PREcommunity.
