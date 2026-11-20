import { randomBytes } from "node:crypto";

import Stripe from "stripe";

import { lookupKeyFor } from "../../src/lib/plans.js";

/** Signing secret for webhook tests; payloads are signed locally with it. */
export const TEST_WEBHOOK_SECRET = "whsec_test_suite_signing_secret";

const GATEWAY_METHODS = Object.freeze([
  "createCustomer",
  "findPriceIdByLookupKey",
  "createCheckoutSession",
  "retrieveCheckoutSession",
  "expireCheckoutSession",
  "createPortalSession",
  "retrieveSubscription",
  "updateCustomerEmail",
  "cancelSubscription",
]);

const SECONDS_PER_DAY = 24 * 60 * 60;

function suffix() {
  return randomBytes(8).toString("hex");
}

/** Unix seconds `days` from now. */
export function secondsFromNow(days) {
  return Math.floor(Date.now() / 1000) + Math.round(days * SECONDS_PER_DAY);
}

/**
 * The default billing gateway for test contexts: every call rejects with an error that has
 * no GraphQL code, so a test that reaches Stripe unexpectedly fails.
 */
export function unexpectedStripeGateway() {
  return Object.freeze(
    Object.fromEntries(
      GATEWAY_METHODS.map((name) => [
        name,
        async () => {
          throw new Error(`Unexpected Stripe call: ${name}`);
        },
      ]),
    ),
  );
}

/**
 * A billing gateway that records every call and answers like Stripe would, with no network.
 * `subscriptions` maps subscription ids to objects from stripeSubscription(); `sessions`
 * maps Checkout session ids to `{ status }`. Pass `overrides` to replace single methods.
 */
export function recordingStripeGateway({ subscriptions = new Map(), sessions = new Map(), overrides = {} } = {}) {
  const calls = [];
  const record = (name, args) => calls.push({ name, args });

  const gateway = {
    async createCustomer(params, options) {
      record("createCustomer", [params, options]);
      return { id: `cus_test_${suffix()}` };
    },
    async findPriceIdByLookupKey(lookupKey) {
      record("findPriceIdByLookupKey", [lookupKey]);
      return `price_test_${lookupKey}`;
    },
    async createCheckoutSession(params) {
      record("createCheckoutSession", [params]);
      const id = `cs_test_${suffix()}`;
      sessions.set(id, { status: "open" });
      return { id, url: `https://checkout.stripe.test/c/pay/${id}` };
    },
    async retrieveCheckoutSession(id) {
      record("retrieveCheckoutSession", [id]);
      return { id, status: sessions.get(id)?.status ?? "expired" };
    },
    async expireCheckoutSession(id) {
      record("expireCheckoutSession", [id]);
      sessions.set(id, { status: "expired" });
      return { id, status: "expired" };
    },
    async createPortalSession(params) {
      record("createPortalSession", [params]);
      return { url: `https://billing.stripe.test/p/session/${suffix()}` };
    },
    async retrieveSubscription(id) {
      record("retrieveSubscription", [id]);
      const subscription = subscriptions.get(id);

      if (!subscription) {
        throw new Error(`No test subscription ${id}`);
      }

      return subscription;
    },
    async updateCustomerEmail(params) {
      record("updateCustomerEmail", [params]);
      return { id: params.customerId, email: params.email };
    },
    async cancelSubscription(id, options) {
      record("cancelSubscription", [id, options]);
      const subscription = subscriptions.get(id);

      if (subscription) {
        subscription.status = "canceled";
      }

      return { id, object: "subscription", status: "canceled" };
    },
    ...overrides,
  };

  return { gateway, calls, subscriptions, sessions };
}

/**
 * A Stripe Subscription object with the fields billing reads, shaped like API version
 * 2026-11-18.endive (the billing period is on the subscription item).
 */
export function stripeSubscription({
  id = `sub_test_${suffix()}`,
  customer,
  status = "active",
  plan = "STARTER",
  interval = "MONTH",
  lookupKey = lookupKeyFor(plan, interval),
  trialStart = null,
  trialEnd = null,
  periodEnd = secondsFromNow(30),
  cancelAtPeriodEnd = false,
  metadata = {},
} = {}) {
  return {
    id,
    object: "subscription",
    customer,
    status,
    trial_start: trialStart,
    trial_end: trialEnd,
    cancel_at_period_end: cancelAtPeriodEnd,
    metadata,
    items: {
      object: "list",
      data: [
        {
          id: `si_test_${suffix()}`,
          object: "subscription_item",
          current_period_end: periodEnd,
          price: { id: `price_test_${lookupKey}`, object: "price", lookup_key: lookupKey },
        },
      ],
    },
  };
}

/** A Stripe event envelope for `type` carrying `object`. */
export function stripeEvent(type, object, id = `evt_test_${suffix()}`) {
  return { id, object: "event", type, created: Math.floor(Date.now() / 1000), data: { object } };
}

/** `{ rawBody, signature }` for an event, signed locally the way Stripe signs deliveries. */
export function signWebhook(event, secret = TEST_WEBHOOK_SECRET) {
  const rawBody = JSON.stringify(event);
  const signature = Stripe.webhooks.generateTestHeaderString({ payload: rawBody, secret });
  return { rawBody: Buffer.from(rawBody), signature };
}
