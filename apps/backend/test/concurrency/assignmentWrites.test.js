import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { prisma, resetDatabase } from "../support/db.js";
import {
  contextFor,
  createAssignment,
  createHouse,
  createInvitation,
  createIssue,
  createOwnerAccount,
  createUser,
} from "../support/factories.js";
import { race, run } from "../support/graphql.js";

const ROUNDS = 5;
const EXIT = `mutation ($id: ID!) { exitTenantAssignment(id: $id) { id status } }`;
const ACCEPT = `mutation ($id: ID!) { acceptInvitation(id: $id) { id status } }`;
const CREATE_RECEIPT = `mutation ($input: CreateReceiptInput!) { createReceipt(input: $input) { id } }`;
const CREATE_ISSUE = `mutation ($input: CreateIssueInput!) { createIssue(input: $input) { id } }`;
const UPDATE_ISSUE = `mutation ($input: UpdateIssueStatusInput!) { updateIssueStatus(input: $input) { id status } }`;
const MESSAGES = Object.freeze({
  NOT_ACTIVE: "This tenant assignment is no longer active.",
  HOUSE_FULL: "This house has no free tenant places.",
  TRANSITION_NOT_ALLOWED: "This status change is not allowed for this issue.",
  STATUS_CHANGED: "The issue changed while this request was running. Try again.",
});

async function lease({ maxTenants = 3 } = {}) {
  const [owner, tenant] = await Promise.all([createUser(), createUser()]);
  const account = await createOwnerAccount(owner);
  const house = await createHouse(account, { maxTenants });
  const assignment = await createAssignment(house, tenant);
  return { owner, tenant, account, house, assignment };
}

async function assertOccupancyMatches(house) {
  const [row, active] = await Promise.all([
    prisma.house.findUnique({ where: { id: house.id } }),
    prisma.tenantAssignment.count({ where: { houseId: house.id, status: { in: ["ACTIVE", "NOTICE_PERIOD"] } } }),
  ]);

  assert.ok(active <= row.maxTenants, `active ${active} exceeds maxTenants ${row.maxTenants}`);
  assert.equal(row.status, active > 0 ? "OCCUPIED" : "VACANT", `house ${row.status} with ${active} active assignments`);
  return active;
}

async function assertExited(assignment) {
  assert.equal((await prisma.tenantAssignment.findUnique({ where: { id: assignment.id } })).status, "EXITED");
}

beforeEach(resetDatabase);

describe("concurrent updateIssueStatus", () => {
  it("lets exactly one of two owners move an issue out of the same status", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { owner, account, assignment } = await lease();
      const coOwner = await createUser();
      await prisma.ownerAccountMember.create({ data: { ownerAccountId: account.id, userId: coOwner.id, role: "CO_OWNER" } });
      const issue = await createIssue(assignment, { status: "OPEN" });
      const input = { id: issue.id, status: "IN_PROGRESS" };

      const outcomes = await race([
        () => run(contextFor(owner), UPDATE_ISSUE, { input }),
        () => run(contextFor(coOwner), UPDATE_ISSUE, { input }),
      ]);

      assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1, `round ${round}`);
      const loser = outcomes.find((outcome) => !outcome.ok);
      assert.equal(loser.code, "CONFLICT");
      assert.ok([MESSAGES.STATUS_CHANGED, MESSAGES.TRANSITION_NOT_ALLOWED].includes(loser.message), loser.message);

      assert.equal((await prisma.issue.findUnique({ where: { id: issue.id } })).status, "IN_PROGRESS");
      assert.equal(await prisma.activityLog.count({ where: { entityId: issue.id, action: "STATUS_CHANGED" } }), 1);
    }
  });

  it("lets exactly one of an owner and the tenant move an OPEN issue", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { owner, tenant, assignment } = await lease();
      const issue = await createIssue(assignment, { status: "OPEN" });

      const [ownerMove, tenantMove] = await race([
        () => run(contextFor(owner), UPDATE_ISSUE, { input: { id: issue.id, status: "IN_PROGRESS" } }),
        () => run(contextFor(tenant), UPDATE_ISSUE, { input: { id: issue.id, status: "CLOSED" } }),
      ]);

      assert.equal(Number(ownerMove.ok) + Number(tenantMove.ok), 1, `round ${round}`);
      assert.equal((ownerMove.ok ? tenantMove : ownerMove).code, "CONFLICT");

      const stored = await prisma.issue.findUnique({ where: { id: issue.id } });
      assert.equal(stored.status, ownerMove.ok ? "IN_PROGRESS" : "CLOSED");

      const logs = await prisma.activityLog.findMany({ where: { entityId: issue.id, action: "STATUS_CHANGED" } });
      assert.equal(logs.length, 1);
      assert.equal(logs[0].metadata.actorRole, ownerMove.ok ? "OWNER" : "TENANT");
    }
  });
});

describe("createReceipt racing exitTenantAssignment", () => {
  it("always exits; the receipt either commits first or gets CONFLICT; never a deadlock", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { owner, tenant, house, assignment } = await lease();
      const input = { tenantAssignmentId: assignment.id, amountCents: 10_000, paidAt: "2026-11-01" };

      const [receipt, exit] = await race([
        () => run(contextFor(tenant), CREATE_RECEIPT, { input }),
        () => run(contextFor(owner), EXIT, { id: assignment.id }),
      ]);

      assert.ok(exit.ok, `round ${round}: exit failed with ${exit.code}`);
      if (!receipt.ok) {
        assert.equal(receipt.code, "CONFLICT");
        assert.equal(receipt.message, MESSAGES.NOT_ACTIVE);
      }

      await assertExited(assignment);
      const receipts = await prisma.receipt.findMany({ where: { tenantAssignmentId: assignment.id }, select: { id: true } });
      const receiptIds = receipts.map((row) => row.id);
      assert.equal(receipts.length, receipt.ok ? 1 : 0);
      assert.equal(await prisma.activityLog.count({ where: { entityType: "Receipt", entityId: { in: receiptIds } } }), receiptIds.length);
      await assertOccupancyMatches(house);
    }
  });
});

describe("createIssue racing exitTenantAssignment", () => {
  it("always exits; the issue either commits first or gets CONFLICT; never a deadlock", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { owner, tenant, house, assignment } = await lease();
      const input = { tenantAssignmentId: assignment.id, title: "Broken heater", description: "No heat in the bedroom." };

      const [issue, exit] = await race([
        () => run(contextFor(tenant), CREATE_ISSUE, { input }),
        () => run(contextFor(owner), EXIT, { id: assignment.id }),
      ]);

      assert.ok(exit.ok, `round ${round}: exit failed with ${exit.code}`);
      if (!issue.ok) {
        assert.equal(issue.code, "CONFLICT");
        assert.equal(issue.message, MESSAGES.NOT_ACTIVE);
      }

      await assertExited(assignment);
      assert.equal(await prisma.issue.count({ where: { tenantAssignmentId: assignment.id } }), issue.ok ? 1 : 0);
      await assertOccupancyMatches(house);
    }
  });
});

describe("exitTenantAssignment racing acceptInvitation on the same house", () => {
  it("keeps the house status equal to the real active count when both fit", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { owner, house, assignment } = await lease({ maxTenants: 2 });
      const invitee = await createUser();
      const invitation = await createInvitation(house, owner, { email: invitee.email });

      const [exit, accept] = await race([
        () => run(contextFor(owner), EXIT, { id: assignment.id }),
        () => run(contextFor(invitee), ACCEPT, { id: invitation.id }),
      ]);

      assert.ok(exit.ok, `round ${round}: exit failed with ${exit.code}`);
      assert.ok(accept.ok, `round ${round}: accept failed with ${accept.code}`);
      assert.equal(await assertOccupancyMatches(house), 1);
    }
  });

  it("keeps the house status equal to the real active count when only the exit frees the place", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const { owner, house, assignment } = await lease({ maxTenants: 1 });
      const invitee = await createUser();
      const invitation = await createInvitation(house, owner, { email: invitee.email });

      const [exit, accept] = await race([
        () => run(contextFor(owner), EXIT, { id: assignment.id }),
        () => run(contextFor(invitee), ACCEPT, { id: invitation.id }),
      ]);

      assert.ok(exit.ok, `round ${round}: exit failed with ${exit.code}`);
      if (!accept.ok) {
        assert.equal(accept.code, "CONFLICT");
        assert.equal(accept.message, MESSAGES.HOUSE_FULL);
      }

      assert.equal(await assertOccupancyMatches(house), accept.ok ? 1 : 0);
    }
  });
});
