import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { prisma, resetDatabase } from "../support/db.js";
import {
  addMember,
  anonymousContext,
  contextFor,
  createAssignment,
  createHouse,
  createIssue,
  createLeaveRequest,
  createOwnerAccount,
  createReceipt,
  createUser,
} from "../support/factories.js";
import { expectData, expectError, run } from "../support/graphql.js";

const EXPORT = `query ($id: ID!) {
  tenancyExport(tenantAssignmentId: $id) {
    assignment { id houseId houseName status leaseStartDate leaseEndDate plannedExitDate actualExitDate }
    receipts { id tenantAssignmentId amountCents currency paidAt note createdAt }
    issues { id tenantAssignmentId status title createdAt }
    leaveRequests { id tenantAssignmentId status requestedExitDate createdAt }
    generatedAt
  }
}`;

const MESSAGES = Object.freeze({
  ACCESS_NOT_ALLOWED: "This action is not available to you.",
  STATUS_NOT_ALLOWED:
    "This action is not available for the owner account in its current state.",
  NOT_FOUND: "Tenant assignment not found.",
  SUSPENDED: "This account has been suspended.",
});

const BASE_TIME = Date.parse("2026-01-01T00:00:00.000Z");
const MS_PER_MINUTE = 60_000;

function at(minute) {
  return new Date(BASE_TIME + minute * MS_PER_MINUTE);
}

async function lease({
  accountStatus = "APPROVED",
  billing,
  assignmentStatus = "ACTIVE",
} = {}) {
  const [owner, tenant] = await Promise.all([createUser(), createUser()]);
  const account = await createOwnerAccount(owner, {
    status: accountStatus,
    ...(billing === undefined ? {} : { billing }),
  });
  const house = await createHouse(account, { name: "Harbour View 4" });
  const assignment = await createAssignment(house, tenant, {
    status: assignmentStatus,
  });
  return { owner, tenant, account, house, assignment };
}

function exportAs(user, assignment) {
  return run(contextFor(user), EXPORT, { id: assignment.id });
}

beforeEach(resetDatabase);

describe("tenancyExport", () => {
  it("returns the assignment with its house name and every receipt, issue and leave request, oldest first", async () => {
    const { tenant, house, assignment } = await lease();
    const receiptCount = 25;

    for (let index = 0; index < receiptCount; index += 1) {
      await createReceipt(assignment, {
        amountCents: 1000 + index,
        createdAt: at(receiptCount - index),
      });
    }

    const laterIssue = await createIssue(assignment, {
      title: "Broken heater",
      createdAt: at(10),
    });
    const earlierIssue = await createIssue(assignment, {
      title: "Leaking tap",
      createdAt: at(5),
    });
    const request = await createLeaveRequest(assignment, {
      status: "REJECTED",
      createdAt: at(3),
    });

    const data = expectData(await exportAs(tenant, assignment)).tenancyExport;

    assert.deepEqual({ ...data.assignment }, {
      id: assignment.id,
      houseId: house.id,
      houseName: "Harbour View 4",
      status: "ACTIVE",
      leaseStartDate: assignment.leaseStartDate.toISOString().slice(0, 10),
      leaseEndDate: null,
      plannedExitDate: null,
      actualExitDate: null,
    });

    assert.equal(data.receipts.length, receiptCount);
    assert.deepEqual(
      data.receipts.map((receipt) => receipt.amountCents),
      Array.from(
        { length: receiptCount },
        (_, index) => 1000 + receiptCount - 1 - index,
      ),
    );
    assert.ok(
      data.receipts.every(
        (receipt) => receipt.tenantAssignmentId === assignment.id,
      ),
    );
    assert.deepEqual(
      data.issues.map((issue) => issue.id),
      [earlierIssue.id, laterIssue.id],
    );
    assert.deepEqual(
      data.leaveRequests.map((entry) => [entry.id, entry.status]),
      [[request.id, "REJECTED"]],
    );
    assert.ok(Date.parse(data.generatedAt));
  });

  it("leaves out the tenant's other assignments", async () => {
    const { tenant, account, assignment } = await lease();
    const otherHouse = await createHouse(account, { name: "Other" });
    const other = await createAssignment(otherHouse, tenant);
    await createReceipt(other);
    await createIssue(other);
    await createLeaveRequest(other);

    const data = expectData(await exportAs(tenant, assignment)).tenancyExport;

    assert.deepEqual(
      [data.receipts, data.issues, data.leaveRequests],
      [[], [], []],
    );
  });

  it("exports an exited assignment", async () => {
    const { tenant, assignment } = await lease({ assignmentStatus: "EXITED" });

    const data = expectData(await exportAs(tenant, assignment)).tenancyExport;

    assert.equal(data.assignment.status, "EXITED");
  });

  for (const accountStatus of ["BLOCKED", "PENDING_DELETION"]) {
    it(`works while the owner account is ${accountStatus}`, async () => {
      const { tenant, assignment } = await lease({ accountStatus });
      await createReceipt(assignment);

      const data = expectData(await exportAs(tenant, assignment)).tenancyExport;

      assert.equal(data.receipts.length, 1);
    });
  }

  it("works while billing makes the owner account read-only", async () => {
    const { tenant, assignment } = await lease({ billing: null });

    expectData(await exportAs(tenant, assignment));
  });

  it("gives FORBIDDEN while the owner account is PENDING", async () => {
    const { tenant, assignment } = await lease({ accountStatus: "PENDING" });

    expectError(
      await exportAs(tenant, assignment),
      "FORBIDDEN",
      MESSAGES.STATUS_NOT_ALLOWED,
    );
  });

  it("gives FORBIDDEN to an owner member who is not the tenant", async () => {
    const { owner, account, assignment } = await lease();
    const coOwner = await createUser();
    await addMember(account, coOwner);

    expectError(
      await exportAs(owner, assignment),
      "FORBIDDEN",
      MESSAGES.ACCESS_NOT_ALLOWED,
    );
    expectError(
      await exportAs(coOwner, assignment),
      "FORBIDDEN",
      MESSAGES.ACCESS_NOT_ALLOWED,
    );
  });

  it("lets a member who is also the tenant export their own assignment", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner);
    const house = await createHouse(account);
    const assignment = await createAssignment(house, owner);

    expectData(await exportAs(owner, assignment));
  });

  it("gives NOT_FOUND to an unrelated user and for a missing assignment", async () => {
    const { assignment } = await lease();
    const stranger = await createUser();

    expectError(
      await exportAs(stranger, assignment),
      "NOT_FOUND",
      MESSAGES.NOT_FOUND,
    );
    expectError(
      await exportAs(stranger, { id: "cjld2cjxh0000qzrmn831i7rn" }),
      "NOT_FOUND",
      MESSAGES.NOT_FOUND,
    );
  });

  it("gives UNAUTHENTICATED to an anonymous request and FORBIDDEN to a blocked tenant", async () => {
    const { assignment } = await lease();
    const { tenant, assignment: blockedAssignment } = await lease();
    await prisma.user.update({
      where: { id: tenant.id },
      data: { isBlocked: true },
    });

    expectError(
      await run(anonymousContext(), EXPORT, { id: assignment.id }),
      "UNAUTHENTICATED",
    );
    expectError(
      await exportAs(tenant, blockedAssignment),
      "FORBIDDEN",
      MESSAGES.SUSPENDED,
    );
  });
});
