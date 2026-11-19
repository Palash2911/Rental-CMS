import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { beforeEach, describe, it } from "node:test";

import { createStripeWebhookHandler, processStripeWebhook } from "../../src/stripe/webhook.js";
import { prisma, resetDatabase } from "../support/db.js";
import { contextFor, createOwnerAccount, createUser } from "../support/factories.js";
import { expectData, run } from "../support/graphql.js";
import {
  recordingStripeGateway,
  secondsFromNow,
  signWebhook,
  stripeEvent,
  stripeSubscription,
  TEST_WEBHOOK_SECRET,
} from "../support/stripe.js";

const BILLING = `query ($id: ID!) { ownerAccount(id: $id) { billing { plan interval status access readOnly tenantLimit trialAvailable } } }`;
const START_CHECKOUT = `mutation ($ownerAccountId: ID!) { startCheckout(ownerAccountId: $ownerAccountId, plan: STARTER, interval: MONTH) { url } }`;
const MS_PER_SECOND = 1000;

let sequence = 0;

function nextIds() {
  sequence += 1;
  return { customer: `cus_test_hook_${sequence}`, session: `cs_test_hook_${sequence}` };
}

/**
 * An account as it is after startCheckout: a Subscription row with the Stripe customer and
 * the pending Checkout session, and nothing synced yet.
 */
async function checkoutStarted({ status = "PENDING", billing = {} } = {}) {
  const owner = await createUser();
  const ids = nextIds();
  const account = await createOwnerAccount(owner, {
    status,
    billing: { stripeCustomerId: ids.customer, pendingCheckoutSessionId: ids.session, ...billing },
  });
  return { owner, account, customer: ids.customer, sessionId: ids.session };
}

function checkoutSession({ id, customer, subscription, account, mode = "subscription" }) {
  return {
    id,
    object: "checkout.session",
    mode,
    customer,
    subscription,
    client_reference_id: account.id,
    metadata: { ownerAccountId: account.id },
    status: "complete",
  };
}

function deliver(gateway, event, { now } = {}) {
  return processStripeWebhook(
    { prisma, gateway, webhookSecret: TEST_WEBHOOK_SECRET, ...(now ? { now: () => now } : {}) },
    signWebhook(event),
  );
}

function storedSubscription(account) {
  return prisma.subscription.findUnique({ where: { ownerAccountId: account.id } });
}

function storedAccount(account) {
  return prisma.ownerAccount.findUnique({ where: { id: account.id } });
}

async function billingOf(owner, account) {
  return expectData(await run(contextFor(owner), BILLING, { id: account.id })).ownerAccount.billing;
}

// Completes checkout for `account` with a subscription in `status`, as Stripe would.
async function completeCheckout(fixture, { status = "trialing", plan = "STARTER", interval = "MONTH", trial = status === "trialing" } = {}) {
  const subscription = stripeSubscription({
    customer: fixture.customer,
    status,
    plan,
    interval,
    trialStart: trial ? secondsFromNow(0) : null,
    trialEnd: trial ? secondsFromNow(7) : null,
    metadata: { ownerAccountId: fixture.account.id },
  });
  const stripe = recordingStripeGateway({ subscriptions: new Map([[subscription.id, subscription]]) });
  const event = stripeEvent(
    "checkout.session.completed",
    checkoutSession({ id: fixture.sessionId, customer: fixture.customer, subscription: subscription.id, account: fixture.account }),
  );
  const result = await deliver(stripe.gateway, event);
  return { ...stripe, subscription, event, result };
}

beforeEach(resetDatabase);

describe("webhook signature", () => {
  it("rejects a delivery without a signature and records nothing", async () => {
    const { gateway, calls } = recordingStripeGateway();
    const { rawBody } = signWebhook(stripeEvent("invoice.paid", {}));

    const result = await processStripeWebhook({ prisma, gateway, webhookSecret: TEST_WEBHOOK_SECRET }, { rawBody, signature: undefined });

    assert.deepEqual(result, { status: 400, body: { error: "Missing Stripe-Signature header." } });
    assert.equal(await prisma.stripeEvent.count(), 0);
    assert.equal(calls.length, 0);
  });

  it("rejects a wrong secret and a tampered body", async () => {
    const { gateway } = recordingStripeGateway();
    const event = stripeEvent("invoice.paid", {});
    const wrongSecret = signWebhook(event, "whsec_some_other_secret");
    const signed = signWebhook(event);
    const tampered = { rawBody: Buffer.from(signed.rawBody.toString().replace("invoice.paid", "invoice.payment_failed")), signature: signed.signature };

    for (const delivery of [wrongSecret, tampered]) {
      const result = await processStripeWebhook({ prisma, gateway, webhookSecret: TEST_WEBHOOK_SECRET }, delivery);
      assert.deepEqual(result, { status: 400, body: { error: "Invalid webhook signature." } });
    }

    assert.equal(await prisma.stripeEvent.count(), 0);
  });
});

describe("checkout.session.completed and auto-approval", () => {
  it("approves a PENDING account on a trial checkout and syncs the subscription", async () => {
    const fixture = await checkoutStarted();
    const now = new Date();

    const { subscription, event, result } = await completeCheckout(fixture);

    assert.deepEqual(result, { status: 200, body: { received: true } });
    assert.equal((await storedAccount(fixture.account)).status, "APPROVED");

    const stored = await storedSubscription(fixture.account);
    assert.equal(stored.stripeSubscriptionId, subscription.id);
    assert.equal(stored.stripeCustomerId, fixture.customer);
    assert.equal(stored.pendingCheckoutSessionId, null);
    assert.equal(stored.plan, "STARTER");
    assert.equal(stored.interval, "MONTH");
    assert.equal(stored.stripeStatus, "trialing");
    assert.equal(stored.trialEnd.getTime(), subscription.trial_end * MS_PER_SECOND);
    assert.equal(stored.currentPeriodEnd.getTime(), subscription.items.data[0].current_period_end * MS_PER_SECOND);
    assert.ok(stored.trialUsedAt.getTime() >= now.getTime() - MS_PER_SECOND);
    assert.equal(stored.readOnlySince, null);

    const approval = await prisma.activityLog.findFirst({ where: { entityId: fixture.account.id, action: "APPROVED" } });
    assert.equal(approval.performedByUserId, null);
    assert.deepEqual(approval.metadata, { fromStatus: "PENDING", toStatus: "APPROVED", reason: "CHECKOUT_COMPLETED" });

    const synced = await prisma.activityLog.findFirst({ where: { entityId: stored.id, action: "SYNCED" } });
    assert.equal(synced.performedByUserId, null);
    assert.equal(synced.metadata.eventId, event.id);
    assert.equal(synced.metadata.approved, true);

    const billing = await billingOf(fixture.owner, fixture.account);
    assert.equal(billing.access, "FULL");
    assert.equal(billing.tenantLimit, 8);
    assert.equal(billing.trialAvailable, false);
  });

  it("approves a PENDING account on a paid checkout without a trial", async () => {
    const fixture = await checkoutStarted({ billing: { trialUsedAt: new Date("2026-01-01T00:00:00.000Z") } });

    await completeCheckout(fixture, { status: "active", plan: "PRO", interval: "YEAR" });

    assert.equal((await storedAccount(fixture.account)).status, "APPROVED");
    const stored = await storedSubscription(fixture.account);
    assert.equal(stored.plan, "PRO");
    assert.equal(stored.interval, "YEAR");
    assert.equal(stored.trialUsedAt.toISOString(), "2026-01-01T00:00:00.000Z", "trialUsedAt is set once and never moved");
  });

  it("does not approve when the subscription has no paid access yet", async () => {
    const fixture = await checkoutStarted();

    await completeCheckout(fixture, { status: "incomplete" });

    assert.equal((await storedAccount(fixture.account)).status, "PENDING");
    assert.equal((await storedSubscription(fixture.account)).stripeStatus, "incomplete");
    assert.equal(await prisma.activityLog.count({ where: { entityId: fixture.account.id, action: "APPROVED" } }), 0);
  });

  it("leaves a BLOCKED or PENDING_DELETION account in its status, but still syncs billing", async () => {
    for (const status of ["BLOCKED", "PENDING_DELETION"]) {
      const fixture = await checkoutStarted({ status });

      await completeCheckout(fixture, { status: "active" });

      assert.equal((await storedAccount(fixture.account)).status, status);
      assert.equal((await storedSubscription(fixture.account)).stripeStatus, "active");
    }
  });

  it("leaves an already APPROVED account approved and logs no second approval", async () => {
    const fixture = await checkoutStarted({ status: "APPROVED", billing: { readOnlySince: new Date() } });

    await completeCheckout(fixture, { status: "active" });

    assert.equal((await storedAccount(fixture.account)).status, "APPROVED");
    assert.equal(await prisma.activityLog.count({ where: { entityId: fixture.account.id, action: "APPROVED" } }), 0);
    assert.equal((await storedSubscription(fixture.account)).readOnlySince, null, "paying lifts read-only");
  });

  it("finds the account from client_reference_id when the customer is not stored yet", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner, { status: "PENDING", billing: null });

    await completeCheckout({ owner, account, customer: "cus_test_unseen", sessionId: "cs_test_unseen" }, { status: "active" });

    assert.equal((await storedAccount(account)).status, "APPROVED");
    assert.equal((await storedSubscription(account)).stripeCustomerId, "cus_test_unseen");
  });

  it("ignores a checkout session that is not for a subscription, but records the event", async () => {
    const fixture = await checkoutStarted();
    const { gateway, calls } = recordingStripeGateway();
    const event = stripeEvent(
      "checkout.session.completed",
      checkoutSession({ id: fixture.sessionId, customer: fixture.customer, subscription: null, account: fixture.account, mode: "payment" }),
    );

    const result = await deliver(gateway, event);

    assert.deepEqual(result.body, { received: true, ignored: true });
    assert.equal(calls.length, 0);
    assert.equal((await storedAccount(fixture.account)).status, "PENDING");
    assert.ok(await prisma.stripeEvent.findUnique({ where: { id: event.id } }));
  });
});

describe("idempotency", () => {
  it("applies a redelivered event once", async () => {
    const fixture = await checkoutStarted();
    const { gateway, calls, event } = await completeCheckout(fixture);

    const second = await deliver(gateway, event);

    assert.deepEqual(second, { status: 200, body: { received: true, duplicate: true } });
    assert.equal(calls.filter((call) => call.name === "retrieveSubscription").length, 1);
    assert.equal(await prisma.stripeEvent.count({ where: { id: event.id } }), 1);
    assert.equal(await prisma.activityLog.count({ where: { action: "SYNCED" } }), 1);
    assert.equal(await prisma.activityLog.count({ where: { action: "APPROVED" } }), 1);
  });

  it("records nothing when Stripe cannot be reached, so the retry applies the event", async () => {
    const fixture = await checkoutStarted();
    const subscription = stripeSubscription({ customer: fixture.customer, status: "active" });
    const event = stripeEvent(
      "checkout.session.completed",
      checkoutSession({ id: fixture.sessionId, customer: fixture.customer, subscription: subscription.id, account: fixture.account }),
    );
    const down = recordingStripeGateway({
      overrides: {
        retrieveSubscription: async () => {
          throw new Error("Stripe is unreachable");
        },
      },
    });

    await assert.rejects(deliver(down.gateway, event), /Stripe is unreachable/);
    assert.equal(await prisma.stripeEvent.count(), 0);
    assert.equal((await storedAccount(fixture.account)).status, "PENDING");

    const up = recordingStripeGateway({ subscriptions: new Map([[subscription.id, subscription]]) });
    assert.deepEqual((await deliver(up.gateway, event)).body, { received: true });
    assert.equal((await storedAccount(fixture.account)).status, "APPROVED");
  });

  it("records an event for an unknown account and an event type it does not act on", async () => {
    const unknown = stripeSubscription({ customer: "cus_test_nobody" });
    const { gateway, calls } = recordingStripeGateway({ subscriptions: new Map([[unknown.id, unknown]]) });
    const events = [
      stripeEvent("customer.subscription.updated", unknown),
      stripeEvent("customer.created", { id: "cus_test_nobody", object: "customer" }),
    ];

    for (const event of events) {
      assert.deepEqual((await deliver(gateway, event)).body, { received: true, ignored: true });
    }

    assert.equal(await prisma.stripeEvent.count(), 2);
    assert.equal(await prisma.subscription.count(), 0);
    assert.deepEqual(calls.map((call) => call.name), ["retrieveSubscription"]);
  });
});

describe("entitlement transitions", () => {
  async function activeAccount() {
    const fixture = await checkoutStarted();
    const stripe = await completeCheckout(fixture, { status: "active" });
    return { ...fixture, ...stripe };
  }

  // Sets the subscription's state in the fake Stripe and delivers an update for it.
  async function update(fixture, changes, payload = fixture.subscription) {
    const latest = stripeSubscription({
      id: fixture.subscription.id,
      customer: fixture.customer,
      metadata: { ownerAccountId: fixture.account.id },
      ...changes,
    });
    fixture.subscriptions.set(latest.id, latest);
    const result = await deliver(fixture.gateway, stripeEvent("customer.subscription.updated", payload));
    assert.deepEqual(result.body, { received: true });
    return latest;
  }

  it("moves through past_due, unpaid and back to active, with readOnlySince following", async () => {
    const fixture = await activeAccount();

    await update(fixture, { status: "past_due" });
    assert.equal((await billingOf(fixture.owner, fixture.account)).access, "FULL");
    assert.equal((await storedSubscription(fixture.account)).readOnlySince, null);

    await update(fixture, { status: "unpaid" });
    const readOnly = await storedSubscription(fixture.account);
    assert.equal((await billingOf(fixture.owner, fixture.account)).access, "READ_ONLY");
    assert.ok(readOnly.readOnlySince instanceof Date);

    await update(fixture, { status: "unpaid", cancelAtPeriodEnd: true });
    assert.equal(
      (await storedSubscription(fixture.account)).readOnlySince.getTime(),
      readOnly.readOnlySince.getTime(),
      "readOnlySince is set once, not moved by later events",
    );

    await update(fixture, { status: "active" });
    assert.equal((await billingOf(fixture.owner, fixture.account)).access, "FULL");
    assert.equal((await storedSubscription(fixture.account)).readOnlySince, null);
  });

  it("makes the account read-only when the subscription is deleted, and keeps it APPROVED", async () => {
    const fixture = await activeAccount();
    const canceled = stripeSubscription({ id: fixture.subscription.id, customer: fixture.customer, status: "canceled" });
    fixture.subscriptions.set(canceled.id, canceled);

    await deliver(fixture.gateway, stripeEvent("customer.subscription.deleted", canceled));

    assert.equal((await storedAccount(fixture.account)).status, "APPROVED");
    const billing = await billingOf(fixture.owner, fixture.account);
    assert.equal(billing.access, "READ_ONLY");
    assert.equal(billing.tenantLimit, 0);
    assert.equal(billing.trialAvailable, false);
  });

  it("applies Stripe's latest state, not the event payload", async () => {
    const fixture = await activeAccount();
    const stalePayload = { ...fixture.subscription, status: "active" };

    await update(fixture, { status: "canceled" }, stalePayload);

    assert.equal((await storedSubscription(fixture.account)).stripeStatus, "canceled");
  });

  it("applies a plan change made in the portal", async () => {
    const fixture = await activeAccount();

    await update(fixture, { status: "active", plan: "GROWTH", interval: "YEAR", cancelAtPeriodEnd: true });

    const stored = await storedSubscription(fixture.account);
    assert.equal(stored.plan, "GROWTH");
    assert.equal(stored.interval, "YEAR");
    assert.equal(stored.cancelAtPeriodEnd, true);
    assert.equal((await billingOf(fixture.owner, fixture.account)).tenantLimit, 26);
  });

  it("gives no access for a price that is not one of our plans", async () => {
    const fixture = await activeAccount();

    await update(fixture, { status: "active", lookupKey: "someone_elses_price" });

    assert.equal((await storedSubscription(fixture.account)).plan, null);
    assert.equal((await billingOf(fixture.owner, fixture.account)).access, "READ_ONLY");
  });

  it("ignores an event for an older subscription while the current one is live", async () => {
    const fixture = await activeAccount();
    const old = stripeSubscription({ customer: fixture.customer, status: "canceled" });
    fixture.subscriptions.set(old.id, old);

    await deliver(fixture.gateway, stripeEvent("customer.subscription.deleted", old));

    const stored = await storedSubscription(fixture.account);
    assert.equal(stored.stripeSubscriptionId, fixture.subscription.id);
    assert.equal(stored.stripeStatus, "active");
    assert.equal(await prisma.activityLog.count({ where: { entityId: stored.id, action: "SYNCED" } }), 1);
  });

  it("re-syncs the tracked subscription on invoice events", async () => {
    const fixture = await activeAccount();
    fixture.subscriptions.set(
      fixture.subscription.id,
      stripeSubscription({ id: fixture.subscription.id, customer: fixture.customer, status: "past_due" }),
    );

    await deliver(fixture.gateway, stripeEvent("invoice.payment_failed", { id: "in_test_1", object: "invoice", customer: fixture.customer }));
    assert.equal((await storedSubscription(fixture.account)).stripeStatus, "past_due");

    fixture.subscriptions.set(
      fixture.subscription.id,
      stripeSubscription({ id: fixture.subscription.id, customer: fixture.customer, status: "active" }),
    );
    await deliver(fixture.gateway, stripeEvent("invoice.paid", { id: "in_test_2", object: "invoice", customer: fixture.customer }));
    assert.equal((await storedSubscription(fixture.account)).stripeStatus, "active");
  });

  it("ignores an invoice for a customer with no tracked subscription", async () => {
    const fixture = await checkoutStarted();
    const { gateway, calls } = recordingStripeGateway();

    const result = await deliver(gateway, stripeEvent("invoice.paid", { id: "in_test_3", object: "invoice", customer: fixture.customer }));

    assert.deepEqual(result.body, { received: true, ignored: true });
    assert.equal(calls.length, 0);
  });

  it("does not approve a PENDING account from a subscription event alone", async () => {
    const fixture = await checkoutStarted();
    const subscription = stripeSubscription({ customer: fixture.customer, status: "active" });
    const { gateway } = recordingStripeGateway({ subscriptions: new Map([[subscription.id, subscription]]) });

    await deliver(gateway, stripeEvent("customer.subscription.created", subscription));

    assert.equal((await storedAccount(fixture.account)).status, "PENDING");
    assert.equal((await storedSubscription(fixture.account)).stripeStatus, "active");
  });
});

describe("one trial per account", () => {
  it("offers no second trial after a trial subscription was synced and then canceled", async () => {
    const fixture = await checkoutStarted();
    const first = await completeCheckout(fixture);
    const canceled = stripeSubscription({ id: first.subscription.id, customer: fixture.customer, status: "canceled", trialStart: secondsFromNow(-7) });
    first.subscriptions.set(canceled.id, canceled);
    await deliver(first.gateway, stripeEvent("customer.subscription.deleted", canceled));

    const { gateway, calls } = recordingStripeGateway();
    expectData(await run(contextFor(fixture.owner, { billingGateway: gateway }), START_CHECKOUT, { ownerAccountId: fixture.account.id }));

    const [params] = calls.find((call) => call.name === "createCheckoutSession").args;
    assert.equal(params.subscription_data.trial_period_days, undefined);
    assert.equal(params.customer, fixture.customer);
  });
});

describe("checkout.session.expired", () => {
  it("clears the pending session only when it is the one the account tracks", async () => {
    const fixture = await checkoutStarted();
    const { gateway, calls } = recordingStripeGateway();
    const session = (id) => ({ id, object: "checkout.session", mode: "subscription", customer: fixture.customer, client_reference_id: fixture.account.id, status: "expired" });

    await deliver(gateway, stripeEvent("checkout.session.expired", session("cs_test_some_older_session")));
    assert.equal((await storedSubscription(fixture.account)).pendingCheckoutSessionId, fixture.sessionId);

    await deliver(gateway, stripeEvent("checkout.session.expired", session(fixture.sessionId)));
    const stored = await storedSubscription(fixture.account);
    assert.equal(stored.pendingCheckoutSessionId, null);
    assert.equal(stored.stripeStatus, null);
    assert.equal((await storedAccount(fixture.account)).status, "PENDING");
    assert.equal(calls.length, 0);
  });
});

describe("HTTP handler", () => {
  function request({ method = "POST", body = Buffer.alloc(0), headers = {} }) {
    return Object.assign(Readable.from([body]), { method, headers });
  }

  function response() {
    const sent = { status: null, headers: {}, body: null };
    return {
      sent,
      setHeader(name, value) {
        sent.headers[name] = value;
      },
      writeHead(status, headers) {
        sent.status = status;
        Object.assign(sent.headers, headers);
      },
      end(body) {
        sent.body = JSON.parse(body);
      },
    };
  }

  function handler(gateway, logger = { error() {} }) {
    return createStripeWebhookHandler({ prisma, gateway, webhookSecret: TEST_WEBHOOK_SECRET, logger });
  }

  it("processes a signed POST and returns JSON", async () => {
    const fixture = await checkoutStarted();
    const subscription = stripeSubscription({ customer: fixture.customer, status: "active" });
    const { gateway } = recordingStripeGateway({ subscriptions: new Map([[subscription.id, subscription]]) });
    const { rawBody, signature } = signWebhook(
      stripeEvent("checkout.session.completed", checkoutSession({ id: fixture.sessionId, customer: fixture.customer, subscription: subscription.id, account: fixture.account })),
    );
    const res = response();

    await handler(gateway)(request({ body: rawBody, headers: { "stripe-signature": signature } }), res);

    assert.equal(res.sent.status, 200);
    assert.equal(res.sent.headers["content-type"], "application/json");
    assert.deepEqual(res.sent.body, { received: true });
    assert.equal((await storedAccount(fixture.account)).status, "APPROVED");
  });

  it("answers 405 to anything but POST", async () => {
    const res = response();

    await handler(recordingStripeGateway().gateway)(request({ method: "GET" }), res);

    assert.equal(res.sent.status, 405);
    assert.equal(res.sent.headers.allow, "POST");
  });

  it("answers 413 to a body over 1 MB without processing it", async () => {
    const res = response();

    await handler(recordingStripeGateway().gateway)(request({ body: Buffer.alloc(1024 * 1024 + 1) }), res);

    assert.equal(res.sent.status, 413);
    assert.equal(await prisma.stripeEvent.count(), 0);
  });

  it("answers 500 and logs the error when processing fails, so Stripe retries", async () => {
    const fixture = await checkoutStarted();
    const { gateway } = recordingStripeGateway({
      overrides: {
        retrieveSubscription: async () => {
          throw new Error("Stripe is unreachable");
        },
      },
    });
    const { rawBody, signature } = signWebhook(
      stripeEvent("checkout.session.completed", checkoutSession({ id: fixture.sessionId, customer: fixture.customer, subscription: "sub_test_x", account: fixture.account })),
    );
    const logged = [];
    const res = response();

    await handler(gateway, { error: (...args) => logged.push(args) })(request({ body: rawBody, headers: { "stripe-signature": signature } }), res);

    assert.equal(res.sent.status, 500);
    assert.deepEqual(res.sent.body, { error: "Webhook processing failed." });
    assert.equal(logged.length, 1);
    assert.equal(logged[0][1].message, "Stripe is unreachable");
    assert.equal(await prisma.stripeEvent.count(), 0);
  });
});
