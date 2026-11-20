import Stripe from "stripe";

// Bounded so a slow Stripe call cannot outlive the database transaction that waits for it.
const REQUEST_TIMEOUT_MS = 10_000;
const MAX_NETWORK_RETRIES = 2;

/**
 * Creates the Stripe client the app uses at runtime. The SDK pins its own API version
 * (stripe 23.2.0: 2026-11-18.endive), so it is not overridden here.
 */
export function createStripeClient(secretKey) {
  return new Stripe(secretKey, {
    timeout: REQUEST_TIMEOUT_MS,
    maxNetworkRetries: MAX_NETWORK_RETRIES,
  });
}

/**
 * The narrow set of Stripe calls billing needs, injected into the request context like the
 * Firebase lookup, so tests pass plain functions and never reach the network.
 */
export function createStripeGateway(stripe) {
  return Object.freeze({
    createCustomer({ ownerAccountId, email, name }, { idempotencyKey }) {
      return stripe.customers.create(
        { email, name, metadata: { ownerAccountId } },
        { idempotencyKey },
      );
    },

    async findPriceIdByLookupKey(lookupKey) {
      const prices = await stripe.prices.list({
        lookup_keys: [lookupKey],
        active: true,
        limit: 1,
      });
      return prices.data[0]?.id ?? null;
    },

    createCheckoutSession(params) {
      return stripe.checkout.sessions.create(params);
    },

    retrieveCheckoutSession(id) {
      return stripe.checkout.sessions.retrieve(id);
    },

    expireCheckoutSession(id) {
      return stripe.checkout.sessions.expire(id);
    },

    createPortalSession({ customer, returnUrl }) {
      return stripe.billingPortal.sessions.create({ customer, return_url: returnUrl });
    },

    retrieveSubscription(id) {
      return stripe.subscriptions.retrieve(id);
    },

    updateCustomerEmail({ customerId, email }) {
      return stripe.customers.update(customerId, { email });
    },
  });
}

/**
 * Verifies a webhook's `stripe-signature` header against the raw body and returns the event.
 * Pure crypto (no network). Throws Stripe's StripeSignatureVerificationError when invalid.
 */
export function constructWebhookEvent(rawBody, signature, webhookSecret) {
  return Stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
}
