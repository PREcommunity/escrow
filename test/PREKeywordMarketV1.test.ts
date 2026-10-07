import { expect } from "chai";
import fc from "fast-check";
import { mkdir, writeFile } from "node:fs/promises";
import type { ContractTransactionResponse } from "ethers";
import { ethers, hardhatConnection } from "../scripts/lib/hardhat-runtime";
import keywordHashVectors from "./fixtures/ads-keyword-hash-vectors.json";
import type {
  MockERC20,
  MockReentrantERC20,
  MockRestrictedERC20,
  PREKeywordMarketV1,
} from "../typechain-types";

type Signer = Awaited<ReturnType<typeof ethers.getSigners>>[number];
const pre = (value: string) => ethers.parseEther(value);
const bid = (value: number) => BigInt(value) * 1_000_000n;

describe("PREKeywordMarketV1", () => {
  async function deploy(token?: string, minimum = pre("1"), activate = true, startPaused = true) {
    const signers = await ethers.getSigners();
    const owner = signers[0]!;
    const operator = signers[1]!;
    const alice = signers[2]!;
    const bob = signers[3]!;
    const carol = signers[4]!;
    const stranger = signers[5]!;
    const Token = await ethers.getContractFactory("MockERC20");
    const payment = token
      ? null
      : ((await Token.deploy("Presearch", "PRE", 18)) as unknown as MockERC20);
    const Market = await ethers.getContractFactory("PREKeywordMarketV1");
    const market = (await Market.deploy(
      owner.address,
      token ?? (await payment!.getAddress()),
      minimum,
      startPaused,
    )) as unknown as PREKeywordMarketV1;
    if (activate) {
      await market.connect(owner).setOperator(operator.address);
      if (startPaused) await market.connect(owner).unpause();
    }
    if (payment) {
      for (const staker of [alice, bob, carol]) {
        await payment.mint(staker.address, pre("100"));
        await payment
          .connect(staker)
          .approve(await market.getAddress(), ethers.MaxUint256);
      }
    }
    return {
      owner,
      operator,
      alice,
      bob,
      carol,
      stranger,
      payment,
      market,
      keywordId: ethers.keccak256(ethers.toUtf8Bytes("bitcoin poland")),
    };
  }

  async function stake(
    market: PREKeywordMarketV1,
    staker: Signer,
    keywordId: string,
    amountPre: bigint,
    bidUsd: bigint,
  ) {
    return market.connect(staker).stake(keywordId, amountPre, bidUsd);
  }

  async function advanceTo(timestamp: bigint) {
    const latest = await ethers.provider.getBlock("latest");
    const next =
      timestamp > BigInt(latest!.timestamp)
        ? timestamp
        : BigInt(latest!.timestamp) + 1n;
    await ethers.provider.send("evm_setNextBlockTimestamp", [Number(next)]);
    await ethers.provider.send("evm_mine", []);
  }

  async function decodedEvents(
    market: PREKeywordMarketV1,
    transaction: ContractTransactionResponse,
  ) {
    const receipt = await transaction.wait();
    expect(receipt?.status).to.equal(1);
    return receipt!.logs.flatMap((log) => {
      try {
        const event = market.interface.parseLog(log);
        return event ? [event] : [];
      } catch {
        return [];
      }
    });
  }

  it("uses the application's canonical UTF-8 keyword hashes", () => {
    for (const vector of keywordHashVectors) {
      expect(ethers.keccak256(ethers.toUtf8Bytes(vector.canonical))).to.equal(
        vector.keywordId,
      );
    }
  });

  it("starts paused with no operator and lets the Safe enable unsigned staking", async () => {
    const { owner, alice, market, keywordId } = await deploy(
      undefined,
      pre("1"),
      false,
    );
    expect(await market.paused()).to.equal(true);
    expect(await market.operator()).to.equal(ethers.ZeroAddress);
    const constructorEvents = await decodedEvents(
      market,
      market.deploymentTransaction()!,
    );
    expect(
      constructorEvents.find((event) => event.name === "Paused")?.args.account,
    ).to.equal(owner.address);
    await expect(
      stake(market, alice, keywordId, pre("1"), bid(1)),
    ).to.be.revertedWithCustomError(market, "EnforcedPause");
    await market.connect(owner).unpause();
    await stake(market, alice, keywordId, pre("1"), bid(1));
    expect((await market.topStakeOf(keywordId)).staker).to.equal(alice.address);
  });

  it("can start active with the same owner and accept a stake without an operator or unpause", async () => {
    const { owner, alice, market, keywordId } = await deploy(undefined, pre("1"), false, false);
    expect(await market.owner()).to.equal(owner.address);
    expect(await market.paused()).to.equal(false);
    expect(await market.operator()).to.equal(ethers.ZeroAddress);
    const constructorEvents = await decodedEvents(market, market.deploymentTransaction()!);
    expect(constructorEvents.some((event) => event.name === "Paused")).to.equal(false);
    const ownership = constructorEvents.find((event) => event.name === "OwnershipTransferred")!.args;
    expect(ownership.previousOwner).to.equal(ethers.ZeroAddress);
    expect(ownership.newOwner).to.equal(owner.address);
    await stake(market, alice, keywordId, pre("1"), bid(1));
    expect((await market.topStakeOf(keywordId)).staker).to.equal(alice.address);
  });

  it("rejects invalid addresses, zero values and missing positions", async () => {
    const { owner, operator, alice, payment, market, keywordId } = await deploy();
    const Market = await ethers.getContractFactory("PREKeywordMarketV1");
    const token = await payment!.getAddress();
    await expect(Market.deploy(ethers.ZeroAddress, token, pre("1"), true))
      .to.be.revertedWithCustomError(market, "OwnableInvalidOwner");
    await expect(Market.deploy(owner.address, ethers.ZeroAddress, pre("1"), true))
      .to.be.revertedWithCustomError(market, "ZeroAddress");
    await expect(Market.deploy(owner.address, token, 0n, true))
      .to.be.revertedWithCustomError(market, "ZeroAmount");
    await expect(stake(market, alice, ethers.ZeroHash, pre("1"), bid(1)))
      .to.be.revertedWithCustomError(market, "ZeroKeyword");
    await expect(market.connect(alice).requestUnstake(keywordId))
      .to.be.revertedWithCustomError(market, "PositionMissing");
    await expect(market.connect(alice).unstake(keywordId))
      .to.be.revertedWithCustomError(market, "PositionMissing");
    await expect(market.connect(operator).chargeStake(keywordId, alice.address, 1n, 1n, ethers.ZeroHash))
      .to.be.revertedWithCustomError(market, "InvalidChargeId");
    await expect(market.connect(operator).chargeStake(keywordId, alice.address, 1n, 0n, ethers.id("zero-charge")))
      .to.be.revertedWithCustomError(market, "ZeroAmount");
    await expect(market.connect(operator).chargeStake(keywordId, alice.address, 1n, 1n, ethers.id("missing-charge")))
      .to.be.revertedWithCustomError(market, "PositionMissing");
    await expect(market.connect(owner).withdrawAccrued(ethers.ZeroAddress, 1n))
      .to.be.revertedWithCustomError(market, "ZeroAddress");
    await expect(market.connect(owner).withdrawAccrued(alice.address, 0n))
      .to.be.revertedWithCustomError(market, "ZeroAmount");
    await expect(market.connect(owner).setOperator(token))
      .to.be.revertedWithCustomError(market, "InvalidOperator");
    await expect(market.connect(owner).setMinimumStake(0n))
      .to.be.revertedWithCustomError(market, "ZeroAmount");
    expect(await market.operator()).to.equal(operator.address);
    expect(await market.minimumStake()).to.equal(pre("1"));
    expect(await market.totalStaked()).to.equal(0n);
    expect(await market.accruedFees()).to.equal(0n);
  });

  it("decodes deposit, bid, capped charge and admin fields by their correct names", async () => {
    const { owner, operator, alice, bob, market, keywordId } = await deploy();
    await stake(market, alice, keywordId, pre("10"), bid(2));
    const topUp = await decodedEvents(
      market,
      await stake(market, alice, keywordId, pre("2"), bid(4)),
    );
    const deposited = topUp.find((event) => event.name === "Staked")!.args;
    expect(deposited.depositedPre).to.equal(pre("2"));
    expect(deposited.amountPre).to.equal(pre("12"));
    const repriced = topUp.find((event) => event.name === "BidUpdated")!.args;
    expect(repriced.previousBidUsd).to.equal(bid(2));
    expect(repriced.newBidUsd).to.equal(bid(4));
    const charged = (
      await decodedEvents(
        market,
        await market
          .connect(operator)
          .chargeStake(
            keywordId,
            alice.address,
            1n,
            pre("15"),
            ethers.id("named-charge"),
          ),
      )
    ).find((event) => event.name === "StakeCharged")!.args;
    expect(charged.requestedPre).to.equal(pre("15"));
    expect(charged.chargedPre).to.equal(pre("12"));
    expect(charged.remainingPre).to.equal(0n);
    const minimum = (
      await decodedEvents(
        market,
        await market.connect(owner).setMinimumStake(pre("3")),
      )
    ).find((event) => event.name === "MinimumStakeUpdated")!.args;
    expect(minimum.previousMinimum).to.equal(pre("1"));
    expect(minimum.newMinimum).to.equal(pre("3"));
    const changedOperator = (
      await decodedEvents(
        market,
        await market.connect(owner).setOperator(bob.address),
      )
    ).find((event) => event.name === "OperatorUpdated")!.args;
    expect(changedOperator.previousOperator).to.equal(operator.address);
    expect(changedOperator.newOperator).to.equal(bob.address);
  });

  it("replays every position mutation from named PositionChanged fields", async () => {
    const { operator, alice, bob, market, keywordId } = await deploy();
    const otherKeyword = ethers.id("replay other keyword");
    const projected = new Map<
      string,
      {
        keywordId: string;
        staker: string;
        amount: bigint;
        bidUsd: bigint;
        coverage: bigint;
        eligible: boolean;
        withdrawal: bigint;
        version: bigint;
      }
    >();
    async function replay(transaction: ContractTransactionResponse) {
      const changes = (await decodedEvents(market, transaction)).filter(
        (event) => event.name === "PositionChanged",
      );
      expect(changes).to.have.length(1);
      for (const { args } of changes) {
        const key = `${args.keywordId}:${args.staker}`;
        expect(args.previousStake).to.equal(projected.get(key)?.amount ?? 0n);
        projected.set(key, {
          keywordId: args.keywordId,
          staker: args.staker,
          amount: args.newStake,
          bidUsd: args.bidUsd,
          coverage: args.requiredCoveragePre,
          eligible: args.eligible,
          withdrawal: args.withdrawAvailableAt,
          version: args.positionVersion,
        });
      }
      for (const position of projected.values()) {
        expect(
          await market.stakeDetailsOf(position.keywordId, position.staker),
        ).to.deep.equal([
          position.amount,
          position.bidUsd,
          position.coverage,
          position.eligible,
          position.withdrawal,
          position.version,
        ]);
      }
      for (const keyword of [keywordId, otherKeyword]) {
        const eligible = [...projected.values()].filter(
          (position) => position.keywordId === keyword && position.eligible,
        );
        eligible.sort((left, right) =>
          left.bidUsd === right.bidUsd
            ? BigInt(left.staker) < BigInt(right.staker)
              ? -1
              : 1
            : left.bidUsd > right.bidUsd
              ? -1
              : 1,
        );
        const leader = eligible[0];
        expect(await market.topStakeOf(keyword)).to.deep.equal(
          leader
            ? [
                leader.staker,
                leader.amount,
                leader.bidUsd,
                leader.version,
                leader.coverage,
              ]
            : [ethers.ZeroAddress, 0n, 0n, 0n, 0n],
        );
      }
    }
    await replay(await stake(market, alice, keywordId, pre("10"), bid(2)));
    await replay(await stake(market, bob, keywordId, pre("5"), bid(3)));
    await replay(await stake(market, alice, otherKeyword, pre("4"), bid(1)));
    await replay(await stake(market, alice, keywordId, 0n, bid(4)));
    await replay(await stake(market, alice, keywordId, pre("2"), bid(4)));
    await replay(
      await market
        .connect(operator)
        .chargeStake(
          keywordId,
          alice.address,
          1n,
          pre("11.5"),
          ethers.id("replay-below"),
        ),
    );
    await replay(await stake(market, alice, keywordId, pre("2"), bid(4)));
    await replay(await market.connect(bob).requestUnstake(keywordId));
    await replay(
      await market
        .connect(operator)
        .chargeStake(
          keywordId,
          bob.address,
          1n,
          pre("1"),
          ethers.id("replay-pending"),
        ),
    );
    await advanceTo(projected.get(`${keywordId}:${bob.address}`)!.withdrawal);
    await replay(await market.connect(bob).unstake(keywordId));
    await replay(await stake(market, bob, keywordId, pre("3"), bid(5)));
    const chargeId = ethers.id("replay-capped");
    await replay(
      await market
        .connect(operator)
        .chargeStake(keywordId, alice.address, 1n, pre("20"), chargeId),
    );
    const duplicate = await decodedEvents(
      market,
      await market
        .connect(operator)
        .chargeStake(keywordId, alice.address, 1n, pre("20"), chargeId),
    );
    expect(
      duplicate.filter((event) => event.name === "PositionChanged"),
    ).to.have.length(0);
    await replay(await stake(market, alice, keywordId, pre("2"), bid(6)));
  });

  it("matches an independent position model through seeded heap mutations and complete exits", async function () {
    this.timeout(180_000);
    const commands = fc.array(
      fc.record({
        wallet: fc.integer({ min: 0, max: 7 }),
        operation: fc.constantFrom(
          "STAKE",
          "BID",
          "CHARGE",
          "REQUEST",
          "CLAIM",
        ),
        value: fc.integer({ min: 1, max: 12 }),
      }),
      { minLength: 60, maxLength: 80 },
    );
    await fc.assert(
      fc.asyncProperty(commands, async (operations) => {
        const { operator, payment, market, keywordId } = await deploy(
          undefined,
          1n,
        );
        const participants = (await ethers.getSigners()).slice(2, 10);
        const model = participants.map(() => ({
          amount: 0n,
          bidUsd: 0n,
          coverage: 0n,
          withdrawal: 0n,
          version: 0n,
        }));
        let fees = 0n;
        for (const participant of participants) {
          await payment!.mint(participant.address, 1_000n);
          await payment!
            .connect(participant)
            .approve(await market.getAddress(), ethers.MaxUint256);
        }
        async function assertModel() {
          const eligible = participants
            .flatMap((participant, index) => {
              const position = model[index]!;
              return position.amount >= position.coverage &&
                position.amount > 0n &&
                position.withdrawal === 0n
                ? [{ ...position, address: participant.address }]
                : [];
            })
            .sort((left, right) =>
              left.bidUsd === right.bidUsd
                ? BigInt(left.address) < BigInt(right.address)
                  ? -1
                  : 1
                : left.bidUsd > right.bidUsd
                  ? -1
                  : 1,
            );
          const leader = eligible[0];
          expect(await market.topStakeOf(keywordId)).to.deep.equal(
            leader
              ? [
                  leader.address,
                  leader.amount,
                  leader.bidUsd,
                  leader.version,
                  leader.coverage,
                ]
              : [ethers.ZeroAddress, 0n, 0n, 0n, 0n],
          );
          const total = model.reduce(
            (sum, position) => sum + position.amount,
            0n,
          );
          expect(await market.totalStaked()).to.equal(total);
          expect(await market.accruedFees()).to.equal(fees);
          expect(await payment!.balanceOf(await market.getAddress())).to.equal(
            total + fees,
          );
        }
        for (let index = 0; index < operations.length; index++) {
          const command = operations[index]!;
          const participant = participants[command.wallet]!;
          const position = model[command.wallet]!;
          const value = BigInt(command.value);
          const previous = position.amount;
          let transaction: ContractTransactionResponse;
          if (command.operation === "STAKE" || command.operation === "BID") {
            if (
              position.withdrawal !== 0n ||
              (command.operation === "BID" && position.amount === 0n)
            )
              continue;
            const deposit = command.operation === "BID" ? 0n : value;
            if (position.amount === 0n) {
              position.version += 1n;
              position.coverage = 1n;
            }
            position.amount += deposit;
            position.bidUsd = bid(command.value);
            transaction = await stake(
              market,
              participant,
              keywordId,
              deposit,
              position.bidUsd,
            );
          } else if (command.operation === "CHARGE") {
            if (position.amount === 0n) continue;
            transaction = await market
              .connect(operator)
              .chargeStake(
                keywordId,
                participant.address,
                position.version,
                value,
                ethers.id(`model-${index}`),
              );
            const charged = value < position.amount ? value : position.amount;
            position.amount -= charged;
            fees += charged;
            if (position.amount === 0n)
              Object.assign(position, {
                bidUsd: 0n,
                coverage: 0n,
                withdrawal: 0n,
              });
          } else if (command.operation === "REQUEST") {
            if (position.amount === 0n || position.withdrawal !== 0n) continue;
            transaction = await market
              .connect(participant)
              .requestUnstake(keywordId);
            const receipt = await transaction.wait();
            const block = await ethers.provider.getBlock(receipt!.blockNumber);
            position.withdrawal = BigInt(block!.timestamp) + 86_400n;
          } else {
            if (position.amount === 0n || position.withdrawal === 0n) continue;
            await advanceTo(position.withdrawal);
            transaction = await market.connect(participant).unstake(keywordId);
            Object.assign(position, {
              amount: 0n,
              bidUsd: 0n,
              coverage: 0n,
              withdrawal: 0n,
            });
          }
          const change = (await decodedEvents(market, transaction)).find(
            (event) => event.name === "PositionChanged",
          )!.args;
          expect(change.keywordId).to.equal(keywordId);
          expect(change.staker).to.equal(participant.address);
          const eligible =
            position.amount > 0n &&
            position.amount >= position.coverage &&
            position.withdrawal === 0n;
          expect(change.previousStake).to.equal(previous);
          expect([
            change.newStake,
            change.bidUsd,
            change.requiredCoveragePre,
            change.eligible,
            change.withdrawAvailableAt,
            change.positionVersion,
          ]).to.deep.equal([
            position.amount,
            position.bidUsd,
            position.coverage,
            eligible,
            position.withdrawal,
            position.version,
          ]);
          expect(
            await market.stakeDetailsOf(keywordId, participant.address),
          ).to.deep.equal([
            position.amount,
            position.bidUsd,
            position.coverage,
            eligible,
            position.withdrawal,
            position.version,
          ]);
          await assertModel();
        }
        for (let index = 0; index < participants.length; index++) {
          const position = model[index]!;
          if (position.amount > 0n && position.withdrawal === 0n) {
            await market
              .connect(participants[index]!)
              .requestUnstake(keywordId);
            position.withdrawal = 1n;
            await assertModel();
          }
        }
        expect((await market.topStakeOf(keywordId)).staker).to.equal(
          ethers.ZeroAddress,
        );
      }),
      { seed: 64519, numRuns: 12 },
    );
  });

  it("records bounded mutation gas at 16, 128 and 1024 positions", async function () {
    this.timeout(300_000);
    const { operator, payment, market, keywordId } = await deploy(
      undefined,
      1n,
    );
    const participants: Signer[] = [];
    const measurements: Array<{
      participants: number;
      gas: Record<string, string>;
    }> = [];
    const gasCap = 1_500_000n;
    for (let index = 0; index < 1024; index++) {
      const address = ethers.getAddress(
        ethers.toBeHex(BigInt(index + 10_000), 20),
      );
      await ethers.provider.send("hardhat_impersonateAccount", [address]);
      await ethers.provider.send("hardhat_setBalance", [
        address,
        ethers.toBeHex(pre("1")),
      ]);
      const participant = await ethers.getSigner(address);
      participants.push(participant);
      await payment!.mint(address, 101n);
      await payment!
        .connect(participant)
        .approve(await market.getAddress(), 101n);
      const inserted = await (
        await stake(market, participant, keywordId, 100n, bid(index + 1))
      ).wait();
      const size = participants.length;
      if (![16, 128, 1024].includes(size)) continue;
      const gas: Record<string, string> = {
        insert: inserted!.gasUsed.toString(),
      };
      const leader = participants[size - 1]!;
      async function measure(
        name: string,
        send: () => Promise<ContractTransactionResponse>,
      ) {
        const snapshot = await hardhatConnection.networkHelpers.takeSnapshot();
        try {
          const receipt = await (await send()).wait();
          gas[name] = receipt!.gasUsed.toString();
        } finally {
          await snapshot.restore();
        }
      }
      await measure("repriceUp", () =>
        stake(market, participants[0]!, keywordId, 0n, bid(size + 1)),
      );
      await measure("repriceDown", () =>
        stake(market, leader, keywordId, 0n, bid(1)),
      );
      await measure("topUp", () =>
        stake(market, leader, keywordId, 1n, bid(size)),
      );
      await measure("requestUnstake", () =>
        market.connect(leader).requestUnstake(keywordId),
      );
      await measure("chargeStake", () =>
        market
          .connect(operator)
          .chargeStake(
            keywordId,
            leader.address,
            1n,
            100n,
            ethers.id(`gas-${size}`),
          ),
      );
      const row = { participants: size, gas };
      measurements.push(row);
      await mkdir("reports", { recursive: true });
      await writeFile(
        "reports/keyword-market-gas.json",
        `${JSON.stringify({ contract: "PREKeywordMarketV1", gasCap: gasCap.toString(), measurements }, null, 2)}\n`,
      );
      console.info(`Keyword Market gas: ${JSON.stringify(row)}`);
      for (const [operation, used] of Object.entries(gas)) {
        expect(BigInt(used), `${operation} at ${size} positions`).to.be.at.most(
          gasCap,
        );
      }
    }
  });

  it("accepts a user-selected bid, deposits exact PRE and emits the complete position", async () => {
    const { operator, alice, payment, market, keywordId } = await deploy();
    const amount = pre("10");
    await expect(stake(market, alice, keywordId, amount, bid(2)))
      .to.emit(market, "PositionChanged")
      .withArgs(
        keywordId,
        alice.address,
        bid(2),
        true,
        amount,
        1n,
        0n,
        pre("1"),
        0n,
      )
      .and.to.emit(market, "TopStakeChanged")
      .withArgs(keywordId, alice.address, bid(2), ethers.ZeroAddress, 0n);
    expect(await market.positionOf(keywordId, alice.address)).to.equal(amount);
    expect(await market.stakeDetailsOf(keywordId, alice.address)).to.deep.equal(
      [amount, bid(2), pre("1"), true, 0n, 1n],
    );
    expect(await market.totalStaked()).to.equal(amount);
    expect(await payment!.balanceOf(await market.getAddress())).to.equal(
      amount,
    );
  });

  it("ranks by USD bid, reorders on bid-only update and promotes eligible runners-up", async () => {
    const { operator, alice, bob, carol, market, keywordId } = await deploy();
    await stake(market, alice, keywordId, pre("20"), bid(2));
    await stake(market, bob, keywordId, pre("10"), bid(4));
    await stake(market, carol, keywordId, pre("15"), bid(1));
    expect((await market.topStakeOf(keywordId)).staker).to.equal(bob.address);

    await expect(stake(market, carol, keywordId, pre("1"), bid(5)))
      .to.emit(market, "BidUpdated")
      .withArgs(keywordId, carol.address, bid(1), bid(5));
    expect((await market.topStakeOf(keywordId)).staker).to.equal(carol.address);
    await market.connect(carol).requestUnstake(keywordId);
    expect((await market.topStakeOf(keywordId)).staker).to.equal(bob.address);

    await market
      .connect(operator)
      .chargeStake(keywordId, bob.address, 1n, pre("6"), ethers.id("bob-1"));
    expect(await market.stakeDetailsOf(keywordId, bob.address)).to.deep.equal([
      pre("4"),
      bid(4),
      pre("1"),
      true,
      0n,
      1n,
    ]);
    expect((await market.topStakeOf(keywordId)).staker).to.equal(bob.address);
    const topUp = await stake(market, bob, keywordId, pre("2"), bid(6));
    await expect(topUp)
      .to.emit(market, "Staked")
      .withArgs(keywordId, bob.address, pre("2"), pre("6"));
    await expect(topUp)
      .to.emit(market, "BidUpdated")
      .withArgs(keywordId, bob.address, bid(4), bid(6));
    await expect(topUp)
      .to.emit(market, "TopStakeChanged")
      .withArgs(keywordId, bob.address, bid(6), bob.address, bid(4));
    expect((await market.topStakeOf(keywordId)).staker).to.equal(bob.address);
  });

  it("breaks equal bids by lower staker address and keeps keywords independent", async () => {
    const { operator, alice, bob, market, keywordId } = await deploy();
    const otherKeyword = ethers.id("other keyword");
    await stake(market, alice, keywordId, pre("5"), bid(3));
    await stake(market, bob, keywordId, pre("8"), bid(3));
    const lowerAddress =
      BigInt(alice.address) < BigInt(bob.address) ? alice.address : bob.address;
    expect((await market.topStakeOf(keywordId)).staker).to.equal(lowerAddress);
    await stake(market, bob, otherKeyword, pre("3"), bid(1));
    expect((await market.topStakeOf(otherKeyword)).staker).to.equal(
      bob.address,
    );
  });

  it("keeps the heap leader correct through multi-level bid changes, exits and charges", async () => {
    const { operator, payment, market, keywordId } = await deploy();
    const participants = (await ethers.getSigners()).slice(2, 10);
    const bids = [4, 7, 2, 8, 1, 6, 3, 5];
    async function assertTop() {
      const active = await Promise.all(
        participants.map(async (staker) => {
          const details = await market.stakeDetailsOf(
            keywordId,
            staker.address,
          );
          return {
            address: staker.address,
            bidUsd: details.bidUsd,
            eligible: details.eligible,
          };
        }),
      );
      active.sort((left, right) => {
        if (left.eligible !== right.eligible) return left.eligible ? -1 : 1;
        if (left.bidUsd !== right.bidUsd)
          return left.bidUsd > right.bidUsd ? -1 : 1;
        return BigInt(left.address) < BigInt(right.address) ? -1 : 1;
      });
      const expected =
        active.find((position) => position.eligible)?.address ??
        ethers.ZeroAddress;
      expect((await market.topStakeOf(keywordId)).staker).to.equal(expected);
    }
    for (let index = 0; index < participants.length; index++) {
      const staker = participants[index]!;
      await payment!.mint(staker.address, pre("10"));
      await payment!
        .connect(staker)
        .approve(await market.getAddress(), ethers.MaxUint256);
      await stake(market, staker, keywordId, pre("5"), bid(bids[index]!));
      await assertTop();
    }
    await stake(market, participants[3]!, keywordId, pre("1"), bid(1));
    await assertTop();
    await stake(market, participants[4]!, keywordId, pre("1"), bid(9));
    await assertTop();
    await market.connect(participants[4]!).requestUnstake(keywordId);
    await assertTop();
    await market
      .connect(operator)
      .chargeStake(
        keywordId,
        participants[1]!.address,
        1n,
        pre("5"),
        ethers.id("heap-1"),
      );
    await assertTop();
    await market
      .connect(operator)
      .chargeStake(
        keywordId,
        participants[5]!.address,
        1n,
        pre("4.5"),
        ethers.id("heap-2"),
      );
    await assertTop();
    await stake(market, participants[5]!, keywordId, pre("1"), bid(10));
    await assertTop();
    await market.connect(participants[2]!).requestUnstake(keywordId);
    await market
      .connect(operator)
      .chargeStake(
        keywordId,
        participants[2]!.address,
        1n,
        pre("10"),
        ethers.id("heap-3"),
      );
    await assertTop();
    expect(
      (await market.totalStaked()) + (await market.accruedFees()),
    ).to.equal(await payment!.balanceOf(await market.getAddress()));
  });

  it("repairs an upward-moving removal replacement and drains the last heap member", async () => {
    const { operator, payment, market, keywordId } = await deploy(
      undefined,
      1n,
    );
    const participants = (await ethers.getSigners()).slice(2, 9);
    const bids = [100, 70, 90, 60, 50, 80, 85];
    for (let index = 0; index < participants.length; index++) {
      const participant = participants[index]!;
      await payment!.mint(participant.address, 10n);
      await payment!
        .connect(participant)
        .approve(await market.getAddress(), ethers.MaxUint256);
      await stake(market, participant, keywordId, 5n, bid(bids[index]!));
    }
    // Removing bid 60 moves tail bid 85 above its new parent bid 70.
    await market.connect(participants[3]!).requestUnstake(keywordId);
    await stake(market, participants[0]!, keywordId, 0n, bid(1));
    for (const index of [2, 6, 5, 1, 4, 0]) {
      expect((await market.topStakeOf(keywordId)).staker).to.equal(
        participants[index]!.address,
      );
      await market.connect(participants[index]!).requestUnstake(keywordId);
    }
    expect((await market.topStakeOf(keywordId)).staker).to.equal(
      ethers.ZeroAddress,
    );
    const exited = participants[3]!;
    await market
      .connect(operator)
      .chargeStake(
        keywordId,
        exited.address,
        1n,
        5n,
        ethers.id("drained-pending"),
      );
    await stake(market, exited, keywordId, 5n, bid(200));
    expect((await market.topStakeOf(keywordId)).staker).to.equal(
      exited.address,
    );
    await market
      .connect(operator)
      .chargeStake(
        keywordId,
        exited.address,
        2n,
        5n,
        ethers.id("drained-singleton"),
      );
    expect(await market.topStakeOf(keywordId)).to.deep.equal([
      ethers.ZeroAddress,
      0n,
      0n,
      0n,
      0n,
    ]);
  });

  it("accepts any positive bid and rejects zero values or underfunded positions", async () => {
    const { operator, alice, market, keywordId } = await deploy(
      undefined,
      pre("3"),
    );
    await expect(
      stake(market, alice, keywordId, 0n, bid(1)),
    ).to.be.revertedWithCustomError(market, "StakeBelowMinimum");
    await expect(
      stake(market, alice, keywordId, pre("2"), 0n),
    ).to.be.revertedWithCustomError(market, "ZeroAmount");
    await expect(
      stake(market, alice, keywordId, pre("2"), bid(1)),
    ).to.be.revertedWithCustomError(market, "StakeBelowMinimum");

    await stake(market, alice, keywordId, pre("3"), bid(1));
    await expect(stake(market, alice, keywordId, 0n, bid(2)))
      .to.emit(market, "BidUpdated")
      .withArgs(keywordId, alice.address, bid(1), bid(2));
  });

  it("applies minimum changes only to new positions, including a reopened zeroed position", async () => {
    const { owner, operator, alice, bob, market, keywordId } = await deploy();
    await stake(market, alice, keywordId, pre("2"), bid(1));
    await market.connect(owner).setMinimumStake(pre("10"));
    await stake(market, alice, keywordId, pre("1"), bid(2));
    await expect(
      stake(market, bob, keywordId, pre("2"), bid(1)),
    ).to.be.revertedWithCustomError(market, "StakeBelowMinimum");
    await market
      .connect(operator)
      .chargeStake(
        keywordId,
        alice.address,
        1n,
        pre("3"),
        ethers.id("zero-alice"),
      );
    await expect(
      stake(market, alice, keywordId, pre("2"), bid(1)),
    ).to.be.revertedWithCustomError(market, "StakeBelowMinimum");
    await stake(market, alice, keywordId, pre("10"), bid(1));
    expect(
      (await market.stakeDetailsOf(keywordId, alice.address)).positionVersion,
    ).to.equal(2n);
  });

  it("deactivates on withdrawal request, holds PRE for 24 hours and permits a paused claim", async () => {
    const { owner, operator, alice, bob, market, keywordId } = await deploy();
    await stake(market, alice, keywordId, pre("10"), bid(4));
    await stake(market, bob, keywordId, pre("10"), bid(2));
    await expect(
      market.connect(alice).unstake(keywordId),
    ).to.be.revertedWithCustomError(market, "UnstakeNotRequested");
    await expect(market.connect(alice).requestUnstake(keywordId)).to.emit(
      market,
      "UnstakeRequested",
    );
    expect((await market.topStakeOf(keywordId)).staker).to.equal(bob.address);
    const details = await market.stakeDetailsOf(keywordId, alice.address);
    expect(details.eligible).to.equal(false);
    await expect(
      market.connect(alice).requestUnstake(keywordId),
    ).to.be.revertedWithCustomError(market, "UnstakeAlreadyRequested");
    await expect(
      stake(market, alice, keywordId, pre("1"), bid(5)),
    ).to.be.revertedWithCustomError(market, "UnstakePending");
    await expect(
      market.connect(alice).unstake(keywordId),
    ).to.be.revertedWithCustomError(market, "UnstakeNotReady");
    await market.connect(owner).pause();
    await advanceTo(details.withdrawAvailableAt);
    await expect(market.connect(alice).unstake(keywordId))
      .to.emit(market, "Unstaked")
      .withArgs(keywordId, alice.address, pre("10"));
    expect(await market.positionOf(keywordId, alice.address)).to.equal(0n);
    expect(
      (await market.stakeDetailsOf(keywordId, alice.address)).positionVersion,
    ).to.equal(1n);
  });

  it("charges while paused, caps to balance, ignores duplicate IDs and accrues only actual PRE", async () => {
    const {
      owner,
      operator,
      alice,
      bob,
      stranger,
      payment,
      market,
      keywordId,
    } = await deploy();
    await stake(market, alice, keywordId, pre("10"), bid(3));
    await stake(market, bob, keywordId, pre("10"), bid(2));
    await market.connect(owner).pause();
    await expect(
      stake(market, alice, keywordId, pre("1"), bid(3)),
    ).to.be.revertedWithCustomError(market, "EnforcedPause");
    const firstId = ethers.id("click-batch-1");
    await expect(
      market
        .connect(operator)
        .chargeStake(keywordId, alice.address, 1n, pre("7"), firstId),
    )
      .to.emit(market, "StakeCharged")
      .withArgs(
        keywordId,
        alice.address,
        firstId,
        pre("7"),
        pre("7"),
        pre("3"),
      );
    expect((await market.topStakeOf(keywordId)).staker).to.equal(alice.address);
    expect(
      await market
        .connect(operator)
        .chargeStake.staticCall(
          keywordId,
          alice.address,
          1n,
          pre("7"),
          firstId,
        ),
    ).to.equal(0n);
    await market
      .connect(operator)
      .chargeStake(keywordId, alice.address, 1n, pre("7"), firstId);
    const secondId = ethers.id("click-batch-2");
    await expect(
      market
        .connect(stranger)
        .chargeStake(keywordId, alice.address, 1n, pre("100"), secondId),
    ).to.be.revertedWithCustomError(market, "UnauthorizedOperator");
    await market
      .connect(operator)
      .chargeStake(keywordId, alice.address, 1n, pre("100"), secondId);
    expect(await market.positionOf(keywordId, alice.address)).to.equal(0n);
    expect(await market.totalStaked()).to.equal(pre("10"));
    expect(await market.accruedFees()).to.equal(pre("10"));
    expect(await payment!.balanceOf(await market.getAddress())).to.equal(
      pre("20"),
    );
    await expect(
      market.connect(stranger).withdrawAccrued(stranger.address, pre("1")),
    ).to.be.revertedWithCustomError(market, "OwnableUnauthorizedAccount");
    await expect(
      market.connect(owner).withdrawAccrued(owner.address, pre("11")),
    ).to.be.revertedWithCustomError(market, "InsufficientAccruedFees");
    await market.connect(owner).withdrawAccrued(owner.address, pre("10"));
    expect(await payment!.balanceOf(await market.getAddress())).to.equal(
      pre("10"),
    );
    expect(await market.accruedFees()).to.equal(0n);
  });

  it("rejects stale charges after a zeroed position reopens", async () => {
    const { operator, alice, market, keywordId } = await deploy();
    await stake(market, alice, keywordId, pre("2"), bid(1));
    await market
      .connect(operator)
      .chargeStake(keywordId, alice.address, 1n, pre("2"), ethers.id("old"));
    await stake(market, alice, keywordId, pre("3"), bid(1));
    await expect(
      market
        .connect(operator)
        .chargeStake(
          keywordId,
          alice.address,
          1n,
          pre("1"),
          ethers.id("late-old"),
        ),
    )
      .to.be.revertedWithCustomError(market, "PositionVersionMismatch")
      .withArgs(1n, 2n);
    expect(await market.positionOf(keywordId, alice.address)).to.equal(
      pre("3"),
    );
  });

  it("rejects fee-on-transfer deposits and rolls position state back", async () => {
    const signers = await ethers.getSigners();
    const owner = signers[0]!;
    const operator = signers[1]!;
    const alice = signers[2]!;
    const Token = await ethers.getContractFactory("MockRestrictedERC20");
    const payment = (await Token.deploy(
      "Restricted PRE",
      "rPRE",
      18,
    )) as unknown as MockRestrictedERC20;
    const { market, keywordId } = await deploy(await payment.getAddress(), 1n);
    await payment.mint(alice.address, 100n);
    await payment.connect(alice).approve(await market.getAddress(), 100n);
    await payment.setTransferFee(1n, owner.address);
    await expect(
      stake(market, alice, keywordId, 10n, bid(1)),
    ).to.be.revertedWithCustomError(market, "TransferAmountMismatch");
    expect(await market.totalStaked()).to.equal(0n);
    expect(await market.stakeDetailsOf(keywordId, alice.address)).to.deep.equal([
      0n,
      0n,
      0n,
      false,
      0n,
      0n,
    ]);
  });

  it("rolls back inbound reentrancy and failed outbound withdrawals", async () => {
    const signers = await ethers.getSigners();
    const owner = signers[0]!;
    const operator = signers[1]!;
    const alice = signers[2]!;
    const Reentrant = await ethers.getContractFactory("MockReentrantERC20");
    const payment = (await Reentrant.deploy()) as unknown as MockReentrantERC20;
    const { market, keywordId } = await deploy(await payment.getAddress(), 1n);
    await payment.mint(alice.address, 100n);
    await payment.connect(alice).approve(await market.getAddress(), 100n);
    await payment.configureCall(
      await market.getAddress(),
      market.interface.encodeFunctionData("stake", [keywordId, 1n, bid(1)]),
    );
    await expect(
      stake(market, alice, keywordId, 10n, bid(1)),
    ).to.be.revertedWithCustomError(market, "ReentrancyGuardReentrantCall");
    expect(await market.positionOf(keywordId, alice.address)).to.equal(0n);
    await payment.configureCall(ethers.ZeroAddress, "0x");
    await stake(market, alice, keywordId, 10n, bid(1));
    await market.connect(alice).requestUnstake(keywordId);
    const details = await market.stakeDetailsOf(keywordId, alice.address);
    await advanceTo(details.withdrawAvailableAt);
    await payment.configureCall(
      await market.getAddress(),
      market.interface.encodeFunctionData("unstake", [keywordId]),
    );
    await expect(
      market.connect(alice).unstake(keywordId),
    ).to.be.revertedWithCustomError(market, "ReentrancyGuardReentrantCall");
    expect(await market.positionOf(keywordId, alice.address)).to.equal(10n);
    expect(await market.totalStaked()).to.equal(10n);
    await payment.configureCall(ethers.ZeroAddress, "0x");
    await market.connect(alice).unstake(keywordId);
    expect(await payment.balanceOf(await market.getAddress())).to.equal(0n);
    expect(await market.owner()).to.equal(owner.address);
  });

  it("lets the Safe revoke the operator and cannot renounce ownership", async () => {
    const { owner, operator, alice, market, keywordId } = await deploy();
    await stake(market, alice, keywordId, pre("2"), bid(1));
    await market.connect(owner).setOperator(ethers.ZeroAddress);
    await expect(
      market
        .connect(operator)
        .chargeStake(
          keywordId,
          alice.address,
          1n,
          pre("1"),
          ethers.id("revoked"),
        ),
    ).to.be.revertedWithCustomError(market, "UnauthorizedOperator");
    await expect(
      market.connect(owner).renounceOwnership(),
    ).to.be.revertedWithCustomError(market, "OwnershipRenunciationDisabled");
  });
});
