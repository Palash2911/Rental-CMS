import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { prisma, resetDatabase } from "../support/db.js";
import {
  addMember,
  anonymousContext,
  contextFor,
  createAssignment,
  createHouse,
  createOwnerAccount,
  createUser,
  setAccountStatus,
} from "../support/factories.js";
import { expectData, expectError, run } from "../support/graphql.js";

const BY_ACCOUNT = `query ($ownerAccountId: ID!, $entityType: String, $first: Int, $after: String) {
  activityLogByAccount(ownerAccountId: $ownerAccountId, entityType: $entityType, first: $first, after: $after) {
    items { id action entityType entityId actorName createdAt }
    pageInfo { nextCursor hasNextPage }
  }
}`;

const ADMIN = `query ($filter: AdminActivityLogFilter, $first: Int, $after: String) {
  adminActivityLog(filter: $filter, first: $first, after: $after) {
    items { id ownerAccountId action entityType entityId performedByUserId actorName metadata createdAt }
    pageInfo { nextCursor hasNextPage }
  }
}`;

const MESSAGES = Object.freeze({
  OWNER_ACCOUNT_NOT_FOUND: "Owner account not found.",
  STATUS_NOT_ALLOWED: "This action is not available for the owner account in its current state.",
  ADMIN_REQUIRED: "This action requires an administrator.",
  UNKNOWN_ENTITY_TYPE: "Unknown entity type.",
  ENTITY_ID_NEEDS_TYPE: "Filter by entity type when filtering by entity id.",
});

const BASE_TIME = Date.parse("2026-06-01T00:00:00.000Z");
const MS_PER_MINUTE = 60_000;

function at(minute) {
  return new Date(BASE_TIME + minute * MS_PER_MINUTE);
}

function insertLog(account, { minute, entityType = "House", entityId = "chouse0001", action = "CREATED", actor = null, metadata = {} }) {
  return prisma.activityLog.create({
    data: {
      ownerAccountId: account?.id ?? null,
      entityType,
      entityId,
      action,
      performedByUserId: actor?.id ?? null,
      metadata,
      createdAt: at(minute),
    },
  });
}

async function account(status = "APPROVED", options = {}) {
  const owner = await createUser({ name: "Priya Primary" });
  const ownerAccount = await createOwnerAccount(owner, { status, ...options });
  return { owner, ownerAccount };
}

function byAccount(user, ownerAccount, variables = {}) {
  return run(contextFor(user), BY_ACCOUNT, { ownerAccountId: ownerAccount.id, ...variables });
}

function adminContext(admin) {
  return contextFor(admin, { superAdmin: true });
}

beforeEach(resetDatabase);

describe("logActivity scoping", () => {
  it("sets ownerAccountId on every entry a lease's lifecycle writes", async () => {
    const { owner, ownerAccount } = await account();
    const tenant = await createUser();
    const owners = contextFor(owner);
    const tenants = contextFor(tenant);

    const house = expectData(await run(owners, `mutation ($input: CreateHouseInput!) { createHouse(input: $input) { id } }`, {
      input: { ownerAccountId: ownerAccount.id, name: "Unit 9", location: "9 Log Lane", maxTenants: 2 },
    })).createHouse;
    expectData(await run(owners, `mutation ($input: UpdateHouseInput!) { updateHouse(input: $input) { id } }`, {
      input: { id: house.id, name: "Unit 9A" },
    }));
    expectData(await run(owners, `mutation ($id: ID!) { updateOwnerAccount(id: $id, name: "Renamed") { id } }`, { id: ownerAccount.id }));

    const invitation = expectData(await run(owners, `mutation ($input: CreateInvitationInput!) { createInvitation(input: $input) { id } }`, {
      input: { houseId: house.id, email: tenant.email, leaseStartDate: "2027-01-01" },
    })).createInvitation;
    const assignment = expectData(await run(tenants, `mutation ($id: ID!) { acceptInvitation(id: $id) { id } }`, { id: invitation.id })).acceptInvitation;

    expectData(await run(tenants, `mutation ($input: CreateReceiptInput!) { createReceipt(input: $input) { id } }`, {
      input: { tenantAssignmentId: assignment.id, amountCents: 1000, paidAt: "2026-11-01" },
    }));
    expectData(await run(tenants, `mutation ($input: CreateIssueInput!) { createIssue(input: $input) { id } }`, {
      input: { tenantAssignmentId: assignment.id, title: "Door", description: "Sticks." },
    }));
    const request = expectData(await run(tenants, `mutation ($input: CreateLeaveRequestInput!) { createLeaveRequest(input: $input) { id } }`, {
      input: { tenantAssignmentId: assignment.id, requestedExitDate: "2027-06-30" },
    })).createLeaveRequest;
    expectData(await run(owners, `mutation ($id: ID!) { rejectLeaveRequest(id: $id) { id } }`, { id: request.id }));
    expectData(await run(owners, `mutation ($id: ID!) { giveNotice(tenantAssignmentId: $id, plannedExitDate: "2027-06-30") { id } }`, { id: assignment.id }));
    expectData(await run(owners, `mutation ($id: ID!) { withdrawNotice(tenantAssignmentId: $id) { id } }`, { id: assignment.id }));
    expectData(await run(owners, `mutation ($id: ID!) { exitTenantAssignment(id: $id) { id } }`, { id: assignment.id }));

    const logs = await prisma.activityLog.findMany({ select: { entityType: true, action: true, ownerAccountId: true } });
    const entityTypes = new Set(logs.map((log) => log.entityType));

    assert.ok(logs.length >= 15, `only ${logs.length} entries`);
    assert.deepEqual(logs.filter((log) => log.ownerAccountId !== ownerAccount.id), []);
    for (const type of ["House", "OwnerAccount", "Invitation", "TenantProfile", "TenantAssignment", "Receipt", "Issue", "LeaveRequest"]) {
      assert.ok(entityTypes.has(type), `no ${type} entry`);
    }
  });
});

describe("activityLogByAccount", () => {
  it("lists the account's entries newest first with the actor's name and nothing else", async () => {
    const { owner, ownerAccount } = await account();
    const other = await account();
    const older = await insertLog(ownerAccount, { minute: 1, actor: owner, metadata: { secret: "hidden" } });
    const system = await insertLog(ownerAccount, { minute: 2, entityType: "OwnerAccount", entityId: ownerAccount.id, action: "APPROVED" });
    await insertLog(other.ownerAccount, { minute: 3 });
    await insertLog(null, { minute: 4 });

    const page = expectData(await byAccount(owner, ownerAccount)).activityLogByAccount;

    assert.deepEqual(page.items.map((item) => ({ ...item })), [
      { id: system.id, action: "APPROVED", entityType: "OwnerAccount", entityId: ownerAccount.id, actorName: null, createdAt: at(2).toISOString() },
      { id: older.id, action: "CREATED", entityType: "House", entityId: "chouse0001", actorName: "Priya Primary", createdAt: at(1).toISOString() },
    ]);
    assert.deepEqual({ ...page.pageInfo }, { nextCursor: null, hasNextPage: false });
  });

  it("does not expose metadata or the actor's id", async () => {
    const { owner, ownerAccount } = await account();
    const query = `query ($id: ID!) { activityLogByAccount(ownerAccountId: $id) { items { metadata performedByUserId } } }`;

    const result = await run(contextFor(owner), query, { id: ownerAccount.id });

    assert.ok(result.errors?.length);
    assert.match(result.errors[0].message, /Cannot query field "metadata"/);
  });

  it("gives a null actorName for an actor whose user has no name or no row", async () => {
    const { owner, ownerAccount } = await account();
    const nameless = await createUser({ name: null });
    await insertLog(ownerAccount, { minute: 1, actor: nameless });
    await insertLog(ownerAccount, { minute: 2, actor: { id: "gone-user" } });

    const page = expectData(await byAccount(owner, ownerAccount)).activityLogByAccount;

    assert.deepEqual(page.items.map((item) => item.actorName), [null, null]);
  });

  it("filters by entity type", async () => {
    const { owner, ownerAccount } = await account();
    const issue = await insertLog(ownerAccount, { minute: 1, entityType: "Issue", entityId: "cissue0001" });
    await insertLog(ownerAccount, { minute: 2 });

    const page = expectData(await byAccount(owner, ownerAccount, { entityType: "Issue" })).activityLogByAccount;

    assert.deepEqual(page.items.map((item) => item.id), [issue.id]);
  });

  it("pages with a cursor", async () => {
    const { owner, ownerAccount } = await account();
    const entries = [];

    for (let minute = 1; minute <= 5; minute += 1) {
      entries.push(await insertLog(ownerAccount, { minute }));
    }

    const first = expectData(await byAccount(owner, ownerAccount, { first: 2 })).activityLogByAccount;
    const second = expectData(await byAccount(owner, ownerAccount, { first: 2, after: first.pageInfo.nextCursor })).activityLogByAccount;
    const third = expectData(await byAccount(owner, ownerAccount, { first: 2, after: second.pageInfo.nextCursor })).activityLogByAccount;

    const ids = [...first.items, ...second.items, ...third.items].map((item) => item.id);
    assert.deepEqual(ids, entries.map((entry) => entry.id).reverse());
    assert.equal(third.pageInfo.hasNextPage, false);
  });

  it("is open to a CO_OWNER", async () => {
    const { ownerAccount } = await account();
    const coOwner = await createUser();
    await addMember(ownerAccount, coOwner);
    await insertLog(ownerAccount, { minute: 1 });

    assert.equal(expectData(await byAccount(coOwner, ownerAccount)).activityLogByAccount.items.length, 1);
  });

  for (const status of ["PENDING", "PENDING_DELETION"]) {
    it(`is open while the account is ${status}`, async () => {
      const { owner, ownerAccount } = await account(status);

      expectData(await byAccount(owner, ownerAccount));
    });
  }

  it("is open while billing makes the account read-only", async () => {
    const { owner, ownerAccount } = await account("APPROVED", { billing: null });

    expectData(await byAccount(owner, ownerAccount));
  });

  it("gives FORBIDDEN while the account is BLOCKED", async () => {
    const { owner, ownerAccount } = await account();
    await setAccountStatus(ownerAccount, "BLOCKED");

    expectError(await byAccount(owner, ownerAccount), "FORBIDDEN", MESSAGES.STATUS_NOT_ALLOWED);
  });

  it("gives NOT_FOUND to a non-member, including the account's tenant", async () => {
    const { ownerAccount } = await account();
    const [stranger, tenant] = await Promise.all([createUser(), createUser()]);
    await createAssignment(await createHouse(ownerAccount), tenant);

    expectError(await byAccount(stranger, ownerAccount), "NOT_FOUND", MESSAGES.OWNER_ACCOUNT_NOT_FOUND);
    expectError(await byAccount(tenant, ownerAccount), "NOT_FOUND", MESSAGES.OWNER_ACCOUNT_NOT_FOUND);
  });

  it("gives UNAUTHENTICATED to an anonymous request", async () => {
    const { ownerAccount } = await account();

    expectError(await run(anonymousContext(), BY_ACCOUNT, { ownerAccountId: ownerAccount.id }), "UNAUTHENTICATED");
  });

  it("gives BAD_USER_INPUT for an unknown entity type or page size", async () => {
    const { owner, ownerAccount } = await account();

    const error = expectError(await byAccount(owner, ownerAccount, { entityType: "User" }), "BAD_USER_INPUT");
    assert.deepEqual(error.extensions.fieldErrors.map((entry) => ({ ...entry })), [{ path: "entityType", message: MESSAGES.UNKNOWN_ENTITY_TYPE }]);
    expectError(await byAccount(owner, ownerAccount, { first: 101 }), "BAD_USER_INPUT");
  });
});

describe("adminActivityLog", () => {
  it("gives FORBIDDEN to anyone without the super admin claim", async () => {
    const user = await createUser();

    expectError(await run(contextFor(user), ADMIN), "FORBIDDEN", MESSAGES.ADMIN_REQUIRED);
    expectError(await run(contextFor(user, { superAdmin: true, liveSuperAdmin: false }), ADMIN), "FORBIDDEN", MESSAGES.ADMIN_REQUIRED);
  });

  it("lists every account's entries, unscoped ones included, with metadata", async () => {
    const admin = await createUser();
    const { owner, ownerAccount } = await account();
    const other = await account();
    const scoped = await insertLog(ownerAccount, { minute: 1, actor: owner, metadata: { name: "Unit 1", nested: { n: 2 } } });
    const otherEntry = await insertLog(other.ownerAccount, { minute: 2 });
    const unscoped = await insertLog(null, { minute: 3 });

    const page = expectData(await run(adminContext(admin), ADMIN)).adminActivityLog;

    assert.deepEqual(page.items.map((item) => item.id), [unscoped.id, otherEntry.id, scoped.id]);
    assert.deepEqual({ ...page.items[2] }, {
      id: scoped.id,
      ownerAccountId: ownerAccount.id,
      action: "CREATED",
      entityType: "House",
      entityId: "chouse0001",
      performedByUserId: owner.id,
      actorName: "Priya Primary",
      metadata: { name: "Unit 1", nested: { n: 2 } },
      createdAt: at(1).toISOString(),
    });
    assert.equal(page.items[0].ownerAccountId, null);
  });

  it("filters by account, entity type and id, and actor, combined", async () => {
    const admin = await createUser();
    const { owner, ownerAccount } = await account();
    const other = await account();
    const target = await insertLog(ownerAccount, { minute: 1, entityType: "Issue", entityId: "cissue0001", actor: owner });
    await insertLog(ownerAccount, { minute: 2, entityType: "Issue", entityId: "cissue0002", actor: owner });
    await insertLog(ownerAccount, { minute: 3, entityType: "House", actor: owner });
    await insertLog(other.ownerAccount, { minute: 4, entityType: "Issue", entityId: "cissue0001", actor: other.owner });

    const list = async (filter) =>
      expectData(await run(adminContext(admin), ADMIN, { filter })).adminActivityLog.items.map((item) => item.id);

    assert.equal((await list({ ownerAccountId: ownerAccount.id })).length, 3);
    assert.equal((await list({ entityType: "Issue" })).length, 3);
    assert.equal((await list({ performedByUserId: other.owner.id })).length, 1);
    assert.deepEqual(await list({ ownerAccountId: ownerAccount.id, entityType: "Issue", entityId: "cissue0001", performedByUserId: owner.id }), [target.id]);
    assert.equal((await list(null)).length, 4);
  });

  it("gives BAD_USER_INPUT for an entity id without an entity type", async () => {
    const admin = await createUser();

    const error = expectError(await run(adminContext(admin), ADMIN, { filter: { entityId: "cissue0001" } }), "BAD_USER_INPUT");
    assert.deepEqual(error.extensions.fieldErrors.map((entry) => ({ ...entry })), [{ path: "filter.entityType", message: MESSAGES.ENTITY_ID_NEEDS_TYPE }]);
  });
});
