import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { prisma, resetDatabase } from "../support/db.js";
import {
  contextFor,
  createAssignment,
  createHouse,
  createLeaveRequest,
  createOwnerAccount,
  createUser,
} from "../support/factories.js";
import { race, run } from "../support/graphql.js";

const ROUNDS = 5;
const PLANNED_EXIT_DATE = "2099-06-30";

const CREATE = `mutation ($input: CreateLeaveRequestInput!) { createLeaveRequest(input: $input) { id } }`;
const WITHDRAW = `mutation ($id: ID!) { withdrawLeaveRequest(id: $id) { id status } }`;
const APPROVE = `mutation ($id: ID!) { approveLeaveRequest(id: $id) { id status } }`;
const GIVE_NOTICE = `mutation ($tenantAssignmentId: ID!, $plannedExitDate: Date!) {
  giveNotice(tenantAssignmentId: $tenantAssignmentId, plannedExitDate: $plannedExitDate) { id status } }`;
const EXIT = `mutation ($id: ID!) { exitTenantAssignment(id: $id) { id status } }`;

const MESSAGES = Object.freeze({
  ALREADY_PENDING: "This tenant assignment already has a pending leave request.",
  NOT_PENDING: "This leave request is no longer pending.",
  NOTICE_NEEDS_ACTIVE: "Only an active tenant assignment can be given notice.",
});

async function lease() {
  const [owner, tenant] = await Promise.all([createUser(), createUser()]);
  const account = await createOwnerAccount(owner);
  const house = await createHouse(account);
  const assignment = await createAssignment(house, tenant);
  return { owner, tenant, assignment };
}

function stored(model, id) {
  return prisma[model].findUnique({ where: { id } });
}

beforeEach(resetDatabase);

describe("approveLeaveRequest racing withdrawLeaveRequest", () => {
  it("lets exactly one win and keeps the request and the lease consistent", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { owner, tenant, assignment } = await lease();
      const request = await createLeaveRequest(assignment);

      const [approve, withdraw] = await race([
        () => run(contextFor(owner), APPROVE, { id: request.id }),
        () => run(contextFor(tenant), WITHDRAW, { id: request.id }),
      ]);

      assert.equal([approve, withdraw].filter((outcome) => outcome.ok).length, 1, `round ${round}`);
      const loser = approve.ok ? withdraw : approve;
      assert.deepEqual([loser.code, loser.message], ["CONFLICT", MESSAGES.NOT_PENDING]);

      const [storedRequest, storedAssignment] = await Promise.all([
        stored("leaveRequest", request.id),
        stored("tenantAssignment", assignment.id),
      ]);

      if (approve.ok) {
        assert.equal(storedRequest.status, "APPROVED");
        assert.equal(storedAssignment.status, "NOTICE_PERIOD");
        assert.ok(storedAssignment.plannedExitDate);
      } else {
        assert.equal(storedRequest.status, "WITHDRAWN");
        assert.equal(storedAssignment.status, "ACTIVE");
        assert.equal(storedAssignment.plannedExitDate, null);
      }
    }
  });
});

describe("giveNotice racing exitTenantAssignment", () => {
  it("always exits; notice either commits first or gets CONFLICT; never a deadlock", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { owner, assignment } = await lease();

      const [notice, exit] = await race([
        () => run(contextFor(owner), GIVE_NOTICE, { tenantAssignmentId: assignment.id, plannedExitDate: PLANNED_EXIT_DATE }),
        () => run(contextFor(owner), EXIT, { id: assignment.id }),
      ]);

      assert.ok(exit.ok, `round ${round}: exit failed with ${exit.code}`);

      if (!notice.ok) {
        assert.deepEqual([notice.code, notice.message], ["CONFLICT", MESSAGES.NOTICE_NEEDS_ACTIVE]);
      }

      const storedAssignment = await stored("tenantAssignment", assignment.id);
      assert.equal(storedAssignment.status, "EXITED");
      assert.equal(storedAssignment.plannedExitDate === null, !notice.ok);
    }
  });
});

describe("approveLeaveRequest racing giveNotice", () => {
  it("starts exactly one notice period", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { owner, assignment } = await lease();
      const request = await createLeaveRequest(assignment);

      const [approve, notice] = await race([
        () => run(contextFor(owner), APPROVE, { id: request.id }),
        () => run(contextFor(owner), GIVE_NOTICE, { tenantAssignmentId: assignment.id, plannedExitDate: PLANNED_EXIT_DATE }),
      ]);

      assert.equal([approve, notice].filter((outcome) => outcome.ok).length, 1, `round ${round}`);
      const loser = approve.ok ? notice : approve;
      assert.deepEqual([loser.code, loser.message], ["CONFLICT", MESSAGES.NOTICE_NEEDS_ACTIVE]);

      const storedRequest = await stored("leaveRequest", request.id);
      assert.equal(storedRequest.status, approve.ok ? "APPROVED" : "PENDING");
      const notices = await prisma.activityLog.count({ where: { entityId: assignment.id, action: "NOTICE_GIVEN" } });
      assert.equal(notices, 1);
    }
  });
});

describe("two createLeaveRequest calls on one lease", () => {
  it("creates exactly one pending request", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { tenant, assignment } = await lease();
      const input = { input: { tenantAssignmentId: assignment.id, requestedExitDate: PLANNED_EXIT_DATE } };

      const outcomes = await race([
        () => run(contextFor(tenant), CREATE, input),
        () => run(contextFor(tenant), CREATE, input),
      ]);

      assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1, `round ${round}`);
      const loser = outcomes.find((outcome) => !outcome.ok);
      assert.deepEqual([loser.code, loser.message], ["CONFLICT", MESSAGES.ALREADY_PENDING]);
      assert.equal(await prisma.leaveRequest.count({ where: { tenantAssignmentId: assignment.id } }), 1);
    }
  });
});
