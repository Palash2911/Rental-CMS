import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { prisma, resetDatabase } from "../support/db.js";
import {
  addMember,
  contextFor,
  createAssignment,
  createHouse,
  createInvitation,
  createOwnerAccount,
  createUser,
  setAccountStatus,
} from "../support/factories.js";
import { expectData, expectError, run } from "../support/graphql.js";

const FIELDS = "id tenantProfileId houseId status leaseStartDate leaseEndDate actualExitDate createdAt updatedAt";
const EXIT = `mutation ($id: ID!) { exitTenantAssignment(id: $id) { ${FIELDS} } }`;
const ACCEPT = `mutation ($id: ID!) { acceptInvitation(id: $id) { ${FIELDS} } }`;
const GET = `query ($id: ID!) { tenantAssignment(id: $id) { ${FIELDS} } }`;
const BY_HOUSE = `query ($houseId: ID!, $first: Int, $after: String) { tenantAssignmentsByHouse(houseId: $houseId, first: $first, after: $after) { items { id status } pageInfo { nextCursor hasNextPage } } }`;
const MINE = `query ($first: Int, $after: String) { myTenantAssignments(first: $first, after: $after) { items { id houseId status } pageInfo { nextCursor hasNextPage } } }`;
const PROFILE = `query ($id: ID!) { tenantProfile(id: $id) { id name email createdAt } }`;
const PROFILES = `query ($ownerAccountId: ID!, $first: Int, $after: String) { tenantProfilesByOwner(ownerAccountId: $ownerAccountId, first: $first, after: $after) { items { id email } pageInfo { nextCursor hasNextPage } } }`;

const NOT_ACTIVE = "Only an active tenant assignment can be exited.";

async function lease({ accountStatus = "APPROVED", assignmentStatus = "ACTIVE", maxTenants = 3 } = {}) {
  const [owner, coOwner, tenant] = await Promise.all([createUser(), createUser(), createUser()]);
  const account = await createOwnerAccount(owner, { status: accountStatus });
  await addMember(account, coOwner);
  const house = await createHouse(account, { maxTenants });
  const assignment = await createAssignment(house, tenant, { status: assignmentStatus });
  return { owner, coOwner, tenant, account, house, assignment };
}

function houseStatus(house) {
  return prisma.house.findUnique({ where: { id: house.id } }).then((row) => row.status);
}

function profileOf(user) {
  return prisma.tenantProfile.findUnique({ where: { userId: user.id } });
}

beforeEach(resetDatabase);

describe("exitTenantAssignment", () => {
  it("sets EXITED with actualExitDate, logs it and sets the house VACANT", async () => {
    const { owner, house, assignment } = await lease();
    const before = Date.now();
    const exited = expectData(await run(contextFor(owner), EXIT, { id: assignment.id })).exitTenantAssignment;

    assert.equal(exited.status, "EXITED");
    assert.ok(Math.abs(Date.parse(exited.actualExitDate) - before) < 60_000);
    assert.equal(await houseStatus(house), "VACANT");

    const [log] = await prisma.activityLog.findMany({ where: { entityId: assignment.id } });
    assert.equal(log.action, "EXITED");
    assert.equal(log.metadata.fromStatus, "ACTIVE");
    assert.equal(log.metadata.toStatus, "EXITED");
    assert.equal(log.metadata.actualExitDate, exited.actualExitDate);

    const stored = await prisma.tenantAssignment.findUnique({ where: { id: assignment.id } });
    assert.equal(stored.deletionScheduledAt, null);
  });

  it("exits a NOTICE_PERIOD assignment", async () => {
    const { owner, assignment } = await lease({ assignmentStatus: "NOTICE_PERIOD" });

    assert.equal(expectData(await run(contextFor(owner), EXIT, { id: assignment.id })).exitTenantAssignment.status, "EXITED");
  });

  it("sets VACANT only when the last active tenant leaves", async () => {
    const { owner, house, assignment } = await lease();
    const second = await createAssignment(house, await createUser());

    expectData(await run(contextFor(owner), EXIT, { id: assignment.id }));
    assert.equal(await houseStatus(house), "OCCUPIED");
    assert.equal(await prisma.activityLog.count({ where: { entityId: house.id } }), 0);

    expectData(await run(contextFor(owner), EXIT, { id: second.id }));
    assert.equal(await houseStatus(house), "VACANT");
    assert.equal(await prisma.activityLog.count({ where: { entityId: house.id } }), 1);
  });

  it("gives CONFLICT on a second exit", async () => {
    const { owner, assignment } = await lease();

    expectData(await run(contextFor(owner), EXIT, { id: assignment.id }));
    expectError(await run(contextFor(owner), EXIT, { id: assignment.id }), "CONFLICT", NOT_ACTIVE);
  });

  it("is allowed for CO_OWNER and refused to the tenant", async () => {
    const { coOwner, tenant, assignment } = await lease();

    expectError(await run(contextFor(tenant), EXIT, { id: assignment.id }), "FORBIDDEN");
    expectData(await run(contextFor(coOwner), EXIT, { id: assignment.id }));
  });

  it("gives FORBIDDEN on non-APPROVED accounts and NOT_FOUND to strangers", async () => {
    for (const accountStatus of ["PENDING", "BLOCKED", "PENDING_DELETION"]) {
      const { owner, assignment } = await lease({ accountStatus });
      expectError(await run(contextFor(owner), EXIT, { id: assignment.id }), "FORBIDDEN", undefined);
    }

    const { assignment } = await lease();
    expectError(await run(contextFor(await createUser()), EXIT, { id: assignment.id }), "NOT_FOUND");
  });

  it("allows re-inviting and re-accepting after exit, keeping the history", async () => {
    const { owner, tenant, house, assignment } = await lease();

    expectData(await run(contextFor(owner), EXIT, { id: assignment.id }));
    const invitation = await createInvitation(house, owner, { email: tenant.email });
    const renewed = expectData(await run(contextFor(tenant), ACCEPT, { id: invitation.id })).acceptInvitation;

    assert.notEqual(renewed.id, assignment.id);
    assert.equal(renewed.status, "ACTIVE");
    assert.equal(await houseStatus(house), "OCCUPIED");
    assert.equal(await prisma.tenantAssignment.count({ where: { houseId: house.id } }), 2);
  });
});

describe("tenantAssignment", () => {
  const cases = [
    { accountStatus: "APPROVED", owner: true, tenant: true },
    { accountStatus: "PENDING_DELETION", owner: true, tenant: true },
    { accountStatus: "BLOCKED", owner: false, tenant: true },
    { accountStatus: "PENDING", owner: false, tenant: false },
  ];

  for (const { accountStatus, owner: ownerAllowed, tenant: tenantAllowed } of cases) {
    it(`on a ${accountStatus} account: owner ${ownerAllowed ? "reads" : "is refused"}, tenant ${tenantAllowed ? "reads" : "is refused"}`, async () => {
      const { coOwner, tenant, assignment } = await lease({ accountStatus });

      for (const [user, allowed] of [[coOwner, ownerAllowed], [tenant, tenantAllowed]]) {
        const result = await run(contextFor(user), GET, { id: assignment.id });

        if (allowed) {
          const data = expectData(result).tenantAssignment;
          assert.equal(data.id, assignment.id);
          assert.equal(data.leaseStartDate, "2026-01-01");
        } else {
          expectError(result, "FORBIDDEN");
        }
      }
    });
  }

  it("gives NOT_FOUND to unrelated users and does not expose deletionScheduledAt", async () => {
    const { owner, assignment } = await lease();

    expectError(await run(contextFor(await createUser()), GET, { id: assignment.id }), "NOT_FOUND");
    assert.ok((await run(contextFor(owner), `query ($id: ID!) { tenantAssignment(id: $id) { deletionScheduledAt } }`, { id: assignment.id })).errors?.length);
  });
});

describe("tenantAssignmentsByHouse", () => {
  it("lists every status newest first, paged, for members only", async () => {
    const { owner, tenant, house, assignment } = await lease();
    const exited = await createAssignment(house, await createUser(), { status: "EXITED" });
    const notice = await createAssignment(house, await createUser(), { status: "NOTICE_PERIOD" });

    const first = expectData(await run(contextFor(owner), BY_HOUSE, { houseId: house.id, first: 2 })).tenantAssignmentsByHouse;
    const second = expectData(await run(contextFor(owner), BY_HOUSE, { houseId: house.id, first: 2, after: first.pageInfo.nextCursor })).tenantAssignmentsByHouse;

    assert.deepEqual([...first.items, ...second.items].map((item) => item.id), [notice.id, exited.id, assignment.id]);
    expectError(await run(contextFor(tenant), BY_HOUSE, { houseId: house.id }), "NOT_FOUND");
  });

  it("is readable on PENDING_DELETION and refused on BLOCKED accounts", async () => {
    const deleting = await lease({ accountStatus: "PENDING_DELETION" });
    const blocked = await lease({ accountStatus: "BLOCKED" });

    expectData(await run(contextFor(deleting.owner), BY_HOUSE, { houseId: deleting.house.id }));
    expectError(await run(contextFor(blocked.owner), BY_HOUSE, { houseId: blocked.house.id }), "FORBIDDEN");
  });
});

describe("myTenantAssignments", () => {
  it("lists the caller's assignments across accounts in APPROVED, BLOCKED and PENDING_DELETION only", async () => {
    const [owner, tenant] = await Promise.all([createUser(), createUser()]);
    const visible = [];

    for (const status of ["APPROVED", "BLOCKED", "PENDING_DELETION", "PENDING"]) {
      const account = await createOwnerAccount(owner, { status });
      const assignment = await createAssignment(await createHouse(account), tenant);
      if (status !== "PENDING") {
        visible.push(assignment.id);
      }
    }
    await createAssignment(await createHouse(await createOwnerAccount(owner)), await createUser());

    const items = expectData(await run(contextFor(tenant), MINE, {})).myTenantAssignments.items;
    assert.deepEqual(items.map((item) => item.id), visible.reverse());
  });

  it("returns an empty page for a user with no profile", async () => {
    const data = expectData(await run(contextFor(await createUser()), MINE, {})).myTenantAssignments;

    // GraphQL result objects have a null prototype; compare a plain copy.
    assert.deepEqual(structuredClone(data), { items: [], pageInfo: { nextCursor: null, hasNextPage: false } });
  });

  it("includes EXITED assignments and pages results", async () => {
    const { tenant, account } = await lease({ assignmentStatus: "EXITED" });
    await createAssignment(await createHouse(account), tenant);
    await createAssignment(await createHouse(account), tenant);

    const first = expectData(await run(contextFor(tenant), MINE, { first: 2 })).myTenantAssignments;
    const second = expectData(await run(contextFor(tenant), MINE, { first: 2, after: first.pageInfo.nextCursor })).myTenantAssignments;

    assert.equal(first.pageInfo.hasNextPage, true);
    assert.deepEqual(second.items.map((item) => item.status), ["EXITED"]);
  });
});

describe("tenantProfile and tenantProfilesByOwner", () => {
  it("tenantProfile returns only id, name, email and createdAt, to the tenant and to linked members", async () => {
    const { owner, tenant } = await lease({ assignmentStatus: "EXITED" });
    const profile = await profileOf(tenant);

    for (const user of [tenant, owner]) {
      const data = expectData(await run(contextFor(user), PROFILE, { id: profile.id })).tenantProfile;
      assert.deepEqual({ ...data, createdAt: undefined }, { id: profile.id, name: tenant.name, email: tenant.email, createdAt: undefined });
    }

    assert.ok((await run(contextFor(owner), `query ($id: ID!) { tenantProfile(id: $id) { userId } }`, { id: profile.id })).errors?.length);
  });

  it("tenantProfile gives NOT_FOUND to unrelated users and FORBIDDEN through a BLOCKED account only", async () => {
    const { owner, account, tenant } = await lease();
    const profile = await profileOf(tenant);

    expectError(await run(contextFor(await createUser()), PROFILE, { id: profile.id }), "NOT_FOUND");
    await setAccountStatus(account, "BLOCKED");
    expectError(await run(contextFor(owner), PROFILE, { id: profile.id }), "FORBIDDEN");
    expectData(await run(contextFor(tenant), PROFILE, { id: profile.id }));
  });

  it("tenantProfilesByOwner lists tenants with any assignment, EXITED included, once each, paged", async () => {
    const { owner, account, house, tenant } = await lease({ assignmentStatus: "EXITED" });
    const second = await createUser();
    await createAssignment(house, second);
    await createAssignment(await createHouse(account), second, { status: "EXITED" });
    await createAssignment(await createHouse(await createOwnerAccount(await createUser())), await createUser());

    const first = expectData(await run(contextFor(owner), PROFILES, { ownerAccountId: account.id, first: 1 })).tenantProfilesByOwner;
    const rest = expectData(await run(contextFor(owner), PROFILES, { ownerAccountId: account.id, first: 1, after: first.pageInfo.nextCursor })).tenantProfilesByOwner;

    assert.deepEqual([...first.items, ...rest.items].map((item) => item.email), [second.email, tenant.email]);
    assert.equal(rest.pageInfo.hasNextPage, false);
  });

  it("tenantProfilesByOwner is readable on PENDING_DELETION and refused on BLOCKED and to non-members", async () => {
    const deleting = await lease({ accountStatus: "PENDING_DELETION" });
    const blocked = await lease({ accountStatus: "BLOCKED" });

    expectData(await run(contextFor(deleting.coOwner), PROFILES, { ownerAccountId: deleting.account.id }));
    expectError(await run(contextFor(blocked.owner), PROFILES, { ownerAccountId: blocked.account.id }), "FORBIDDEN");
    expectError(await run(contextFor(deleting.tenant), PROFILES, { ownerAccountId: deleting.account.id }), "NOT_FOUND");
  });
});
