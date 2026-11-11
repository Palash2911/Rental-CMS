import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  ACCESS_TYPES,
  ACCOUNT_STATUSES,
  requireAssignmentAccess,
  requireInvitationAccess,
  requireTenantProfileAccess,
  ROLES,
} from "../../src/lib/auth.js";
import { prisma, resetDatabase } from "../support/db.js";
import {
  addMember,
  anonymousContext,
  contextFor,
  createAssignment,
  createHouse,
  createInvitation,
  createOwnerAccount,
  createUser,
} from "../support/factories.js";

const ALL_STATUSES = Object.freeze(["PENDING", "APPROVED", "BLOCKED", "PENDING_DELETION"]);
const MEMBER_PRESETS = Object.freeze(["MEMBER_ACCOUNT_READ", "MEMBER_ACCOUNT_WRITE", "MEMBER_TENANT_READ", "MEMBER_TENANT_WRITE", "MEMBER_DELETION_CANCEL"]);
const TENANT_PRESETS = Object.freeze(["TENANT_READ", "TENANT_WRITE"]);
const MISSING_ID = "cjld2cjxh0000qzrmn831i7rn";
const MESSAGES = Object.freeze({
  SUSPENDED: "This account has been suspended.",
  ACCESS_NOT_ALLOWED: "This action is not available to you.",
  ROLE_NOT_ALLOWED: "Your role on this owner account does not allow this action.",
  STATUS_NOT_ALLOWED: "This action is not available for the owner account in its current state.",
});

async function expectGuardError(promise, code, message, label = code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.extensions?.code, code, label);
    if (message !== undefined) {
      assert.equal(error.message, message, label);
    }
    return true;
  });
}

async function leaseSetup({ status = "APPROVED", assignmentStatus = "ACTIVE" } = {}) {
  const [owner, coOwner, tenant, stranger] = await Promise.all([createUser(), createUser(), createUser(), createUser()]);
  const account = await createOwnerAccount(owner, { status });
  await addMember(account, coOwner);
  const house = await createHouse(account);
  const assignment = await createAssignment(house, tenant, { status: assignmentStatus });
  return { owner, coOwner, tenant, stranger, account, house, assignment };
}

beforeEach(resetDatabase);

describe("requireAssignmentAccess", () => {
  const OWNER_ANY = Object.freeze({ owner: { statuses: ACCOUNT_STATUSES.MEMBER_TENANT_READ } });
  const TENANT_ONLY = Object.freeze({ tenant: { statuses: ACCOUNT_STATUSES.TENANT_READ } });

  it("gives UNAUTHENTICATED to anonymous callers and FORBIDDEN to blocked users", async () => {
    const { assignment } = await leaseSetup();
    const blocked = await createUser({ isBlocked: true });

    await expectGuardError(requireAssignmentAccess(anonymousContext(), assignment.id, OWNER_ANY), "UNAUTHENTICATED");
    await expectGuardError(requireAssignmentAccess(contextFor(blocked), assignment.id, OWNER_ANY), "FORBIDDEN", MESSAGES.SUSPENDED);
  });

  it("gives NOT_FOUND to an unrelated user and for a missing assignment", async () => {
    const { stranger, owner, assignment } = await leaseSetup();

    await expectGuardError(requireAssignmentAccess(contextFor(stranger), assignment.id, { ...OWNER_ANY, ...TENANT_ONLY }), "NOT_FOUND", "Tenant assignment not found.");
    await expectGuardError(requireAssignmentAccess(contextFor(owner), MISSING_ID, OWNER_ANY), "NOT_FOUND");
  });

  it("lets PRIMARY and CO_OWNER members through the owner path", async () => {
    const { owner, coOwner, assignment } = await leaseSetup();

    for (const member of [owner, coOwner]) {
      const result = await requireAssignmentAccess(contextFor(member), assignment.id, OWNER_ANY);
      assert.equal(result.accessAs, ACCESS_TYPES.OWNER);
      assert.equal(result.tenantAccess, false);
      assert.ok(result.membership);
    }
  });

  it("gives FORBIDDEN to a CO_OWNER when the owner path is PRIMARY only", async () => {
    const { coOwner, assignment } = await leaseSetup();

    await expectGuardError(
      requireAssignmentAccess(contextFor(coOwner), assignment.id, {
        owner: { roles: ROLES.PRIMARY_ONLY, statuses: ACCOUNT_STATUSES.MEMBER_TENANT_READ },
      }),
      "FORBIDDEN",
      MESSAGES.ROLE_NOT_ALLOWED,
    );
  });

  it("gives FORBIDDEN to a member when no owner path is allowed", async () => {
    const { owner, assignment } = await leaseSetup();

    await expectGuardError(requireAssignmentAccess(contextFor(owner), assignment.id, TENANT_ONLY), "FORBIDDEN", MESSAGES.ACCESS_NOT_ALLOWED);
  });

  it("lets the tenant through the tenant path and refuses when no tenant path is allowed", async () => {
    const { tenant, assignment } = await leaseSetup();
    const result = await requireAssignmentAccess(contextFor(tenant), assignment.id, TENANT_ONLY);

    assert.equal(result.accessAs, ACCESS_TYPES.TENANT);
    assert.equal(result.tenantAccess, true);
    assert.equal(result.membership, null);
    await expectGuardError(requireAssignmentAccess(contextFor(tenant), assignment.id, OWNER_ANY), "FORBIDDEN", MESSAGES.ACCESS_NOT_ALLOWED);
  });

  it("does not return deletionScheduledAt", async () => {
    const { owner, assignment } = await leaseSetup();
    const result = await requireAssignmentAccess(contextFor(owner), assignment.id, OWNER_ANY);

    assert.equal("deletionScheduledAt" in result.assignment, false);
  });

  for (const status of ALL_STATUSES) {
    it(`applies every member preset to a ${status} account`, async () => {
      const { owner, assignment } = await leaseSetup({ status });

      for (const preset of MEMBER_PRESETS) {
        const allowed = ACCOUNT_STATUSES[preset];
        const attempt = requireAssignmentAccess(contextFor(owner), assignment.id, { owner: { statuses: allowed } });

        if (allowed.includes(status)) {
          assert.equal((await attempt).accessAs, ACCESS_TYPES.OWNER, preset);
        } else {
          await expectGuardError(attempt, "FORBIDDEN", MESSAGES.STATUS_NOT_ALLOWED, preset);
        }
      }
    });

    it(`applies every tenant preset to a ${status} account`, async () => {
      const { tenant, assignment } = await leaseSetup({ status });

      for (const preset of TENANT_PRESETS) {
        const allowed = ACCOUNT_STATUSES[preset];
        const attempt = requireAssignmentAccess(contextFor(tenant), assignment.id, { tenant: { statuses: allowed } });

        if (allowed.includes(status)) {
          assert.equal((await attempt).accessAs, ACCESS_TYPES.TENANT, preset);
        } else {
          await expectGuardError(attempt, "FORBIDDEN", MESSAGES.STATUS_NOT_ALLOWED, preset);
        }
      }
    });
  }

  describe("self-tenancy (a member who is also the tenant)", () => {
    async function selfTenancy(status) {
      const owner = await createUser();
      const account = await createOwnerAccount(owner, { status });
      const house = await createHouse(account);
      const assignment = await createAssignment(house, owner);
      return { owner, assignment };
    }

    it("reports OWNER access with tenantAccess when both paths pass", async () => {
      const { owner, assignment } = await selfTenancy("APPROVED");
      const result = await requireAssignmentAccess(contextFor(owner), assignment.id, { ...OWNER_ANY, ...TENANT_ONLY });

      assert.equal(result.accessAs, ACCESS_TYPES.OWNER);
      assert.equal(result.tenantAccess, true);
    });

    it("falls back to the tenant path when the owner path fails on status", async () => {
      const { owner, assignment } = await selfTenancy("BLOCKED");
      const result = await requireAssignmentAccess(contextFor(owner), assignment.id, {
        owner: { statuses: ACCOUNT_STATUSES.MEMBER_TENANT_READ },
        tenant: { statuses: ACCOUNT_STATUSES.TENANT_READ },
      });

      assert.equal(result.accessAs, ACCESS_TYPES.TENANT);
      assert.equal(result.tenantAccess, true);
      assert.equal(result.membership, null);
    });

    it("reports the owner error when both paths fail", async () => {
      const { owner, assignment } = await selfTenancy("PENDING");

      await expectGuardError(
        requireAssignmentAccess(contextFor(owner), assignment.id, {
          owner: { statuses: ACCOUNT_STATUSES.MEMBER_TENANT_READ },
          tenant: { statuses: ACCOUNT_STATUSES.TENANT_READ },
        }),
        "FORBIDDEN",
        MESSAGES.STATUS_NOT_ALLOWED,
      );
    });
  });
});

describe("requireInvitationAccess", () => {
  async function invitationSetup(status = "APPROVED") {
    const { owner, coOwner, stranger, account, house } = await leaseSetup({ status });
    const invitee = await createUser();
    const invitation = await createInvitation(house, owner, { email: invitee.email });
    return { owner, coOwner, stranger, invitee, account, house, invitation };
  }

  it("returns the invitation, house name and membership to PRIMARY and CO_OWNER", async () => {
    const { owner, coOwner, house, invitation } = await invitationSetup();

    for (const member of [owner, coOwner]) {
      const result = await requireInvitationAccess(contextFor(member), invitation.id, { statuses: ACCOUNT_STATUSES.MEMBER_TENANT_WRITE });
      assert.equal(result.invitation.id, invitation.id);
      assert.equal(result.houseName, house.name);
      assert.ok(result.membership);
    }
  });

  it("gives NOT_FOUND to non-members, members of another account, the invitee and for a missing id", async () => {
    const { stranger, invitee, invitation } = await invitationSetup();
    const otherOwner = await createUser();
    await createOwnerAccount(otherOwner);

    for (const user of [stranger, invitee, otherOwner]) {
      await expectGuardError(requireInvitationAccess(contextFor(user), invitation.id), "NOT_FOUND", "Invitation not found.");
    }
    await expectGuardError(requireInvitationAccess(contextFor(stranger), MISSING_ID), "NOT_FOUND");
  });

  it("gives FORBIDDEN for a disallowed role", async () => {
    const { coOwner, invitation } = await invitationSetup();

    await expectGuardError(requireInvitationAccess(contextFor(coOwner), invitation.id, { roles: ROLES.PRIMARY_ONLY }), "FORBIDDEN", MESSAGES.ROLE_NOT_ALLOWED);
  });

  for (const status of ALL_STATUSES) {
    it(`applies every member preset to a ${status} account`, async () => {
      const { owner, invitation } = await invitationSetup(status);

      for (const preset of MEMBER_PRESETS) {
        const allowed = ACCOUNT_STATUSES[preset];
        const attempt = requireInvitationAccess(contextFor(owner), invitation.id, { statuses: allowed });

        if (allowed.includes(status)) {
          await attempt;
        } else {
          await expectGuardError(attempt, "FORBIDDEN", MESSAGES.STATUS_NOT_ALLOWED, preset);
        }
      }
    });
  }

  it("gives UNAUTHENTICATED and blocked FORBIDDEN", async () => {
    const { invitation } = await invitationSetup();
    const blocked = await createUser({ isBlocked: true });

    await expectGuardError(requireInvitationAccess(anonymousContext(), invitation.id), "UNAUTHENTICATED");
    await expectGuardError(requireInvitationAccess(contextFor(blocked), invitation.id), "FORBIDDEN", MESSAGES.SUSPENDED);
  });
});

describe("requireTenantProfileAccess", () => {
  const OWNER_READ = Object.freeze({ owner: { statuses: ACCOUNT_STATUSES.MEMBER_TENANT_READ } });

  async function profileOf(user) {
    return prisma.tenantProfile.findUnique({ where: { userId: user.id } });
  }

  it("lets the tenant read their own profile in every account status", async () => {
    for (const status of ALL_STATUSES) {
      const { tenant } = await leaseSetup({ status });
      const profile = await profileOf(tenant);
      const result = await requireTenantProfileAccess(contextFor(tenant), profile.id, OWNER_READ);

      assert.equal(result.accessAs, ACCESS_TYPES.TENANT);
      assert.deepEqual(Object.keys(result.profile).sort(), ["createdAt", "email", "id", "name"]);
      assert.equal(result.profile.email, tenant.email);
    }
  });

  it("lets members read a profile linked by an ACTIVE, NOTICE_PERIOD or EXITED assignment", async () => {
    for (const assignmentStatus of ["ACTIVE", "NOTICE_PERIOD", "EXITED"]) {
      const { owner, coOwner, tenant } = await leaseSetup({ assignmentStatus });
      const profile = await profileOf(tenant);

      for (const member of [owner, coOwner]) {
        const result = await requireTenantProfileAccess(contextFor(member), profile.id, OWNER_READ);
        assert.equal(result.accessAs, ACCESS_TYPES.OWNER, assignmentStatus);
      }
    }
  });

  it("gives FORBIDDEN when every linking account has a disallowed status", async () => {
    for (const status of ["PENDING", "BLOCKED"]) {
      const { owner, tenant } = await leaseSetup({ status });
      const profile = await profileOf(tenant);

      await expectGuardError(requireTenantProfileAccess(contextFor(owner), profile.id, OWNER_READ), "FORBIDDEN", MESSAGES.STATUS_NOT_ALLOWED, status);
    }
  });

  it("allows access when any one linking account is allowed", async () => {
    const [owner, tenant] = await Promise.all([createUser(), createUser()]);
    const blocked = await createOwnerAccount(owner, { status: "BLOCKED" });
    const approved = await createOwnerAccount(owner, { status: "APPROVED" });
    await createAssignment(await createHouse(blocked), tenant);
    await createAssignment(await createHouse(approved), tenant, { status: "EXITED" });
    const profile = await profileOf(tenant);

    assert.equal((await requireTenantProfileAccess(contextFor(owner), profile.id, OWNER_READ)).accessAs, ACCESS_TYPES.OWNER);
  });

  it("gives NOT_FOUND to unrelated users, members of unlinked accounts and for a missing id", async () => {
    const { tenant, stranger } = await leaseSetup();
    const otherOwner = await createUser();
    await createHouse(await createOwnerAccount(otherOwner));
    const profile = await profileOf(tenant);

    for (const user of [stranger, otherOwner]) {
      await expectGuardError(requireTenantProfileAccess(contextFor(user), profile.id, OWNER_READ), "NOT_FOUND", "Tenant profile not found.");
    }
    await expectGuardError(requireTenantProfileAccess(contextFor(stranger), MISSING_ID, OWNER_READ), "NOT_FOUND");
  });

  it("gives FORBIDDEN to a linked member when no owner path is allowed", async () => {
    const { owner, tenant } = await leaseSetup();
    const profile = await profileOf(tenant);

    await expectGuardError(requireTenantProfileAccess(contextFor(owner), profile.id), "FORBIDDEN", MESSAGES.ACCESS_NOT_ALLOWED);
  });

  it("gives UNAUTHENTICATED and blocked FORBIDDEN", async () => {
    const { tenant } = await leaseSetup();
    const profile = await profileOf(tenant);
    const blocked = await createUser({ isBlocked: true });

    await expectGuardError(requireTenantProfileAccess(anonymousContext(), profile.id, OWNER_READ), "UNAUTHENTICATED");
    await expectGuardError(requireTenantProfileAccess(contextFor(blocked), profile.id, OWNER_READ), "FORBIDDEN", MESSAGES.SUSPENDED);
  });
});
