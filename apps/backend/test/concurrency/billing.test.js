import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { READ_ONLY_MESSAGE } from "../../src/lib/entitlement.js";
import { processStripeWebhook } from "../../src/stripe/webhook.js";
import { prisma, resetDatabase } from "../support/db.js";
import {
  contextFor,
  createAssignment,
  createHouse,
  createInvitation,
  createOwnerAccount,
  createUser,
} from "../support/factories.js";
import { race, run } from "../support/graphql.js";
import {
  recordingStripeGateway,
  signWebhook,
  stripeEvent,
  stripeSubscription,
  TEST_WEBHOOK_SECRET,
} from "../support/stripe.js";

const ROUNDS = 5;
const STARTER_LIMIT = 8;
const ACCEPT = `mutation ($id: ID!) { acceptInvitation(id: $id) { id status } }`;
const START_CHECKOUT = `mutation ($ownerAccountId: ID!) { startCheckout(ownerAccountId: $ownerAccountId, plan: STARTER, interval: MONTH) { url } }`;
const PLAN_LIMIT = "This owner account has reached the tenant limit of its plan.";
const STARTER = Object.freeze({ plan: "STARTER", interval: "MONTH", stripeStatus: "active" });

function activeOnAccount(account) {
  return prisma.tenantAssignment.count({
    where: { status: { in: ["ACTIVE", "NOTICE_PERIOD"] }, house: { ownerAccountId: account.id } },
  });
}

function deliver(gateway, event) {
  return processStripeWebhook({ prisma, gateway, webhookSecret: TEST_WEBHOOK_SECRET }, signWebhook(event));
}

// Settles webhook deliveries together; any rejection (a deadlock included) fails the test.
async function raceDeliveries(deliveries) {
  const settled = await Promise.allSettled(deliveries.map((delivery) => delivery()));

  return settled.map((entry, index) => {
    if (entry.status === "rejected") {
      assert.fail(`Delivery ${index} rejected: ${entry.reason?.message ?? entry.reason}`);
    }

    return entry.value;
  });
}

beforeEach(resetDatabase);

describe("acceptInvitation into different houses of one account", () => {
  it("lets exactly one of two accepts take the plan's last place", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const owner = await createUser();
      const account = await createOwnerAccount(owner, { billing: STARTER });
      const filled = await createHouse(account, { name: "Filled", maxTenants: STARTER_LIMIT });

      for (let index = 0; index < STARTER_LIMIT - 1; index += 1) {
        await createAssignment(filled, await createUser());
      }

      const houses = await Promise.all([
        createHouse(account, { name: "East" }),
        createHouse(account, { name: "West" }),
      ]);
      const [first, second] = await Promise.all([createUser(), createUser()]);
      const invitations = await Promise.all([
        createInvitation(houses[0], owner, { email: first.email }),
        createInvitation(houses[1], owner, { email: second.email }),
      ]);

      const outcomes = await race([
        () => run(contextFor(first), ACCEPT, { id: invitations[0].id }),
        () => run(contextFor(second), ACCEPT, { id: invitations[1].id }),
      ]);

      const losers = outcomes.filter((outcome) => !outcome.ok);
      assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1, `round ${round}`);
      assert.deepEqual(losers.map(({ code, message }) => ({ code, message })), [{ code: "CONFLICT", message: PLAN_LIMIT }]);
      assert.equal(await activeOnAccount(account), STARTER_LIMIT);
    }
  });
});

describe("acceptInvitation racing a subscription cancellation", () => {
  it("either accepts before the cancellation or is refused as read-only, never deadlocks", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const [owner, invitee] = await Promise.all([createUser(), createUser()]);
      const customer = `cus_test_race_${round}`;
      const subscriptionId = `sub_test_race_${round}`;
      const account = await createOwnerAccount(owner, {
        billing: { ...STARTER, stripeCustomerId: customer, stripeSubscriptionId: subscriptionId },
      });
      const house = await createHouse(account);
      const invitation = await createInvitation(house, owner, { email: invitee.email });
      const canceled = stripeSubscription({ id: subscriptionId, customer, status: "canceled" });
      const { gateway } = recordingStripeGateway({ subscriptions: new Map([[subscriptionId, canceled]]) });

      const [[accept], [hook]] = await Promise.all([
        race([() => run(contextFor(invitee), ACCEPT, { id: invitation.id })]),
        raceDeliveries([() => deliver(gateway, stripeEvent("customer.subscription.deleted", canceled))]),
      ]);

      assert.deepEqual(hook.body, { received: true }, `round ${round}`);

      if (!accept.ok) {
        assert.equal(accept.code, "FORBIDDEN");
        assert.equal(accept.message, READ_ONLY_MESSAGE);
      }

      assert.equal(await activeOnAccount(account), accept.ok ? 1 : 0);
      const stored = await prisma.subscription.findUnique({ where: { ownerAccountId: account.id } });
      assert.equal(stored.stripeStatus, "canceled");
      assert.ok(stored.readOnlySince instanceof Date);
    }
  });
});

describe("concurrent deliveries of one Stripe event", () => {
  it("applies the event exactly once", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const owner = await createUser();
      const customer = `cus_test_dup_${round}`;
      const account = await createOwnerAccount(owner, { status: "PENDING", billing: { stripeCustomerId: customer } });
      const subscription = stripeSubscription({ customer, status: "active" });
      const { gateway } = recordingStripeGateway({ subscriptions: new Map([[subscription.id, subscription]]) });
      const event = stripeEvent("checkout.session.completed", {
        id: `cs_test_dup_${round}`,
        object: "checkout.session",
        mode: "subscription",
        customer,
        subscription: subscription.id,
        client_reference_id: account.id,
      });

      const results = await raceDeliveries([() => deliver(gateway, event), () => deliver(gateway, event)]);

      const bodies = results.map((result) => result.body).sort((a, b) => Number(Boolean(a.duplicate)) - Number(Boolean(b.duplicate)));
      assert.deepEqual(bodies, [{ received: true }, { received: true, duplicate: true }], `round ${round}`);
      assert.ok(results.every((result) => result.status === 200));
      assert.equal(await prisma.activityLog.count({ where: { action: "SYNCED", metadata: { path: ["eventId"], equals: event.id } } }), 1);
      assert.equal(await prisma.activityLog.count({ where: { entityId: account.id, action: "APPROVED" } }), 1);
    }
  });
});

describe("concurrent startCheckout calls on one account", () => {
  it("serialize on the Subscription row: one customer, and only the last session stays open", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const owner = await createUser();
      const account = await createOwnerAccount(owner, { status: "PENDING", billing: null });
      const { gateway, calls, sessions } = recordingStripeGateway();
      const checkout = () => run(contextFor(owner, { billingGateway: gateway }), START_CHECKOUT, { ownerAccountId: account.id });

      const outcomes = await race([checkout, checkout]);

      assert.ok(outcomes.every((outcome) => outcome.ok), `round ${round}`);
      assert.equal(calls.filter((call) => call.name === "createCustomer").length, 1);
      assert.equal(await prisma.subscription.count({ where: { ownerAccountId: account.id } }), 1);

      const stored = await prisma.subscription.findUnique({ where: { ownerAccountId: account.id } });
      const open = [...sessions.entries()].filter(([, session]) => session.status === "open").map(([id]) => id);
      assert.deepEqual(open, [stored.pendingCheckoutSessionId]);
      assert.equal(sessions.size, 2);
    }
  });
});
