import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { prisma, resetDatabase } from "../support/db.js";
import {
  addMember,
  contextFor,
  createOwnerAccount,
  createUser,
} from "../support/factories.js";
import { expectData, expectError, run } from "../support/graphql.js";

const FIELDS = "id name status createdAt updatedAt";
const CREATE = `mutation ($name: String!) { createOwnerAccount(name: $name) { ${FIELDS} } }`;
const GET = `query ($id: ID!) { ownerAccount(id: $id) { ${FIELDS} } }`;
const RENAME = `mutation ($id: ID!, $name: String!) { updateOwnerAccount(id: $id, name: $name) { ${FIELDS} } }`;
const MINE = `query ($first: Int, $after: String) { myOwnerAccounts(first: $first, after: $after) { items { id status } pageInfo { nextCursor hasNextPage } } }`;
const ADMIN_LIST = `query ($status: OwnerAccountStatus) { adminOwnerAccounts(status: $status) { items { id status } } }`;
const SCHEDULE = `mutation ($id: ID!) { scheduleOwnerAccountDeletion(id: $id) { ${FIELDS} } }`;
const CANCEL = `mutation ($id: ID!) { cancelOwnerAccountDeletion(id: $id) { ${FIELDS} } }`;

const ADMIN_OPERATIONS = Object.freeze({
  approve: "approveOwnerAccount",
  block: "blockOwnerAccount",
  unblock: "unblockOwnerAccount",
  schedule: "adminScheduleOwnerAccountDeletion",
  cancel: "adminCancelOwnerAccountDeletion",
});

const INVALID_TRANSITION = "This action is not available for the owner account in its current state.";
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MISSING_ID = "cjld2cjxh0000qzrmn831i7rn";

function adminMutation(field, withReason = false) {
  const args = withReason ? "$id: ID!, $reason: String" : "$id: ID!";
  const call = withReason ? `${field}(id: $id, reason: $reason)` : `${field}(id: $id)`;
  return `mutation (${args}) { ${call} { ${FIELDS} } }`;
}

function adminContext(admin) {
  return contextFor(admin, { superAdmin: true });
}

async function adminRun(admin, operation, id, variables = {}) {
  const field = ADMIN_OPERATIONS[operation];
  const source = adminMutation(field, operation === "block");
  const result = await run(adminContext(admin), source, { id, ...variables });
  return { result, field };
}

function activityFor(entityId) {
  return prisma.activityLog.findMany({ where: { entityId }, orderBy: { createdAt: "asc" } });
}

function storedAccount(id) {
  return prisma.ownerAccount.findUnique({ where: { id } });
}

beforeEach(resetDatabase);

describe("createOwnerAccount", () => {
  it("creates a PENDING account with the caller as PRIMARY and logs it", async () => {
    const user = await createUser();
    const { createOwnerAccount: account } = expectData(
      await run(contextFor(user), CREATE, { name: "  Harbour Rentals  " }),
    );

    assert.equal(account.status, "PENDING");
    assert.equal(account.name, "Harbour Rentals");

    const membership = await prisma.ownerAccountMember.findFirst({ where: { ownerAccountId: account.id } });
    assert.equal(membership.userId, user.id);
    assert.equal(membership.role, "PRIMARY");

    const [log] = await activityFor(account.id);
    assert.equal(log.action, "CREATED");
    assert.equal(log.performedByUserId, user.id);
  });

  it("validates the name", async () => {
    const user = await createUser();

    for (const name of ["   ", "x".repeat(101)]) {
      expectError(await run(contextFor(user), CREATE, { name }), "BAD_USER_INPUT");
    }
  });

  it("refuses a sixth PRIMARY account", async () => {
    const user = await createUser();

    for (let index = 0; index < 5; index += 1) {
      expectData(await run(contextFor(user), CREATE, { name: `Account ${index}` }));
    }

    expectError(
      await run(contextFor(user), CREATE, { name: "One too many" }),
      "CONFLICT",
      "You can be the primary owner of at most 5 owner accounts.",
    );
  });

  it("does not count CO_OWNER memberships toward the cap", async () => {
    const [user, other] = await Promise.all([createUser(), createUser()]);

    for (let index = 0; index < 5; index += 1) {
      const account = await createOwnerAccount(other, { name: `Other ${index}` });
      await addMember(account, user);
    }

    expectData(await run(contextFor(user), CREATE, { name: "Mine" }));
  });

  it("holds the cap under concurrent creates", async () => {
    const user = await createUser();

    for (let index = 0; index < 4; index += 1) {
      await createOwnerAccount(user, { name: `Existing ${index}` });
    }

    const results = await Promise.all(
      [1, 2, 3].map((index) => run(contextFor(user), CREATE, { name: `Race ${index}` })),
    );
    const succeeded = results.filter((result) => !result.errors);

    assert.equal(succeeded.length, 1);
    results.filter((result) => result.errors).forEach((result) => expectError(result, "CONFLICT"));
    assert.equal(await prisma.ownerAccountMember.count({ where: { userId: user.id, role: "PRIMARY" } }), 5);
  });
});

describe("reading owner accounts", () => {
  it("lets members read the account while PENDING, APPROVED or PENDING_DELETION", async () => {
    const owner = await createUser();

    for (const status of ["PENDING", "APPROVED", "PENDING_DELETION"]) {
      const account = await createOwnerAccount(owner, { status });
      assert.equal(expectData(await run(contextFor(owner), GET, { id: account.id })).ownerAccount.status, status);
    }
  });

  it("gives FORBIDDEN to members of a BLOCKED account", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner, { status: "BLOCKED" });

    expectError(await run(contextFor(owner), GET, { id: account.id }), "FORBIDDEN");
  });

  it("gives NOT_FOUND to non-members and for missing accounts", async () => {
    const [owner, stranger] = await Promise.all([createUser(), createUser()]);
    const account = await createOwnerAccount(owner);

    expectError(await run(contextFor(stranger), GET, { id: account.id }), "NOT_FOUND");
    expectError(await run(contextFor(owner), GET, { id: MISSING_ID }), "NOT_FOUND");
  });

  it("does not expose deletion fields", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner);
    const result = await run(contextFor(owner), `query ($id: ID!) { ownerAccount(id: $id) { deletionScheduledAt } }`, { id: account.id });

    assert.ok(result.errors?.length);
  });

  it("myOwnerAccounts lists only the caller's accounts in every status, newest first, paginated", async () => {
    const [owner, other] = await Promise.all([createUser(), createUser()]);
    const created = [];

    for (const status of ["PENDING", "APPROVED", "BLOCKED", "PENDING_DELETION"]) {
      created.push(await createOwnerAccount(owner, { status }));
    }
    await createOwnerAccount(other);

    const first = expectData(await run(contextFor(owner), MINE, { first: 3 })).myOwnerAccounts;
    const second = expectData(
      await run(contextFor(owner), MINE, { first: 3, after: first.pageInfo.nextCursor }),
    ).myOwnerAccounts;
    const ids = [...first.items, ...second.items].map((item) => item.id);

    assert.equal(first.pageInfo.hasNextPage, true);
    assert.equal(second.pageInfo.hasNextPage, false);
    assert.deepEqual(ids, created.map((account) => account.id).reverse());
  });

  it("adminOwnerAccounts filters by status for super admins only", async () => {
    const [owner, admin] = await Promise.all([createUser(), createUser()]);
    const pending = await createOwnerAccount(owner, { status: "PENDING" });
    await createOwnerAccount(owner, { status: "APPROVED" });

    const items = expectData(await run(adminContext(admin), ADMIN_LIST, { status: "PENDING" })).adminOwnerAccounts.items;
    assert.deepEqual(items.map((item) => item.id), [pending.id]);

    expectError(await run(contextFor(owner), ADMIN_LIST, {}), "FORBIDDEN");
  });
});

describe("updateOwnerAccount", () => {
  it("lets the PRIMARY rename a PENDING or APPROVED account and logs it", async () => {
    const owner = await createUser();

    for (const status of ["PENDING", "APPROVED"]) {
      const account = await createOwnerAccount(owner, { status });
      const data = expectData(await run(contextFor(owner), RENAME, { id: account.id, name: "Renamed" }));

      assert.equal(data.updateOwnerAccount.name, "Renamed");
      assert.equal((await activityFor(account.id)).at(-1).action, "UPDATED");
    }
  });

  it("gives FORBIDDEN to a CO_OWNER", async () => {
    const [owner, coOwner] = await Promise.all([createUser(), createUser()]);
    const account = await createOwnerAccount(owner);
    await addMember(account, coOwner);

    expectError(
      await run(contextFor(coOwner), RENAME, { id: account.id, name: "Renamed" }),
      "FORBIDDEN",
      "Your role on this owner account does not allow this action.",
    );
  });

  it("gives FORBIDDEN on a BLOCKED or PENDING_DELETION account", async () => {
    const owner = await createUser();

    for (const status of ["BLOCKED", "PENDING_DELETION"]) {
      const account = await createOwnerAccount(owner, { status });
      expectError(await run(contextFor(owner), RENAME, { id: account.id, name: "Renamed" }), "FORBIDDEN");
    }
  });
});

describe("super admin status transitions", () => {
  const cases = [
    { operation: "approve", from: "PENDING", to: "APPROVED", action: "APPROVED" },
    { operation: "block", from: "PENDING", to: "BLOCKED", action: "BLOCKED" },
    { operation: "block", from: "APPROVED", to: "BLOCKED", action: "BLOCKED" },
    { operation: "unblock", from: "BLOCKED", to: "APPROVED", action: "UNBLOCKED" },
    { operation: "schedule", from: "PENDING", to: "PENDING_DELETION", action: "DELETION_SCHEDULED" },
    { operation: "schedule", from: "APPROVED", to: "PENDING_DELETION", action: "DELETION_SCHEDULED" },
    { operation: "schedule", from: "BLOCKED", to: "PENDING_DELETION", action: "DELETION_SCHEDULED" },
  ];

  for (const { operation, from, to, action } of cases) {
    it(`${operation} moves ${from} to ${to} and logs ${action}`, async () => {
      const [owner, admin] = await Promise.all([createUser(), createUser()]);
      const account = await createOwnerAccount(owner, { status: from });
      const { result, field } = await adminRun(admin, operation, account.id);

      assert.equal(expectData(result)[field].status, to);

      const log = (await activityFor(account.id)).at(-1);
      assert.equal(log.action, action);
      assert.equal(log.performedByUserId, admin.id);
      assert.deepEqual({ fromStatus: log.metadata.fromStatus, toStatus: log.metadata.toStatus }, { fromStatus: from, toStatus: to });
    });
  }

  const refused = [
    ["approve", ["APPROVED", "BLOCKED", "PENDING_DELETION"]],
    ["block", ["BLOCKED", "PENDING_DELETION"]],
    ["unblock", ["PENDING", "APPROVED", "PENDING_DELETION"]],
    ["schedule", ["PENDING_DELETION"]],
    ["cancel", ["PENDING", "APPROVED", "BLOCKED"]],
  ];

  for (const [operation, statuses] of refused) {
    for (const status of statuses) {
      it(`${operation} gives CONFLICT from ${status} and changes nothing`, async () => {
        const [owner, admin] = await Promise.all([createUser(), createUser()]);
        const account = await createOwnerAccount(owner, { status });
        const { result } = await adminRun(admin, operation, account.id);

        expectError(result, "CONFLICT", INVALID_TRANSITION);
        assert.equal((await storedAccount(account.id)).status, status);
      });
    }
  }

  it("keeps the block reason only in the activity log", async () => {
    const [owner, admin] = await Promise.all([createUser(), createUser()]);
    const account = await createOwnerAccount(owner);
    await adminRun(admin, "block", account.id, { reason: "  Fraud report  " });

    assert.equal((await activityFor(account.id)).at(-1).metadata.reason, "Fraud report");
  });

  it("gives NOT_FOUND for a missing account", async () => {
    const admin = await createUser();
    const { result } = await adminRun(admin, "approve", MISSING_ID);

    expectError(result, "NOT_FOUND");
  });

  it("gives FORBIDDEN to non-admins", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner, { status: "PENDING" });
    const result = await run(contextFor(owner), adminMutation("approveOwnerAccount"), { id: account.id });

    expectError(result, "FORBIDDEN", "This action requires an administrator.");
  });

  it("admin cancel restores the exact status before deletion, including BLOCKED", async () => {
    const [owner, admin] = await Promise.all([createUser(), createUser()]);
    const account = await createOwnerAccount(owner, { status: "BLOCKED" });

    await adminRun(admin, "schedule", account.id);
    const { result, field } = await adminRun(admin, "cancel", account.id);

    assert.equal(expectData(result)[field].status, "BLOCKED");
    const stored = await storedAccount(account.id);
    assert.equal(stored.statusBeforeDeletion, null);
    assert.equal(stored.deletionScheduledAt, null);
  });

  it("cancel falls back to PENDING for an account scheduled before statusBeforeDeletion existed", async () => {
    const [owner, admin] = await Promise.all([createUser(), createUser()]);
    const account = await createOwnerAccount(owner, {
      status: "PENDING_DELETION",
      deletionScheduledAt: new Date(),
    });
    const { result, field } = await adminRun(admin, "cancel", account.id);

    assert.equal(expectData(result)[field].status, "PENDING");
  });

  it("gives CONFLICT to the loser of two concurrent transitions", async () => {
    const [owner, admin] = await Promise.all([createUser(), createUser()]);
    const account = await createOwnerAccount(owner, { status: "PENDING" });
    const results = await Promise.all([
      adminRun(admin, "approve", account.id),
      adminRun(admin, "block", account.id),
    ]);
    const failures = results.filter(({ result }) => result.errors);

    assert.equal(failures.length, 1);
    expectError(failures[0].result, "CONFLICT");
  });
});

describe("owner-requested deletion", () => {
  it("the PRIMARY schedules deletion 30 days ahead, remembering the status", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner, { status: "APPROVED" });
    const before = Date.now();

    assert.equal(expectData(await run(contextFor(owner), SCHEDULE, { id: account.id })).scheduleOwnerAccountDeletion.status, "PENDING_DELETION");

    const stored = await storedAccount(account.id);
    const days = (stored.deletionScheduledAt.getTime() - before) / MS_PER_DAY;
    assert.equal(stored.statusBeforeDeletion, "APPROVED");
    assert.ok(days > 29.99 && days < 30.01, `scheduled ${days} days ahead`);
  });

  it("the PRIMARY cancel restores the previous status and clears the deletion fields", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner, { status: "PENDING" });

    expectData(await run(contextFor(owner), SCHEDULE, { id: account.id }));
    assert.equal(expectData(await run(contextFor(owner), CANCEL, { id: account.id })).cancelOwnerAccountDeletion.status, "PENDING");

    const stored = await storedAccount(account.id);
    assert.equal(stored.statusBeforeDeletion, null);
    assert.equal(stored.deletionScheduledAt, null);
  });

  it("gives FORBIDDEN to a CO_OWNER", async () => {
    const [owner, coOwner] = await Promise.all([createUser(), createUser()]);
    const account = await createOwnerAccount(owner);
    await addMember(account, coOwner);

    expectError(await run(contextFor(coOwner), SCHEDULE, { id: account.id }), "FORBIDDEN");
  });

  it("gives FORBIDDEN to schedule a BLOCKED account or cancel one not pending deletion", async () => {
    const owner = await createUser();
    const blocked = await createOwnerAccount(owner, { status: "BLOCKED" });
    const approved = await createOwnerAccount(owner, { status: "APPROVED" });

    expectError(await run(contextFor(owner), SCHEDULE, { id: blocked.id }), "FORBIDDEN");
    expectError(await run(contextFor(owner), CANCEL, { id: approved.id }), "FORBIDDEN");
  });
});
