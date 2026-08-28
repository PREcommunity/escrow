import { expect } from "chai";
import fc from "fast-check";
import { readFileSync } from "node:fs";
import { ethers, hardhatConnection, hardhatRuntime } from "../scripts/lib/hardhat-runtime";
import type {
  MockERC20,
  MockReentrantERC20,
  PREcommunityEscrowV1,
  PREcommunityEscrowV1Harness,
} from "../typechain-types";

const PAYOUT_ALL = 0n;
const ROLL_OVER = 1n;
const DAY = 24n * 60n * 60n;

type MonthlyScheduleVector = {
  boundary: string;
  settlementDay: number;
  expected: string;
};

const monthlyScheduleVectors = JSON.parse(
  readFileSync(
    new URL("./fixtures/monthly-schedule-vectors.json", import.meta.url),
    "utf8",
  ),
) as MonthlyScheduleVector[];

function unix(iso: string): bigint {
  return BigInt(Math.floor(Date.parse(iso) / 1000));
}

function addUtcMonths(
  timestamp: bigint,
  months: number,
  settlementDay?: number,
): bigint {
  const date = new Date(Number(timestamp) * 1000);
  const targetMonthStart = new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + months, 1),
  );
  const targetYear = targetMonthStart.getUTCFullYear();
  const targetMonth = targetMonthStart.getUTCMonth();
  const lastDay = new Date(
    Date.UTC(targetYear, targetMonth + 1, 0),
  ).getUTCDate();
  const day = Math.min(settlementDay ?? date.getUTCDate(), lastDay);
  return BigInt(Date.UTC(targetYear, targetMonth, day) / 1000);
}

function expectedDefaultFirstSettlement(timestamp: number): bigint {
  const date = new Date(timestamp * 1000);
  return addUtcMonths(BigInt(timestamp), 1, date.getUTCDate());
}

async function setNextTimestamp(timestamp: bigint): Promise<void> {
  await ethers.provider.send("evm_setNextBlockTimestamp", [Number(timestamp)]);
}

describe("PREcommunityEscrowV1 monthly goals", () => {
  async function monthlyFixture(
    policy = ROLL_OVER,
    preTarget = 100n,
    usdcTarget = 100_000_000n,
  ) {
    const signers = await ethers.getSigners();
    const owner = signers[0]!;
    const sponsor = signers[1]!;
    const recipient = signers[2]!;
    const treasury = signers[3]!;
    const stranger = signers[4]!;
    const creator = signers[5]!;
    const otherManager = signers[6]!;
    const alternatePayout = signers[7]!;

    const Token = await ethers.getContractFactory("MockERC20");
    const pre = (await Token.deploy(
      "Presearch",
      "PRE",
      18,
    )) as unknown as MockERC20;
    const usdc = (await Token.deploy(
      "USD Coin",
      "USDC",
      6,
    )) as unknown as MockERC20;
    const Escrow = await ethers.getContractFactory("PREcommunityEscrowV1");
    const escrow = (await Escrow.deploy(
      owner.address,
      await pre.getAddress(),
      await usdc.getAddress(),
      treasury.address,
    )) as unknown as PREcommunityEscrowV1;

    await escrow.setGoalManager(creator.address, true);
    const goalId = ethers.id(
      `monthly-${policy}-${preTarget}-${usdcTarget}-${await ethers.provider.getBlockNumber()}`,
    );
    const creation = await escrow
      .connect(creator)
      .createMonthlyGoal(
        goalId,
        recipient.address,
        preTarget,
        usdcTarget,
        0n,
        policy,
        "Monthly public infrastructure",
        "Recurring community operations.",
        "ipfs://monthly-goal",
      );
    const creationReceipt = await creation.wait();
    const creationBlock = await ethers.provider.getBlock(
      creationReceipt!.blockNumber,
    );

    await pre.mint(sponsor.address, ethers.parseEther("1000000"));
    await usdc.mint(sponsor.address, 1_000_000_000_000n);
    await pre
      .connect(sponsor)
      .approve(await escrow.getAddress(), ethers.MaxUint256);
    await usdc
      .connect(sponsor)
      .approve(await escrow.getAddress(), ethers.MaxUint256);

    return {
      owner,
      sponsor,
      recipient,
      treasury,
      stranger,
      creator,
      otherManager,
      alternatePayout,
      pre,
      usdc,
      escrow,
      goalId,
      creation,
      creationTimestamp: creationBlock!.timestamp,
    };
  }

  it("matches the shared Solidity and TypeScript monthly schedule golden vectors", async () => {
    const [owner, treasury] = await ethers.getSigners();
    const Token = await ethers.getContractFactory("MockERC20");
    const pre = (await Token.deploy(
      "Presearch",
      "PRE",
      18,
    )) as unknown as MockERC20;
    const usdc = (await Token.deploy(
      "USD Coin",
      "USDC",
      6,
    )) as unknown as MockERC20;
    const Harness = await ethers.getContractFactory(
      "PREcommunityEscrowV1Harness",
    );
    const calendar = (await Harness.deploy(
      owner!.address,
      await pre.getAddress(),
      await usdc.getAddress(),
      treasury!.address,
    )) as unknown as PREcommunityEscrowV1Harness;

    for (const vector of monthlyScheduleVectors) {
      expect(
        await calendar.nextMonthlySettlement(
          unix(vector.boundary),
          vector.settlementDay,
        ),
        `${vector.boundary} with anchor ${vector.settlementDay}`,
      ).to.equal(unix(vector.expected));
    }
  });

  it("starts immediately with a stable default settlement day", async () => {
    const {
      sponsor,
      recipient,
      pre,
      escrow,
      goalId,
      creation,
      creationTimestamp,
    } = await monthlyFixture();
    const goal = await escrow.goal(goalId);
    const monthly = await escrow.monthlyGoal(goalId);
    const expectedStart = BigInt(creationTimestamp);
    const expectedEnd = expectedDefaultFirstSettlement(creationTimestamp);
    const expectedDay = BigInt(new Date(creationTimestamp * 1000).getUTCDate());

    await expect(creation)
      .to.emit(escrow, "MonthlyGoalCreated")
      .withArgs(goalId, expectedStart, expectedEnd, expectedDay, ROLL_OVER);

    expect(goal.goalType).to.equal(1n);
    expect(goal.status).to.equal(1n);
    expect(monthly.periodStart).to.equal(expectedStart);
    expect(goal.deadline).to.equal(expectedEnd);
    expect(monthly.settlementDay).to.equal(expectedDay);
    expect(monthly.periodsSettled).to.equal(0n);
    expect(monthly.surplusPolicy).to.equal(ROLL_OVER);
    expect(monthly.stopRequested).to.equal(false);

    await expect(
      escrow
        .connect(sponsor)
        .contribute(goalId, await pre.getAddress(), 1n, false),
    ).to.emit(escrow, "ContributionReceived");
    await expect(escrow.settleMonthlyGoal(goalId, 1))
      .to.be.revertedWithCustomError(escrow, "MonthlyPeriodNotEnded")
      .withArgs(goal.deadline);

    const oneTime = ethers.id("monthly-getter-one-time");
    await escrow.createGoal(
      oneTime,
      recipient.address,
      1n,
      0n,
      goal.deadline,
      "One time",
      "",
      "",
    );
    await expect(escrow.monthlyGoal(oneTime))
      .to.be.revertedWithCustomError(escrow, "InvalidGoalType")
      .withArgs(1n, 0n);
    await expect(
      escrow.monthlyGoal(ethers.id("missing-monthly")),
    ).to.be.revertedWithCustomError(escrow, "InvalidGoal");
    await expect(
      escrow.releaseExpense(
        ethers.id("missing-monthly"),
        await pre.getAddress(),
        1n,
      ),
    ).to.be.revertedWithCustomError(escrow, "InvalidGoal");
    await expect(escrow.closeGoal(goalId))
      .to.be.revertedWithCustomError(escrow, "InvalidGoalType")
      .withArgs(0n, 1n);
    await expect(escrow.connect(recipient).cancelGoal(goalId))
      .to.be.revertedWithCustomError(escrow, "UnauthorizedGoalManager")
      .withArgs(recipient.address);
  });

  it("accepts UTC-midnight overrides at the exact 7-day and 60-day boundaries", async () => {
    const { owner, recipient, escrow } = await monthlyFixture();
    expect(await escrow.MONTHLY_SCHEDULE_VERSION()).to.equal(1n);
    expect(await escrow.MIN_FIRST_SETTLEMENT_DELAY()).to.equal(7n * DAY);
    expect(await escrow.MAX_FIRST_SETTLEMENT_DELAY()).to.equal(60n * DAY);

    const latestBlock = await ethers.provider.getBlock("latest");
    const firstCreationAt = (BigInt(latestBlock!.timestamp) / DAY + 1n) * DAY;
    const minimum = firstCreationAt + 7n * DAY;
    await setNextTimestamp(firstCreationAt);
    const minimumGoal = ethers.id("minimum-first-settlement");
    await expect(
      escrow
        .connect(owner)
        .createMonthlyGoal(
          minimumGoal,
          recipient.address,
          100n,
          0n,
          minimum,
          ROLL_OVER,
          "Minimum override",
          "",
          "",
        ),
    )
      .to.emit(escrow, "MonthlyGoalCreated")
      .withArgs(
        minimumGoal,
        firstCreationAt,
        minimum,
        BigInt(new Date(Number(minimum) * 1000).getUTCDate()),
        ROLL_OVER,
      );

    const secondCreationAt = firstCreationAt + DAY;
    const maximum = secondCreationAt + 60n * DAY;
    await setNextTimestamp(secondCreationAt);
    const maximumGoal = ethers.id("maximum-first-settlement");
    await expect(
      escrow
        .connect(owner)
        .createMonthlyGoal(
          maximumGoal,
          recipient.address,
          100n,
          0n,
          maximum,
          ROLL_OVER,
          "Maximum override",
          "",
          "",
        ),
    ).to.emit(escrow, "MonthlyGoalCreated");

    const lowerCreationAt = secondCreationAt + DAY;
    const tooEarly = lowerCreationAt + 7n * DAY - 1n;
    await setNextTimestamp(lowerCreationAt);
    await expect(
      escrow
        .connect(owner)
        .createMonthlyGoal(
          ethers.id("early-first-settlement"),
          recipient.address,
          100n,
          0n,
          tooEarly,
          ROLL_OVER,
          "Early override",
          "",
          "",
        ),
    )
      .to.be.revertedWithCustomError(escrow, "FirstSettlementOutOfRange")
      .withArgs(
        tooEarly,
        lowerCreationAt + 7n * DAY,
        lowerCreationAt + 60n * DAY,
      );

    const upperCreationAt = lowerCreationAt + DAY;
    const tooLate = upperCreationAt + 61n * DAY;
    await setNextTimestamp(upperCreationAt);
    await expect(
      escrow
        .connect(owner)
        .createMonthlyGoal(
          ethers.id("late-first-settlement"),
          recipient.address,
          100n,
          0n,
          tooLate,
          ROLL_OVER,
          "Late override",
          "",
          "",
        ),
    )
      .to.be.revertedWithCustomError(escrow, "FirstSettlementOutOfRange")
      .withArgs(
        tooLate,
        upperCreationAt + 7n * DAY,
        upperCreationAt + 60n * DAY,
      );

    const nonMidnightCreationAt = upperCreationAt + DAY;
    const nonMidnight = nonMidnightCreationAt + 8n * DAY + 1n;
    await setNextTimestamp(nonMidnightCreationAt);
    await expect(
      escrow
        .connect(owner)
        .createMonthlyGoal(
          ethers.id("non-midnight-first-settlement"),
          recipient.address,
          100n,
          0n,
          nonMidnight,
          ROLL_OVER,
          "Non-midnight override",
          "",
          "",
        ),
    )
      .to.be.revertedWithCustomError(escrow, "FirstSettlementNotUtcMidnight")
      .withArgs(nonMidnight);
  });

  it("uses the full monthly target for a seven-day first period", async () => {
    const { owner, sponsor, recipient, pre, escrow } = await monthlyFixture(
      ROLL_OVER,
      100n,
      0n,
    );
    const latestBlock = await ethers.provider.getBlock("latest");
    const creationAt = (BigInt(latestBlock!.timestamp) / DAY + 1n) * DAY;
    const firstSettlementAt = creationAt + 7n * DAY;
    const goalId = ethers.id("short-full-target-period");
    await setNextTimestamp(creationAt);
    await escrow
      .connect(owner)
      .createMonthlyGoal(
        goalId,
        recipient.address,
        100n,
        0n,
        firstSettlementAt,
        ROLL_OVER,
        "Short first period",
        "",
        "",
      );

    await escrow
      .connect(sponsor)
      .contribute(goalId, await pre.getAddress(), 140n, false);
    await setNextTimestamp(firstSettlementAt);
    await escrow.settleMonthlyGoal(goalId, 1);
    const goal = await escrow.goal(goalId);
    const monthly = await escrow.monthlyGoal(goalId);
    expect(goal.preRecipientEntitlement).to.equal(100n);
    expect(monthly.preCarry).to.equal(40n);
  });

  it("makes every token contributed in PayoutAll claimable without transferring during settlement", async () => {
    const {
      sponsor,
      recipient,
      stranger,
      alternatePayout,
      pre,
      usdc,
      escrow,
      goalId,
    } = await monthlyFixture(PAYOUT_ALL);
    const tokenAddress = await pre.getAddress();
    const usdcAddress = await usdc.getAddress();
    await escrow.connect(sponsor).contribute(goalId, tokenAddress, 140n, true);
    await escrow
      .connect(sponsor)
      .contribute(goalId, usdcAddress, 150_000_000n, false);
    const periodStart = (await escrow.monthlyGoal(goalId)).periodStart;
    const deadline = (await escrow.goal(goalId)).deadline;
    await setNextTimestamp(deadline);

    const settlement = await escrow
      .connect(stranger)
      .settleMonthlyGoal(goalId, 1);
    await expect(settlement)
      .to.emit(escrow, "MonthlyPeriodSettled")
      .withArgs(goalId, 1n, periodStart, deadline, PAYOUT_ALL, false);
    await expect(settlement)
      .to.emit(escrow, "MonthlyTokenSettled")
      .withArgs(goalId, 1n, tokenAddress, 140n, 0n, 140n, 0n);
    await expect(settlement)
      .to.emit(escrow, "MonthlyTokenSettled")
      .withArgs(goalId, 1n, usdcAddress, 150_000_000n, 0n, 150_000_000n, 0n);

    const goal = await escrow.goal(goalId);
    const monthly = await escrow.monthlyGoal(goalId);
    expect(goal.preRecipientEntitlement).to.equal(140n);
    expect(goal.usdcRecipientEntitlement).to.equal(150_000_000n);
    expect(monthly.preCarry).to.equal(0n);
    expect(monthly.usdcCarry).to.equal(0n);
    expect(await pre.balanceOf(recipient.address)).to.equal(0n);
    expect(await escrow.accountedByToken(tokenAddress)).to.equal(140n);
    expect(await escrow.accountedByToken(usdcAddress)).to.equal(150_000_000n);

    await expect(
      escrow.connect(stranger).releaseExpense(goalId, tokenAddress, 1n),
    ).to.be.revertedWithCustomError(escrow, "UnauthorizedRelease");
    await escrow
      .connect(recipient)
      .setGoalPayout(goalId, alternatePayout.address);
    await escrow.connect(recipient).releaseExpense(goalId, tokenAddress, 140n);
    await escrow.releaseExpense(goalId, usdcAddress, 150_000_000n);
    expect(await pre.balanceOf(alternatePayout.address)).to.equal(140n);
    expect(await usdc.balanceOf(alternatePayout.address)).to.equal(
      150_000_000n,
    );
    expect(await escrow.accountedByToken(tokenAddress)).to.equal(0n);
    expect(await escrow.accountedByToken(usdcAddress)).to.equal(0n);
  });

  it("rolls only over-target funds forward and resets an underfunded month", async () => {
    const { sponsor, pre, usdc, escrow, goalId } =
      await monthlyFixture(ROLL_OVER);
    const tokenAddress = await pre.getAddress();
    const usdcAddress = await usdc.getAddress();
    await escrow.connect(sponsor).contribute(goalId, tokenAddress, 140n, false);
    await escrow
      .connect(sponsor)
      .contribute(goalId, usdcAddress, 50_000_000n, false);

    let deadline = (await escrow.goal(goalId)).deadline;
    await setNextTimestamp(deadline);
    await escrow.settleMonthlyGoal(goalId, 1);
    let goal = await escrow.goal(goalId);
    let monthly = await escrow.monthlyGoal(goalId);
    expect(goal.preRecipientEntitlement).to.equal(100n);
    expect(goal.usdcRecipientEntitlement).to.equal(50_000_000n);
    expect(monthly.preCarry).to.equal(40n);
    expect(monthly.usdcCarry).to.equal(0n);

    await escrow.connect(sponsor).contribute(goalId, tokenAddress, 70n, false);
    deadline = (await escrow.goal(goalId)).deadline;
    await setNextTimestamp(deadline);
    await escrow.settleMonthlyGoal(goalId, 1);
    goal = await escrow.goal(goalId);
    monthly = await escrow.monthlyGoal(goalId);
    expect(goal.preRecipientEntitlement).to.equal(200n);
    expect(monthly.preCarry).to.equal(10n);

    deadline = goal.deadline;
    await setNextTimestamp(deadline);
    await escrow.settleMonthlyGoal(goalId, 1);
    goal = await escrow.goal(goalId);
    monthly = await escrow.monthlyGoal(goalId);
    expect(goal.preRecipientEntitlement).to.equal(210n);
    expect(monthly.preCarry).to.equal(0n);
    expect(goal.preContributed).to.equal(210n);
    expect(goal.preContributed).to.equal(
      goal.preRecipientEntitlement +
        monthly.preCarry +
        monthly.preCurrentContributed,
    );
  });

  it("rebuilds a three-period RollOver ledger from settlement events", async () => {
    const { sponsor, pre, usdc, escrow, goalId } =
      await monthlyFixture(ROLL_OVER);
    const preAddress = await pre.getAddress();
    const usdcAddress = await usdc.getAddress();
    const period0 = (await escrow.monthlyGoal(goalId)).periodStart;
    const period1 = addUtcMonths(period0, 1);
    const period2 = addUtcMonths(period0, 2);
    const period3 = addUtcMonths(period0, 3);

    await escrow.connect(sponsor).contribute(goalId, preAddress, 140n, false);
    await escrow
      .connect(sponsor)
      .contribute(goalId, usdcAddress, 50_000_000n, false);
    await setNextTimestamp(period1);
    await escrow.settleMonthlyGoal(goalId, 1);

    await escrow.connect(sponsor).contribute(goalId, preAddress, 70n, false);
    await escrow
      .connect(sponsor)
      .contribute(goalId, usdcAddress, 200_000_000n, false);
    await setNextTimestamp(period2);
    await escrow.settleMonthlyGoal(goalId, 1);

    await setNextTimestamp(period3);
    await escrow.settleMonthlyGoal(goalId, 1);

    const periodEvents = await escrow.queryFilter(
      escrow.filters.MonthlyPeriodSettled(goalId),
    );
    expect(
      periodEvents.map(({ args }) => [
        args.goalId,
        args.periodIndex,
        args.periodStart,
        args.periodEnd,
        args.surplusPolicy,
        args.finalPeriod,
      ]),
    ).to.deep.equal([
      [goalId, 1n, period0, period1, ROLL_OVER, false],
      [goalId, 2n, period1, period2, ROLL_OVER, false],
      [goalId, 3n, period2, period3, ROLL_OVER, false],
    ]);

    const tokenEvents = await escrow.queryFilter(
      escrow.filters.MonthlyTokenSettled(goalId),
    );
    expect(
      tokenEvents.map(({ args }) => [
        args.goalId,
        args.periodIndex,
        args.token,
        args.periodContributed,
        args.carryIn,
        args.recipientEntitlementAdded,
        args.carryOut,
      ]),
    ).to.deep.equal([
      [goalId, 1n, preAddress, 140n, 0n, 100n, 40n],
      [goalId, 1n, usdcAddress, 50_000_000n, 0n, 50_000_000n, 0n],
      [goalId, 2n, preAddress, 70n, 40n, 100n, 10n],
      [goalId, 2n, usdcAddress, 200_000_000n, 0n, 100_000_000n, 100_000_000n],
      [goalId, 3n, preAddress, 0n, 10n, 10n, 0n],
      [goalId, 3n, usdcAddress, 0n, 100_000_000n, 100_000_000n, 0n],
    ]);

    const replay = new Map<
      string,
      { contributed: bigint; entitlement: bigint; carry: bigint }
    >([
      [
        preAddress.toLowerCase(),
        { contributed: 0n, entitlement: 0n, carry: 0n },
      ],
      [
        usdcAddress.toLowerCase(),
        { contributed: 0n, entitlement: 0n, carry: 0n },
      ],
    ]);
    for (const { args } of tokenEvents) {
      const ledger = replay.get(args.token.toLowerCase());
      if (ledger === undefined)
        throw new Error(`Unexpected token event: ${args.token}`);
      expect(args.carryIn).to.equal(ledger.carry);
      expect(args.periodContributed + args.carryIn).to.equal(
        args.recipientEntitlementAdded + args.carryOut,
      );
      ledger.contributed += args.periodContributed;
      ledger.entitlement += args.recipientEntitlementAdded;
      ledger.carry = args.carryOut;
    }

    const goal = await escrow.goal(goalId);
    const monthly = await escrow.monthlyGoal(goalId);
    const replayedPre = replay.get(preAddress.toLowerCase())!;
    const replayedUsdc = replay.get(usdcAddress.toLowerCase())!;
    expect(goal.preContributed).to.equal(replayedPre.contributed);
    expect(goal.preRecipientEntitlement).to.equal(replayedPre.entitlement);
    expect(monthly.preCarry).to.equal(replayedPre.carry);
    expect(goal.usdcContributed).to.equal(replayedUsdc.contributed);
    expect(goal.usdcRecipientEntitlement).to.equal(replayedUsdc.entitlement);
    expect(monthly.usdcCarry).to.equal(replayedUsdc.carry);
    expect(monthly.periodsSettled).to.equal(3n);
    expect(monthly.preCurrentContributed).to.equal(0n);
    expect(monthly.usdcCurrentContributed).to.equal(0n);
  });

  it("lets only the active creator or owner change policy and preserves funds across both transitions", async () => {
    const {
      owner,
      sponsor,
      recipient,
      creator,
      otherManager,
      pre,
      usdc,
      escrow,
      goalId,
    } = await monthlyFixture(ROLL_OVER, 100n, 50_000_000n);
    const preAddress = await pre.getAddress();
    const usdcAddress = await usdc.getAddress();
    const escrowAddress = await escrow.getAddress();
    await escrow.setGoalManager(otherManager.address, true);
    await escrow.connect(sponsor).contribute(goalId, preAddress, 140n, false);
    await escrow
      .connect(sponsor)
      .contribute(goalId, usdcAddress, 130_000_000n, false);
    await setNextTimestamp((await escrow.goal(goalId)).deadline);
    await escrow.settleMonthlyGoal(goalId, 1);
    await escrow.connect(recipient).releaseExpense(goalId, preAddress, 30n);
    await escrow
      .connect(recipient)
      .releaseExpense(goalId, usdcAddress, 10_000_000n);
    expect((await escrow.monthlyGoal(goalId)).preCarry).to.equal(40n);
    expect((await escrow.monthlyGoal(goalId)).usdcCarry).to.equal(80_000_000n);

    await expect(
      escrow.connect(otherManager).setMonthlySurplusPolicy(goalId, PAYOUT_ALL),
    )
      .to.be.revertedWithCustomError(escrow, "UnauthorizedGoalController")
      .withArgs(goalId, otherManager.address);
    await escrow.setGoalManager(creator.address, false);
    await expect(
      escrow.connect(creator).setMonthlySurplusPolicy(goalId, PAYOUT_ALL),
    )
      .to.be.revertedWithCustomError(escrow, "UnauthorizedGoalManager")
      .withArgs(creator.address);
    await expect(
      escrow.connect(owner).setMonthlySurplusPolicy(goalId, PAYOUT_ALL),
    )
      .to.emit(escrow, "MonthlySurplusPolicyUpdated")
      .withArgs(goalId, ROLL_OVER, PAYOUT_ALL);
    await escrow.connect(sponsor).contribute(goalId, preAddress, 70n, false);
    await escrow
      .connect(sponsor)
      .contribute(goalId, usdcAddress, 20_000_000n, false);

    const deadline = (await escrow.goal(goalId)).deadline;
    await setNextTimestamp(deadline);
    await expect(escrow.setMonthlySurplusPolicy(goalId, ROLL_OVER))
      .to.be.revertedWithCustomError(escrow, "MonthlySettlementRequired")
      .withArgs(deadline);
    const payoutAllSettlement = await escrow.settleMonthlyGoal(goalId, 1);
    await expect(payoutAllSettlement)
      .to.emit(escrow, "MonthlyTokenSettled")
      .withArgs(goalId, 2n, preAddress, 70n, 40n, 110n, 0n);
    await expect(payoutAllSettlement)
      .to.emit(escrow, "MonthlyTokenSettled")
      .withArgs(
        goalId,
        2n,
        usdcAddress,
        20_000_000n,
        80_000_000n,
        100_000_000n,
        0n,
      );
    let goal = await escrow.goal(goalId);
    let monthly = await escrow.monthlyGoal(goalId);
    expect(goal.preRecipientEntitlement).to.equal(210n);
    expect(goal.usdcRecipientEntitlement).to.equal(150_000_000n);
    expect(goal.preReleasedExpense).to.equal(30n);
    expect(goal.usdcReleasedExpense).to.equal(10_000_000n);
    expect(monthly.preCarry).to.equal(0n);
    expect(monthly.usdcCarry).to.equal(0n);
    expect(await escrow.accountedByToken(preAddress)).to.equal(180n);
    expect(await escrow.accountedByToken(usdcAddress)).to.equal(140_000_000n);

    await escrow.setGoalManager(creator.address, true);
    await expect(
      escrow.connect(creator).setMonthlySurplusPolicy(goalId, ROLL_OVER),
    )
      .to.emit(escrow, "MonthlySurplusPolicyUpdated")
      .withArgs(goalId, PAYOUT_ALL, ROLL_OVER);
    await escrow.connect(sponsor).contribute(goalId, preAddress, 160n, false);
    await escrow
      .connect(sponsor)
      .contribute(goalId, usdcAddress, 90_000_000n, false);
    await setNextTimestamp(goal.deadline);
    await escrow.settleMonthlyGoal(goalId, 1);
    goal = await escrow.goal(goalId);
    monthly = await escrow.monthlyGoal(goalId);
    expect(goal.preContributed).to.equal(370n);
    expect(goal.usdcContributed).to.equal(240_000_000n);
    expect(goal.preRecipientEntitlement).to.equal(310n);
    expect(goal.usdcRecipientEntitlement).to.equal(200_000_000n);
    expect(monthly.preCarry).to.equal(60n);
    expect(monthly.usdcCarry).to.equal(40_000_000n);

    await escrow.connect(recipient).releaseExpense(goalId, preAddress, 280n);
    await escrow
      .connect(recipient)
      .releaseExpense(goalId, usdcAddress, 190_000_000n);
    expect(await pre.balanceOf(recipient.address)).to.equal(310n);
    expect(await usdc.balanceOf(recipient.address)).to.equal(200_000_000n);
    expect(await escrow.accountedByToken(preAddress)).to.equal(60n);
    expect(await escrow.accountedByToken(usdcAddress)).to.equal(40_000_000n);
    expect(await pre.balanceOf(escrowAddress)).to.equal(60n);
    expect(await usdc.balanceOf(escrowAddress)).to.equal(40_000_000n);

    await setNextTimestamp(goal.deadline);
    await escrow.settleMonthlyGoal(goalId, 1);
    await escrow.connect(recipient).releaseExpense(goalId, preAddress, 60n);
    await escrow
      .connect(recipient)
      .releaseExpense(goalId, usdcAddress, 40_000_000n);
    goal = await escrow.goal(goalId);
    monthly = await escrow.monthlyGoal(goalId);
    expect(goal.preRecipientEntitlement).to.equal(370n);
    expect(goal.usdcRecipientEntitlement).to.equal(240_000_000n);
    expect(goal.preReleasedExpense).to.equal(370n);
    expect(goal.usdcReleasedExpense).to.equal(240_000_000n);
    expect(monthly.preCarry).to.equal(0n);
    expect(monthly.usdcCarry).to.equal(0n);
    expect(await pre.balanceOf(recipient.address)).to.equal(370n);
    expect(await usdc.balanceOf(recipient.address)).to.equal(240_000_000n);
    expect(await escrow.accountedByToken(preAddress)).to.equal(0n);
    expect(await escrow.accountedByToken(usdcAddress)).to.equal(0n);
    expect(await pre.balanceOf(escrowAddress)).to.equal(0n);
    expect(await usdc.balanceOf(escrowAddress)).to.equal(0n);
  });

  it("settles a permissionless 24-month catch-up below five million gas", async () => {
    const { sponsor, stranger, pre, escrow, goalId } = await monthlyFixture(
      ROLL_OVER,
      100n,
      0n,
    );
    const tokenAddress = await pre.getAddress();
    await escrow
      .connect(sponsor)
      .contribute(goalId, tokenAddress, 3_000n, false);
    const firstDeadline = (await escrow.goal(goalId)).deadline;
    const settlementDay = (await escrow.monthlyGoal(goalId)).settlementDay;
    await setNextTimestamp(
      addUtcMonths(firstDeadline, 24, Number(settlementDay)),
    );

    await expect(escrow.settleMonthlyGoal(goalId, 0))
      .to.be.revertedWithCustomError(escrow, "InvalidSettlementLimit")
      .withArgs(0n, 24n);
    await expect(escrow.settleMonthlyGoal(goalId, 25))
      .to.be.revertedWithCustomError(escrow, "InvalidSettlementLimit")
      .withArgs(25n, 24n);

    const transaction = await escrow
      .connect(stranger)
      .settleMonthlyGoal(goalId, 24);
    const receipt = await transaction.wait();
    expect(receipt!.gasUsed).to.be.lessThan(5_000_000n);
    let goal = await escrow.goal(goalId);
    let monthly = await escrow.monthlyGoal(goalId);
    expect(monthly.periodsSettled).to.equal(24n);
    expect(goal.preRecipientEntitlement).to.equal(2_400n);
    expect(monthly.preCarry).to.equal(600n);
    expect(await escrow.accountedByToken(tokenAddress)).to.equal(3_000n);

    await expect(
      escrow.connect(sponsor).contribute(goalId, tokenAddress, 1n, false),
    )
      .to.be.revertedWithCustomError(escrow, "MonthlySettlementRequired")
      .withArgs(goal.deadline);
    await escrow.connect(stranger).settleMonthlyGoal(goalId, 24);
    goal = await escrow.goal(goalId);
    monthly = await escrow.monthlyGoal(goalId);
    expect(monthly.periodsSettled).to.equal(25n);
    expect(goal.preRecipientEntitlement).to.equal(2_500n);
    expect(monthly.preCarry).to.equal(500n);
  });

  it("keeps day-30 and day-31 anchors when a February catch-up reaches a leap year", async () => {
    // Fix the clock on an isolated chain so the regression never depends on
    // wall-clock time or the months advanced by preceding tests.
    const connection = await hardhatRuntime.network.create({
      override: { initialDate: "2029-01-01T00:00:00Z" },
    });
    const { ethers } = connection;
    const setNextTimestamp = async (timestamp: bigint) => {
      await ethers.provider.send("evm_setNextBlockTimestamp", [Number(timestamp)]);
    };
    try {
      const [owner, sponsor, recipient, treasury, stranger] =
        await ethers.getSigners();
      const Token = await ethers.getContractFactory("MockERC20");
      const pre = (await Token.deploy(
        "Presearch",
        "PRE",
        18,
      )) as unknown as MockERC20;
      const usdc = (await Token.deploy(
        "USD Coin",
        "USDC",
        6,
      )) as unknown as MockERC20;
      const Escrow = await ethers.getContractFactory("PREcommunityEscrowV1");
      const escrow = (await Escrow.deploy(
        owner!.address,
        await pre.getAddress(),
        await usdc.getAddress(),
        treasury!.address,
      )) as unknown as PREcommunityEscrowV1;
      const preAddress = await pre.getAddress();
      await pre.mint(sponsor!.address, 10_000n);
      await pre
        .connect(sponsor!)
        .approve(await escrow.getAddress(), ethers.MaxUint256);
      const goals: { goalId: string; settlementDay: number }[] = [];

      for (const settlementDay of [30, 31]) {
        await setNextTimestamp(unix(`2030-01-${settlementDay}T12:00:00Z`));
        const goalId = ethers.id(`clamped-february-catch-up-${settlementDay}`);
        await escrow.createMonthlyGoal(
          goalId,
          recipient!.address,
          100n,
          0n,
          0n,
          ROLL_OVER,
          `Day ${settlementDay} leap-year catch-up`,
          "",
          "",
        );
        await escrow
          .connect(sponsor!)
          .contribute(goalId, preAddress, 3_000n, false);
        const firstDeadline = (await escrow.goal(goalId)).deadline;
        const storedDay = (await escrow.monthlyGoal(goalId)).settlementDay;
        expect(firstDeadline).to.equal(unix("2030-02-28T00:00:00Z"));
        expect(storedDay).to.equal(BigInt(settlementDay));
        expect(addUtcMonths(firstDeadline, 24, Number(storedDay))).to.equal(
          unix("2032-02-29T00:00:00Z"),
        );
        goals.push({ goalId, settlementDay });
      }

      await setNextTimestamp(unix("2032-02-29T00:00:00Z"));
      for (const { goalId, settlementDay } of goals) {
        await escrow.connect(stranger!).settleMonthlyGoal(goalId, 24);
        let goal = await escrow.goal(goalId);
        let monthly = await escrow.monthlyGoal(goalId);
        expect(monthly.periodsSettled).to.equal(24n);
        expect(goal.preRecipientEntitlement).to.equal(2_400n);
        expect(monthly.preCarry).to.equal(600n);
        expect(goal.deadline).to.equal(unix("2032-02-29T00:00:00Z"));
        await expect(
          escrow.connect(sponsor!).contribute(goalId, preAddress, 1n, false),
        )
          .to.be.revertedWithCustomError(escrow, "MonthlySettlementRequired")
          .withArgs(goal.deadline);
        expect(await escrow.settleMonthlyGoal.staticCall(goalId, 24)).to.equal(
          1n,
        );
        await escrow.connect(stranger!).settleMonthlyGoal(goalId, 24);
        goal = await escrow.goal(goalId);
        monthly = await escrow.monthlyGoal(goalId);
        expect(monthly.periodsSettled).to.equal(25n);
        expect(goal.preRecipientEntitlement).to.equal(2_500n);
        expect(monthly.preCarry).to.equal(500n);
        expect(monthly.settlementDay).to.equal(BigInt(settlementDay));
        expect(goal.deadline).to.equal(
          unix(`2032-03-${settlementDay}T00:00:00Z`),
        );
        await escrow.connect(sponsor!).contribute(goalId, preAddress, 1n, false);
        expect(
          (await escrow.monthlyGoal(goalId)).preCurrentContributed,
        ).to.equal(1n);
      }
    } finally {
      await connection.close();
    }
  });

  it("closes a delayed final period and pays both carries after earlier partial releases", async () => {
    const active = await monthlyFixture(ROLL_OVER, 100n, 50_000_000n);
    const tokenAddress = await active.pre.getAddress();
    const usdcAddress = await active.usdc.getAddress();
    const escrowAddress = await active.escrow.getAddress();
    await active.escrow
      .connect(active.sponsor)
      .contribute(active.goalId, tokenAddress, 250n, false);
    await active.escrow
      .connect(active.sponsor)
      .contribute(active.goalId, usdcAddress, 180_000_000n, false);
    await setNextTimestamp((await active.escrow.goal(active.goalId)).deadline);
    await active.escrow.settleMonthlyGoal(active.goalId, 1);
    await active.escrow
      .connect(active.recipient)
      .releaseExpense(active.goalId, tokenAddress, 40n);
    await active.escrow
      .connect(active.recipient)
      .releaseExpense(active.goalId, usdcAddress, 15_000_000n);
    const monthlyBefore = await active.escrow.monthlyGoal(active.goalId);
    expect(monthlyBefore.preCarry).to.equal(150n);
    expect(monthlyBefore.usdcCarry).to.equal(130_000_000n);
    const activePeriodEnd = (await active.escrow.goal(active.goalId)).deadline;
    const activeStop = await active.escrow
      .connect(active.creator)
      .requestMonthlyGoalStop(active.goalId);
    await expect(activeStop)
      .to.emit(active.escrow, "MonthlyGoalStopRequested")
      .withArgs(active.goalId, activePeriodEnd);
    expect((await active.escrow.goal(active.goalId)).status).to.equal(1n);
    expect(
      (await active.escrow.monthlyGoal(active.goalId)).stopRequested,
    ).to.equal(true);
    await expect(
      active.escrow
        .connect(active.creator)
        .requestMonthlyGoalStop(active.goalId),
    ).to.be.revertedWithCustomError(active.escrow, "MonthlyGoalStopping");
    await expect(
      active.escrow
        .connect(active.creator)
        .setMonthlySurplusPolicy(active.goalId, PAYOUT_ALL),
    ).to.be.revertedWithCustomError(active.escrow, "MonthlyGoalStopping");
    await active.escrow
      .connect(active.sponsor)
      .contribute(active.goalId, tokenAddress, 20n, false);
    await active.escrow
      .connect(active.sponsor)
      .contribute(active.goalId, usdcAddress, 7_000_000n, false);

    await setNextTimestamp(
      addUtcMonths(activePeriodEnd, 5, Number(monthlyBefore.settlementDay)),
    );
    const settlement = await active.escrow
      .connect(active.stranger)
      .settleMonthlyGoal(active.goalId, 24);
    await expect(settlement)
      .to.emit(active.escrow, "MonthlyPeriodSettled")
      .withArgs(
        active.goalId,
        2n,
        monthlyBefore.periodStart,
        activePeriodEnd,
        ROLL_OVER,
        true,
      );
    await expect(settlement)
      .to.emit(active.escrow, "MonthlyTokenSettled")
      .withArgs(active.goalId, 2n, tokenAddress, 20n, 150n, 170n, 0n);
    await expect(settlement)
      .to.emit(active.escrow, "MonthlyTokenSettled")
      .withArgs(
        active.goalId,
        2n,
        usdcAddress,
        7_000_000n,
        130_000_000n,
        137_000_000n,
        0n,
      );
    const receipt = await settlement.wait();
    const periods = await active.escrow.queryFilter(
      active.escrow.filters.MonthlyPeriodSettled(active.goalId),
      receipt!.blockNumber,
      receipt!.blockNumber,
    );
    expect(periods).to.have.lengthOf(1);
    const goal = await active.escrow.goal(active.goalId);
    const monthly = await active.escrow.monthlyGoal(active.goalId);
    expect(goal.status).to.equal(2n);
    expect(goal.preRecipientEntitlement).to.equal(270n);
    expect(goal.usdcRecipientEntitlement).to.equal(187_000_000n);
    expect(goal.preReleasedExpense).to.equal(40n);
    expect(goal.usdcReleasedExpense).to.equal(15_000_000n);
    expect(goal.preTreasuryEntitlement).to.equal(0n);
    expect(goal.usdcTreasuryEntitlement).to.equal(0n);
    expect(monthly.periodsSettled).to.equal(2n);
    expect(monthly.preCarry).to.equal(0n);
    expect(monthly.usdcCarry).to.equal(0n);
    expect(monthly.preCurrentContributed).to.equal(0n);
    expect(monthly.usdcCurrentContributed).to.equal(0n);
    expect(
      await active.escrow.openGoalCountByCreator(active.creator.address),
    ).to.equal(0n);
    expect(await active.escrow.accountedByToken(tokenAddress)).to.equal(230n);
    expect(await active.escrow.accountedByToken(usdcAddress)).to.equal(
      172_000_000n,
    );
    expect(await active.pre.balanceOf(escrowAddress)).to.equal(230n);
    expect(await active.usdc.balanceOf(escrowAddress)).to.equal(172_000_000n);

    await active.escrow
      .connect(active.recipient)
      .releaseExpense(active.goalId, tokenAddress, 230n);
    await active.escrow
      .connect(active.recipient)
      .releaseExpense(active.goalId, usdcAddress, 172_000_000n);
    const claimed = await active.escrow.goal(active.goalId);
    expect(claimed.preReleasedExpense).to.equal(270n);
    expect(claimed.usdcReleasedExpense).to.equal(187_000_000n);
    expect(await active.pre.balanceOf(active.recipient.address)).to.equal(270n);
    expect(await active.usdc.balanceOf(active.recipient.address)).to.equal(
      187_000_000n,
    );
    expect(await active.escrow.accountedByToken(tokenAddress)).to.equal(0n);
    expect(await active.escrow.accountedByToken(usdcAddress)).to.equal(0n);
    expect(await active.pre.balanceOf(escrowAddress)).to.equal(0n);
    expect(await active.usdc.balanceOf(escrowAddress)).to.equal(0n);
    await expect(
      active.escrow.settleMonthlyGoal(active.goalId, 1),
    ).to.be.revertedWithCustomError(active.escrow, "GoalNotOpen");
    await expect(
      active.escrow.setMonthlySurplusPolicy(active.goalId, PAYOUT_ALL),
    ).to.be.revertedWithCustomError(active.escrow, "GoalNotOpen");
    await expect(
      active.escrow.requestMonthlyGoalStop(active.goalId),
    ).to.be.revertedWithCustomError(active.escrow, "GoalNotOpen");
    await expect(
      active.escrow.connect(active.owner).cancelMonthlyGoal(active.goalId),
    ).to.be.revertedWithCustomError(active.escrow, "GoalNotOpen");
  });

  it("prevents retroactive stop requests after a period ends", async () => {
    const { owner, escrow, goalId } = await monthlyFixture(ROLL_OVER, 100n, 0n);
    const deadline = (await escrow.goal(goalId)).deadline;
    await setNextTimestamp(deadline);
    await expect(escrow.connect(owner).requestMonthlyGoalStop(goalId))
      .to.be.revertedWithCustomError(escrow, "MonthlySettlementRequired")
      .withArgs(deadline);
  });

  it("settles an elapsed period before allowing owner cancellation", async () => {
    const { owner, sponsor, recipient, treasury, pre, escrow, goalId } =
      await monthlyFixture(ROLL_OVER, 100n, 0n);
    const tokenAddress = await pre.getAddress();
    await escrow.connect(sponsor).contribute(goalId, tokenAddress, 140n, false);
    const deadline = (await escrow.goal(goalId)).deadline;
    await setNextTimestamp(deadline);

    await expect(escrow.connect(owner).cancelMonthlyGoal(goalId))
      .to.be.revertedWithCustomError(escrow, "MonthlySettlementRequired")
      .withArgs(deadline);

    await escrow.settleMonthlyGoal(goalId, 1);
    let goal = await escrow.goal(goalId);
    expect(goal.preRecipientEntitlement).to.equal(100n);
    expect((await escrow.monthlyGoal(goalId)).preCarry).to.equal(40n);

    await expect(escrow.connect(owner).cancelMonthlyGoal(goalId))
      .to.emit(escrow, "MonthlyGoalCancelled")
      .withArgs(goalId, 40n, 0n);

    goal = await escrow.goal(goalId);
    expect(goal.preRecipientEntitlement).to.equal(100n);
    expect(goal.preTreasuryEntitlement).to.equal(40n);
    await escrow.connect(recipient).releaseExpense(goalId, tokenAddress, 100n);
    await escrow
      .connect(treasury)
      .releaseCancelledFunds(goalId, tokenAddress, 40n);
    expect(await escrow.accountedByToken(tokenAddress)).to.equal(0n);
  });

  it("lets only the owner cancel both unallocated balances and preserves vested funds when treasury claims first", async () => {
    const {
      owner,
      sponsor,
      recipient,
      treasury,
      creator,
      pre,
      usdc,
      escrow,
      goalId,
    } = await monthlyFixture(ROLL_OVER, 100n, 50_000_000n);
    const tokenAddress = await pre.getAddress();
    const usdcAddress = await usdc.getAddress();
    const escrowAddress = await escrow.getAddress();
    await escrow.connect(sponsor).contribute(goalId, tokenAddress, 250n, false);
    await escrow
      .connect(sponsor)
      .contribute(goalId, usdcAddress, 180_000_000n, false);
    const deadline = (await escrow.goal(goalId)).deadline;
    await setNextTimestamp(deadline);
    await escrow.settleMonthlyGoal(goalId, 1);
    await escrow.connect(recipient).releaseExpense(goalId, tokenAddress, 40n);
    await escrow
      .connect(recipient)
      .releaseExpense(goalId, usdcAddress, 15_000_000n);
    await escrow.connect(sponsor).contribute(goalId, tokenAddress, 20n, false);
    await escrow
      .connect(sponsor)
      .contribute(goalId, usdcAddress, 7_000_000n, false);

    await expect(escrow.connect(creator).cancelMonthlyGoal(goalId))
      .to.be.revertedWithCustomError(escrow, "OwnableUnauthorizedAccount")
      .withArgs(creator.address);
    await expect(escrow.connect(owner).cancelMonthlyGoal(goalId))
      .to.emit(escrow, "MonthlyGoalCancelled")
      .withArgs(goalId, 170n, 137_000_000n);

    const goal = await escrow.goal(goalId);
    const monthly = await escrow.monthlyGoal(goalId);
    expect(goal.status).to.equal(3n);
    expect(goal.preContributed).to.equal(270n);
    expect(goal.usdcContributed).to.equal(187_000_000n);
    expect(goal.preRecipientEntitlement).to.equal(100n);
    expect(goal.usdcRecipientEntitlement).to.equal(50_000_000n);
    expect(goal.preReleasedExpense).to.equal(40n);
    expect(goal.usdcReleasedExpense).to.equal(15_000_000n);
    expect(goal.preTreasuryEntitlement).to.equal(170n);
    expect(goal.usdcTreasuryEntitlement).to.equal(137_000_000n);
    expect(monthly.preCurrentContributed).to.equal(0n);
    expect(monthly.usdcCurrentContributed).to.equal(0n);
    expect(monthly.preCarry).to.equal(0n);
    expect(monthly.usdcCarry).to.equal(0n);
    expect(await escrow.openGoalCountByCreator(creator.address)).to.equal(0n);
    expect(await escrow.accountedByToken(tokenAddress)).to.equal(230n);
    expect(await escrow.accountedByToken(usdcAddress)).to.equal(172_000_000n);

    await escrow
      .connect(treasury)
      .releaseCancelledFunds(goalId, tokenAddress, 170n);
    await escrow
      .connect(treasury)
      .releaseCancelledFunds(goalId, usdcAddress, 137_000_000n);
    expect(await pre.balanceOf(treasury.address)).to.equal(170n);
    expect(await usdc.balanceOf(treasury.address)).to.equal(137_000_000n);
    expect(await pre.balanceOf(recipient.address)).to.equal(40n);
    expect(await usdc.balanceOf(recipient.address)).to.equal(15_000_000n);
    expect(await escrow.accountedByToken(tokenAddress)).to.equal(60n);
    expect(await escrow.accountedByToken(usdcAddress)).to.equal(35_000_000n);
    expect(await pre.balanceOf(escrowAddress)).to.equal(60n);
    expect(await usdc.balanceOf(escrowAddress)).to.equal(35_000_000n);

    await escrow.connect(recipient).releaseExpense(goalId, tokenAddress, 60n);
    await escrow
      .connect(recipient)
      .releaseExpense(goalId, usdcAddress, 35_000_000n);
    const claimed = await escrow.goal(goalId);
    expect(claimed.preReleasedExpense).to.equal(100n);
    expect(claimed.usdcReleasedExpense).to.equal(50_000_000n);
    expect(claimed.preReleasedCancelledFunds).to.equal(170n);
    expect(claimed.usdcReleasedCancelledFunds).to.equal(137_000_000n);
    expect(await pre.balanceOf(recipient.address)).to.equal(100n);
    expect(await usdc.balanceOf(recipient.address)).to.equal(50_000_000n);
    expect(await escrow.accountedByToken(tokenAddress)).to.equal(0n);
    expect(await escrow.accountedByToken(usdcAddress)).to.equal(0n);
    expect(await pre.balanceOf(escrowAddress)).to.equal(0n);
    expect(await usdc.balanceOf(escrowAddress)).to.equal(0n);
  });

  it("preserves carry in accounted balances and recovers only direct excess tokens", async () => {
    const { owner, sponsor, stranger, pre, escrow, goalId } =
      await monthlyFixture(ROLL_OVER, 100n, 0n);
    const tokenAddress = await pre.getAddress();
    await escrow.connect(sponsor).contribute(goalId, tokenAddress, 140n, false);
    const deadline = (await escrow.goal(goalId)).deadline;
    await setNextTimestamp(deadline);
    await escrow.settleMonthlyGoal(goalId, 1);

    await pre.connect(sponsor).transfer(await escrow.getAddress(), 5n);
    await expect(
      escrow
        .connect(owner)
        .recoverExcessToken(tokenAddress, stranger.address, 6n),
    ).to.be.revertedWithCustomError(escrow, "ExcessBalanceUnavailable");
    await escrow
      .connect(owner)
      .recoverExcessToken(tokenAddress, stranger.address, 5n);
    expect((await escrow.monthlyGoal(goalId)).preCarry).to.equal(40n);
    expect(await escrow.accountedByToken(tokenAddress)).to.equal(140n);
    expect(await pre.balanceOf(await escrow.getAddress())).to.equal(140n);
  });

  it("prevents partial releases from draining pooled obligations of other goals", async () => {
    const {
      owner,
      sponsor,
      recipient,
      treasury,
      stranger,
      otherManager,
      alternatePayout,
      pre,
      escrow,
      goalId: monthlyGoalId,
    } = await monthlyFixture(ROLL_OVER, 100n, 0n);
    const preAddress = await pre.getAddress();
    const escrowAddress = await escrow.getAddress();
    const closedGoalId = ethers.id("pooled-closed-goal");
    const cancelledGoalId = ethers.id("pooled-cancelled-goal");
    const oneTimeDeadline = (await escrow.goal(monthlyGoalId)).deadline;

    await escrow
      .connect(owner)
      .createGoal(
        closedGoalId,
        alternatePayout.address,
        150n,
        0n,
        oneTimeDeadline,
        "Closed pooled obligation",
        "",
        "",
      );
    await escrow
      .connect(owner)
      .createGoal(
        cancelledGoalId,
        otherManager.address,
        200n,
        0n,
        oneTimeDeadline,
        "Cancelled pooled obligation",
        "",
        "",
      );

    await escrow
      .connect(sponsor)
      .contribute(monthlyGoalId, preAddress, 250n, false);
    await escrow
      .connect(sponsor)
      .contribute(closedGoalId, preAddress, 150n, false);
    await escrow
      .connect(sponsor)
      .contribute(cancelledGoalId, preAddress, 200n, false);
    await escrow.connect(owner).closeGoal(closedGoalId);
    await escrow.connect(owner).cancelGoal(cancelledGoalId);

    const firstMonthlyDeadline = (await escrow.goal(monthlyGoalId)).deadline;
    await setNextTimestamp(firstMonthlyDeadline);
    await escrow.connect(stranger).settleMonthlyGoal(monthlyGoalId, 1);
    expect(await escrow.accountedByToken(preAddress)).to.equal(600n);
    expect(await pre.balanceOf(escrowAddress)).to.equal(600n);

    await escrow
      .connect(recipient)
      .releaseExpense(monthlyGoalId, preAddress, 40n);
    await escrow
      .connect(alternatePayout)
      .releaseExpense(closedGoalId, preAddress, 60n);
    await escrow
      .connect(treasury)
      .releaseCancelledFunds(cancelledGoalId, preAddress, 50n);
    expect(await escrow.accountedByToken(preAddress)).to.equal(450n);
    expect(await pre.balanceOf(escrowAddress)).to.equal(450n);

    await expect(
      escrow.connect(recipient).releaseExpense(monthlyGoalId, preAddress, 61n),
    ).to.be.revertedWithCustomError(escrow, "ExpenseLimitExceeded");
    await expect(
      escrow
        .connect(alternatePayout)
        .releaseExpense(closedGoalId, preAddress, 91n),
    ).to.be.revertedWithCustomError(escrow, "ExpenseLimitExceeded");
    await expect(
      escrow
        .connect(treasury)
        .releaseCancelledFunds(cancelledGoalId, preAddress, 151n),
    ).to.be.revertedWithCustomError(escrow, "CancelledFundsLimitExceeded");
    expect(await escrow.accountedByToken(preAddress)).to.equal(450n);
    expect(await pre.balanceOf(escrowAddress)).to.equal(450n);

    await escrow.connect(owner).cancelMonthlyGoal(monthlyGoalId);
    await escrow
      .connect(recipient)
      .releaseExpense(monthlyGoalId, preAddress, 60n);
    await escrow
      .connect(treasury)
      .releaseCancelledFunds(monthlyGoalId, preAddress, 150n);
    await escrow
      .connect(alternatePayout)
      .releaseExpense(closedGoalId, preAddress, 90n);
    await escrow
      .connect(treasury)
      .releaseCancelledFunds(cancelledGoalId, preAddress, 150n);

    expect((await escrow.goal(monthlyGoalId)).preReleasedExpense).to.equal(
      100n,
    );
    expect(
      (await escrow.goal(monthlyGoalId)).preReleasedCancelledFunds,
    ).to.equal(150n);
    expect((await escrow.goal(closedGoalId)).preReleasedExpense).to.equal(150n);
    expect(
      (await escrow.goal(cancelledGoalId)).preReleasedCancelledFunds,
    ).to.equal(200n);
    expect(await pre.balanceOf(recipient.address)).to.equal(100n);
    expect(await pre.balanceOf(alternatePayout.address)).to.equal(150n);
    expect(await pre.balanceOf(treasury.address)).to.equal(350n);
    expect(await escrow.accountedByToken(preAddress)).to.equal(0n);
    expect(await pre.balanceOf(escrowAddress)).to.equal(0n);
  });

  it("pauses every monthly mutation and settlement path", async () => {
    const { owner, sponsor, recipient, pre, escrow, goalId } =
      await monthlyFixture(ROLL_OVER, 100n, 0n);
    const tokenAddress = await pre.getAddress();
    await escrow.connect(sponsor).contribute(goalId, tokenAddress, 100n, false);
    const deadline = (await escrow.goal(goalId)).deadline;
    await setNextTimestamp(deadline);
    await escrow.pause();

    await expect(
      escrow.createMonthlyGoal(
        ethers.id("paused-monthly-create"),
        recipient.address,
        1n,
        0n,
        0n,
        PAYOUT_ALL,
        "Paused",
        "",
        "",
      ),
    ).to.be.revertedWithCustomError(escrow, "EnforcedPause");
    await expect(
      escrow.connect(sponsor).contribute(goalId, tokenAddress, 1n, false),
    ).to.be.revertedWithCustomError(escrow, "EnforcedPause");
    await expect(
      escrow.setMonthlySurplusPolicy(goalId, PAYOUT_ALL),
    ).to.be.revertedWithCustomError(escrow, "EnforcedPause");
    await expect(
      escrow.requestMonthlyGoalStop(goalId),
    ).to.be.revertedWithCustomError(escrow, "EnforcedPause");
    await expect(
      escrow.settleMonthlyGoal(goalId, 1),
    ).to.be.revertedWithCustomError(escrow, "EnforcedPause");
    await expect(
      escrow.connect(owner).cancelMonthlyGoal(goalId),
    ).to.be.revertedWithCustomError(escrow, "EnforcedPause");
    await expect(
      escrow.releaseCancelledFunds(goalId, tokenAddress, 1n),
    ).to.be.revertedWithCustomError(escrow, "EnforcedPause");
  });

  for (const callback of [
    "setMonthlySurplusPolicy",
    "requestMonthlyGoalStop",
    "settleMonthlyGoal",
    "cancelMonthlyGoal",
  ] as const) {
    it(`rolls back token transfers when a callback reenters ${callback}`, async () => {
      const signers = await ethers.getSigners();
      const owner = signers[0]!;
      const sponsor = signers[1]!;
      const recipient = signers[2]!;
      const treasury = signers[3]!;
      const Reentrant = await ethers.getContractFactory("MockReentrantERC20");
      const pre = (await Reentrant.deploy()) as unknown as MockReentrantERC20;
      const Token = await ethers.getContractFactory("MockERC20");
      const usdc = (await Token.deploy(
        "USD Coin",
        "USDC",
        6,
      )) as unknown as MockERC20;
      const preAddress = await pre.getAddress();
      const usdcAddress = await usdc.getAddress();
      const Escrow = await ethers.getContractFactory("PREcommunityEscrowV1");
      const escrow = (await Escrow.deploy(
        owner.address,
        preAddress,
        usdcAddress,
        treasury.address,
      )) as unknown as PREcommunityEscrowV1;
      const escrowAddress = await escrow.getAddress();
      const goalId = ethers.id(`monthly-reentrancy-${callback}`);

      // The callback sender is an active manager and the actual goal creator.
      await escrow.setGoalManager(preAddress, true);
      await pre.executeEscrow(
        escrowAddress,
        escrow.interface.encodeFunctionData("createMonthlyGoal", [
          goalId,
          recipient.address,
          100n,
          100n,
          0n,
          ROLL_OVER,
          "Monthly reentrancy",
          "",
          "",
        ]),
      );
      for (const token of [pre, usdc]) {
        await token.mint(sponsor.address, 1_000n);
        await token.connect(sponsor).approve(escrowAddress, 1_000n);
      }
      await escrow.connect(sponsor).contribute(goalId, preAddress, 250n, false);
      await escrow.connect(sponsor).contribute(goalId, usdcAddress, 240n, false);
      await setNextTimestamp((await escrow.goal(goalId)).deadline);
      await escrow.settleMonthlyGoal(goalId, 1);
      await escrow.connect(sponsor).contribute(goalId, preAddress, 30n, false);
      await escrow.connect(sponsor).contribute(goalId, usdcAddress, 20n, false);

      if (callback === "cancelMonthlyGoal") {
        // Monthly cancellation requires owner authority, not manager authority.
        await escrow.transferOwnership(preAddress);
        await pre.executeEscrow(
          escrowAddress,
          escrow.interface.encodeFunctionData("acceptOwnership"),
        );
      }

      const callbackData = {
        setMonthlySurplusPolicy: escrow.interface.encodeFunctionData(
          "setMonthlySurplusPolicy", [goalId, PAYOUT_ALL],
        ),
        requestMonthlyGoalStop: escrow.interface.encodeFunctionData("requestMonthlyGoalStop", [goalId]),
        settleMonthlyGoal: escrow.interface.encodeFunctionData("settleMonthlyGoal", [goalId, 1]),
        cancelMonthlyGoal: escrow.interface.encodeFunctionData("cancelMonthlyGoal", [goalId]),
      }[callback];
      await pre.configureCall(escrowAddress, callbackData);

      async function readAccounting() {
        return {
          goal: Array.from(await escrow.goal(goalId)),
          monthly: Array.from(await escrow.monthlyGoal(goalId)),
          openGoals: await escrow.openGoalCountByCreator(preAddress),
          tokens: await Promise.all(
            [pre, usdc].map(async (token) => ({
              accounted: await escrow.accountedByToken(await token.getAddress()),
              allowance: await token.allowance(sponsor.address, escrowAddress),
              balances: await Promise.all(
                [
                  escrowAddress,
                  sponsor.address,
                  recipient.address,
                  treasury.address,
                ].map((address) => token.balanceOf(address)),
              ),
            })),
          ),
        };
      }

      const before = await readAccounting();
      if (callback === "settleMonthlyGoal") {
        // An expired period cannot accept contributions. Reenter settlement from
        // a payout of the entitlement already vested in the preceding period.
        await setNextTimestamp((await escrow.goal(goalId)).deadline);
        await expect(
          escrow.connect(recipient).releaseExpense(goalId, preAddress, 40n),
        ).to.be.revertedWithCustomError(escrow, "ReentrancyGuardReentrantCall");
      } else {
        await expect(
          escrow.connect(sponsor).contribute(goalId, preAddress, 25n, false),
        ).to.be.revertedWithCustomError(escrow, "ReentrancyGuardReentrantCall");
      }
      expect(await readAccounting()).to.deep.equal(before);

      // The identical call succeeds outside the transfer callback, proving that
      // the rejected attempt was not blocked by authorization or period checks.
      const events = {
        setMonthlySurplusPolicy: "MonthlySurplusPolicyUpdated",
        requestMonthlyGoalStop: "MonthlyGoalStopRequested",
        settleMonthlyGoal: "MonthlyPeriodSettled",
        cancelMonthlyGoal: "MonthlyGoalCancelled",
      } as const;
      await expect(pre.executeEscrow(escrowAddress, callbackData)).to.emit(
        escrow,
        events[callback],
      );
    });
  }

  it("preserves settlement day across short months and Gregorian leap-year boundaries", async () => {
    const snapshot = await ethers.provider.send("evm_snapshot", []);
    try {
      const signers = await ethers.getSigners();
      const owner = signers[0]!;
      const recipient = signers[1]!;
      const treasury = signers[2]!;
      const Token = await ethers.getContractFactory("MockERC20");
      const pre = (await Token.deploy(
        "Presearch",
        "PRE",
        18,
      )) as unknown as MockERC20;
      const usdc = (await Token.deploy(
        "USD Coin",
        "USDC",
        6,
      )) as unknown as MockERC20;
      const Escrow = await ethers.getContractFactory("PREcommunityEscrowV1");
      const escrow = (await Escrow.deploy(
        owner.address,
        await pre.getAddress(),
        await usdc.getAddress(),
        treasury.address,
      )) as unknown as PREcommunityEscrowV1;
      const Harness = await ethers.getContractFactory(
        "PREcommunityEscrowV1Harness",
      );
      const calendar = (await Harness.deploy(
        owner.address,
        await pre.getAddress(),
        await usdc.getAddress(),
        treasury.address,
      )) as unknown as PREcommunityEscrowV1Harness;

      const february2000 = await calendar.nextMonthlySettlement(
        unix("2000-01-31T00:00:00Z"),
        31,
      );
      expect(february2000).to.equal(unix("2000-02-29T00:00:00Z"));
      expect(await calendar.nextMonthlySettlement(february2000, 31)).to.equal(
        unix("2000-03-31T00:00:00Z"),
      );

      async function createAnchoredGoal(
        label: string,
        creationAt: bigint,
        firstSettlementAt: bigint,
      ): Promise<string> {
        await setNextTimestamp(creationAt);
        const goalId = ethers.id(`calendar-${label}`);
        await escrow.createMonthlyGoal(
          goalId,
          recipient.address,
          1n,
          0n,
          firstSettlementAt,
          PAYOUT_ALL,
          label,
          "",
          "",
        );
        return goalId;
      }

      const defaultClampCreation = unix("2099-08-31T23:59:59Z");
      await setNextTimestamp(defaultClampCreation);
      const defaultClamp = ethers.id("calendar-default-clamp");
      await escrow.createMonthlyGoal(
        defaultClamp,
        recipient.address,
        1n,
        0n,
        0n,
        PAYOUT_ALL,
        "Default day 31",
        "",
        "",
      );
      expect((await escrow.monthlyGoal(defaultClamp)).periodStart).to.equal(
        defaultClampCreation,
      );
      expect((await escrow.monthlyGoal(defaultClamp)).settlementDay).to.equal(
        31n,
      );
      expect((await escrow.goal(defaultClamp)).deadline).to.equal(
        unix("2099-09-30T00:00:00Z"),
      );
      await setNextTimestamp(unix("2099-09-30T00:00:00Z"));
      await escrow.settleMonthlyGoal(defaultClamp, 1);
      expect((await escrow.goal(defaultClamp)).deadline).to.equal(
        unix("2099-10-31T00:00:00Z"),
      );

      const century2100 = await createAnchoredGoal(
        "Non-leap 2100",
        unix("2099-12-15T00:00:00Z"),
        unix("2100-01-31T00:00:00Z"),
      );
      expect((await escrow.monthlyGoal(century2100)).settlementDay).to.equal(
        31n,
      );
      await setNextTimestamp(unix("2100-01-31T00:00:00Z"));
      await escrow.settleMonthlyGoal(century2100, 1);
      expect((await escrow.goal(century2100)).deadline).to.equal(
        unix("2100-02-28T00:00:00Z"),
      );
      await setNextTimestamp(unix("2100-02-28T00:00:00Z"));
      await escrow.settleMonthlyGoal(century2100, 1);
      expect((await escrow.goal(century2100)).deadline).to.equal(
        unix("2100-03-31T00:00:00Z"),
      );

      const leap2128 = await createAnchoredGoal(
        "Leap 2128",
        unix("2127-12-15T00:00:00Z"),
        unix("2128-01-31T00:00:00Z"),
      );
      await setNextTimestamp(unix("2128-01-31T00:00:00Z"));
      await escrow.settleMonthlyGoal(leap2128, 1);
      expect((await escrow.goal(leap2128)).deadline).to.equal(
        unix("2128-02-29T00:00:00Z"),
      );
      await setNextTimestamp(unix("2128-02-29T00:00:00Z"));
      await escrow.settleMonthlyGoal(leap2128, 1);
      expect((await escrow.goal(leap2128)).deadline).to.equal(
        unix("2128-03-31T00:00:00Z"),
      );

      const shortSeptember = await createAnchoredGoal(
        "August clamp",
        unix("2128-08-01T00:00:00Z"),
        unix("2128-08-31T00:00:00Z"),
      );
      await setNextTimestamp(unix("2128-08-31T00:00:00Z"));
      await escrow.settleMonthlyGoal(shortSeptember, 1);
      expect((await escrow.goal(shortSeptember)).deadline).to.equal(
        unix("2128-09-30T00:00:00Z"),
      );
      await setNextTimestamp(unix("2128-09-30T00:00:00Z"));
      await escrow.settleMonthlyGoal(shortSeptember, 1);
      expect((await escrow.goal(shortSeptember)).deadline).to.equal(
        unix("2128-10-31T00:00:00Z"),
      );

      const explicit28 = await createAnchoredGoal(
        "Explicit 28",
        unix("2129-02-01T00:00:00Z"),
        unix("2129-02-28T00:00:00Z"),
      );
      expect((await escrow.monthlyGoal(explicit28)).settlementDay).to.equal(
        28n,
      );
      await setNextTimestamp(unix("2129-02-28T00:00:00Z"));
      await escrow.settleMonthlyGoal(explicit28, 1);
      expect((await escrow.goal(explicit28)).deadline).to.equal(
        unix("2129-03-28T00:00:00Z"),
      );

      const century2200 = await createAnchoredGoal(
        "Non-leap 2200",
        unix("2199-12-15T00:00:00Z"),
        unix("2200-01-31T00:00:00Z"),
      );
      await setNextTimestamp(unix("2200-01-31T00:00:00Z"));
      await escrow.settleMonthlyGoal(century2200, 1);
      expect((await escrow.goal(century2200)).deadline).to.equal(
        unix("2200-02-28T00:00:00Z"),
      );

      // Repeat the divisible-by-400 rule at a future on-chain timestamp as an integration check.
      const century2400 = await createAnchoredGoal(
        "Leap 2400",
        unix("2399-12-15T00:00:00Z"),
        unix("2400-01-31T00:00:00Z"),
      );
      await setNextTimestamp(unix("2400-01-31T00:00:00Z"));
      await escrow.settleMonthlyGoal(century2400, 1);
      expect((await escrow.goal(century2400)).deadline).to.equal(
        unix("2400-02-29T00:00:00Z"),
      );
    } finally {
      await ethers.provider.send("evm_revert", [snapshot]);
    }
  });

  it("matches an independent ledger across randomized monthly lifecycles", async function () {
    // Keep instrumented coverage bounded without reducing the number of trials.
    this.timeout(120_000);
    const { sponsor, recipient, treasury, creator, stranger, pre, usdc, escrow,
      goalId: reserveGoalId } = await monthlyFixture(ROLL_OVER, 1_000n, 1_000n);
    const assets = [pre, usdc] as const;
    const addresses = [await pre.getAddress(), await usdc.getAddress()] as const;
    const escrowAddress = await escrow.getAddress();
    const reserve = [19n, 31n] as const;
    const indexes = [0, 1] as const;
    for (const index of indexes) {
      await escrow.connect(sponsor).contribute(
        reserveGoalId, addresses[index], reserve[index], false,
      );
    }
    // Deploy once; every trial and fast-check shrink starts from the same state.
    const snapshot = await hardhatConnection.networkHelpers.takeSnapshot();
    const tokenIndex = fc.constantFrom(0 as const, 1 as const);
    const amount = fc.bigInt({ min: 1n, max: 1_000n });
    const action = fc.oneof(
      fc.record({ kind: fc.constant("contribute" as const), token: tokenIndex, amount }),
      fc.record({
        kind: fc.constant("settle" as const),
        periods: fc.integer({ min: 1, max: 4 }),
        batch: fc.constantFrom(1, 24),
      }),
      fc.record({
        kind: fc.constant("release" as const), token: tokenIndex,
        percent: fc.integer({ min: 1, max: 100 }),
      }),
      fc.record({ kind: fc.constant("policy" as const), rollOver: fc.boolean() }),
    );
    const tokenModel = (target: bigint) => ({
      target, contributed: 0n, recipientEntitlement: 0n, treasuryEntitlement: 0n,
      releasedExpense: 0n, releasedCancelled: 0n, current: 0n, carry: 0n,
    });

    try {
      await fc.assert(fc.asyncProperty(fc.record({
        targets: fc.tuple(
          fc.bigInt({ min: 1n, max: 300n }),
          fc.bigInt({ min: 1n, max: 300n }),
        ),
        initial: fc.tuple(amount, amount),
        rollOver: fc.boolean(),
        actions: fc.array(action, { minLength: 4, maxLength: 10 }),
        stop: fc.boolean(),
        stopDelay: fc.integer({ min: 0, max: 4 }),
      }), async (scenario) => {
        await snapshot.restore();
        const goalId = ethers.id("modeled-monthly-goal");
        const policy = scenario.rollOver ? ROLL_OVER : PAYOUT_ALL;
        const creation = await escrow.connect(creator).createMonthlyGoal(
          goalId, recipient.address, scenario.targets[0], scenario.targets[1],
          0n, policy, "Modeled monthly goal", "", "",
        );
        const receipt = await creation.wait();
        const creationBlock = await ethers.provider.getBlock(receipt!.blockNumber);
        const start = BigInt(creationBlock!.timestamp);
        const anchor = new Date(Number(start) * 1_000).getUTCDate();
        const model = {
          policy, status: 1n, stopping: false, periods: 0n, start,
          deadline: addUtcMonths(start, 1, anchor),
          tokens: [tokenModel(scenario.targets[0]), tokenModel(scenario.targets[1])],
        };

        async function assertLedger() {
          const goal = await escrow.goal(goalId);
          const monthly = await escrow.monthlyGoal(goalId);
          expect([
            goal.status, goal.deadline, monthly.periodStart, monthly.periodsSettled,
            monthly.settlementDay, monthly.surplusPolicy, monthly.stopRequested,
          ]).to.deep.equal([
            model.status, model.deadline, model.start, model.periods,
            BigInt(anchor), model.policy, model.stopping,
          ]);
          const actual = [
            [goal.preTarget, goal.preContributed, goal.preRecipientEntitlement,
              goal.preTreasuryEntitlement, goal.preReleasedExpense,
              goal.preReleasedCancelledFunds, monthly.preCurrentContributed, monthly.preCarry],
            [goal.usdcTarget, goal.usdcContributed, goal.usdcRecipientEntitlement,
              goal.usdcTreasuryEntitlement, goal.usdcReleasedExpense,
              goal.usdcReleasedCancelledFunds, monthly.usdcCurrentContributed, monthly.usdcCarry],
          ];
          for (const index of indexes) {
            const expected = model.tokens[index]!;
            expect(actual[index]).to.deep.equal([
              expected.target, expected.contributed, expected.recipientEntitlement,
              expected.treasuryEntitlement, expected.releasedExpense,
              expected.releasedCancelled, expected.current, expected.carry,
            ]);
            const pooled = reserve[index] + expected.contributed
              - expected.releasedExpense - expected.releasedCancelled;
            expect(await escrow.accountedByToken(addresses[index])).to.equal(pooled);
            expect(await assets[index].balanceOf(escrowAddress)).to.equal(pooled);
            expect(await assets[index].balanceOf(recipient.address)).to.equal(expected.releasedExpense);
            expect(await assets[index].balanceOf(treasury.address)).to.equal(expected.releasedCancelled);
          }
          expect(await escrow.openGoalCountByCreator(creator.address))
            .to.equal(model.status === 1n ? 2n : 1n);
        }

        async function contribute(index: 0 | 1, value: bigint) {
          await escrow.connect(sponsor).contribute(goalId, addresses[index], value, false);
          model.tokens[index]!.contributed += value;
          model.tokens[index]!.current += value;
          await assertLedger();
        }

        function allocatePeriod() {
          for (const token of model.tokens) {
            const available = token.current + token.carry;
            // Model the documented allocation, never derive expected payouts from getters.
            const vested = !model.stopping && model.policy === ROLL_OVER && available > token.target
              ? token.target : available;
            token.recipientEntitlement += vested;
            token.current = 0n;
            token.carry = available - vested;
          }
          model.periods += 1n;
          if (model.stopping) {
            model.status = 2n;
          } else {
            model.start = model.deadline;
            model.deadline = addUtcMonths(model.deadline, 1, anchor);
          }
        }

        async function settle(periods: number, batch: number, delay = 0) {
          await setNextTimestamp(addUtcMonths(model.deadline, periods - 1 + delay, anchor));
          await ethers.provider.send("evm_mine", []);
          let remaining = periods;
          while (remaining > 0) {
            const processed = Math.min(batch, remaining);
            await escrow.connect(stranger).settleMonthlyGoal(goalId, batch);
            for (let period = 0; period < processed; period += 1) allocatePeriod();
            remaining -= processed;
            await assertLedger();
          }
        }

        async function release(index: 0 | 1, percent: number) {
          const token = model.tokens[index]!;
          const available = token.recipientEntitlement - token.releasedExpense;
          if (available === 0n) {
            await expect(escrow.connect(recipient).releaseExpense(goalId, addresses[index], 1n))
              .to.be.revertedWithCustomError(escrow, "ExpenseLimitExceeded");
          } else {
            const fraction = available * BigInt(percent) / 100n;
            const value = fraction > 0n ? fraction : 1n;
            await escrow.connect(recipient).releaseExpense(goalId, addresses[index], value);
            token.releasedExpense += value;
          }
          await assertLedger();
        }

        await assertLedger();
        for (const index of indexes) await contribute(index, scenario.initial[index]);
        await settle(1, 24);
        for (const operation of scenario.actions) {
          switch (operation.kind) {
            case "contribute":
              await contribute(operation.token, operation.amount);
              break;
            case "settle":
              await settle(operation.periods, operation.batch);
              break;
            case "release":
              await release(operation.token, operation.percent);
              break;
            case "policy":
              model.policy = operation.rollOver ? ROLL_OVER : PAYOUT_ALL;
              await escrow.connect(creator).setMonthlySurplusPolicy(goalId, model.policy);
              await assertLedger();
              break;
          }
        }
        if (scenario.stop) {
          await escrow.connect(creator).requestMonthlyGoalStop(goalId);
          model.stopping = true;
          await assertLedger();
          await settle(1, 24, scenario.stopDelay);
        } else {
          await escrow.cancelMonthlyGoal(goalId);
          model.status = 3n;
          for (const token of model.tokens) {
            token.treasuryEntitlement += token.current + token.carry;
            token.current = 0n;
            token.carry = 0n;
          }
          await assertLedger();
          // Treasury claims first; already vested beneficiary funds must remain intact.
          for (const index of indexes) {
            const token = model.tokens[index]!;
            if (token.treasuryEntitlement > 0n) {
              await escrow.connect(treasury).releaseCancelledFunds(
                goalId, addresses[index], token.treasuryEntitlement,
              );
              token.releasedCancelled = token.treasuryEntitlement;
              await assertLedger();
            }
          }
        }
        for (const index of indexes) {
          await release(index, 100);
          expect(await escrow.accountedByToken(addresses[index])).to.equal(reserve[index]);
        }
      }), { numRuns: 20 });
    } finally {
      await snapshot.restore();
    }
  });
});
