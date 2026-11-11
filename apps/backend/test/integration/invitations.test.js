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
  createPendingInvitations,
  createUser,
  expireInvitation,
  setAccountStatus,
  uniqueEmail,
} from "../support/factories.js";
import { expectData, expectError, run } from "../support/graphql.js";

const FIELDS = "id houseId houseName ownerAccountName email status expired leaseStartDate leaseEndDate expiresAt respondedAt acceptedAssignmentId createdAt updatedAt";
const CREATE = `mutation ($input: CreateInvitationInput!) { createInvitation(input: $input) { ${FIELDS} } }`;
const REVOKE = `mutation ($id: ID!) { revokeInvitation(id: $id) { ${FIELDS} } }`;
const DECLINE = `mutation ($id: ID!) { declineInvitation(id: $id) { ${FIELDS} } }`;
const MINE = `query ($first: Int, $after: String) { myInvitations(first: $first, after: $after) { items { id email status } pageInfo { nextCursor hasNextPage } } }`;
const BY_HOUSE = `query ($houseId: ID!, $status: InvitationStatus, $first: Int, $after: String) { invitationsByHouse(houseId: $houseId, status: $status, first: $first, after: $after) { items { id status expired } pageInfo { nextCursor hasNextPage } } }`;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MESSAGES = Object.freeze({
  HOUSE_INACTIVE: "This house is inactive and cannot take new tenants.",
  ALREADY_TENANT: "This email address already has an active tenancy on this house.",
  ALREADY_INVITED: "This email address already has a pending invitation for this house.",
  PENDING_LIMIT: "A house can have at most 50 pending invitations.",
  NOT_PENDING: "This invitation is no longer pending.",
  EXPIRED: "This invitation has expired.",
  NOT_FOUND: "Invitation not found.",
});

async function ownerHouse({ status = "APPROVED", ...houseOptions } = {}) {
  const [owner, coOwner] = await Promise.all([createUser(), createUser()]);
  const account = await createOwnerAccount(owner, { status, name: "Harbour Rentals" });
  await addMember(account, coOwner);
  const house = await createHouse(account, { name: "Unit 7", ...houseOptions });
  return { owner, coOwner, account, house };
}

function input(house, overrides = {}) {
  return { houseId: house.id, email: uniqueEmail("invitee"), leaseStartDate: "2026-12-01", leaseEndDate: "2027-11-30", ...overrides };
}

function create(user, house, overrides) {
  return run(contextFor(user), CREATE, { input: input(house, overrides) });
}

function activityFor(entityId) {
  return prisma.activityLog.findMany({ where: { entityId }, orderBy: { createdAt: "asc" } });
}

function stored(id) {
  return prisma.invitation.findUnique({ where: { id } });
}

beforeEach(resetDatabase);

describe("createInvitation", () => {
  it("creates a PENDING invitation with a normalised email, 14-day expiry and calendar dates", async () => {
    const { owner, house } = await ownerHouse();
    const before = Date.now();
    const invitation = expectData(await create(owner, house, { email: "  ANA+Lease@Example.TEST  " })).createInvitation;

    assert.equal(invitation.status, "PENDING");
    assert.equal(invitation.expired, false);
    assert.equal(invitation.email, "ana+lease@example.test");
    assert.equal(invitation.leaseStartDate, "2026-12-01");
    assert.equal(invitation.leaseEndDate, "2027-11-30");
    assert.equal(invitation.houseName, "Unit 7");
    assert.equal(invitation.ownerAccountName, "Harbour Rentals");
    assert.equal(invitation.respondedAt, null);

    const days = (Date.parse(invitation.expiresAt) - before) / MS_PER_DAY;
    assert.ok(days > 13.99 && days < 14.01, `expires in ${days} days`);

    const row = await stored(invitation.id);
    assert.equal(row.invitedByUserId, owner.id);
    assert.equal(row.leaseStartDate.toISOString(), "2026-12-01T00:00:00.000Z");

    const [log] = await activityFor(invitation.id);
    assert.equal(log.action, "CREATED");
    assert.equal(log.performedByUserId, owner.id);
  });

  it("accepts a missing end date and a start date in the past", async () => {
    const { owner, house } = await ownerHouse();
    const invitation = expectData(await create(owner, house, { leaseStartDate: "2024-03-01", leaseEndDate: null })).createInvitation;

    assert.equal(invitation.leaseStartDate, "2024-03-01");
    assert.equal(invitation.leaseEndDate, null);
  });

  it("does not expose invitedByUserId", async () => {
    const { owner, house } = await ownerHouse();
    const result = await run(contextFor(owner), `mutation ($input: CreateInvitationInput!) { createInvitation(input: $input) { invitedByUserId } }`, { input: input(house) });

    assert.ok(result.errors?.length);
  });

  it("validates lease dates", async () => {
    const { owner, house } = await ownerHouse();
    const cases = [
      [{ leaseEndDate: "2026-12-01" }, "input.leaseEndDate", "The lease end date must be after the lease start date."],
      [{ leaseEndDate: "2026-11-30" }, "input.leaseEndDate", "The lease end date must be after the lease start date."],
      [{ leaseStartDate: "2026-02-30" }, "input.leaseStartDate", "Enter a valid calendar date as YYYY-MM-DD."],
      [{ leaseStartDate: "1999-12-31" }, "input.leaseStartDate", "Dates must fall between 2000 and 2100."],
      [{ leaseStartDate: "2026-12-01T00:00:00Z" }, "input.leaseStartDate", "Enter a valid calendar date as YYYY-MM-DD."],
    ];

    for (const [overrides, path, message] of cases) {
      const error = expectError(await create(owner, house, overrides), "BAD_USER_INPUT");
      assert.deepEqual(error.extensions.fieldErrors, [{ path, message }], JSON.stringify(overrides));
    }
  });

  it("validates the email", async () => {
    const { owner, house } = await ownerHouse();

    for (const email of ["not-an-email", `${"a".repeat(250)}@x.io`, "   "]) {
      expectError(await create(owner, house, { email }), "BAD_USER_INPUT");
    }
  });

  it("refuses an INACTIVE house", async () => {
    const { owner, house } = await ownerHouse();
    await prisma.house.update({ where: { id: house.id }, data: { status: "INACTIVE" } });

    expectError(await create(owner, house), "CONFLICT", MESSAGES.HOUSE_INACTIVE);
  });

  it("refuses a second pending invitation for the same house and email, ignoring case", async () => {
    const { owner, house } = await ownerHouse();
    const email = uniqueEmail("dup");

    expectData(await create(owner, house, { email }));
    expectError(await create(owner, house, { email: email.toUpperCase() }), "CONFLICT", MESSAGES.ALREADY_INVITED);
  });

  it("allows the same email on another house, and again after the first was answered", async () => {
    const { owner, account, house } = await ownerHouse();
    const otherHouse = await createHouse(account, { name: "Unit 8" });
    const email = uniqueEmail("multi");
    const first = expectData(await create(owner, house, { email })).createInvitation;

    expectData(await create(owner, otherHouse, { email }));
    expectData(await run(contextFor(owner), REVOKE, { id: first.id }));
    expectData(await create(owner, house, { email }));
  });

  it("supersedes an expired pending invitation: REVOKED with reason EXPIRED_SUPERSEDED, then a new one", async () => {
    const { owner, house } = await ownerHouse();
    const email = uniqueEmail("again");
    const old = await createInvitation(house, owner, { email });
    await expireInvitation(old);

    const fresh = expectData(await create(owner, house, { email })).createInvitation;
    const oldRow = await stored(old.id);

    assert.notEqual(fresh.id, old.id);
    assert.equal(oldRow.status, "REVOKED");
    assert.ok(oldRow.respondedAt);

    const [log] = await activityFor(old.id);
    assert.equal(log.action, "REVOKED");
    assert.deepEqual(log.metadata, { reason: "EXPIRED_SUPERSEDED", fromStatus: "PENDING", toStatus: "REVOKED" });
  });

  it("refuses the 51st unexpired pending invitation on a house", async () => {
    const { owner, house } = await ownerHouse();
    await createPendingInvitations(house, owner, 50);

    expectError(await create(owner, house), "CONFLICT", MESSAGES.PENDING_LIMIT);
  });

  it("does not count expired or answered invitations toward the cap", async () => {
    const { owner, house } = await ownerHouse();
    await createPendingInvitations(house, owner, 49);

    for (let index = 0; index < 3; index += 1) {
      await expireInvitation(await createInvitation(house, owner));
      await createInvitation(house, owner, { status: "DECLINED", respondedAt: new Date() });
    }

    expectData(await create(owner, house));
    expectError(await create(owner, house), "CONFLICT", MESSAGES.PENDING_LIMIT);
  });

  it("refuses an email with an ACTIVE or NOTICE_PERIOD tenancy on the house, ignoring case", async () => {
    for (const status of ["ACTIVE", "NOTICE_PERIOD"]) {
      const { owner, house } = await ownerHouse();
      const tenant = await createUser({ email: uniqueEmail("MixedCaseTenant") });
      await createAssignment(house, tenant, { status });

      expectError(await create(owner, house, { email: tenant.email }), "CONFLICT", MESSAGES.ALREADY_TENANT);
    }
  });

  it("allows re-inviting a tenant whose assignment has EXITED", async () => {
    const { owner, house } = await ownerHouse();
    const tenant = await createUser();
    await createAssignment(house, tenant, { status: "EXITED" });

    expectData(await create(owner, house, { email: tenant.email }));
  });

  it("is allowed for CO_OWNER and refused on non-APPROVED accounts and to non-members", async () => {
    const { coOwner, house } = await ownerHouse();
    expectData(await create(coOwner, house));

    for (const status of ["PENDING", "BLOCKED", "PENDING_DELETION"]) {
      const setup = await ownerHouse({ status });
      expectError(await create(setup.owner, setup.house), "FORBIDDEN", undefined);
    }

    const stranger = await createUser();
    expectError(await create(stranger, house), "NOT_FOUND");
  });
});

describe("revokeInvitation", () => {
  it("revokes a pending invitation and logs it", async () => {
    const { owner, house } = await ownerHouse();
    const invitation = await createInvitation(house, owner);
    const revoked = expectData(await run(contextFor(owner), REVOKE, { id: invitation.id })).revokeInvitation;

    assert.equal(revoked.status, "REVOKED");
    assert.ok(revoked.respondedAt);
    const [log] = await activityFor(invitation.id);
    assert.equal(log.action, "REVOKED");
    assert.deepEqual(log.metadata, { fromStatus: "PENDING", toStatus: "REVOKED" });
  });

  it("gives CONFLICT once the invitation was answered", async () => {
    const { owner, house } = await ownerHouse();

    for (const status of ["REVOKED", "DECLINED", "ACCEPTED"]) {
      const invitation = await createInvitation(house, owner, { status, respondedAt: new Date() });
      expectError(await run(contextFor(owner), REVOKE, { id: invitation.id }), "CONFLICT", MESSAGES.NOT_PENDING);
    }
  });

  it("gives CONFLICT for an expired invitation", async () => {
    const { owner, house } = await ownerHouse();
    const invitation = await createInvitation(house, owner);
    await expireInvitation(invitation);

    expectError(await run(contextFor(owner), REVOKE, { id: invitation.id }), "CONFLICT", MESSAGES.EXPIRED);
    assert.equal((await stored(invitation.id)).status, "PENDING");
  });

  it("lets exactly one of two concurrent revokes succeed", async () => {
    const { owner, coOwner, house } = await ownerHouse();
    const invitation = await createInvitation(house, owner);
    const results = await Promise.all([
      run(contextFor(owner), REVOKE, { id: invitation.id }),
      run(contextFor(coOwner), REVOKE, { id: invitation.id }),
    ]);
    const failures = results.filter((result) => result.errors);

    assert.equal(failures.length, 1);
    expectError(failures[0], "CONFLICT", MESSAGES.NOT_PENDING);
    assert.equal((await activityFor(invitation.id)).length, 1);
  });

  it("gives NOT_FOUND to the invitee and to non-members", async () => {
    const { owner, house } = await ownerHouse();
    const [invitee, stranger] = await Promise.all([createUser(), createUser()]);
    const invitation = await createInvitation(house, owner, { email: invitee.email });

    expectError(await run(contextFor(invitee), REVOKE, { id: invitation.id }), "NOT_FOUND");
    expectError(await run(contextFor(stranger), REVOKE, { id: invitation.id }), "NOT_FOUND");
  });

  it("gives FORBIDDEN on a non-APPROVED account", async () => {
    const { owner, account, house } = await ownerHouse();
    const invitation = await createInvitation(house, owner);
    await setAccountStatus(account, "PENDING_DELETION");

    expectError(await run(contextFor(owner), REVOKE, { id: invitation.id }), "FORBIDDEN");
  });
});

describe("declineInvitation", () => {
  it("lets the matching invitee decline, in any account status, and logs it", async () => {
    for (const status of ["APPROVED", "PENDING", "BLOCKED", "PENDING_DELETION"]) {
      const { owner, house } = await ownerHouse({ status });
      const invitee = await createUser();
      const invitation = await createInvitation(house, owner, { email: invitee.email });
      const declined = expectData(await run(contextFor(invitee), DECLINE, { id: invitation.id })).declineInvitation;

      assert.equal(declined.status, "DECLINED", status);
      assert.equal((await activityFor(invitation.id))[0].action, "DECLINED");
    }
  });

  it("matches the invitee's stored email regardless of case", async () => {
    const { owner, house } = await ownerHouse();
    const invitee = await createUser({ email: uniqueEmail("Mixed").toUpperCase() });
    const invitation = await createInvitation(house, owner, { email: invitee.email.toLowerCase() });

    expectData(await run(contextFor(invitee), DECLINE, { id: invitation.id }));
  });

  it("gives NOT_FOUND, never FORBIDDEN, to any other user and leaves the invitation unchanged", async () => {
    const { owner, house } = await ownerHouse();
    const invitation = await createInvitation(house, owner);

    for (const user of [await createUser(), owner]) {
      expectError(await run(contextFor(user), DECLINE, { id: invitation.id }), "NOT_FOUND", MESSAGES.NOT_FOUND);
    }
    assert.equal((await stored(invitation.id)).status, "PENDING");
  });

  it("gives CONFLICT when expired or already answered", async () => {
    const { owner, house } = await ownerHouse();
    const invitee = await createUser();
    const expired = await createInvitation(house, owner, { email: invitee.email });
    await expireInvitation(expired);
    const answered = await createInvitation(house, owner, { email: invitee.email, status: "REVOKED", respondedAt: new Date() });

    expectError(await run(contextFor(invitee), DECLINE, { id: expired.id }), "CONFLICT", MESSAGES.EXPIRED);
    expectError(await run(contextFor(invitee), DECLINE, { id: answered.id }), "CONFLICT", MESSAGES.NOT_PENDING);
  });
});

describe("myInvitations", () => {
  it("lists only pending, unexpired invitations for the caller's email, newest first", async () => {
    const { owner, account, house } = await ownerHouse();
    const otherHouse = await createHouse(account, { name: "Unit 9" });
    const invitee = await createUser({ email: uniqueEmail("MixedCaseInvitee") });
    const email = invitee.email.toLowerCase();

    const older = await createInvitation(house, owner, { email });
    const newer = await createInvitation(otherHouse, owner, { email });
    await expireInvitation(await createInvitation(await createHouse(account), owner, { email }));
    await createInvitation(await createHouse(account), owner, { email, status: "DECLINED", respondedAt: new Date() });
    await createInvitation(house, owner);

    const items = expectData(await run(contextFor(invitee), MINE, {})).myInvitations.items;

    assert.deepEqual(items.map((item) => item.id), [newer.id, older.id]);
  });

  it("lists only invitations from APPROVED accounts", async () => {
    const invitee = await createUser();
    const visible = [];

    for (const status of ["APPROVED", "PENDING", "BLOCKED", "PENDING_DELETION"]) {
      const { owner, house } = await ownerHouse({ status });
      const invitation = await createInvitation(house, owner, { email: invitee.email });
      if (status === "APPROVED") {
        visible.push(invitation.id);
      }
    }

    const items = expectData(await run(contextFor(invitee), MINE, {})).myInvitations.items;
    assert.deepEqual(items.map((item) => item.id), visible);
  });

  it("shows an invitation again when its account returns to APPROVED", async () => {
    const { owner, account, house } = await ownerHouse();
    const invitee = await createUser();
    await createInvitation(house, owner, { email: invitee.email });

    await setAccountStatus(account, "BLOCKED");
    assert.equal(expectData(await run(contextFor(invitee), MINE, {})).myInvitations.items.length, 0);

    await setAccountStatus(account, "APPROVED");
    assert.equal(expectData(await run(contextFor(invitee), MINE, {})).myInvitations.items.length, 1);
  });

  it("pages results", async () => {
    const { owner, account } = await ownerHouse();
    const invitee = await createUser();

    for (let index = 0; index < 3; index += 1) {
      await createInvitation(await createHouse(account, { name: `Unit ${index}` }), owner, { email: invitee.email });
    }

    const first = expectData(await run(contextFor(invitee), MINE, { first: 2 })).myInvitations;
    const second = expectData(await run(contextFor(invitee), MINE, { first: 2, after: first.pageInfo.nextCursor })).myInvitations;

    assert.equal(first.items.length, 2);
    assert.equal(first.pageInfo.hasNextPage, true);
    assert.equal(second.items.length, 1);
    assert.equal(second.pageInfo.hasNextPage, false);
  });
});

describe("invitationsByHouse", () => {
  it("lists every invitation newest first, flags expired ones, and filters by status", async () => {
    const { owner, house } = await ownerHouse();
    const pending = await createInvitation(house, owner);
    const expired = await createInvitation(house, owner);
    await expireInvitation(expired);
    const declined = await createInvitation(house, owner, { status: "DECLINED", respondedAt: new Date() });

    const all = expectData(await run(contextFor(owner), BY_HOUSE, { houseId: house.id })).invitationsByHouse.items;
    assert.deepEqual(all.map((item) => item.id), [declined.id, expired.id, pending.id]);

    const onlyPending = expectData(await run(contextFor(owner), BY_HOUSE, { houseId: house.id, status: "PENDING" })).invitationsByHouse.items;
    assert.deepEqual(
      onlyPending.map((item) => [item.id, item.expired]),
      [[expired.id, true], [pending.id, false]],
    );

    for (const status of ["ACCEPTED", "REVOKED"]) {
      const items = expectData(await run(contextFor(owner), BY_HOUSE, { houseId: house.id, status })).invitationsByHouse.items;
      assert.equal(items.length, 0, status);
    }
  });

  it("pages results", async () => {
    const { owner, house } = await ownerHouse();

    for (let index = 0; index < 3; index += 1) {
      await createInvitation(house, owner);
    }

    const first = expectData(await run(contextFor(owner), BY_HOUSE, { houseId: house.id, first: 2 })).invitationsByHouse;
    const second = expectData(await run(contextFor(owner), BY_HOUSE, { houseId: house.id, first: 2, after: first.pageInfo.nextCursor })).invitationsByHouse;

    assert.equal(first.pageInfo.hasNextPage, true);
    assert.equal(second.items.length, 1);
  });

  it("is readable on APPROVED and PENDING_DELETION accounts only", async () => {
    for (const status of ["APPROVED", "PENDING_DELETION", "PENDING", "BLOCKED"]) {
      const { coOwner, house } = await ownerHouse({ status });
      const result = await run(contextFor(coOwner), BY_HOUSE, { houseId: house.id });

      if (["APPROVED", "PENDING_DELETION"].includes(status)) {
        expectData(result);
      } else {
        expectError(result, "FORBIDDEN", undefined);
      }
    }
  });

  it("gives NOT_FOUND to non-members and invitees", async () => {
    const { owner, house } = await ownerHouse();
    const invitee = await createUser();
    await createInvitation(house, owner, { email: invitee.email });

    expectError(await run(contextFor(invitee), BY_HOUSE, { houseId: house.id }), "NOT_FOUND");
  });
});
