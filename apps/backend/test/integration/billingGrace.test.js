import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { DELETION_GRACE_DAYS } from "../../src/graphql/ownerAccount/serviceOwnerAccount.js";
import { runAccountDeletion } from "../../src/jobs/accountDeletion.js";
import { BILLING_GRACE_DAYS, runBillingGrace } from "../../src/jobs/billingGrace.js";
import { processStripeWebhook } from "../../src/stripe/webhook.js";
import { prisma, prismaFailingTransactions, resetDatabase } from "../support/db.js";
import { recordingNotifier } from "../support/email.js";
import { contextFor, createOwnerAccount, createUser, firebaseUid, recordingLogger } from "../support/factories.js";
import { expectData, run } from "../support/graphql.js";
import {
  recordingStripeGateway,
  signWebhook,
  stripeEvent,
  stripeSubscription,
  TEST_WEBHOOK_SECRET,
} from "../support/stripe.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2027-03-01T02:00:00.000Z");
const CANCELED = Object.freeze({ plan: "STARTER", interval: "MONTH", stripeStatus: "canceled" });

function daysBeforeNow(days) {
  return new Date(NOW.getTime() - days * MS_PER_DAY);
}

// An APPROVED account whose canceled subscription made it read-only `days` days before NOW.
async function readOnlyAccount(days, options = {}) {
  const owner = await createUser();
  const account = await createOwnerAccount(owner, {
    billing: { ...CANCELED, readOnlySince: daysBeforeNow(days) },
    ...options,
  });
  return { owner, account };
}

function stored(account) {
  return prisma.ownerAccount.findUnique({ where: { id: account.id } });
}

function deletionLogs() {
  return prisma.activityLog.findMany({ where: { action: "DELETION_SCHEDULED" }, orderBy: { createdAt: "asc" } });
}

function runJob(options = {}, dependencies = {}) {
  const log = dependencies.log ?? recordingLogger();
  return runBillingGrace(
    { prisma: dependencies.prisma ?? prisma, notifier: dependencies.notifier ?? recordingNotifier(), log },
    { now: NOW, ...options },
  );
}

const SCHEDULE_DELETION = "mutation ($id: ID!) { scheduleOwnerAccountDeletion(id: $id) { status } }";
const ADMIN_SCHEDULE_DELETION = "mutation ($id: ID!) { adminScheduleOwnerAccountDeletion(id: $id) { status } }";
const CANCEL_DELETION = "mutation ($id: ID!) { cancelOwnerAccountDeletion(id: $id) { status } }";

// A read-only account with a Stripe customer and its old, canceled subscription, so a new
// subscription for that customer reaches it through the webhook.
async function lapsedCustomer(days = BILLING_GRACE_DAYS + 1) {
  const stripeCustomerId = `cus_test_${firebaseUid().toLowerCase()}`;
  const fixture = await readOnlyAccount(days, {});
  await prisma.subscription.update({
    where: { ownerAccountId: fixture.account.id },
    data: { stripeCustomerId, stripeSubscriptionId: `sub_test_old_${firebaseUid().toLowerCase()}` },
  });
  return { ...fixture, stripeCustomerId };
}

// Delivers customer.subscription.updated for a new subscription in `status`.
function deliverSubscription(stripeCustomerId, status) {
  const subscription = stripeSubscription({ customer: stripeCustomerId, status });
  const stripe = recordingStripeGateway({ subscriptions: new Map([[subscription.id, subscription]]) });
  const event = stripeEvent("customer.subscription.updated", subscription);
  return processStripeWebhook({ prisma, gateway: stripe.gateway, notifier: recordingNotifier(), webhookSecret: TEST_WEBHOOK_SECRET }, signWebhook(event));
}

beforeEach(resetDatabase);

describe("deletionReason", () => {
  it("records why a deletion was scheduled and clears it on cancel", async () => {
    const billing = await readOnlyAccount(BILLING_GRACE_DAYS + 1);
    await runJob();
    assert.equal((await stored(billing.account)).deletionReason, "BILLING_GRACE");

    const owner = await createUser();
    const byOwner = await createOwnerAccount(owner);
    expectData(await run(contextFor(owner), SCHEDULE_DELETION, { id: byOwner.id }));
    assert.equal((await stored(byOwner)).deletionReason, "OWNER_REQUEST");

    const byAdmin = await createOwnerAccount(await createUser());
    expectData(await run(contextFor(await createUser(), { superAdmin: true }), ADMIN_SCHEDULE_DELETION, { id: byAdmin.id }));
    assert.equal((await stored(byAdmin)).deletionReason, "ADMIN_REQUEST");

    expectData(await run(contextFor(owner), CANCEL_DELETION, { id: byOwner.id }));
    const cancelled = await stored(byOwner);
    assert.deepEqual([cancelled.status, cancelled.deletionReason, cancelled.deletionScheduledAt], ["APPROVED", null, null]);
  });
});

describe("billing comes back during a billing deletion", () => {
  it("cancels the deletion when the new subscription is active, and logs it", async () => {
    const { account, stripeCustomerId } = await lapsedCustomer();
    await runJob();

    const result = await deliverSubscription(stripeCustomerId, "active");

    assert.equal(result.status, 200);
    const row = await stored(account);
    assert.deepEqual(
      [row.status, row.statusBeforeDeletion, row.deletionScheduledAt, row.deletionReason],
      ["APPROVED", null, null, null],
    );
    const subscription = await prisma.subscription.findUnique({ where: { ownerAccountId: account.id } });
    assert.equal(subscription.readOnlySince, null);

    const [log] = await prisma.activityLog.findMany({ where: { entityId: account.id, action: "DELETION_CANCELLED" } });
    assert.equal(log.performedByUserId, null);
    assert.deepEqual(
      { fromStatus: log.metadata.fromStatus, toStatus: log.metadata.toStatus, reason: log.metadata.reason, stripeStatus: log.metadata.stripeStatus },
      { fromStatus: "PENDING_DELETION", toStatus: "APPROVED", reason: "SUBSCRIPTION_RESUMED", stripeStatus: "active" },
    );
    assert.ok(log.metadata.eventId.startsWith("evt_test_"));

    const later = await runAccountDeletion({ prisma, billingGateway: recordingStripeGateway().gateway, log: recordingLogger() }, { now: new Date(NOW.getTime() + 60 * MS_PER_DAY) });
    assert.equal(later.processed, 0);
  });

  it("also cancels on trialing, but not on past_due or an ended status", async () => {
    const trialing = await lapsedCustomer();
    const pastDue = await lapsedCustomer();
    const unpaid = await lapsedCustomer();
    await runJob();

    await deliverSubscription(trialing.stripeCustomerId, "trialing");
    await deliverSubscription(pastDue.stripeCustomerId, "past_due");
    await deliverSubscription(unpaid.stripeCustomerId, "unpaid");

    assert.equal((await stored(trialing.account)).status, "APPROVED");
    assert.equal((await stored(pastDue.account)).status, "PENDING_DELETION");
    assert.equal((await stored(unpaid.account)).status, "PENDING_DELETION");
  });

  it("leaves deletions the owner or an admin asked for, and ones with no recorded reason", async () => {
    const byOwner = await lapsedCustomer(1);
    expectData(await run(contextFor(byOwner.owner), SCHEDULE_DELETION, { id: byOwner.account.id }));
    const byAdmin = await lapsedCustomer(1);
    expectData(await run(contextFor(await createUser(), { superAdmin: true }), ADMIN_SCHEDULE_DELETION, { id: byAdmin.account.id }));
    const legacy = await lapsedCustomer();
    await runJob();
    await prisma.ownerAccount.update({ where: { id: legacy.account.id }, data: { deletionReason: null } });

    for (const { account, stripeCustomerId } of [byOwner, byAdmin, legacy]) {
      await deliverSubscription(stripeCustomerId, "active");

      const row = await stored(account);
      assert.equal(row.status, "PENDING_DELETION");
      assert.ok(row.deletionScheduledAt);
    }

    assert.equal(await prisma.activityLog.count({ where: { action: "DELETION_CANCELLED" } }), 0);
  });
});

describe("billingGrace", () => {
  it("schedules deletion of an account read-only for more than 30 days, with the usual deletion window", async () => {
    const { account } = await readOnlyAccount(BILLING_GRACE_DAYS + 1);

    const summary = await runJob();

    assert.deepEqual(summary, { job: "billingGrace", processed: 1, done: 1, skipped: 0, deferred: 0, failed: 0 });
    const row = await stored(account);
    assert.equal(row.status, "PENDING_DELETION");
    assert.equal(row.statusBeforeDeletion, "APPROVED");
    assert.equal(row.deletionScheduledAt.toISOString(), new Date(NOW.getTime() + DELETION_GRACE_DAYS * MS_PER_DAY).toISOString());

    const [log] = await deletionLogs();
    assert.deepEqual([log.entityType, log.entityId, log.performedByUserId], ["OwnerAccount", account.id, null]);
    assert.deepEqual(log.metadata, {
      fromStatus: "APPROVED",
      toStatus: "PENDING_DELETION",
      reason: "BILLING_GRACE_EXPIRED",
      readOnlySince: daysBeforeNow(BILLING_GRACE_DAYS + 1).toISOString(),
      deletionScheduledAt: row.deletionScheduledAt.toISOString(),
    });
  });

  it("leaves accounts that are not past the grace period, not read-only, blocked or already scheduled", async () => {
    const untouched = [
      (await readOnlyAccount(BILLING_GRACE_DAYS - 1)).account,
      (await readOnlyAccount(BILLING_GRACE_DAYS)).account,
      (await readOnlyAccount(BILLING_GRACE_DAYS + 5, { status: "BLOCKED" })).account,
      (await readOnlyAccount(BILLING_GRACE_DAYS + 5, { status: "PENDING_DELETION", deletionScheduledAt: NOW })).account,
      await createOwnerAccount(await createUser()),
      await createOwnerAccount(await createUser(), { billing: null }),
    ];
    const before = await Promise.all(untouched.map(stored));

    const summary = await runJob();

    assert.equal(summary.done, 0);
    assert.deepEqual(await Promise.all(untouched.map(stored)), before);
    assert.deepEqual(await deletionLogs(), []);
  });

  it("re-checks under the lock and skips an account whose billing access came back", async () => {
    const paid = await readOnlyAccount(BILLING_GRACE_DAYS + 3);
    await prisma.subscription.update({ where: { ownerAccountId: paid.account.id }, data: { stripeStatus: "active" } });
    const enterprise = await readOnlyAccount(BILLING_GRACE_DAYS + 3);
    await prisma.subscription.update({ where: { ownerAccountId: enterprise.account.id }, data: { enterprise: true } });
    const pending = await readOnlyAccount(BILLING_GRACE_DAYS + 3, { status: "PENDING" });

    const summary = await runJob();

    assert.deepEqual([summary.processed, summary.done, summary.skipped], [3, 0, 3]);
    for (const { account } of [paid, enterprise, pending]) {
      assert.notEqual((await stored(account)).status, "PENDING_DELETION");
    }
  });

  it("works through every batch", async () => {
    const accounts = [];

    for (let index = 0; index < 5; index += 1) {
      accounts.push((await readOnlyAccount(BILLING_GRACE_DAYS + 1 + index)).account);
    }

    const summary = await runJob({ batchSize: 2 });

    assert.deepEqual([summary.processed, summary.done], [5, 5]);
    for (const account of accounts) {
      assert.equal((await stored(account)).status, "PENDING_DELETION");
    }
  });

  it("is idempotent: a second run changes nothing", async () => {
    const { account } = await readOnlyAccount(BILLING_GRACE_DAYS + 2);
    await runJob();
    const after = await stored(account);

    const second = await runJob();

    assert.equal(second.processed, 0);
    assert.deepEqual(await stored(account), after);
    assert.equal((await deletionLogs()).length, 1);
  });

  it("logs an account that fails and carries on with the rest", async () => {
    const accounts = [];

    for (let index = 0; index < 3; index += 1) {
      accounts.push((await readOnlyAccount(BILLING_GRACE_DAYS + 1)).account);
    }

    const [first, ...rest] = accounts.sort((a, b) => (a.id < b.id ? -1 : 1));
    const log = recordingLogger();

    const summary = await runJob({}, { prisma: prismaFailingTransactions([1]), log });

    assert.deepEqual([summary.processed, summary.done, summary.failed], [3, 2, 1]);
    assert.equal((await stored(first)).status, "APPROVED");
    for (const account of rest) {
      assert.equal((await stored(account)).status, "PENDING_DELETION");
    }

    const [{ level, args }] = log.entries;
    assert.equal(level, "error");
    assert.equal(args[0].ownerAccountId, first.id);
    assert.equal(args[0].job, "billingGrace");

    const retried = await runJob();
    assert.equal(retried.done, 1);
    assert.equal((await stored(first)).status, "PENDING_DELETION");
  });

  it("schedules again on the next run when the owner cancels the deletion without paying", async () => {
    const { owner, account } = await readOnlyAccount(BILLING_GRACE_DAYS + 1);
    await runJob();

    expectData(await run(contextFor(owner), "mutation ($id: ID!) { cancelOwnerAccountDeletion(id: $id) { status } }", { id: account.id }));
    assert.equal((await stored(account)).status, "APPROVED");

    const again = await runJob();
    assert.equal(again.done, 1);
    assert.equal((await stored(account)).status, "PENDING_DELETION");
  });
});
