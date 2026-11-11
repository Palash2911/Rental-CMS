import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  ACCOUNT_STATUSES,
  requireHouseAccess,
  requireOwnerMember,
  ROLES,
} from "../../src/lib/auth.js";
import { resetDatabase } from "../support/db.js";
import {
  addMember,
  anonymousContext,
  contextFor,
  createHouse,
  createOwnerAccount,
  createUser,
} from "../support/factories.js";

const ALL_STATUSES = Object.freeze(["PENDING", "APPROVED", "BLOCKED", "PENDING_DELETION"]);
const MISSING_ID = "cjld2cjxh0000qzrmn831i7rn";

async function expectGuardError(promise, code, message, label = code) {
  await assert.rejects(promise, (error) => {
    assert.equal(error.extensions?.code, code, label);
    if (message !== undefined) {
      assert.equal(error.message, message);
    }
    return true;
  });
}

beforeEach(resetDatabase);

describe("requireOwnerMember", () => {
  it("returns the user, membership and account for a member", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner);
    const result = await requireOwnerMember(contextFor(owner), account.id);

    assert.equal(result.user.id, owner.id);
    assert.equal(result.membership.role, "PRIMARY");
    assert.equal(result.ownerAccount.id, account.id);
  });

  it("gives UNAUTHENTICATED to anonymous callers", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner);

    await expectGuardError(requireOwnerMember(anonymousContext(), account.id), "UNAUTHENTICATED");
  });

  it("gives FORBIDDEN to a blocked member", async () => {
    const owner = await createUser({ isBlocked: true });
    const account = await createOwnerAccount(owner);

    await expectGuardError(
      requireOwnerMember(contextFor(owner), account.id),
      "FORBIDDEN",
      "This account has been suspended.",
    );
  });

  it("gives NOT_FOUND to a non-member and for a missing account", async () => {
    const [owner, stranger] = await Promise.all([createUser(), createUser()]);
    const account = await createOwnerAccount(owner);

    await expectGuardError(requireOwnerMember(contextFor(stranger), account.id), "NOT_FOUND", "Owner account not found.");
    await expectGuardError(requireOwnerMember(contextFor(owner), MISSING_ID), "NOT_FOUND");
  });

  it("gives FORBIDDEN to a role that is not allowed", async () => {
    const [owner, coOwner] = await Promise.all([createUser(), createUser()]);
    const account = await createOwnerAccount(owner);
    await addMember(account, coOwner);

    await expectGuardError(
      requireOwnerMember(contextFor(coOwner), account.id, { roles: ROLES.PRIMARY_ONLY }),
      "FORBIDDEN",
      "Your role on this owner account does not allow this action.",
    );
    await requireOwnerMember(contextFor(coOwner), account.id, { roles: ROLES.ANY });
  });

  it("allows only APPROVED accounts by default", async () => {
    const owner = await createUser();

    for (const status of ALL_STATUSES) {
      const account = await createOwnerAccount(owner, { status });
      const attempt = requireOwnerMember(contextFor(owner), account.id);

      if (status === "APPROVED") {
        await attempt;
      } else {
        await expectGuardError(
          attempt,
          "FORBIDDEN",
          "This action is not available for the owner account in its current state.",
        );
      }
    }
  });

  it("applies each status preset exactly", async () => {
    const owner = await createUser();
    const accounts = {};

    for (const status of ALL_STATUSES) {
      accounts[status] = await createOwnerAccount(owner, { status });
    }

    for (const [preset, allowed] of Object.entries(ACCOUNT_STATUSES)) {
      for (const status of ALL_STATUSES) {
        const attempt = requireOwnerMember(contextFor(owner), accounts[status].id, { statuses: allowed });

        if (allowed.includes(status)) {
          await attempt;
        } else {
          await expectGuardError(attempt, "FORBIDDEN", undefined, `${preset} ${status}`);
        }
      }
    }
  });
});

describe("requireHouseAccess", () => {
  it("returns the house and membership for a member", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner);
    const house = await createHouse(account);
    const result = await requireHouseAccess(contextFor(owner), house.id);

    assert.equal(result.house.id, house.id);
    assert.equal(result.membership.role, "PRIMARY");
    assert.equal(result.ownerAccount.status, "APPROVED");
  });

  it("gives NOT_FOUND for a missing house and to a member of another account", async () => {
    const [owner, other] = await Promise.all([createUser(), createUser()]);
    const account = await createOwnerAccount(owner);
    await createOwnerAccount(other);
    const house = await createHouse(account);

    await expectGuardError(requireHouseAccess(contextFor(owner), MISSING_ID), "NOT_FOUND", "House not found.");
    await expectGuardError(requireHouseAccess(contextFor(other), house.id), "NOT_FOUND", "House not found.");
  });

  it("gives FORBIDDEN for a disallowed status or role", async () => {
    const [owner, coOwner] = await Promise.all([createUser(), createUser()]);
    const account = await createOwnerAccount(owner, { status: "BLOCKED" });
    await addMember(account, coOwner);
    const house = await createHouse(account);

    await expectGuardError(requireHouseAccess(contextFor(owner), house.id), "FORBIDDEN");
    await expectGuardError(
      requireHouseAccess(contextFor(coOwner), house.id, {
        roles: ROLES.PRIMARY_ONLY,
        statuses: ["BLOCKED"],
      }),
      "FORBIDDEN",
      "Your role on this owner account does not allow this action.",
    );
  });

  it("gives UNAUTHENTICATED and blocked-user FORBIDDEN before reading the house", async () => {
    const blocked = await createUser({ isBlocked: true });

    await expectGuardError(requireHouseAccess(anonymousContext(), MISSING_ID), "UNAUTHENTICATED");
    await expectGuardError(requireHouseAccess(contextFor(blocked), MISSING_ID), "FORBIDDEN", "This account has been suspended.");
  });
});
