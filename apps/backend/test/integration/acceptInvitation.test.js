import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { prisma, resetDatabase } from "../support/db.js";
import {
  anonymousContext,
  contextFor,
  createAssignment,
  createHouse,
  createInvitation,
  createOwnerAccount,
  createUser,
  expireInvitation,
  setAccountStatus,
} from "../support/factories.js";
import { expectData, expectError, run } from "../support/graphql.js";

const ACCEPT = `mutation ($id: ID!) { acceptInvitation(id: $id) { id tenantProfileId houseId status leaseStartDate leaseEndDate actualExitDate createdAt updatedAt } }`;

const MESSAGES = Object.freeze({
  NOT_FOUND: "Invitation not found.",
  NOT_PENDING: "This invitation is no longer pending.",
  EXPIRED: "This invitation has expired.",
  ACCOUNT_NOT_APPROVED: "This action is not available for the owner account in its current state.",
  HOUSE_INACTIVE: "This house is inactive and cannot take new tenants.",
  HOUSE_FULL: "This house has no free tenant places.",
  ALREADY_ASSIGNED: "You already have an active tenancy on this house.",
});

async function invited({ maxTenants = 2, accountStatus = "APPROVED", leaseEndDate = new Date("2027-11-30T00:00:00.000Z") } = {}) {
  const [owner, invitee] = await Promise.all([createUser(), createUser()]);
  const account = await createOwnerAccount(owner, { status: accountStatus });
  const house = await createHouse(account, { maxTenants });
  const invitation = await createInvitation(house, owner, {
    email: invitee.email,
    leaseStartDate: new Date("2026-12-01T00:00:00.000Z"),
    leaseEndDate,
  });
  return { owner, invitee, account, house, invitation };
}

function accept(user, invitation) {
  return run(contextFor(user), ACCEPT, { id: invitation.id });
}

function logs(where) {
  return prisma.activityLog.findMany({ where, orderBy: { createdAt: "asc" } });
}

async function assertNothingCreated(invitee, house, invitation) {
  assert.equal(await prisma.tenantProfile.count({ where: { userId: invitee.id } }), 0);
  assert.equal(await prisma.tenantAssignment.count({ where: { houseId: house.id } }), 0);
  assert.equal((await logs({ entityType: { in: ["TenantProfile", "TenantAssignment"] } })).length, 0);
  assert.equal((await prisma.invitation.findUnique({ where: { id: invitation.id } })).acceptedAssignmentId, null);
}

beforeEach(resetDatabase);

describe("acceptInvitation", () => {
  it("creates the profile and an ACTIVE assignment, sets the house OCCUPIED and marks the invitation ACCEPTED", async () => {
    const { invitee, house, invitation } = await invited();
    const assignment = expectData(await accept(invitee, invitation)).acceptInvitation;

    assert.equal(assignment.status, "ACTIVE");
    assert.equal(assignment.houseId, house.id);
    assert.equal(assignment.leaseStartDate, "2026-12-01");
    assert.equal(assignment.leaseEndDate, "2027-11-30");
    assert.equal(assignment.actualExitDate, null);

    const profile = await prisma.tenantProfile.findUnique({ where: { userId: invitee.id } });
    assert.equal(assignment.tenantProfileId, profile.id);
    assert.equal((await prisma.house.findUnique({ where: { id: house.id } })).status, "OCCUPIED");

    const stored = await prisma.invitation.findUnique({ where: { id: invitation.id } });
    assert.equal(stored.status, "ACCEPTED");
    assert.equal(stored.acceptedAssignmentId, assignment.id);
    assert.ok(stored.respondedAt);
  });

  it("writes the four activity log entries, all by the invitee", async () => {
    const { invitee, house, invitation } = await invited();
    const assignment = expectData(await accept(invitee, invitation)).acceptInvitation;
    const profile = await prisma.tenantProfile.findUnique({ where: { userId: invitee.id } });

    const entries = await logs({ performedByUserId: invitee.id });
    const byEntity = Object.fromEntries(entries.map((entry) => [entry.entityType, entry]));

    assert.equal(entries.length, 4);
    assert.equal(byEntity.Invitation.action, "ACCEPTED");
    assert.equal(byEntity.Invitation.metadata.acceptedAssignmentId, assignment.id);
    assert.equal(byEntity.TenantProfile.entityId, profile.id);
    assert.equal(byEntity.TenantProfile.action, "CREATED");
    assert.equal(byEntity.TenantAssignment.entityId, assignment.id);
    assert.equal(byEntity.TenantAssignment.metadata.leaseStartDate, "2026-12-01");
    assert.equal(byEntity.House.entityId, house.id);
    assert.deepEqual(byEntity.House.metadata, { status: { from: "VACANT", to: "OCCUPIED" } });
  });

  it("copies a missing lease end date as null", async () => {
    const { invitee, invitation } = await invited({ leaseEndDate: null });

    assert.equal(expectData(await accept(invitee, invitation)).acceptInvitation.leaseEndDate, null);
  });

  it("reuses one profile across accepts on different houses and logs its creation once", async () => {
    const { owner, invitee, account, invitation } = await invited();
    const secondHouse = await createHouse(account, { name: "Unit 2" });
    const second = await createInvitation(secondHouse, owner, { email: invitee.email });

    const first = expectData(await accept(invitee, invitation)).acceptInvitation;
    const next = expectData(await accept(invitee, second)).acceptInvitation;

    assert.equal(first.tenantProfileId, next.tenantProfileId);
    assert.equal(await prisma.tenantProfile.count({ where: { userId: invitee.id } }), 1);
    assert.equal((await logs({ entityType: "TenantProfile" })).length, 1);
  });

  it("logs no house change when the house is already OCCUPIED", async () => {
    const { invitee, house, invitation } = await invited({ maxTenants: 3 });
    await createAssignment(house, await createUser());

    expectData(await accept(invitee, invitation));

    assert.equal((await logs({ entityType: "House" })).length, 0);
  });

  it("matches the invitee's stored email regardless of case", async () => {
    const { owner, account } = await invited();
    const invitee = await createUser({ email: "Mixed.Case+Tenant@Example.TEST" });
    const house = await createHouse(account);
    const invitation = await createInvitation(house, owner, { email: "mixed.case+tenant@example.test" });

    expectData(await accept(invitee, invitation));
  });

  it("gives NOT_FOUND to any user whose email does not match, and creates nothing", async () => {
    const { owner, invitee, house, invitation } = await invited();

    for (const user of [await createUser(), owner]) {
      expectError(await accept(user, invitation), "NOT_FOUND", MESSAGES.NOT_FOUND);
    }
    await assertNothingCreated(invitee, house, invitation);
  });

  for (const status of ["REVOKED", "DECLINED", "ACCEPTED"]) {
    it(`gives CONFLICT for an invitation already ${status}`, async () => {
      const { invitee, house, invitation } = await invited();
      await prisma.invitation.update({ where: { id: invitation.id }, data: { status, respondedAt: new Date() } });

      expectError(await accept(invitee, invitation), "CONFLICT", MESSAGES.NOT_PENDING);
      await assertNothingCreated(invitee, house, invitation);
    });
  }

  it("gives CONFLICT for an expired invitation", async () => {
    const { invitee, house, invitation } = await invited();
    await expireInvitation(invitation);

    expectError(await accept(invitee, invitation), "CONFLICT", MESSAGES.EXPIRED);
    await assertNothingCreated(invitee, house, invitation);
  });

  for (const status of ["PENDING", "BLOCKED", "PENDING_DELETION"]) {
    it(`gives FORBIDDEN when the account is ${status}`, async () => {
      const { invitee, account, house, invitation } = await invited();
      await setAccountStatus(account, status);

      expectError(await accept(invitee, invitation), "FORBIDDEN", MESSAGES.ACCOUNT_NOT_APPROVED);
      await assertNothingCreated(invitee, house, invitation);
    });
  }

  it("gives CONFLICT when the house became INACTIVE", async () => {
    const { invitee, house, invitation } = await invited();
    await prisma.house.update({ where: { id: house.id }, data: { status: "INACTIVE" } });

    expectError(await accept(invitee, invitation), "CONFLICT", MESSAGES.HOUSE_INACTIVE);
    await assertNothingCreated(invitee, house, invitation);
  });

  it("gives CONFLICT when ACTIVE and NOTICE_PERIOD tenants fill the house", async () => {
    const { invitee, house, invitation } = await invited({ maxTenants: 2 });
    await createAssignment(house, await createUser());
    await createAssignment(house, await createUser(), { status: "NOTICE_PERIOD" });

    expectError(await accept(invitee, invitation), "CONFLICT", MESSAGES.HOUSE_FULL);
    assert.equal(await prisma.tenantAssignment.count({ where: { houseId: house.id } }), 2);
  });

  it("does not count EXITED assignments toward capacity", async () => {
    const { invitee, house, invitation } = await invited({ maxTenants: 1 });
    await createAssignment(house, await createUser(), { status: "EXITED" });

    expectData(await accept(invitee, invitation));
  });

  it("gives CONFLICT when the invitee already has an active lease on the house", async () => {
    const { invitee, house, invitation } = await invited({ maxTenants: 3 });
    await createAssignment(house, invitee);

    expectError(await accept(invitee, invitation), "CONFLICT", MESSAGES.ALREADY_ASSIGNED);
    assert.equal(await prisma.tenantAssignment.count({ where: { houseId: house.id } }), 1);
  });

  it("allows self-tenancy: a member accepting an invitation to their own account's house", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner);
    const house = await createHouse(account);
    const invitation = await createInvitation(house, owner, { email: owner.email });

    assert.equal(expectData(await accept(owner, invitation)).acceptInvitation.status, "ACTIVE");
  });

  it("gives UNAUTHENTICATED to anonymous callers", async () => {
    const { invitation } = await invited();
    expectError(await run(anonymousContext(), ACCEPT, { id: invitation.id }), "UNAUTHENTICATED");
  });
});
