import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { runAccountDeletion } from "../../src/jobs/accountDeletion.js";
import { processStripeWebhook } from "../../src/stripe/webhook.js";
import { prisma, prismaFailingTransactions, resetDatabase } from "../support/db.js";
import { recordingNotifier } from "../support/email.js";
import {
  addMember,
  contextFor,
  createAssignment,
  createHouse,
  createInvitation,
  createIssue,
  createLeaveRequest,
  createMemberInvitation,
  createOwnerAccount,
  createReceipt,
  createUser,
  firebaseUid,
  recordingLogger,
} from "../support/factories.js";
import { expectError, run } from "../support/graphql.js";
import { fakeStorageGateway } from "../support/storage.js";
import {
  recordingStripeGateway,
  signWebhook,
  stripeEvent,
  stripeSubscription,
  TEST_WEBHOOK_SECRET,
} from "../support/stripe.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2027-04-01T03:00:00.000Z");
const PAST_DUE = new Date(NOW.getTime() - MS_PER_DAY);
const NOT_YET_DUE = new Date(NOW.getTime() + MS_PER_DAY);
const INVALID_TRANSITION = "This action is not available for the owner account in its current state.";

const OWNED_MODELS = Object.freeze([
  "house",
  "tenantAssignment",
  "receipt",
  "issue",
  "leaveRequest",
  "invitation",
  "memberInvitation",
  "ownerAccountMember",
  "subscription",
]);

function suffix() {
  return firebaseUid().toLowerCase();
}

/**
 * An account in PENDING_DELETION with a row in every table the job deletes, and a tenant who
 * also rents from a second, healthy account. Its Stripe subscription is live in `stripe`.
 */
async function doomedAccount(stripe, { deletionScheduledAt = PAST_DUE, subscription = {} } = {}) {
  const [owner, coOwner, tenant] = await Promise.all([createUser(), createUser(), createUser()]);
  const stripeCustomerId = `cus_test_${suffix()}`;
  const stripeSubscriptionId = `sub_test_${suffix()}`;
  const billing = { plan: "PRO", interval: "MONTH", stripeStatus: "active", stripeCustomerId, stripeSubscriptionId, ...subscription };

  const account = await createOwnerAccount(owner, {
    status: "PENDING_DELETION",
    statusBeforeDeletion: "APPROVED",
    deletionScheduledAt,
    billing,
  });
  await addMember(account, coOwner);
  stripe.subscriptions.set(stripeSubscriptionId, stripeSubscription({ id: stripeSubscriptionId, customer: stripeCustomerId }));

  const house = await createHouse(account);
  const assignment = await createAssignment(house, tenant);
  await createReceipt(assignment);
  await createIssue(assignment);
  await createLeaveRequest(assignment);
  const accepted = await createInvitation(house, owner, { status: "ACCEPTED", respondedAt: new Date() });
  await prisma.invitation.update({ where: { id: accepted.id }, data: { acceptedAssignmentId: assignment.id } });
  await createInvitation(house, owner);
  await createMemberInvitation(account, owner);
  await prisma.activityLog.create({
    data: { entityType: "OwnerAccount", entityId: account.id, action: "DELETION_SCHEDULED", performedByUserId: owner.id },
  });

  return { owner, coOwner, tenant, account, house, assignment, stripeSubscriptionId };
}

async function healthyAccount(tenant) {
  const owner = await createUser();
  const account = await createOwnerAccount(owner);
  const house = await createHouse(account);
  const assignment = await createAssignment(house, tenant);
  await createReceipt(assignment);
  return { owner, account, house, assignment };
}

function ownedCounts(account) {
  const byHouse = { house: { ownerAccountId: account.id } };
  const where = {
    house: { ownerAccountId: account.id },
    tenantAssignment: byHouse,
    receipt: { tenantAssignment: byHouse },
    issue: byHouse,
    leaveRequest: byHouse,
    invitation: byHouse,
    memberInvitation: { ownerAccountId: account.id },
    ownerAccountMember: { ownerAccountId: account.id },
    subscription: { ownerAccountId: account.id },
  };

  return Promise.all(OWNED_MODELS.map((model) => prisma[model].count({ where: where[model] })));
}

function storedAccount(account) {
  return prisma.ownerAccount.findUnique({ where: { id: account.id } });
}

function runJob(stripe, options = {}, dependencies = {}) {
  return runAccountDeletion(
    {
      prisma: dependencies.prisma ?? prisma,
      billingGateway: stripe.gateway,
      storageGateway: dependencies.storageGateway ?? fakeStorageGateway().gateway,
      log: dependencies.log ?? recordingLogger(),
    },
    { now: NOW, ...options },
  );
}

beforeEach(resetDatabase);

describe("accountDeletion", () => {
  it("cancels Stripe, deletes every row of the account and keeps a tombstone and the activity log", async () => {
    const stripe = recordingStripeGateway();
    const doomed = await doomedAccount(stripe);

    const summary = await runJob(stripe);

    assert.deepEqual(summary, { job: "accountDeletion", processed: 1, done: 1, skipped: 0, deferred: 0, failed: 0 });
    assert.deepEqual(await ownedCounts(doomed.account), OWNED_MODELS.map(() => 0));

    const tombstone = await storedAccount(doomed.account);
    assert.equal(tombstone.name, "");
    assert.equal(tombstone.status, "PENDING_DELETION");
    assert.equal(tombstone.deletionExecutedAt.toISOString(), NOW.toISOString());

    assert.deepEqual(
      stripe.calls.map(({ name, args }) => [name, args[0]]),
      [["retrieveSubscription", doomed.stripeSubscriptionId], ["cancelSubscription", doomed.stripeSubscriptionId]],
    );
    assert.deepEqual(stripe.calls[1].args[1], {
      idempotencyKey: `owner-account-${doomed.account.id}-deletion-${doomed.stripeSubscriptionId}`,
    });

    const logs = await prisma.activityLog.findMany({ where: { entityId: doomed.account.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(logs.map((log) => log.action), ["DELETION_SCHEDULED", "DELETION_EXECUTED"]);
    assert.equal(logs[1].performedByUserId, null);
    assert.deepEqual(logs[1].metadata, {
      deleted: {
        issues: 1,
        receipts: 1,
        receiptUploads: 0,
        leaveRequests: 1,
        invitations: 2,
        tenantAssignments: 1,
        houses: 1,
        memberInvitations: 1,
        members: 2,
        subscriptions: 1,
      },
      stripeSubscriptionCanceled: true,
      storageObjectsDeleted: 0,
    });
  });

  it("keeps the users, the tenant's profile and the tenant's leases with other owners", async () => {
    const stripe = recordingStripeGateway();
    const doomed = await doomedAccount(stripe);
    const other = await healthyAccount(doomed.tenant);
    const otherBefore = await ownedCounts(other.account);

    await runJob(stripe);

    for (const user of [doomed.owner, doomed.coOwner, doomed.tenant]) {
      assert.ok(await prisma.user.findUnique({ where: { id: user.id } }), "user kept");
    }

    const profile = await prisma.tenantProfile.findUnique({ where: { userId: doomed.tenant.id } });
    assert.ok(profile, "tenant profile kept");
    assert.deepEqual(
      (await prisma.tenantAssignment.findMany({ where: { tenantProfileId: profile.id } })).map(({ id }) => id),
      [other.assignment.id],
    );
    assert.deepEqual(await ownedCounts(other.account), otherBefore);
  });

  it("leaves accounts that are not due, not in PENDING_DELETION or already deleted", async () => {
    const stripe = recordingStripeGateway();
    const notDue = await doomedAccount(stripe, { deletionScheduledAt: NOT_YET_DUE });
    const healthy = await healthyAccount(await createUser());
    const before = await Promise.all([ownedCounts(notDue.account), ownedCounts(healthy.account)]);

    const summary = await runJob(stripe);

    assert.equal(summary.processed, 0);
    assert.deepEqual(await Promise.all([ownedCounts(notDue.account), ownedCounts(healthy.account)]), before);
    assert.deepEqual(stripe.calls, []);
  });

  it("is idempotent: a second run touches nothing and calls Stripe no more", async () => {
    const stripe = recordingStripeGateway();
    const doomed = await doomedAccount(stripe);
    await runJob(stripe);
    const tombstone = await storedAccount(doomed.account);
    const callCount = stripe.calls.length;

    const second = await runJob(stripe);

    assert.equal(second.processed, 0);
    assert.deepEqual(await storedAccount(doomed.account), tombstone);
    assert.equal(stripe.calls.length, callCount);
    assert.equal(await prisma.activityLog.count({ where: { action: "DELETION_EXECUTED" } }), 1);
  });

  it("works through every batch", async () => {
    const stripe = recordingStripeGateway();
    const accounts = [];

    for (let index = 0; index < 5; index += 1) {
      accounts.push((await doomedAccount(stripe)).account);
    }

    const summary = await runJob(stripe, { batchSize: 2 });

    assert.deepEqual([summary.processed, summary.done], [5, 5]);
    for (const account of accounts) {
      assert.ok((await storedAccount(account)).deletionExecutedAt);
    }
  });

  it("defers an account when Stripe fails, deletes the others, and deletes it on the next run", async () => {
    const working = recordingStripeGateway();
    const failing = await doomedAccount(working);
    const others = [await doomedAccount(working), await doomedAccount(working)];
    const flaky = recordingStripeGateway({
      subscriptions: working.subscriptions,
      overrides: {
        async cancelSubscription(id, options) {
          if (id === failing.stripeSubscriptionId) {
            throw Object.assign(new Error("Stripe is unavailable"), { type: "StripeConnectionError" });
          }

          return working.gateway.cancelSubscription(id, options);
        },
      },
    });
    const log = recordingLogger();
    const failingBefore = await ownedCounts(failing.account);

    const summary = await runJob(flaky, {}, { log });

    assert.deepEqual([summary.processed, summary.done, summary.deferred, summary.failed], [3, 2, 1, 0]);
    assert.deepEqual(await ownedCounts(failing.account), failingBefore);
    assert.equal((await storedAccount(failing.account)).deletionExecutedAt, null);
    for (const { account } of others) {
      assert.ok((await storedAccount(account)).deletionExecutedAt);
    }

    const [{ level, args }] = log.entries;
    assert.equal(level, "warn");
    assert.equal(args[0].ownerAccountId, failing.account.id);

    const retried = await runJob(working);
    assert.deepEqual([retried.processed, retried.done], [1, 1]);
    assert.ok((await storedAccount(failing.account)).deletionExecutedAt);
  });

  it("logs an account whose transaction fails and carries on with the rest", async () => {
    const stripe = recordingStripeGateway();
    const accounts = [];

    for (let index = 0; index < 3; index += 1) {
      accounts.push((await doomedAccount(stripe)).account);
    }

    const [first, ...rest] = accounts.sort((a, b) => (a.id < b.id ? -1 : 1));
    const log = recordingLogger();

    const summary = await runJob(stripe, {}, { prisma: prismaFailingTransactions([1]), log });

    assert.deepEqual([summary.done, summary.failed], [2, 1]);
    assert.equal((await storedAccount(first)).deletionExecutedAt, null);
    for (const account of rest) {
      assert.ok((await storedAccount(account)).deletionExecutedAt);
    }
    assert.equal(log.entries[0].level, "error");
    assert.equal(log.entries[0].args[0].ownerAccountId, first.id);
  });

  it("skips Stripe for an ended or missing subscription, expires an open Checkout, and handles no billing row", async () => {
    const stripe = recordingStripeGateway();
    const ended = await doomedAccount(stripe);
    stripe.subscriptions.get(ended.stripeSubscriptionId).status = "canceled";

    const missing = await doomedAccount(stripe);
    stripe.subscriptions.delete(missing.stripeSubscriptionId);
    const missingGateway = recordingStripeGateway({
      subscriptions: stripe.subscriptions,
      overrides: {
        async retrieveSubscription(id) {
          if (id === missing.stripeSubscriptionId) {
            throw Object.assign(new Error("No such subscription"), { code: "resource_missing" });
          }

          return stripe.gateway.retrieveSubscription(id);
        },
      },
    });

    const checkout = await doomedAccount(stripe, { subscription: { stripeSubscriptionId: null, pendingCheckoutSessionId: "cs_test_open" } });
    stripe.sessions.set("cs_test_open", { status: "open" });
    missingGateway.sessions.set("cs_test_open", { status: "open" });

    const noBilling = await doomedAccount(stripe);
    await prisma.subscription.delete({ where: { ownerAccountId: noBilling.account.id } });

    const summary = await runJob(missingGateway);

    assert.deepEqual([summary.done, summary.deferred], [4, 0]);
    assert.ok(!missingGateway.calls.some(({ name }) => name === "cancelSubscription"));
    assert.ok(missingGateway.calls.some(({ name, args }) => name === "expireCheckoutSession" && args[0] === "cs_test_open"));
  });

  it("defers when the subscription changes between the Stripe call and the transaction", async () => {
    const stripe = recordingStripeGateway();
    const doomed = await doomedAccount(stripe);
    const racing = recordingStripeGateway({
      subscriptions: stripe.subscriptions,
      overrides: {
        async cancelSubscription(id, options) {
          await prisma.subscription.update({
            where: { ownerAccountId: doomed.account.id },
            data: { stripeSubscriptionId: "sub_test_new_after_payment" },
          });
          return stripe.gateway.cancelSubscription(id, options);
        },
      },
    });

    const summary = await runJob(racing);

    assert.equal(summary.deferred, 1);
    assert.equal((await storedAccount(doomed.account)).deletionExecutedAt, null);
  });
});

describe("tombstones", () => {
  it("cannot be revived by cancelling the deletion", async () => {
    const stripe = recordingStripeGateway();
    const doomed = await doomedAccount(stripe);
    await runJob(stripe);
    const admin = await createUser();

    expectError(
      await run(contextFor(admin, { superAdmin: true }), "mutation ($id: ID!) { adminCancelOwnerAccountDeletion(id: $id) { status } }", { id: doomed.account.id }),
      "CONFLICT",
      INVALID_TRANSITION,
    );
    assert.equal((await storedAccount(doomed.account)).status, "PENDING_DELETION");
  });

  it("ignore later Stripe webhooks, so no billing row comes back", async () => {
    const stripe = recordingStripeGateway();
    const doomed = await doomedAccount(stripe);
    await runJob(stripe);

    const canceled = stripe.subscriptions.get(doomed.stripeSubscriptionId);
    canceled.metadata = { ownerAccountId: doomed.account.id };
    const event = stripeEvent("customer.subscription.deleted", canceled);

    const result = await processStripeWebhook({ prisma, gateway: stripe.gateway, notifier: recordingNotifier(), webhookSecret: TEST_WEBHOOK_SECRET }, signWebhook(event));

    assert.equal(result.status, 200);
    assert.equal(result.body.ignored, true);
    assert.equal(await prisma.subscription.count({ where: { ownerAccountId: doomed.account.id } }), 0);
  });
});
