import Stripe from "stripe";

import {
  applyStripeSubscription,
  approveAfterCheckout,
  clearPendingSession,
  ownerAccountIdForCustomer,
  trackedSubscriptionId,
} from "../graphql/billing/serviceBilling.js";
import {
  lockOwnerAccount,
  syncReadOnlySince,
} from "../graphql/billing/subscriptionStore.js";
import { ACTIVITY_ACTIONS, ENTITY_TYPES, logActivity } from "../lib/activity.js";
import { isUniqueViolation } from "../lib/errors.js";
import { constructWebhookEvent } from "./gateway.js";

export const STRIPE_WEBHOOK_PATH = "/webhooks/stripe";

// Stripe event payloads are a few kilobytes; anything far larger is not from Stripe.
const MAX_BODY_BYTES = 1024 * 1024;
const SIGNATURE_HEADER = "stripe-signature";
const SUBSCRIPTION_MODE = "subscription";

const HTTP = Object.freeze({
  OK: 200,
  BAD_REQUEST: 400,
  METHOD_NOT_ALLOWED: 405,
  PAYLOAD_TOO_LARGE: 413,
  INTERNAL_ERROR: 500,
});

const EVENT_TYPES = Object.freeze({
  CHECKOUT_COMPLETED: "checkout.session.completed",
  CHECKOUT_EXPIRED: "checkout.session.expired",
  INVOICE_PAID: "invoice.paid",
  INVOICE_PAYMENT_FAILED: "invoice.payment_failed",
});

const SUBSCRIPTION_EVENT_TYPES = Object.freeze([
  "customer.subscription.created",
  "customer.subscription.updated",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.pending_update_applied",
  "customer.subscription.pending_update_expired",
  "customer.subscription.trial_will_end",
]);

const RESPONSES = Object.freeze({
  PROCESSED: { received: true },
  DUPLICATE: { received: true, duplicate: true },
  IGNORED: { received: true, ignored: true },
  MISSING_SIGNATURE: { error: "Missing Stripe-Signature header." },
  INVALID_SIGNATURE: { error: "Invalid webhook signature." },
  METHOD_NOT_ALLOWED: { error: "Use POST." },
  TOO_LARGE: { error: "Payload too large." },
  FAILED: { error: "Webhook processing failed." },
});

function stripeId(value) {
  return typeof value === "string" ? value : (value?.id ?? null);
}

// Events are resolved through the Stripe customer (the account boundary we created), with
// our own metadata or client_reference_id only as a fallback.
async function resolveOwnerAccountId(prisma, { customer, fallback }) {
  return (await ownerAccountIdForCustomer(prisma, stripeId(customer))) ?? fallback ?? null;
}

async function planCheckoutCompleted({ prisma, gateway }, session) {
  if (session.mode !== SUBSCRIPTION_MODE || !session.subscription) {
    return null;
  }

  const ownerAccountId = await resolveOwnerAccountId(prisma, {
    customer: session.customer,
    fallback: session.client_reference_id ?? session.metadata?.ownerAccountId,
  });
  const stripeSubscription = await gateway.retrieveSubscription(stripeId(session.subscription));

  return { ownerAccountId, stripeSubscription, checkoutSessionId: session.id, approve: true };
}

async function planCheckoutExpired({ prisma }, session) {
  const ownerAccountId = await resolveOwnerAccountId(prisma, {
    customer: session.customer,
    fallback: session.client_reference_id ?? session.metadata?.ownerAccountId,
  });

  return { ownerAccountId, stripeSubscription: null, checkoutSessionId: session.id, approve: false };
}

// The event payload can be older than the subscription's current state, because Stripe does
// not guarantee delivery order. Re-reading the subscription applies its latest state.
async function planSubscriptionEvent({ prisma, gateway }, subscription) {
  const stripeSubscription = await gateway.retrieveSubscription(subscription.id);
  const ownerAccountId = await resolveOwnerAccountId(prisma, {
    customer: stripeSubscription.customer,
    fallback: stripeSubscription.metadata?.ownerAccountId,
  });

  return { ownerAccountId, stripeSubscription, checkoutSessionId: null, approve: false };
}

// Invoice events re-sync the subscription the account tracks, without depending on the
// invoice's subscription field layout.
async function planInvoiceEvent({ prisma, gateway }, invoice) {
  const ownerAccountId = await resolveOwnerAccountId(prisma, { customer: invoice.customer });
  const subscriptionId = ownerAccountId ? await trackedSubscriptionId(prisma, ownerAccountId) : null;

  if (!subscriptionId) {
    return null;
  }

  const stripeSubscription = await gateway.retrieveSubscription(subscriptionId);
  return { ownerAccountId, stripeSubscription, checkoutSessionId: null, approve: false };
}

function planEvent(dependencies, event) {
  const object = event.data?.object ?? {};

  switch (event.type) {
    case EVENT_TYPES.CHECKOUT_COMPLETED:
      return planCheckoutCompleted(dependencies, object);
    case EVENT_TYPES.CHECKOUT_EXPIRED:
      return planCheckoutExpired(dependencies, object);
    case EVENT_TYPES.INVOICE_PAID:
    case EVENT_TYPES.INVOICE_PAYMENT_FAILED:
      return planInvoiceEvent(dependencies, object);
    default:
      return SUBSCRIPTION_EVENT_TYPES.includes(event.type)
        ? planSubscriptionEvent(dependencies, object)
        : null;
  }
}

async function applyPlan(tx, { event, plan, now }) {
  const account = await lockOwnerAccount(tx, plan.ownerAccountId);

  if (!account) {
    return false;
  }

  if (plan.checkoutSessionId) {
    await clearPendingSession(tx, {
      ownerAccountId: plan.ownerAccountId,
      checkoutSessionId: plan.checkoutSessionId,
    });
  }

  if (plan.stripeSubscription) {
    const applied = await applyStripeSubscription(tx, {
      ownerAccountId: plan.ownerAccountId,
      stripeSubscription: plan.stripeSubscription,
      now,
    });

    if (applied) {
      const approved = plan.approve
        ? await approveAfterCheckout(tx, {
            ownerAccountId: plan.ownerAccountId,
            stripeStatus: applied.stripeStatus,
          })
        : false;

      await logActivity(tx, {
        entityType: ENTITY_TYPES.SUBSCRIPTION,
        entityId: applied.subscriptionRowId,
        action: ACTIVITY_ACTIONS.SYNCED,
        performedByUserId: null,
        metadata: {
          ownerAccountId: plan.ownerAccountId,
          eventId: event.id,
          eventType: event.type,
          stripeStatus: applied.stripeStatus,
          plan: applied.plan,
          interval: applied.interval,
          approved,
        },
      });
    }
  }

  await syncReadOnlySince(tx, plan.ownerAccountId, now);
  return true;
}

function verify(rawBody, signature, webhookSecret) {
  if (!signature) {
    return { error: { status: HTTP.BAD_REQUEST, body: RESPONSES.MISSING_SIGNATURE } };
  }

  try {
    return { event: constructWebhookEvent(rawBody, signature, webhookSecret) };
  } catch (error) {
    if (error instanceof Stripe.errors.StripeSignatureVerificationError) {
      return { error: { status: HTTP.BAD_REQUEST, body: RESPONSES.INVALID_SIGNATURE } };
    }

    throw error;
  }
}

/**
 * Verifies and applies one Stripe webhook delivery and returns `{ status, body }`.
 * - 400 for a missing or invalid signature.
 * - 200 for an event already processed (by event id), an event type we do not act on, or an
 *   event for an unknown account: the event id is recorded so it is never re-applied.
 * - Errors (Stripe unreachable, database failure) propagate, so the HTTP layer returns 500
 *   and Stripe retries; nothing is recorded in that case.
 * Stripe is read before the transaction, so no lock is held during a network call.
 */
export async function processStripeWebhook(
  { prisma, gateway, webhookSecret, now = () => new Date() },
  { rawBody, signature },
) {
  const verified = verify(rawBody, signature, webhookSecret);

  if (verified.error) {
    return verified.error;
  }

  const { event } = verified;
  const seen = await prisma.stripeEvent.findUnique({ where: { id: event.id }, select: { id: true } });

  if (seen) {
    return { status: HTTP.OK, body: RESPONSES.DUPLICATE };
  }

  const plan = await planEvent({ prisma, gateway }, event);

  try {
    const applied = await prisma.$transaction(async (tx) => {
      await tx.stripeEvent.create({
        data: { id: event.id, type: event.type },
        select: { id: true },
      });

      if (!plan?.ownerAccountId) {
        return false;
      }

      return applyPlan(tx, { event, plan, now: now() });
    });

    return { status: HTTP.OK, body: applied ? RESPONSES.PROCESSED : RESPONSES.IGNORED };
  } catch (error) {
    // A concurrent delivery of the same event committed first.
    if (isUniqueViolation(error)) {
      return { status: HTTP.OK, body: RESPONSES.DUPLICATE };
    }

    throw error;
  }
}

/** Reads the raw request body, or returns null once it exceeds `maxBytes`. */
export async function readRawBody(request, maxBytes = MAX_BODY_BYTES) {
  const chunks = [];
  let size = 0;

  for await (const chunk of request) {
    size += chunk.length;

    if (size > maxBytes) {
      return null;
    }

    chunks.push(chunk);
  }

  return Buffer.concat(chunks);
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

/**
 * Returns the node:http handler for POST /webhooks/stripe. It runs outside Yoga, so the body
 * reaches signature verification byte for byte. Failures are logged with the error only,
 * never the payload or the signing secret.
 */
export function createStripeWebhookHandler({ prisma, gateway, webhookSecret, logger = console }) {
  return async function handleStripeWebhook(request, response) {
    if (request.method !== "POST") {
      response.setHeader("allow", "POST");
      send(response, HTTP.METHOD_NOT_ALLOWED, RESPONSES.METHOD_NOT_ALLOWED);
      return;
    }

    try {
      const rawBody = await readRawBody(request);

      if (rawBody === null) {
        send(response, HTTP.PAYLOAD_TOO_LARGE, RESPONSES.TOO_LARGE);
        return;
      }

      const result = await processStripeWebhook(
        { prisma, gateway, webhookSecret },
        { rawBody, signature: request.headers[SIGNATURE_HEADER] },
      );
      send(response, result.status, result.body);
    } catch (error) {
      logger.error("Stripe webhook processing failed:", error);
      send(response, HTTP.INTERNAL_ERROR, RESPONSES.FAILED);
    }
  };
}
