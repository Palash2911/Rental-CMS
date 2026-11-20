import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { Prisma } from "../../src/generated/prisma/client.ts";
import { READ_ONLY_MESSAGE } from "../../src/lib/entitlement.js";
import { prisma, resetDatabase } from "../support/db.js";
import {
  addMember,
  contextFor,
  createAssignment,
  createHouse,
  createLeaveRequest,
  createOwnerAccount,
  createUser,
} from "../support/factories.js";
import { expectData, expectError, run } from "../support/graphql.js";

const REQUEST_FIELDS = "id tenantAssignmentId houseId status requestedExitDate reason respondedAt createdAt updatedAt";
const ASSIGNMENT_FIELDS = "id status plannedExitDate actualExitDate";

const CREATE = `mutation ($input: CreateLeaveRequestInput!) { createLeaveRequest(input: $input) { ${REQUEST_FIELDS} } }`;
const WITHDRAW = `mutation ($id: ID!) { withdrawLeaveRequest(id: $id) { ${REQUEST_FIELDS} } }`;
const APPROVE = `mutation ($id: ID!) { approveLeaveRequest(id: $id) { ${REQUEST_FIELDS} } }`;
const REJECT = `mutation ($id: ID!) { rejectLeaveRequest(id: $id) { ${REQUEST_FIELDS} } }`;
const GIVE_NOTICE = `mutation ($tenantAssignmentId: ID!, $plannedExitDate: Date!) {
  giveNotice(tenantAssignmentId: $tenantAssignmentId, plannedExitDate: $plannedExitDate) { ${ASSIGNMENT_FIELDS} } }`;
const WITHDRAW_NOTICE = `mutation ($tenantAssignmentId: ID!) { withdrawNotice(tenantAssignmentId: $tenantAssignmentId) { ${ASSIGNMENT_FIELDS} } }`;
const EXIT = `mutation ($id: ID!) { exitTenantAssignment(id: $id) { ${ASSIGNMENT_FIELDS} } }`;
const ASSIGNMENT = `query ($id: ID!) { tenantAssignment(id: $id) { ${ASSIGNMENT_FIELDS} } }`;
const BY_ASSIGNMENT = `query ($tenantAssignmentId: ID!, $status: LeaveRequestStatus, $first: Int, $after: String) {
  leaveRequestsByAssignment(tenantAssignmentId: $tenantAssignmentId, status: $status, first: $first, after: $after) {
    items { id status } pageInfo { nextCursor hasNextPage } } }`;
const BY_HOUSE = `query ($houseId: ID!, $status: LeaveRequestStatus, $first: Int, $after: String) {
  leaveRequestsByHouse(houseId: $houseId, status: $status, first: $first, after: $after) {
    items { id status tenantAssignmentId } pageInfo { nextCursor hasNextPage } } }`;

const MESSAGES = Object.freeze({
  REQUEST_NEEDS_ACTIVE: "A leave request can only be made on an active tenant assignment.",
  ALREADY_PENDING: "This tenant assignment already has a pending leave request.",
  NOT_PENDING: "This leave request is no longer pending.",
  NOTICE_NEEDS_ACTIVE: "Only an active tenant assignment can be given notice.",
  NOT_IN_NOTICE: "Only a tenant assignment in its notice period can have its notice withdrawn.",
  EXIT_DATE_PAST: "The exit date cannot be in the past.",
  ACCESS_NOT_ALLOWED: "This action is not available to you.",
  STATUS_NOT_ALLOWED: "This action is not available for the owner account in its current state.",
  LEAVE_REQUEST_NOT_FOUND: "Leave request not found.",
  ASSIGNMENT_NOT_FOUND: "Tenant assignment not found.",
  HOUSE_NOT_FOUND: "House not found.",
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MISSING_ID = "cjld2cjxh0000qzrmn831i7rn";
const CANCELED = Object.freeze({ plan: "STARTER", interval: "MONTH", stripeStatus: "canceled" });
const REASON_MAX_LENGTH = 1000;

/** The UTC calendar date `days` from today, as YYYY-MM-DD. */
function daysFromToday(days) {
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return new Date(todayUtc + days * MS_PER_DAY).toISOString().slice(0, 10);
}

function utcMidnight(calendarDate) {
  return new Date(`${calendarDate}T00:00:00.000Z`);
}

function as(user) {
  return contextFor(user);
}

function storedRequest(request) {
  return prisma.leaveRequest.findUnique({ where: { id: request.id } });
}

function storedAssignment(assignment) {
  return prisma.tenantAssignment.findUnique({ where: { id: assignment.id } });
}

function logsFor(entityId) {
  return prisma.activityLog.findMany({ where: { entityId }, orderBy: { createdAt: "asc" } });
}

// An account with a PRIMARY owner, a CO_OWNER and one tenant on a house.
async function lease({ accountOptions = {}, assignmentOptions = {} } = {}) {
  const [owner, coOwner, tenant] = await Promise.all([createUser(), createUser(), createUser()]);
  const account = await createOwnerAccount(owner, accountOptions);
  await addMember(account, coOwner);
  const house = await createHouse(account);
  const assignment = await createAssignment(house, tenant, assignmentOptions);
  return { owner, coOwner, tenant, account, house, assignment };
}

function createInput(assignment, overrides = {}) {
  return { input: { tenantAssignmentId: assignment.id, requestedExitDate: daysFromToday(30), ...overrides } };
}

beforeEach(resetDatabase);

describe("createLeaveRequest", () => {
  it("lets the tenant request an exit date on an ACTIVE lease and logs it", async () => {
    const { tenant, house, assignment } = await lease();
    const requestedExitDate = daysFromToday(30);

    const data = expectData(
      await run(as(tenant), CREATE, createInput(assignment, { requestedExitDate, reason: "  Moving interstate  " })),
    );
    const request = { ...data.createLeaveRequest };

    assert.equal(request.status, "PENDING");
    assert.equal(request.tenantAssignmentId, assignment.id);
    assert.equal(request.houseId, house.id);
    assert.equal(request.requestedExitDate, requestedExitDate);
    assert.equal(request.reason, "Moving interstate");
    assert.equal(request.respondedAt, null);

    const [log] = await logsFor(request.id);
    assert.deepEqual([log.entityType, log.action, log.performedByUserId], ["LeaveRequest", "CREATED", tenant.id]);
    assert.deepEqual(log.metadata, { tenantAssignmentId: assignment.id, requestedExitDate });
    assert.equal((await storedAssignment(assignment)).status, "ACTIVE");
  });

  it("accepts today and a missing reason", async () => {
    const { tenant, assignment } = await lease();

    const data = expectData(await run(as(tenant), CREATE, createInput(assignment, { requestedExitDate: daysFromToday(0) })));

    assert.equal(data.createLeaveRequest.requestedExitDate, daysFromToday(0));
    assert.equal(data.createLeaveRequest.reason, null);
  });

  it("rejects a date in the past, a blank or too long reason, and a malformed date", async () => {
    const { tenant, assignment } = await lease();

    const past = expectError(
      await run(as(tenant), CREATE, createInput(assignment, { requestedExitDate: daysFromToday(-2) })),
      "BAD_USER_INPUT",
    );
    assert.deepEqual(past.extensions.fieldErrors, [{ path: "input.requestedExitDate", message: MESSAGES.EXIT_DATE_PAST }]);

    expectError(await run(as(tenant), CREATE, createInput(assignment, { reason: "   " })), "BAD_USER_INPUT");
    expectError(
      await run(as(tenant), CREATE, createInput(assignment, { reason: "x".repeat(REASON_MAX_LENGTH + 1) })),
      "BAD_USER_INPUT",
    );
    expectData(await run(as(tenant), CREATE, createInput(assignment, { reason: "x".repeat(REASON_MAX_LENGTH) })));

    const malformed = await run(as(tenant), CREATE, createInput(assignment, { requestedExitDate: "2027-02-30" }));
    assert.equal(malformed.errors[0].extensions.code, "BAD_USER_INPUT");
  });

  it("refuses a lease in its notice period or exited", async () => {
    for (const status of ["NOTICE_PERIOD", "EXITED"]) {
      const { tenant, assignment } = await lease({ assignmentOptions: { status } });

      expectError(await run(as(tenant), CREATE, createInput(assignment)), "CONFLICT", MESSAGES.REQUEST_NEEDS_ACTIVE);
    }

    assert.equal(await prisma.leaveRequest.count(), 0);
  });

  it("allows one pending request per lease, and a new one once it is answered", async () => {
    const { tenant, owner, assignment } = await lease();

    const first = expectData(await run(as(tenant), CREATE, createInput(assignment))).createLeaveRequest;
    expectError(await run(as(tenant), CREATE, createInput(assignment)), "CONFLICT", MESSAGES.ALREADY_PENDING);

    expectData(await run(as(owner), REJECT, { id: first.id }));
    expectData(await run(as(tenant), CREATE, createInput(assignment)));
    assert.equal(await prisma.leaveRequest.count({ where: { tenantAssignmentId: assignment.id } }), 2);
  });

  it("is tenant only: a member gets FORBIDDEN and anyone else NOT_FOUND", async () => {
    const { owner, assignment } = await lease();

    expectError(await run(as(owner), CREATE, createInput(assignment)), "FORBIDDEN", MESSAGES.ACCESS_NOT_ALLOWED);
    expectError(await run(as(await createUser()), CREATE, createInput(assignment)), "NOT_FOUND", MESSAGES.ASSIGNMENT_NOT_FOUND);
  });

  it("requires an APPROVED account with full billing access", async () => {
    const cases = [
      [{ status: "BLOCKED" }, MESSAGES.STATUS_NOT_ALLOWED],
      [{ status: "PENDING_DELETION" }, MESSAGES.STATUS_NOT_ALLOWED],
      [{ status: "PENDING", billing: null }, MESSAGES.STATUS_NOT_ALLOWED],
      [{ billing: CANCELED }, READ_ONLY_MESSAGE],
    ];

    for (const [accountOptions, message] of cases) {
      const { tenant, assignment } = await lease({ accountOptions });
      expectError(await run(as(tenant), CREATE, createInput(assignment)), "FORBIDDEN", message);
    }
  });
});

describe("withdrawLeaveRequest", () => {
  it("lets the tenant withdraw a pending request and logs it", async () => {
    const { tenant, assignment } = await lease();
    const request = await createLeaveRequest(assignment);

    const data = expectData(await run(as(tenant), WITHDRAW, { id: request.id }));

    assert.equal(data.withdrawLeaveRequest.status, "WITHDRAWN");
    assert.ok(data.withdrawLeaveRequest.respondedAt);
    assert.equal((await storedRequest(request)).respondedByUserId, tenant.id);
    const [log] = await logsFor(request.id);
    assert.deepEqual([log.action, log.performedByUserId], ["WITHDRAWN", tenant.id]);
    assert.deepEqual(log.metadata, { tenantAssignmentId: assignment.id, fromStatus: "PENDING", toStatus: "WITHDRAWN" });
  });

  it("refuses a request that is no longer pending", async () => {
    const { tenant, assignment } = await lease();

    for (const status of ["APPROVED", "REJECTED", "WITHDRAWN"]) {
      const request = await createLeaveRequest(assignment, { status, respondedAt: new Date() });
      expectError(await run(as(tenant), WITHDRAW, { id: request.id }), "CONFLICT", MESSAGES.NOT_PENDING);
      assert.equal((await storedRequest(request)).status, status);
    }
  });

  it("is tenant only and hides the request from unrelated users", async () => {
    const { owner, assignment } = await lease();
    const request = await createLeaveRequest(assignment);

    expectError(await run(as(owner), WITHDRAW, { id: request.id }), "FORBIDDEN", MESSAGES.ACCESS_NOT_ALLOWED);
    expectError(await run(as(await createUser()), WITHDRAW, { id: request.id }), "NOT_FOUND", MESSAGES.LEAVE_REQUEST_NOT_FOUND);
    expectError(await run(as(owner), WITHDRAW, { id: MISSING_ID }), "NOT_FOUND", MESSAGES.LEAVE_REQUEST_NOT_FOUND);
  });
});

describe("approveLeaveRequest", () => {
  it("moves the lease to NOTICE_PERIOD with the requested exit date, for PRIMARY and CO_OWNER", async () => {
    for (const approverRole of ["owner", "coOwner"]) {
      const fixture = await lease();
      const { assignment, house } = fixture;
      const approver = fixture[approverRole];
      const requestedExitDate = daysFromToday(45);
      const request = await createLeaveRequest(assignment, { requestedExitDate: utcMidnight(requestedExitDate) });

      const data = expectData(await run(as(approver), APPROVE, { id: request.id }));

      assert.equal(data.approveLeaveRequest.status, "APPROVED");
      assert.ok(data.approveLeaveRequest.respondedAt);
      assert.equal((await storedRequest(request)).respondedByUserId, approver.id);

      const stored = await storedAssignment(assignment);
      assert.equal(stored.status, "NOTICE_PERIOD");
      assert.equal(stored.plannedExitDate.toISOString(), utcMidnight(requestedExitDate).toISOString());
      assert.equal((await prisma.house.findUnique({ where: { id: house.id } })).status, "OCCUPIED");

      const [requestLog] = await logsFor(request.id);
      assert.deepEqual([requestLog.action, requestLog.performedByUserId], ["APPROVED", approver.id]);
      const [noticeLog] = await logsFor(assignment.id);
      assert.equal(noticeLog.action, "NOTICE_GIVEN");
      assert.deepEqual(noticeLog.metadata, {
        fromStatus: "ACTIVE",
        toStatus: "NOTICE_PERIOD",
        plannedExitDate: requestedExitDate,
        leaveRequestId: request.id,
      });
    }
  });

  it("refuses a request that is no longer pending", async () => {
    const { owner, assignment } = await lease();
    const request = await createLeaveRequest(assignment, { status: "WITHDRAWN", respondedAt: new Date() });

    expectError(await run(as(owner), APPROVE, { id: request.id }), "CONFLICT", MESSAGES.NOT_PENDING);
    assert.equal((await storedAssignment(assignment)).status, "ACTIVE");
  });

  it("refuses when the lease is no longer ACTIVE and leaves the request pending", async () => {
    for (const status of ["NOTICE_PERIOD", "EXITED"]) {
      const { owner, assignment } = await lease({ assignmentOptions: { status } });
      const request = await createLeaveRequest(assignment);

      expectError(await run(as(owner), APPROVE, { id: request.id }), "CONFLICT", MESSAGES.NOTICE_NEEDS_ACTIVE);
      assert.equal((await storedRequest(request)).status, "PENDING");
      assert.equal((await storedAssignment(assignment)).status, status);
      assert.equal((await logsFor(request.id)).length, 0);
    }
  });

  it("is owner only, and refused on a read-only or BLOCKED account", async () => {
    const { tenant, assignment } = await lease();
    const request = await createLeaveRequest(assignment);
    expectError(await run(as(tenant), APPROVE, { id: request.id }), "FORBIDDEN", MESSAGES.ACCESS_NOT_ALLOWED);
    expectError(await run(as(await createUser()), APPROVE, { id: request.id }), "NOT_FOUND", MESSAGES.LEAVE_REQUEST_NOT_FOUND);

    const cases = [
      [{ billing: CANCELED }, READ_ONLY_MESSAGE],
      [{ status: "BLOCKED" }, MESSAGES.STATUS_NOT_ALLOWED],
    ];

    for (const [accountOptions, message] of cases) {
      const fixture = await lease({ accountOptions });
      const pending = await createLeaveRequest(fixture.assignment);
      expectError(await run(as(fixture.owner), APPROVE, { id: pending.id }), "FORBIDDEN", message);
    }
  });
});

describe("rejectLeaveRequest", () => {
  it("rejects a pending request without changing the lease and logs it", async () => {
    const { coOwner, assignment } = await lease();
    const request = await createLeaveRequest(assignment);

    const data = expectData(await run(as(coOwner), REJECT, { id: request.id }));

    assert.equal(data.rejectLeaveRequest.status, "REJECTED");
    assert.equal((await storedRequest(request)).respondedByUserId, coOwner.id);
    const stored = await storedAssignment(assignment);
    assert.deepEqual([stored.status, stored.plannedExitDate], ["ACTIVE", null]);
    const [log] = await logsFor(request.id);
    assert.deepEqual([log.action, log.performedByUserId], ["REJECTED", coOwner.id]);
  });

  it("refuses a request that is no longer pending, and the tenant", async () => {
    const { owner, tenant, assignment } = await lease();
    const answered = await createLeaveRequest(assignment, { status: "APPROVED", respondedAt: new Date() });
    const pending = await createLeaveRequest(assignment);

    expectError(await run(as(owner), REJECT, { id: answered.id }), "CONFLICT", MESSAGES.NOT_PENDING);
    expectError(await run(as(tenant), REJECT, { id: pending.id }), "FORBIDDEN", MESSAGES.ACCESS_NOT_ALLOWED);
  });
});

describe("giveNotice", () => {
  it("moves an ACTIVE lease to NOTICE_PERIOD with the planned exit date and logs it", async () => {
    const { owner, tenant, assignment } = await lease();
    const plannedExitDate = daysFromToday(60);

    const data = expectData(await run(as(owner), GIVE_NOTICE, { tenantAssignmentId: assignment.id, plannedExitDate }));

    assert.deepEqual({ ...data.giveNotice }, { id: assignment.id, status: "NOTICE_PERIOD", plannedExitDate, actualExitDate: null });
    const read = expectData(await run(as(tenant), ASSIGNMENT, { id: assignment.id }));
    assert.equal(read.tenantAssignment.plannedExitDate, plannedExitDate);

    const [log] = await logsFor(assignment.id);
    assert.deepEqual([log.action, log.performedByUserId], ["NOTICE_GIVEN", owner.id]);
    assert.deepEqual(log.metadata, { fromStatus: "ACTIVE", toStatus: "NOTICE_PERIOD", plannedExitDate, leaveRequestId: null });
  });

  it("refuses a lease that is not ACTIVE", async () => {
    for (const status of ["NOTICE_PERIOD", "EXITED"]) {
      const { owner, assignment } = await lease({ assignmentOptions: { status } });

      expectError(
        await run(as(owner), GIVE_NOTICE, { tenantAssignmentId: assignment.id, plannedExitDate: daysFromToday(30) }),
        "CONFLICT",
        MESSAGES.NOTICE_NEEDS_ACTIVE,
      );
      assert.equal((await storedAssignment(assignment)).status, status);
    }
  });

  it("rejects a past date and does not enforce a minimum notice period", async () => {
    const { owner, assignment } = await lease();

    const error = expectError(
      await run(as(owner), GIVE_NOTICE, { tenantAssignmentId: assignment.id, plannedExitDate: daysFromToday(-2) }),
      "BAD_USER_INPUT",
    );
    assert.deepEqual(error.extensions.fieldErrors, [{ path: "plannedExitDate", message: MESSAGES.EXIT_DATE_PAST }]);

    expectData(await run(as(owner), GIVE_NOTICE, { tenantAssignmentId: assignment.id, plannedExitDate: daysFromToday(0) }));
  });

  it("is owner only, and refused on a read-only account", async () => {
    const { tenant, assignment } = await lease();
    const variables = { tenantAssignmentId: assignment.id, plannedExitDate: daysFromToday(30) };

    expectError(await run(as(tenant), GIVE_NOTICE, variables), "FORBIDDEN", MESSAGES.ACCESS_NOT_ALLOWED);
    expectError(await run(as(await createUser()), GIVE_NOTICE, variables), "NOT_FOUND", MESSAGES.ASSIGNMENT_NOT_FOUND);

    const readOnly = await lease({ accountOptions: { billing: CANCELED } });
    expectError(
      await run(as(readOnly.owner), GIVE_NOTICE, { ...variables, tenantAssignmentId: readOnly.assignment.id }),
      "FORBIDDEN",
      READ_ONLY_MESSAGE,
    );
  });
});

describe("withdrawNotice", () => {
  it("returns the lease to ACTIVE, clears the planned exit date and withdraws the approved request", async () => {
    const { owner, tenant, assignment } = await lease();
    const created = expectData(await run(as(tenant), CREATE, createInput(assignment))).createLeaveRequest;
    expectData(await run(as(owner), APPROVE, { id: created.id }));
    const plannedExitDate = (await storedAssignment(assignment)).plannedExitDate.toISOString().slice(0, 10);

    const data = expectData(await run(as(owner), WITHDRAW_NOTICE, { tenantAssignmentId: assignment.id }));

    assert.deepEqual({ ...data.withdrawNotice }, { id: assignment.id, status: "ACTIVE", plannedExitDate: null, actualExitDate: null });
    assert.equal((await storedRequest(created)).status, "WITHDRAWN");

    const requestLogs = await logsFor(created.id);
    assert.deepEqual(requestLogs.map((log) => log.action), ["CREATED", "APPROVED", "WITHDRAWN"]);
    assert.equal(requestLogs[2].metadata.reason, "NOTICE_WITHDRAWN");

    const noticeLog = (await logsFor(assignment.id)).find((log) => log.action === "NOTICE_WITHDRAWN");
    assert.deepEqual(noticeLog.metadata, {
      fromStatus: "NOTICE_PERIOD",
      toStatus: "ACTIVE",
      previousPlannedExitDate: plannedExitDate,
      withdrawnLeaveRequestIds: [created.id],
    });

    expectData(await run(as(tenant), CREATE, createInput(assignment)));
  });

  it("withdraws notice given by an owner, with no request to withdraw", async () => {
    const { owner, assignment } = await lease();
    expectData(await run(as(owner), GIVE_NOTICE, { tenantAssignmentId: assignment.id, plannedExitDate: daysFromToday(30) }));

    expectData(await run(as(owner), WITHDRAW_NOTICE, { tenantAssignmentId: assignment.id }));

    const noticeLog = (await logsFor(assignment.id)).find((log) => log.action === "NOTICE_WITHDRAWN");
    assert.deepEqual(noticeLog.metadata.withdrawnLeaveRequestIds, []);
  });

  it("leaves rejected and pending requests alone", async () => {
    const { owner, assignment } = await lease({ assignmentOptions: { status: "NOTICE_PERIOD" } });
    const rejected = await createLeaveRequest(assignment, { status: "REJECTED", respondedAt: new Date() });
    const pending = await createLeaveRequest(assignment);

    expectData(await run(as(owner), WITHDRAW_NOTICE, { tenantAssignmentId: assignment.id }));

    assert.equal((await storedRequest(rejected)).status, "REJECTED");
    assert.equal((await storedRequest(pending)).status, "PENDING");
  });

  it("refuses a lease that is not in its notice period, and the tenant", async () => {
    for (const status of ["ACTIVE", "EXITED"]) {
      const { owner, assignment } = await lease({ assignmentOptions: { status } });
      expectError(await run(as(owner), WITHDRAW_NOTICE, { tenantAssignmentId: assignment.id }), "CONFLICT", MESSAGES.NOT_IN_NOTICE);
    }

    const { tenant, assignment } = await lease({ assignmentOptions: { status: "NOTICE_PERIOD" } });
    expectError(await run(as(tenant), WITHDRAW_NOTICE, { tenantAssignmentId: assignment.id }), "FORBIDDEN", MESSAGES.ACCESS_NOT_ALLOWED);
  });
});

describe("exit from NOTICE_PERIOD", () => {
  it("still exits manually and keeps the planned exit date as history", async () => {
    const { owner, assignment } = await lease();
    const plannedExitDate = daysFromToday(14);
    expectData(await run(as(owner), GIVE_NOTICE, { tenantAssignmentId: assignment.id, plannedExitDate }));

    const data = expectData(await run(as(owner), EXIT, { id: assignment.id }));

    assert.equal(data.exitTenantAssignment.status, "EXITED");
    assert.equal(data.exitTenantAssignment.plannedExitDate, plannedExitDate);
    assert.ok(data.exitTenantAssignment.actualExitDate);
  });
});

describe("leaveRequestsByAssignment", () => {
  it("lists to the tenant and the owners, newest first, with a status filter and paging", async () => {
    const { owner, coOwner, tenant, assignment } = await lease();
    const older = await createLeaveRequest(assignment, { status: "REJECTED", createdAt: new Date("2026-10-01T00:00:00.000Z") });
    const newer = await createLeaveRequest(assignment, { createdAt: new Date("2026-11-01T00:00:00.000Z") });

    for (const reader of [tenant, owner, coOwner]) {
      const data = expectData(await run(as(reader), BY_ASSIGNMENT, { tenantAssignmentId: assignment.id }));
      assert.deepEqual(data.leaveRequestsByAssignment.items.map((item) => item.id), [newer.id, older.id]);
    }

    const filtered = expectData(await run(as(tenant), BY_ASSIGNMENT, { tenantAssignmentId: assignment.id, status: "REJECTED" }));
    assert.deepEqual(filtered.leaveRequestsByAssignment.items.map((item) => item.id), [older.id]);

    const first = expectData(await run(as(owner), BY_ASSIGNMENT, { tenantAssignmentId: assignment.id, first: 1 }));
    assert.equal(first.leaveRequestsByAssignment.pageInfo.hasNextPage, true);
    const second = expectData(
      await run(as(owner), BY_ASSIGNMENT, {
        tenantAssignmentId: assignment.id,
        first: 1,
        after: first.leaveRequestsByAssignment.pageInfo.nextCursor,
      }),
    );
    assert.deepEqual(second.leaveRequestsByAssignment.items.map((item) => item.id), [older.id]);
  });

  it("stays readable for the tenant of a BLOCKED account, and is hidden from unrelated users", async () => {
    const { owner, tenant, assignment } = await lease({ accountOptions: { status: "BLOCKED" } });

    expectData(await run(as(tenant), BY_ASSIGNMENT, { tenantAssignmentId: assignment.id }));
    expectError(await run(as(owner), BY_ASSIGNMENT, { tenantAssignmentId: assignment.id }), "FORBIDDEN", MESSAGES.STATUS_NOT_ALLOWED);
    expectError(await run(as(await createUser()), BY_ASSIGNMENT, { tenantAssignmentId: assignment.id }), "NOT_FOUND");
  });
});

describe("leaveRequestsByHouse", () => {
  it("lists every assignment's requests on the house to owners, with a status filter", async () => {
    const { owner, house, assignment } = await lease();
    const second = await createAssignment(house, await createUser());
    const pending = await createLeaveRequest(assignment, { createdAt: new Date("2026-11-01T00:00:00.000Z") });
    const approved = await createLeaveRequest(second, { status: "APPROVED", respondedAt: new Date(), createdAt: new Date("2026-11-02T00:00:00.000Z") });

    const all = expectData(await run(as(owner), BY_HOUSE, { houseId: house.id }));
    assert.deepEqual(all.leaveRequestsByHouse.items.map((item) => item.id), [approved.id, pending.id]);

    const filtered = expectData(await run(as(owner), BY_HOUSE, { houseId: house.id, status: "PENDING" }));
    assert.deepEqual(filtered.leaveRequestsByHouse.items.map((item) => [item.id, item.tenantAssignmentId]), [[pending.id, assignment.id]]);
  });

  it("is owners only", async () => {
    const { tenant, house } = await lease();

    expectError(await run(as(tenant), BY_HOUSE, { houseId: house.id }), "NOT_FOUND", MESSAGES.HOUSE_NOT_FOUND);
  });
});

describe("database constraints", () => {
  it("allows one PENDING request per assignment, and more once it is answered", async () => {
    const { assignment } = await lease();
    const first = await createLeaveRequest(assignment);

    await assert.rejects(
      createLeaveRequest(assignment),
      (error) => error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002",
    );

    await prisma.leaveRequest.update({ where: { id: first.id }, data: { status: "REJECTED" } });
    await createLeaveRequest(assignment);
  });
});
