import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { schema } from "../../src/graphql/rootSchema.js";
import { prisma, resetDatabase } from "../support/db.js";
import {
  addMember,
  contextFor,
  createAssignment,
  createHouse,
  createIssue,
  createOwnerAccount,
  createUser,
} from "../support/factories.js";
import { expectData, expectError, run } from "../support/graphql.js";

const FIELDS = "id tenantAssignmentId houseId title description status createdAt updatedAt";
const CREATE = `mutation ($input: CreateIssueInput!) { createIssue(input: $input) { ${FIELDS} } }`;
const UPDATE = `mutation ($input: UpdateIssueStatusInput!) { updateIssueStatus(input: $input) { ${FIELDS} } }`;
const GET = `query ($id: ID!) { issue(id: $id) { ${FIELDS} } }`;
const BY_ASSIGNMENT = `query ($tenantAssignmentId: ID!, $status: IssueStatus, $first: Int, $after: String) { issuesByAssignment(tenantAssignmentId: $tenantAssignmentId, status: $status, first: $first, after: $after) { items { id status } pageInfo { nextCursor hasNextPage } } }`;
const BY_HOUSE = `query ($houseId: ID!, $status: IssueStatus, $first: Int, $after: String) { issuesByHouse(houseId: $houseId, status: $status, first: $first, after: $after) { items { id status } pageInfo { nextCursor hasNextPage } } }`;

const STATUSES = Object.freeze(["OPEN", "IN_PROGRESS", "RESOLVED", "CLOSED"]);
const ALLOWED = Object.freeze({
  OWNER: Object.freeze(["OPEN>IN_PROGRESS", "OPEN>RESOLVED", "IN_PROGRESS>RESOLVED"]),
  TENANT: Object.freeze(["RESOLVED>CLOSED", "RESOLVED>OPEN", "OPEN>CLOSED"]),
});
const MESSAGES = Object.freeze({
  TRANSITION_NOT_ALLOWED: "This status change is not allowed for this issue.",
  NOT_ACTIVE: "This tenant assignment is no longer active.",
  ACCESS_NOT_ALLOWED: "This action is not available to you.",
  STATUS_NOT_ALLOWED: "This action is not available for the owner account in its current state.",
  ASSIGNMENT_NOT_FOUND: "Tenant assignment not found.",
  ISSUE_NOT_FOUND: "Issue not found.",
  HOUSE_NOT_FOUND: "House not found.",
});

async function lease({ accountStatus = "APPROVED", assignmentStatus = "ACTIVE" } = {}) {
  const [owner, coOwner, tenant] = await Promise.all([createUser(), createUser(), createUser()]);
  const account = await createOwnerAccount(owner, { status: accountStatus });
  await addMember(account, coOwner);
  const house = await createHouse(account);
  const assignment = await createAssignment(house, tenant, { status: assignmentStatus });
  return { owner, coOwner, tenant, account, house, assignment };
}

function createInput(assignment, overrides = {}) {
  return { tenantAssignmentId: assignment.id, title: "Broken heater", description: "The bedroom heater does not turn on.", ...overrides };
}

function create(user, assignment, overrides) {
  return run(contextFor(user), CREATE, { input: createInput(assignment, overrides) });
}

function update(user, issue, status) {
  return run(contextFor(user), UPDATE, { input: { id: issue.id, status } });
}

function statusLogs(issue) {
  return prisma.activityLog.findMany({ where: { entityId: issue.id, action: "STATUS_CHANGED" } });
}

async function storedStatus(issue) {
  return (await prisma.issue.findUnique({ where: { id: issue.id } })).status;
}

function pairs() {
  return STATUSES.flatMap((from) => STATUSES.map((to) => ({ from, to, key: `${from}>${to}` })));
}

function fieldPaths(error) {
  return error.extensions.fieldErrors.map((entry) => entry.path);
}

async function assertChanged(user, issue, { from, to, actorRole }) {
  const updated = expectData(await update(user, issue, to)).updateIssueStatus;
  assert.equal(updated.status, to);
  assert.equal(await storedStatus(issue), to);

  const logs = await statusLogs(issue);
  assert.equal(logs.length, 1);
  assert.equal(logs[0].performedByUserId, user.id);
  assert.deepEqual(logs[0].metadata, { fromStatus: from, toStatus: to, actorRole });
}

async function assertRefused(user, issue, from, to, message = MESSAGES.TRANSITION_NOT_ALLOWED) {
  expectError(await update(user, issue, to), "CONFLICT", message);
  assert.equal(await storedStatus(issue), from);
  assert.equal((await statusLogs(issue)).length, 0);
}

beforeEach(resetDatabase);

describe("createIssue", () => {
  it("creates an OPEN issue for the tenant, copies houseId from the assignment and logs it", async () => {
    const { tenant, house, assignment } = await lease();
    const issue = expectData(await create(tenant, assignment, { title: "  Broken heater  ", description: "  Cold room.  " })).createIssue;

    assert.equal(issue.status, "OPEN");
    assert.equal(issue.houseId, house.id);
    assert.equal(issue.tenantAssignmentId, assignment.id);
    assert.equal(issue.title, "Broken heater");
    assert.equal(issue.description, "Cold room.");
    assert.equal((await prisma.issue.findUnique({ where: { id: issue.id } })).houseId, house.id);

    const logs = await prisma.activityLog.findMany({ where: { entityId: issue.id } });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].entityType, "Issue");
    assert.equal(logs[0].action, "CREATED");
    assert.equal(logs[0].performedByUserId, tenant.id);
    assert.deepEqual(logs[0].metadata, { tenantAssignmentId: assignment.id, houseId: house.id, title: "Broken heater" });
  });

  it("works on a NOTICE_PERIOD assignment and gives CONFLICT on an EXITED one", async () => {
    const notice = await lease({ assignmentStatus: "NOTICE_PERIOD" });
    const exited = await lease({ assignmentStatus: "EXITED" });

    expectData(await create(notice.tenant, notice.assignment));
    expectError(await create(exited.tenant, exited.assignment), "CONFLICT", MESSAGES.NOT_ACTIVE);
    assert.equal(await prisma.issue.count({ where: { tenantAssignmentId: exited.assignment.id } }), 0);
    assert.equal(await prisma.activityLog.count({ where: { entityType: "Issue" } }), 1);
  });

  it("gives FORBIDDEN to owners and NOT_FOUND to strangers", async () => {
    const { owner, coOwner, assignment } = await lease();

    for (const user of [owner, coOwner]) {
      expectError(await create(user, assignment), "FORBIDDEN", MESSAGES.ACCESS_NOT_ALLOWED);
    }

    expectError(await create(await createUser(), assignment), "NOT_FOUND", MESSAGES.ASSIGNMENT_NOT_FOUND);
    assert.equal(await prisma.issue.count(), 0);
  });

  it("gives FORBIDDEN to the tenant unless the account is APPROVED", async () => {
    for (const accountStatus of ["PENDING", "BLOCKED", "PENDING_DELETION"]) {
      const { tenant, assignment } = await lease({ accountStatus });
      expectError(await create(tenant, assignment), "FORBIDDEN", MESSAGES.STATUS_NOT_ALLOWED);
    }

    assert.equal(await prisma.issue.count(), 0);
  });

  it("accepts a title of 1 to 120 and a description of 1 to 5000 characters after trimming", async () => {
    const { tenant, assignment } = await lease();

    for (const overrides of [
      { title: "x" },
      { title: "x".repeat(120) },
      { title: ` ${"x".repeat(120)} ` },
      { description: "x" },
      { description: "x".repeat(5000) },
    ]) {
      expectData(await create(tenant, assignment, overrides));
    }
  });

  it("refuses empty, blank and over-long titles and descriptions and writes nothing", async () => {
    const { tenant, assignment } = await lease();

    for (const [overrides, path] of [
      [{ title: "" }, "input.title"],
      [{ title: "   " }, "input.title"],
      [{ title: "x".repeat(121) }, "input.title"],
      [{ description: "" }, "input.description"],
      [{ description: "   " }, "input.description"],
      [{ description: "x".repeat(5001) }, "input.description"],
    ]) {
      const error = expectError(await create(tenant, assignment, overrides), "BAD_USER_INPUT");
      assert.deepEqual(fieldPaths(error), [path]);
    }

    assert.equal(await prisma.issue.count(), 0);
    assert.equal(await prisma.activityLog.count({ where: { entityType: "Issue" } }), 0);
  });
});

describe("updateIssueStatus transitions", () => {
  for (const role of ["OWNER", "TENANT"]) {
    for (const { from, to, key } of pairs()) {
      const allowed = ALLOWED[role].includes(key);

      it(`${role} ${from} -> ${to} is ${allowed ? "allowed and logged" : "refused with CONFLICT"}`, async () => {
        const { coOwner, tenant, assignment } = await lease();
        const actor = role === "OWNER" ? coOwner : tenant;
        const issue = await createIssue(assignment, { status: from });

        if (allowed) {
          await assertChanged(actor, issue, { from, to, actorRole: role });
        } else {
          await assertRefused(actor, issue, from, to);
        }
      });
    }
  }

  it("lets the PRIMARY owner make owner transitions too", async () => {
    const { owner, assignment } = await lease();
    const issue = await createIssue(assignment);

    await assertChanged(owner, issue, { from: "OPEN", to: "IN_PROGRESS", actorRole: "OWNER" });
  });

  it("blocks tenant transitions after exit while owner transitions still work", async () => {
    const { coOwner, tenant, assignment } = await lease({ assignmentStatus: "EXITED" });
    const resolved = await createIssue(assignment, { status: "RESOLVED" });
    const open = await createIssue(assignment, { status: "OPEN" });

    await assertRefused(tenant, resolved, "RESOLVED", "CLOSED", MESSAGES.NOT_ACTIVE);
    await assertRefused(tenant, open, "OPEN", "CLOSED", MESSAGES.NOT_ACTIVE);
    await assertChanged(coOwner, open, { from: "OPEN", to: "IN_PROGRESS", actorRole: "OWNER" });
  });

  it("gives a self-tenant both transition tables, owner first, and drops the tenant one after exit", async () => {
    const { owner, house } = await lease();
    const selfAssignment = await createAssignment(house, owner);

    const ownerMove = await createIssue(selfAssignment, { status: "OPEN" });
    await assertChanged(owner, ownerMove, { from: "OPEN", to: "IN_PROGRESS", actorRole: "OWNER" });

    // OPEN -> RESOLVED is only in the owner table; OPEN -> CLOSED only in the tenant table.
    const both = await createIssue(selfAssignment, { status: "OPEN" });
    await assertChanged(owner, both, { from: "OPEN", to: "RESOLVED", actorRole: "OWNER" });

    const tenantMove = await createIssue(selfAssignment, { status: "OPEN" });
    await assertChanged(owner, tenantMove, { from: "OPEN", to: "CLOSED", actorRole: "TENANT" });

    const reopen = await createIssue(selfAssignment, { status: "RESOLVED" });
    await assertChanged(owner, reopen, { from: "RESOLVED", to: "OPEN", actorRole: "TENANT" });

    const neither = await createIssue(selfAssignment, { status: "CLOSED" });
    await assertRefused(owner, neither, "CLOSED", "OPEN");

    await prisma.tenantAssignment.update({ where: { id: selfAssignment.id }, data: { status: "EXITED", actualExitDate: new Date() } });

    const afterExit = await createIssue(selfAssignment, { status: "RESOLVED" });
    await assertRefused(owner, afterExit, "RESOLVED", "CLOSED", MESSAGES.NOT_ACTIVE);

    const ownerAfterExit = await createIssue(selfAssignment, { status: "IN_PROGRESS" });
    await assertChanged(owner, ownerAfterExit, { from: "IN_PROGRESS", to: "RESOLVED", actorRole: "OWNER" });
  });

  it("gives FORBIDDEN to owners and the tenant unless the account is APPROVED", async () => {
    for (const accountStatus of ["PENDING", "BLOCKED", "PENDING_DELETION"]) {
      const { coOwner, tenant, assignment } = await lease({ accountStatus });
      const open = await createIssue(assignment, { status: "OPEN" });
      const resolved = await createIssue(assignment, { status: "RESOLVED" });

      expectError(await update(coOwner, open, "IN_PROGRESS"), "FORBIDDEN", MESSAGES.STATUS_NOT_ALLOWED);
      expectError(await update(tenant, resolved, "CLOSED"), "FORBIDDEN", MESSAGES.STATUS_NOT_ALLOWED);
      assert.equal(await storedStatus(open), "OPEN");
      assert.equal(await storedStatus(resolved), "RESOLVED");
    }
  });

  it("gives NOT_FOUND to strangers and for a missing issue", async () => {
    const { owner, assignment } = await lease();
    const issue = await createIssue(assignment);

    expectError(await update(await createUser(), issue, "CLOSED"), "NOT_FOUND", MESSAGES.ISSUE_NOT_FOUND);
    expectError(await update(owner, { id: "cjld2cjxh0000qzrmn831i7rn" }, "IN_PROGRESS"), "NOT_FOUND", MESSAGES.ISSUE_NOT_FOUND);
    assert.equal(await storedStatus(issue), "OPEN");
  });

  it("the schema has no issue delete or edit mutation besides status changes", () => {
    const mutations = Object.keys(schema.getMutationType().getFields());

    assert.deepEqual(mutations.filter((name) => /issue/i.test(name)).sort(), ["createIssue", "updateIssueStatus"]);
  });
});

describe("issue reads", () => {
  const cases = [
    { accountStatus: "APPROVED", owner: true, tenant: true },
    { accountStatus: "PENDING_DELETION", owner: true, tenant: true },
    { accountStatus: "BLOCKED", owner: false, tenant: true },
    { accountStatus: "PENDING", owner: false, tenant: false },
  ];

  for (const { accountStatus, owner: ownerAllowed, tenant: tenantAllowed } of cases) {
    it(`on a ${accountStatus} account: owners ${ownerAllowed ? "read" : "are refused"}, the tenant ${tenantAllowed ? "reads" : "is refused"}`, async () => {
      const { owner, coOwner, tenant, house, assignment } = await lease({ accountStatus });
      const issue = await createIssue(assignment);

      for (const [user, allowed] of [[owner, ownerAllowed], [coOwner, ownerAllowed], [tenant, tenantAllowed]]) {
        const single = await run(contextFor(user), GET, { id: issue.id });
        const list = await run(contextFor(user), BY_ASSIGNMENT, { tenantAssignmentId: assignment.id });

        if (allowed) {
          assert.deepEqual(structuredClone(expectData(single).issue), {
            id: issue.id,
            tenantAssignmentId: assignment.id,
            houseId: house.id,
            title: "Leaking tap",
            description: "The kitchen tap drips.",
            status: "OPEN",
            createdAt: issue.createdAt.toISOString(),
            updatedAt: issue.updatedAt.toISOString(),
          });
          assert.deepEqual(expectData(list).issuesByAssignment.items.map((item) => item.id), [issue.id]);
        } else {
          expectError(single, "FORBIDDEN", MESSAGES.STATUS_NOT_ALLOWED);
          expectError(list, "FORBIDDEN", MESSAGES.STATUS_NOT_ALLOWED);
        }
      }

      const byHouse = await run(contextFor(coOwner), BY_HOUSE, { houseId: house.id });
      if (ownerAllowed) {
        assert.deepEqual(expectData(byHouse).issuesByHouse.items.map((item) => item.id), [issue.id]);
      } else {
        expectError(byHouse, "FORBIDDEN", MESSAGES.STATUS_NOT_ALLOWED);
      }
    });
  }

  it("gives NOT_FOUND to strangers on every read, and to the tenant on issuesByHouse", async () => {
    const { tenant, house, assignment } = await lease();
    const issue = await createIssue(assignment);
    const stranger = await createUser();

    expectError(await run(contextFor(stranger), GET, { id: issue.id }), "NOT_FOUND", MESSAGES.ISSUE_NOT_FOUND);
    expectError(await run(contextFor(stranger), BY_ASSIGNMENT, { tenantAssignmentId: assignment.id }), "NOT_FOUND", MESSAGES.ASSIGNMENT_NOT_FOUND);
    expectError(await run(contextFor(stranger), BY_HOUSE, { houseId: house.id }), "NOT_FOUND", MESSAGES.HOUSE_NOT_FOUND);
    expectError(await run(contextFor(tenant), BY_HOUSE, { houseId: house.id }), "NOT_FOUND", MESSAGES.HOUSE_NOT_FOUND);
  });

  it("issuesByAssignment filters by status and pages newest first", async () => {
    const { tenant, house, assignment } = await lease();
    const other = await createAssignment(house, await createUser());
    await createIssue(other, { status: "OPEN" });

    const base = Date.parse("2026-11-10T00:00:00.000Z");
    const statuses = ["OPEN", "RESOLVED", "OPEN", "CLOSED", "OPEN"];
    const issues = [];
    for (const [index, status] of statuses.entries()) {
      issues.push(await createIssue(assignment, { status, createdAt: new Date(base + index * 60_000) }));
    }

    const all = expectData(await run(contextFor(tenant), BY_ASSIGNMENT, { tenantAssignmentId: assignment.id })).issuesByAssignment;
    assert.deepEqual(all.items.map((item) => item.id), issues.map((issue) => issue.id).reverse());

    const firstPage = expectData(await run(contextFor(tenant), BY_ASSIGNMENT, { tenantAssignmentId: assignment.id, status: "OPEN", first: 2 })).issuesByAssignment;
    const secondPage = expectData(await run(contextFor(tenant), BY_ASSIGNMENT, { tenantAssignmentId: assignment.id, status: "OPEN", first: 2, after: firstPage.pageInfo.nextCursor })).issuesByAssignment;

    assert.equal(firstPage.pageInfo.hasNextPage, true);
    assert.equal(secondPage.pageInfo.hasNextPage, false);
    assert.equal(secondPage.pageInfo.nextCursor, null);
    assert.deepEqual(
      [...firstPage.items, ...secondPage.items].map((item) => item.id),
      [issues[4].id, issues[2].id, issues[0].id],
    );

    const closed = expectData(await run(contextFor(tenant), BY_ASSIGNMENT, { tenantAssignmentId: assignment.id, status: "CLOSED" })).issuesByAssignment;
    assert.deepEqual(closed.items.map((item) => item.id), [issues[3].id]);
  });

  it("issuesByHouse covers every assignment on the house, EXITED included, with status filter and paging", async () => {
    const { owner, house, assignment } = await lease();
    const exited = await createAssignment(house, await createUser(), { status: "EXITED" });
    const elsewhere = await createAssignment(await createHouse((await lease()).account), await createUser());
    await createIssue(elsewhere);

    const base = Date.parse("2026-11-10T00:00:00.000Z");
    const first = await createIssue(assignment, { status: "OPEN", createdAt: new Date(base) });
    const second = await createIssue(exited, { status: "IN_PROGRESS", createdAt: new Date(base + 60_000) });
    const third = await createIssue(assignment, { status: "OPEN", createdAt: new Date(base + 120_000) });

    const pageOne = expectData(await run(contextFor(owner), BY_HOUSE, { houseId: house.id, first: 2 })).issuesByHouse;
    const pageTwo = expectData(await run(contextFor(owner), BY_HOUSE, { houseId: house.id, first: 2, after: pageOne.pageInfo.nextCursor })).issuesByHouse;
    assert.deepEqual([...pageOne.items, ...pageTwo.items].map((item) => item.id), [third.id, second.id, first.id]);

    const open = expectData(await run(contextFor(owner), BY_HOUSE, { houseId: house.id, status: "OPEN" })).issuesByHouse;
    assert.deepEqual(open.items.map((item) => item.id), [third.id, first.id]);

    const resolved = expectData(await run(contextFor(owner), BY_HOUSE, { houseId: house.id, status: "RESOLVED" })).issuesByHouse;
    assert.deepEqual(structuredClone(resolved), { items: [], pageInfo: { nextCursor: null, hasNextPage: false } });
  });
});
