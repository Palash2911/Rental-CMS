import Stripe from "stripe";

import { accountReadOnlyEmail, paymentFailedEmail, trialEndingEmail } from "../email/events.js";
import { withEmails } from "../email/queue.js";
import { DeletionReason, OwnerAccountStatus } from "../generated/prisma/enums.ts";
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
const RESUMED_STRIPE_STATUSES = Object.freeze(["active", "trialing"]);
const SUBSCRIPTION_RESUMED_REASON = "SUBSCRIPTION_RESUMED";

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
  TRIAL_WILL_END: "customer.subscription.trial_will_end",
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

// The accountDeletion job keeps a tombstone with deletionExecutedAt set. Stripe still sends
// events for it (the cancellation it made, a late checkout), which must not recreate the
// Subscription row, so they are recorded and ignored.
async function isDeletedAccount(tx, ownerAccountId) {
  const account = await tx.ownerAccount.findUnique({
    where: { id: ownerAccountId },
    select: { deletionExecutedAt: true },
  });

  return account?.deletionExecutedAt != null;
}

// Project owner: a deletion the billingGrace job scheduled is undone as soon as billing is
// paid again (active or trialing; past_due is not enough). Deletions the owner or an admin
// asked for are left alone, and so is a BLOCKED account. Runs under the OwnerAccount lock
// applyPlan holds, so it serialises with the accountDeletion job, which re-checks the status
// under the same lock. syncReadOnlySince, which runs after it, clears readOnlySince.
async function cancelBillingDeletion(tx, { ownerAccountId, stripeStatus, eventId }) {
  if (!RESUMED_STRIPE_STATUSES.includes(stripeStatus)) {
    return false;
  }

  const account = await tx.ownerAccount.findUnique({
    where: { id: ownerAccountId },
    select: { status: true, statusBeforeDeletion: true, deletionReason: true },
  });

  if (
    account?.status !== OwnerAccountStatus.PENDING_DELETION ||
    account.deletionReason !== DeletionReason.BILLING_GRACE
  ) {
    return false;
  }

  const restored = account.statusBeforeDeletion ?? OwnerAccountStatus.PENDING;

  await tx.ownerAccount.update({
    where: { id: ownerAccountId, status: OwnerAccountStatus.PENDING_DELETION },
    data: {
      status: restored,
      statusBeforeDeletion: null,
      deletionScheduledAt: null,
      deletionReason: null,
    },
    select: { id: true },
  });

  await logActivity(tx, {
    entityType: ENTITY_TYPES.OWNER_ACCOUNT,
    entityId: ownerAccountId,
    action: ACTIVITY_ACTIONS.DELETION_CANCELLED,
    ownerAccountId,
    performedByUserId: null,
    metadata: {
      fromStatus: OwnerAccountStatus.PENDING_DELETION,
      toStatus: restored,
      reason: SUBSCRIPTION_RESUMED_REASON,
      stripeStatus,
      eventId,
    },
  });

  return true;
}

// Stripe sends trial_will_end three days before the trial ends, and payment_failed once per
// failed attempt; each event id is processed once, so it keys the email.
function billingEmails({ event, ownerAccountId, applied }) {
  if (event.type === EVENT_TYPES.TRIAL_WILL_END && applied?.trialEnd) {
    return [trialEndingEmail({ stripeEventId: event.id, ownerAccountId, trialEnd: applied.trialEnd.toISOString() })];
  }

  if (event.type === EVENT_TYPES.INVOICE_PAYMENT_FAILED) {
    return [paymentFailedEmail({ stripeEventId: event.id, ownerAccountId })];
  }

  return [];
}

async function applyPlan(tx, { event, plan, now, emails }) {
  const account = await lockOwnerAccount(tx, plan.ownerAccountId);

  if (!account || (await isDeletedAccount(tx, plan.ownerAccountId))) {
    return false;
  }

  if (plan.checkoutSessionId) {
    await clearPendingSession(tx, {
      ownerAccountId: plan.ownerAccountId,
      checkoutSessionId: plan.checkoutSessionId,
    });
  }

  let applied = null;

  if (plan.stripeSubscription) {
    applied = await applyStripeSubscription(tx, {
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
        ownerAccountId: plan.ownerAccountId,
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

      await cancelBillingDeletion(tx, {
        ownerAccountId: plan.ownerAccountId,
        stripeStatus: applied.stripeStatus,
        eventId: event.id,
      });
    }
  }

  const readOnly = await syncReadOnlySince(tx, plan.ownerAccountId, now);

  emails.push(...billingEmails({ event, ownerAccountId: plan.ownerAccountId, applied }));

  if (readOnly.becameReadOnly) {
    emails.push(accountReadOnlyEmail({ ownerAccountId: plan.ownerAccountId, readOnlySince: readOnly.readOnlySince }));
  }

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
  { prisma, gateway, notifier, webhookSecret, now = () => new Date() },
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
    const applied = await withEmails(notifier, (emails) =>
      prisma.$transaction(async (tx) => {
        await tx.stripeEvent.create({
          data: { id: event.id, type: event.type },
          select: { id: true },
        });

        if (!plan?.ownerAccountId) {
          return false;
        }

        return applyPlan(tx, { event, plan, now: now(), emails });
      }),
    );

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
export function createStripeWebhookHandler({ prisma, gateway, notifier, webhookSecret, logger = console }) {
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
        { prisma, gateway, notifier, webhookSecret },
        { rawBody, signature: request.headers[SIGNATURE_HEADER] },
      );
      send(response, result.status, result.body);
    } catch (error) {
      logger.error("Stripe webhook processing failed:", error);
      send(response, HTTP.INTERNAL_ERROR, RESPONSES.FAILED);
    }
  };
}
