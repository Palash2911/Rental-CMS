import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { prisma, resetDatabase } from "../support/db.js";
import {
  anonymousContext,
  contextFor,
  createUser,
  firebaseUid,
  tokenContext,
  uniqueEmail,
} from "../support/factories.js";
import { expectData, expectError, run } from "../support/graphql.js";

const ME = "query { me { id email name createdAt } }";
const ADMIN_LIST = "query { adminOwnerAccounts { items { id } } }";

beforeEach(resetDatabase);

describe("user sync on sign-in", () => {
  it("creates the User on first sign-in with a verified email", async () => {
    const userId = firebaseUid();
    const email = uniqueEmail();
    const data = expectData(await run(tokenContext({ userId, email, name: "Ana" }), ME));

    assert.equal(data.me.id, userId);
    assert.equal(data.me.email, email);
    assert.equal(data.me.name, "Ana");
    assert.equal(await prisma.user.count({ where: { id: userId } }), 1);
  });

  it("creates the User only once across sign-ins", async () => {
    const userId = firebaseUid();
    const email = uniqueEmail();

    expectData(await run(tokenContext({ userId, email }), ME));
    expectData(await run(tokenContext({ userId, email }), ME));

    assert.equal(await prisma.user.count(), 1);
  });

  it("creates one User when the first requests arrive concurrently", async () => {
    const userId = firebaseUid();
    const email = uniqueEmail();
    const results = await Promise.all(
      Array.from({ length: 4 }, () => run(tokenContext({ userId, email }), ME)),
    );

    results.forEach(expectData);
    assert.equal(await prisma.user.count(), 1);
  });

  it("refuses first sign-in without a verified email", async () => {
    const userId = firebaseUid();
    const unverified = await run(tokenContext({ userId, email: uniqueEmail(), emailVerified: false }), ME);
    const missing = await run(tokenContext({ userId, email: null }), ME);

    expectError(unverified, "FORBIDDEN", "A verified email address is required.");
    expectError(missing, "FORBIDDEN", "A verified email address is required.");
    assert.equal(await prisma.user.count(), 0);
  });

  it("syncs a changed email only when it is verified", async () => {
    const user = await createUser();
    const newEmail = uniqueEmail("new");

    expectData(await run(contextFor(user, { email: newEmail, emailVerified: false }), ME));
    assert.equal((await prisma.user.findUnique({ where: { id: user.id } })).email, user.email);

    const data = expectData(await run(contextFor(user, { email: newEmail }), ME));
    assert.equal(data.me.email, newEmail);
  });

  it("syncs a changed name but never clears it when the claim is missing", async () => {
    const user = await createUser({ name: "Old Name" });

    assert.equal(expectData(await run(contextFor(user, { name: "New Name" }), ME)).me.name, "New Name");
    assert.equal(expectData(await run(contextFor(user, { name: null }), ME)).me.name, "New Name");
  });

  it("gives CONFLICT when a new User's email belongs to another User", async () => {
    const existing = await createUser();
    const result = await run(tokenContext({ userId: firebaseUid(), email: existing.email }), ME);

    expectError(result, "CONFLICT", "This email address is already linked to another account.");
  });

  it("gives CONFLICT when a changed email belongs to another User", async () => {
    const [user, other] = await Promise.all([createUser(), createUser()]);
    const result = await run(contextFor(user, { email: other.email }), ME);

    expectError(result, "CONFLICT", "This email address is already linked to another account.");
  });
});

describe("requireUser", () => {
  it("gives UNAUTHENTICATED to anonymous requests", async () => {
    expectError(await run(anonymousContext(), ME), "UNAUTHENTICATED", "Authentication required.");
  });

  it("gives FORBIDDEN to a blocked user", async () => {
    const user = await createUser({ isBlocked: true });

    expectError(await run(contextFor(user), ME), "FORBIDDEN", "This account has been suspended.");
  });

  it("does not expose isBlocked or updatedAt on User", async () => {
    const user = await createUser();
    const result = await run(contextFor(user), "query { me { isBlocked } }");

    assert.ok(result.errors?.length);
  });
});

describe("requireSuperAdmin", () => {
  it("allows a user with both the token claim and the live claim", async () => {
    const admin = await createUser();

    expectData(await run(contextFor(admin, { superAdmin: true, liveSuperAdmin: true }), ADMIN_LIST));
  });

  it("refuses a token claim the live lookup no longer confirms", async () => {
    const admin = await createUser();
    const result = await run(contextFor(admin, { superAdmin: true, liveSuperAdmin: false }), ADMIN_LIST);

    expectError(result, "FORBIDDEN", "This action requires an administrator.");
  });

  it("refuses a live claim without the token claim", async () => {
    const admin = await createUser();
    const result = await run(contextFor(admin, { superAdmin: false, liveSuperAdmin: true }), ADMIN_LIST);

    expectError(result, "FORBIDDEN", "This action requires an administrator.");
  });

  it("refuses a blocked super admin", async () => {
    const admin = await createUser({ isBlocked: true });
    const result = await run(contextFor(admin, { superAdmin: true }), ADMIN_LIST);

    expectError(result, "FORBIDDEN", "This account has been suspended.");
  });

  it("fails closed when the context has no live lookup", async () => {
    const admin = await createUser();
    const { hasLiveSuperAdminClaim, ...context } = contextFor(admin, { superAdmin: true });
    const result = await run(context, ADMIN_LIST);

    assert.equal(typeof hasLiveSuperAdminClaim, "function");
    assert.equal(result.data, null);
    assert.ok(result.errors?.length);
    // An unexpected error with no code: Yoga masks it as INTERNAL_SERVER_ERROR, never access.
    assert.equal(result.errors[0].extensions?.code, undefined);
  });
});
