import { expect } from "chai";
import { getCreateAddress, getAddress, ZeroAddress } from "ethers";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  assertKeywordMarketDeploymentAllowed,
  assertKeywordMarketManifestMatches,
  assertKeywordMarketManifestNetwork,
  assertKeywordMarketRolloutState,
  assertKeywordMarketSafeConfiguration,
  KEYWORD_MARKET_MANIFEST_SCHEMA,
  keywordMarketManifestPath,
  parseKeywordMarketCheckStage,
  readKeywordMarketDeploymentInputs,
  readKeywordMarketExpectedOperator,
  readKeywordMarketAccounting,
  readKeywordMarketManifest,
  writeKeywordMarketManifest,
  waitForKeywordMarketDeploymentTransaction,
  type KeywordMarketDeploymentManifest,
} from "../scripts/lib/keyword-market-deployment";
import { resolveDeploymentNetwork } from "../scripts/lib/deployer";
import { acquireDeploymentLock } from "../scripts/lib/deployment-manifest";
import { ethers } from "../scripts/lib/hardhat-runtime";

const preAddress = "0x0000000000000000000000000000000000000001";
const safeAddress = "0x0000000000000000000000000000000000000002";
const deployer = "0x0000000000000000000000000000000000000003";
const canonicalPre = getAddress("0x3816dd4bd44c8830c2fa020a5605bac72fa3de7a");

function manifest(): KeywordMarketDeploymentManifest {
  return {
    schema: KEYWORD_MARKET_MANIFEST_SCHEMA,
    stage: "confirmed",
    network: "base-sepolia",
    chainId: 84532,
    contractAddress: getCreateAddress({ from: deployer, nonce: 1 }),
    transactionHash: `0x${"1".repeat(64)}`,
    transactionNonce: 1,
    deploymentBlock: 100,
    transactionStatus: 1,
    requiredConfirmations: 2,
    confirmations: 2,
    deployer,
    preAddress,
    owner: safeAddress,
    initialMinimumStakeRaw: "1000000000000000000",
    startPaused: true,
    initCodeHash: `0x${"2".repeat(64)}`,
    gasEstimate: "1",
    gasLimit: "2",
    maximumFeePerGasWei: "3",
    maximumDeploymentCostWei: "6",
    createdAt: "2026-09-13T00:00:00.000Z",
    updatedAt: "2026-09-13T00:00:00.000Z",
  };
}

async function rejectionMessage(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the operation to reject.");
}

describe("Keyword Market deployment safeguards", () => {
  const testnet = resolveDeploymentNetwork("testnet", 84532);
  const mainnet = resolveDeploymentNetwork("mainnet", 8453);

  it("reads deposits, accrued charges and PRE balance from one block despite later transactions", async () => {
    const [owner, staker] = await ethers.getSigners();
    const token = await (await ethers.getContractFactory("MockERC20"))
      .deploy("Presearch", "PRE", 18);
    const market = await (await ethers.getContractFactory("PREKeywordMarketV1"))
      .deploy(owner!.address, await token.getAddress(), ethers.parseEther("1"), false);
    const address = await market.getAddress();
    const keywordId = ethers.id("accounting-snapshot");
    await token.getFunction("mint")(staker!.address, ethers.parseEther("10"));
    await token.connect(staker!).getFunction("approve")(address, ethers.MaxUint256);
    const stake = await market.connect(staker!).getFunction("stake")(
      keywordId, ethers.parseEther("10"), 1n,
    );
    const blockTag = BigInt((await stake.wait())!.blockNumber);

    await market.getFunction("setOperator")(owner!.address);
    await market.getFunction("chargeStake")(
      keywordId, staker!.address, 1n, ethers.parseEther("2"), ethers.id("snapshot-charge"),
    );
    await token.getFunction("mint")(address, ethers.parseEther("1"));

    expect(await readKeywordMarketAccounting(market, token, address, blockTag))
      .to.deep.equal([ethers.parseEther("10"), 0n, ethers.parseEther("10")]);
    expect(await market.getFunction("totalStaked").staticCall()).to.equal(ethers.parseEther("8"));
    expect(await market.getFunction("accruedFees").staticCall()).to.equal(ethers.parseEther("2"));
    expect(await token.getFunction("balanceOf").staticCall(address)).to.equal(ethers.parseEther("11"));
  });

  it("reads separate testnet and Base Safe/PRE/minimum keys without testnet fallback", () => {
    expect(
      readKeywordMarketDeploymentInputs(testnet, {
        PRE_ADDRESS_TESTNET: preAddress,
        SAFE_ADDRESS_TESTNET: safeAddress,
        KEYWORD_MARKET_MINIMUM_PRE_TESTNET: "1.5",
      }),
    ).to.deep.equal({
      preAddress,
      owner: safeAddress,
      initialMinimumStakeRaw: 1_500_000_000_000_000_000n,
      startPaused: false,
    });
    expect(
      readKeywordMarketDeploymentInputs(mainnet, {
        PRE_ADDRESS: canonicalPre,
        SAFE_ADDRESS: safeAddress,
        KEYWORD_MARKET_MINIMUM_PRE: "2",
        PRE_ADDRESS_TESTNET: preAddress,
        KEYWORD_MARKET_MINIMUM_PRE_TESTNET: "9",
      }),
    ).to.deep.equal({
      preAddress: canonicalPre,
      owner: safeAddress,
      initialMinimumStakeRaw: 2_000_000_000_000_000_000n,
      startPaused: false,
    });
    expect(() =>
      readKeywordMarketDeploymentInputs(mainnet, {
        PRE_ADDRESS_TESTNET: preAddress,
        SAFE_ADDRESS_TESTNET: safeAddress,
      }),
    ).to.throw("PRE_ADDRESS");
    expect(keywordMarketManifestPath(testnet, {})).to.contain(
      "base-sepolia.keyword-market-v1.json",
    );
    expect(keywordMarketManifestPath(mainnet, {})).to.contain(
      "base.keyword-market-v1.json",
    );
  });

  it("starts active by default on either chain and accepts only an explicit pause toggle", () => {
    for (const deploymentNetwork of [testnet, mainnet]) {
      const suffix =
        deploymentNetwork.manifestName === "base-sepolia" ? "_TESTNET" : "";
      const environment = {
        [`PRE_ADDRESS${suffix}`]: suffix ? preAddress : canonicalPre,
        [`SAFE_ADDRESS${suffix}`]: safeAddress,
      };
      const key = `KEYWORD_MARKET_START_PAUSED${suffix}`;
      expect(
        readKeywordMarketDeploymentInputs(deploymentNetwork, environment)
          .startPaused,
      ).to.equal(false);
      expect(
        readKeywordMarketDeploymentInputs(deploymentNetwork, {
          ...environment,
          [key]: "0",
        }).startPaused,
      ).to.equal(false);
      expect(
        readKeywordMarketDeploymentInputs(deploymentNetwork, {
          ...environment,
          [key]: "1",
        }).startPaused,
      ).to.equal(true);
      for (const value of ["true", "false", "2", "-1"]) {
        expect(() =>
          readKeywordMarketDeploymentInputs(deploymentNetwork, {
            ...environment,
            [key]: value,
          }),
        ).to.throw(key);
      }
    }
    expect(
      readKeywordMarketDeploymentInputs(testnet, {
        PRE_ADDRESS_TESTNET: preAddress,
        SAFE_ADDRESS_TESTNET: safeAddress,
        KEYWORD_MARKET_START_PAUSED: "1",
      }).startPaused,
    ).to.equal(false);
  });

  it("isolates named deployments and their locks without overwriting prior manifests", () => {
    expect(
      keywordMarketManifestPath(testnet, {
        KEYWORD_MARKET_DEPLOYMENT_NAME_TESTNET: "active-rehearsal-20261007",
      }),
    ).to.contain(
      "base-sepolia.keyword-market-v1.active-rehearsal-20261007.json",
    );
    expect(
      keywordMarketManifestPath(mainnet, {
        KEYWORD_MARKET_DEPLOYMENT_NAME_TESTNET: "active-rehearsal-20261007",
      }),
    ).to.contain("base.keyword-market-v1.json");
    expect(
      keywordMarketManifestPath(mainnet, {
        KEYWORD_MARKET_DEPLOYMENT_NAME: "launch",
      }),
    ).to.contain("base.keyword-market-v1.launch.json");
    for (const name of ["../escape", "Active", "-invalid", "a".repeat(65)]) {
      expect(() =>
        keywordMarketManifestPath(testnet, {
          KEYWORD_MARKET_DEPLOYMENT_NAME_TESTNET: name,
        }),
      ).to.throw("KEYWORD_MARKET_DEPLOYMENT_NAME_TESTNET");
    }
  });

  it("requires explicit mainnet deployment opt-in, canonical PRE and a distinct Safe", () => {
    expect(() =>
      assertKeywordMarketDeploymentAllowed(testnet, {}),
    ).not.to.throw();
    for (const value of [undefined, "0", "true", " 1 "]) {
      expect(() =>
        assertKeywordMarketDeploymentAllowed(mainnet, {
          KEYWORD_MARKET_ALLOW_MAINNET: value,
        }),
      ).to.throw("KEYWORD_MARKET_ALLOW_MAINNET=1");
    }
    expect(() =>
      assertKeywordMarketDeploymentAllowed(mainnet, {
        KEYWORD_MARKET_ALLOW_MAINNET: "1",
      }),
    ).not.to.throw();
    expect(() =>
      readKeywordMarketDeploymentInputs(mainnet, {
        PRE_ADDRESS: preAddress,
        SAFE_ADDRESS: safeAddress,
      }),
    ).to.throw("canonical Base mainnet token");
    expect(() =>
      readKeywordMarketDeploymentInputs(testnet, {
        PRE_ADDRESS_TESTNET: preAddress,
        SAFE_ADDRESS_TESTNET: preAddress,
      }),
    ).to.throw("must differ");
  });

  it("rejects zero, negative and over-precise initial minimum amounts", () => {
    for (const amount of ["0", "-1", "0.0000000000000000001", "invalid"]) {
      expect(() =>
        readKeywordMarketDeploymentInputs(testnet, {
          PRE_ADDRESS_TESTNET: preAddress,
          SAFE_ADDRESS_TESTNET: safeAddress,
          KEYWORD_MARKET_MINIMUM_PRE_TESTNET: amount,
        }),
      ).to.throw("KEYWORD_MARKET_MINIMUM_PRE_TESTNET");
    }
  });

  it("requires valid Safe owners and a supported threshold", () => {
    expect(() =>
      assertKeywordMarketSafeConfiguration([safeAddress, deployer], 2n),
    ).not.to.throw();
    for (const [owners, threshold] of [
      [[], 1n],
      [[safeAddress], 0n],
      [[safeAddress], 2n],
    ] as const) {
      expect(() =>
        assertKeywordMarketSafeConfiguration([...owners], threshold),
      ).to.throw("owner list and threshold");
    }
    expect(() =>
      assertKeywordMarketSafeConfiguration([ZeroAddress], 1n),
    ).to.throw("non-zero");
    expect(() =>
      assertKeywordMarketSafeConfiguration([safeAddress, safeAddress], 1n),
    ).to.throw("distinct");
  });

  it("checks paused rollout and active staking without requiring a billing operator", () => {
    expect(parseKeywordMarketCheckStage(undefined)).to.equal("active");
    expect(parseKeywordMarketCheckStage(undefined, true)).to.equal("rollout");
    expect(parseKeywordMarketCheckStage("active")).to.equal("active");
    expect(() => parseKeywordMarketCheckStage("other")).to.throw(
      "rollout or active",
    );
    expect(readKeywordMarketExpectedOperator(mainnet, {})).to.equal(
      ZeroAddress,
    );
    expect(
      readKeywordMarketExpectedOperator(testnet, {
        ADS_OPERATOR_ADDRESS: deployer,
      }),
    ).to.equal(ZeroAddress);
    expect(
      readKeywordMarketExpectedOperator(testnet, {
        ADS_OPERATOR_ADDRESS_TESTNET: deployer,
      }),
    ).to.equal(deployer);
    expect(() =>
      readKeywordMarketExpectedOperator(mainnet, {
        ADS_OPERATOR_ADDRESS: "bad",
      }),
    ).to.throw("public address");
    expect(() =>
      assertKeywordMarketRolloutState(
        true,
        ZeroAddress,
        ZeroAddress,
        "rollout",
      ),
    ).not.to.throw();
    expect(() =>
      assertKeywordMarketRolloutState(
        false,
        ZeroAddress,
        ZeroAddress,
        "active",
      ),
    ).not.to.throw();
    expect(() =>
      assertKeywordMarketRolloutState(
        false,
        ZeroAddress,
        ZeroAddress,
        "rollout",
      ),
    ).to.throw("remain paused");
    expect(() =>
      assertKeywordMarketRolloutState(true, ZeroAddress, ZeroAddress, "active"),
    ).to.throw("not active");
    expect(() =>
      assertKeywordMarketRolloutState(false, deployer, ZeroAddress, "active"),
    ).to.throw("operator");
    expect(() =>
      assertKeywordMarketRolloutState(false, deployer, deployer, "active"),
    ).not.to.throw();
  });

  it("refuses to resume when durable network, constructor, sender or code intent differs", () => {
    const value = manifest();
    const intent = {
      network: "base-sepolia" as const,
      chainId: 84532,
      requiredConfirmations: 2,
      deployer,
      preAddress,
      owner: safeAddress,
      initialMinimumStakeRaw: 1_000_000_000_000_000_000n,
      startPaused: true,
      initCodeHash: value.initCodeHash,
    };
    expect(() =>
      assertKeywordMarketManifestMatches(value, intent),
    ).not.to.throw();
    const legacy = { ...value };
    delete legacy.startPaused;
    expect(() =>
      assertKeywordMarketManifestMatches(legacy, intent),
    ).not.to.throw();
    expect(() =>
      assertKeywordMarketManifestMatches(legacy, {
        ...intent,
        startPaused: false,
      }),
    ).to.throw("startPaused");
    expect(() =>
      assertKeywordMarketManifestNetwork(value, testnet),
    ).not.to.throw();
    expect(() => assertKeywordMarketManifestNetwork(value, mainnet)).to.throw(
      "network and chain ID",
    );
    for (const [key, change] of [
      ["network", { network: "base" as const }],
      ["chainId", { chainId: 8453 }],
      ["requiredConfirmations", { requiredConfirmations: 6 }],
      ["deployer", { deployer: safeAddress }],
      ["preAddress", { preAddress: safeAddress }],
      ["owner", { owner: deployer }],
      ["initialMinimumStakeRaw", { initialMinimumStakeRaw: 2n }],
      ["startPaused", { startPaused: false }],
      ["initCodeHash", { initCodeHash: `0x${"3".repeat(64)}` }],
    ] as const) {
      expect(() =>
        assertKeywordMarketManifestMatches(value, { ...intent, ...change }),
      ).to.throw(key);
    }
  });

  describe("deployment transaction visibility", () => {
    it("waits for propagation and returns the same recorded transaction without sending", async () => {
      const transaction = { hash: manifest().transactionHash };
      const reads: string[] = [];
      const waits: number[] = [];
      const misses: number[] = [];
      let sends = 0;
      const provider = {
        getTransaction: async (hash: string) => {
          reads.push(hash);
          return reads.length < 3 ? null : transaction;
        },
        sendTransaction: async () => {
          sends += 1;
          throw new Error("A visibility check must not send transactions.");
        },
      };
      expect(
        await waitForKeywordMarketDeploymentTransaction(
          provider,
          transaction.hash,
          {
            wait: async (milliseconds) => {
              waits.push(milliseconds);
            },
            onMiss: (attempt) => {
              misses.push(attempt);
            },
          },
        ),
      ).to.equal(transaction);
      expect(reads).to.deep.equal(Array(3).fill(transaction.hash));
      expect(waits).to.deep.equal([2_000, 2_000]);
      expect(misses).to.deep.equal([1, 2]);
      expect(sends).to.equal(0);
    });

    it("does not wait when an existing transaction is already visible", async () => {
      const transaction = { hash: manifest().transactionHash };
      let reads = 0;
      expect(
        await waitForKeywordMarketDeploymentTransaction(
          {
            getTransaction: async () => {
              reads += 1;
              return transaction;
            },
          },
          transaction.hash,
          {
            wait: async () => {
              throw new Error("Unexpected propagation wait.");
            },
          },
        ),
      ).to.equal(transaction);
      expect(reads).to.equal(1);
    });

    it("propagates RPC read failures without resubmitting or polling indefinitely", async () => {
      const failure = new Error("RPC unavailable");
      let reads = 0;
      const message = await rejectionMessage(
        waitForKeywordMarketDeploymentTransaction(
          {
            getTransaction: async () => {
              reads += 1;
              throw failure;
            },
          },
          manifest().transactionHash,
          {
            wait: async () => {
              throw new Error("Unexpected propagation wait.");
            },
          },
        ),
      );
      expect(message).to.equal(failure.message);
      expect(reads).to.equal(1);
    });
  });

  describe("durable manifests and deployment locks", () => {
    let directory: string;
    let filePath: string;
    beforeEach(async () => {
      directory = await mkdtemp(
        path.join(tmpdir(), "keyword-market-deployment-"),
      );
      filePath = path.join(directory, "market.json");
    });
    afterEach(async () => {
      await rm(directory, { recursive: true, force: true });
    });

    it("persists pending and confirmed deployments on both chains", async () => {
      const value = manifest();
      await writeKeywordMarketManifest(filePath, value);
      expect(await readKeywordMarketManifest(filePath)).to.deep.equal(value);
      const pending = {
        ...value,
        network: "base" as const,
        chainId: 8453 as const,
        preAddress: canonicalPre,
        requiredConfirmations: 6,
        confirmations: 0,
        stage: "pending" as const,
        deploymentBlock: null,
        transactionStatus: null,
      };
      await writeKeywordMarketManifest(filePath, pending);
      expect(await readKeywordMarketManifest(filePath)).to.deep.equal(pending);
      expect(
        JSON.parse(await readFile(filePath, "utf8")).transactionHash,
      ).to.equal(value.transactionHash);
    });

    it("bounds visibility waits to 30 seconds and preserves the pending manifest and reconciliation lock", async () => {
      const pending = {
        ...manifest(),
        stage: "pending" as const,
        deploymentBlock: null,
        transactionStatus: null,
        confirmations: 0,
      };
      await writeKeywordMarketManifest(filePath, pending);
      const releaseLock = await acquireDeploymentLock(filePath);
      const beforeManifest = await readFile(filePath, "utf8");
      const beforeLock = await readFile(`${filePath}.lock`, "utf8");
      const reads: string[] = [];
      const waits: number[] = [];
      let sends = 0;
      const provider = {
        getTransaction: async (hash: string) => {
          reads.push(hash);
          return null;
        },
        sendTransaction: async () => {
          sends += 1;
          throw new Error("Unexpected transaction send.");
        },
      };
      const message = await rejectionMessage(
        waitForKeywordMarketDeploymentTransaction(
          provider,
          pending.transactionHash,
          {
            wait: async (milliseconds) => {
              waits.push(milliseconds);
            },
          },
        ),
      );
      expect(reads).to.deep.equal(Array(16).fill(pending.transactionHash));
      expect(waits).to.deep.equal(Array(15).fill(2_000));
      expect(
        waits.reduce((sum, milliseconds) => sum + milliseconds, 0),
      ).to.equal(30_000);
      expect(message).to.contain(pending.transactionHash);
      expect(message).to.contain(
        "manifest and any reconciliation lock were retained",
      );
      expect(message).to.contain("Rerun the same deployment command");
      expect(message).to.contain("do not delete the manifest or deploy again");
      expect(sends).to.equal(0);
      expect(await readFile(filePath, "utf8")).to.equal(beforeManifest);
      expect(await readFile(`${filePath}.lock`, "utf8")).to.equal(beforeLock);
      expect(await readKeywordMarketManifest(filePath)).to.deep.equal(pending);
      expect(
        await rejectionMessage(acquireDeploymentLock(filePath)),
      ).to.contain("reconcile its transaction");
      await releaseLock();
    });

    it("fails closed on corrupted network tuples and incomplete transaction identities", async () => {
      for (const change of [
        { network: "base" },
        { chainId: 8453 },
        { transactionHash: "0x01" },
        { transactionNonce: -1 },
        { contractAddress: preAddress },
        { confirmations: 0 },
        { owner: ZeroAddress },
        { initialMinimumStakeRaw: "0" },
        { startPaused: "false" },
        { deploymentBlock: null },
        { transactionStatus: null },
      ]) {
        await writeFile(filePath, JSON.stringify({ ...manifest(), ...change }));
        expect(
          await rejectionMessage(readKeywordMarketManifest(filePath)),
        ).to.contain("unsupported format");
      }
      await writeFile(filePath, "invalid json");
      expect(
        await rejectionMessage(readKeywordMarketManifest(filePath)),
      ).to.contain("not valid JSON");
    });

    it("refuses another deployment while a prior submission lock requires reconciliation", async () => {
      const release = await acquireDeploymentLock(filePath);
      expect(
        await rejectionMessage(acquireDeploymentLock(filePath)),
      ).to.contain("reconcile its transaction");
      await release();
      const releaseAgain = await acquireDeploymentLock(filePath);
      await releaseAgain();
    });
  });
});
