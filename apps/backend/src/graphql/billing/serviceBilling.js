import { OwnerAccountStatus } from "../../generated/prisma/enums.ts";
import {
  ACTIVITY_ACTIONS,
  ENTITY_TYPES,
  logActivity,
} from "../../lib/activity.js";
import { config } from "../../lib/config.js";
import {
  ACCESS,
  computeEntitlement,
  isFullAccessStatus,
  isLiveStatus,
} from "../../lib/entitlement.js";
import { ConflictError, NotFoundError } from "../../lib/errors.js";
import {
  ENTERPRISE_PLAN,
  lookupKeyFor,
  planForLookupKey,
  TRIAL_PERIOD_DAYS,
} from "../../lib/plans.js";
import { toPublicOwnerAccount } from "../ownerAccount/serviceOwnerAccount.js";
import {
  lockOwnerAccount,
  lockSubscription,
  SUBSCRIPTION_SELECT,
  syncReadOnlySince,
} from "./subscriptionStore.js";

// startCheckout waits on Stripe (customer, price, session) while holding the account's
// Subscription row lock; Prisma's 5 second default is too short for that.
const CHECKOUT_TRANSACTION_TIMEOUT_MS = 30_000;
const MS_PER_SECOND = 1000;
const CHECKOUT_MODE = "subscription";
const CHECKOUT_SESSION_STATUS = Object.freeze({ OPEN: "open", COMPLETE: "complete" });
const CHECKOUT_COMPLETED_REASON = "CHECKOUT_COMPLETED";

// Tags our sessions in the Stripe Dashboard (integration_identifier, API 2026-03-25 and later).
const CHECKOUT_INTEGRATION_IDENTIFIER = "rental_cms_plans_qzkfmwtd";

const OWNER_ACCOUNT_SELECT = Object.freeze({
  id: true,
  name: true,
  status: true,
  createdAt: true,
  updatedAt: true,
});

const MESSAGES = Object.freeze({
  OWNER_ACCOUNT_NOT_FOUND: "Owner account not found.",
  ENTERPRISE: "This account is on an enterprise plan, which is billed manually.",
  ALREADY_SUBSCRIBED:
    "This account already has a subscription. Use the billing portal to change it.",
  CHECKOUT_ALREADY_COMPLETED:
    "A checkout for this account has already completed. Use the billing portal once it is confirmed.",
  NO_CUSTOMER: "This account has no billing details yet. Start a subscription first.",
  ENTERPRISE_ALREADY_SET: "This account is already on the enterprise plan.",
  ENTERPRISE_NOT_SET: "This account is not on the enterprise plan.",
});

function toDateFromSeconds(seconds) {
  return typeof seconds === "number" ? new Date(seconds * MS_PER_SECOND) : null;
}

function toIsoOrNull(date) {
  return date ? date.toISOString() : null;
}

function stripeId(value) {
  if (typeof value === "string") {
    return value;
  }

  return value?.id ?? null;
}

/**
 * Maps a Stripe Subscription (API 2026-11-18.endive) to Subscription columns. The billing
 * period lives on the subscription item, not the subscription, in this API version.
 * Items whose price has none of our lookup keys are ignored; plan is null if none match.
 */
export function mapStripeSubscription(stripeSubscription) {
  const items = stripeSubscription.items?.data ?? [];
  const item = items.find((entry) => planForLookupKey(entry.price?.lookup_key)) ?? null;
  const known = item ? planForLookupKey(item.price.lookup_key) : null;

  return {
    stripeSubscriptionId: stripeSubscription.id,
    stripeCustomerId: stripeId(stripeSubscription.customer),
    plan: known?.plan ?? null,
    interval: known?.interval ?? null,
    stripeStatus: stripeSubscription.status,
    trialEnd: toDateFromSeconds(stripeSubscription.trial_end),
    currentPeriodEnd: toDateFromSeconds(item?.current_period_end),
    cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end === true,
    hadTrial: typeof stripeSubscription.trial_start === "number",
  };
}

/** Converts entitlement inputs to the OwnerAccountBilling GraphQL shape. */
export function toPublicBilling(accountStatus, subscription, activeTenants) {
  const entitlement = computeEntitlement(accountStatus, subscription);
  const enterprise = subscription?.enterprise === true;

  return {
    plan: enterprise ? ENTERPRISE_PLAN : (subscription?.plan ?? null),
    interval: enterprise ? null : (subscription?.interval ?? null),
    status: subscription?.stripeStatus ?? null,
    trialEnd: toIsoOrNull(subscription?.trialEnd),
    currentPeriodEnd: toIsoOrNull(subscription?.currentPeriodEnd),
    cancelAtPeriodEnd: subscription?.cancelAtPeriodEnd === true,
    access: entitlement.access,
    readOnly: entitlement.access === ACCESS.READ_ONLY,
    readOnlySince: toIsoOrNull(subscription?.readOnlySince),
    activeTenants,
    tenantLimit: entitlement.tenantLimit,
    enterprise,
    trialAvailable:
      !enterprise && !subscription?.trialUsedAt && !subscription?.stripeSubscriptionId,
  };
}

async function countActiveTenantsByAccount(prisma, ownerAccountIds) {
  const rows = await prisma.$queryRaw`
    SELECT h."ownerAccountId" AS "ownerAccountId", count(*)::int AS "count"
    FROM "TenantAssignment" ta
    JOIN "House" h ON h.id = ta."houseId"
    WHERE h."ownerAccountId" = ANY(${ownerAccountIds})
      AND ta.status IN ('ACTIVE', 'NOTICE_PERIOD')
    GROUP BY h."ownerAccountId"`;

  return new Map(rows.map((row) => [row.ownerAccountId, row.count]));
}

/**
 * Loads OwnerAccountBilling for many accounts in two queries (accounts with their
 * Subscription, then one grouped tenant count). Used by the batched OwnerAccount.billing field.
 */
export async function loadBillingByAccount(prisma, ownerAccountIds) {
  const [accounts, counts] = await Promise.all([
    prisma.ownerAccount.findMany({
      where: { id: { in: ownerAccountIds } },
      select: { id: true, status: true, subscription: { select: SUBSCRIPTION_SELECT } },
    }),
    countActiveTenantsByAccount(prisma, ownerAccountIds),
  ]);

  return new Map(
    accounts.map((account) => [
      account.id,
      toPublicBilling(account.status, account.subscription, counts.get(account.id) ?? 0),
    ]),
  );
}

// Returns true when the previous session already completed, so a second subscription would
// be created; an open one is expired so only one session per account can ever complete.
async function closePendingSession(gateway, sessionId) {
  const session = await gateway.retrieveCheckoutSession(sessionId);

  if (session.status === CHECKOUT_SESSION_STATUS.COMPLETE) {
    return true;
  }

  if (session.status === CHECKOUT_SESSION_STATUS.OPEN) {
    await gateway.expireCheckoutSession(sessionId);
  }

  return false;
}

async function ensureCustomer(gateway, current, { ownerAccountId, email, accountName }) {
  if (current.stripeCustomerId) {
    return current.stripeCustomerId;
  }

  const customer = await gateway.createCustomer(
    { ownerAccountId, email, name: accountName },
    { idempotencyKey: `owner-account-${ownerAccountId}-customer` },
  );

  return customer.id;
}

function checkoutParams({ customerId, priceId, ownerAccountId, withTrial }) {
  return {
    mode: CHECKOUT_MODE,
    customer: customerId,
    client_reference_id: ownerAccountId,
    line_items: [{ price: priceId, quantity: 1 }],
    payment_method_collection: "always",
    subscription_data: {
      metadata: { ownerAccountId },
      ...(withTrial ? { trial_period_days: TRIAL_PERIOD_DAYS } : {}),
    },
    metadata: { ownerAccountId },
    integration_identifier: CHECKOUT_INTEGRATION_IDENTIFIER,
    success_url: config.stripeCheckoutSuccessUrl,
    cancel_url: config.stripeCheckoutCancelUrl,
  };
}

/**
 * Creates a Stripe Checkout session for a plan and returns `{ url }`, under the account's
 * Subscription row lock so two calls cannot both open a trial. Offers the 7-day trial only
 * if the account never had one or any subscription. Any previous open session is expired.
 * Throws ConflictError for an enterprise account, a live subscription, or a previous
 * session that already completed.
 */
export function startCheckout(
  context,
  { actorId, actorEmail, ownerAccountId, accountName, plan, interval },
) {
  const gateway = context.billingGateway;

  return context.prisma.$transaction(
    async (tx) => {
      const current = await lockSubscription(tx, ownerAccountId);

      if (current.enterprise) {
        throw new ConflictError(MESSAGES.ENTERPRISE);
      }

      if (isLiveStatus(current.stripeStatus)) {
        throw new ConflictError(MESSAGES.ALREADY_SUBSCRIBED);
      }

      if (
        current.pendingCheckoutSessionId &&
        (await closePendingSession(gateway, current.pendingCheckoutSessionId))
      ) {
        throw new ConflictError(MESSAGES.CHECKOUT_ALREADY_COMPLETED);
      }

      const customerId = await ensureCustomer(gateway, current, {
        ownerAccountId,
        email: actorEmail,
        accountName,
      });
      const lookupKey = lookupKeyFor(plan, interval);
      const priceId = await gateway.findPriceIdByLookupKey(lookupKey);

      // A missing price is a deployment problem, not a client error: masked as a 500.
      if (!priceId) {
        throw new Error(`No active Stripe price has lookup key ${lookupKey}; run yarn stripe:sync-plans.`);
      }

      const withTrial = !current.trialUsedAt && !current.stripeSubscriptionId;
      const session = await gateway.createCheckoutSession(
        checkoutParams({ customerId, priceId, ownerAccountId, withTrial }),
      );

      if (!session.url) {
        throw new Error("Stripe returned a Checkout session without a URL.");
      }

      await tx.subscription.update({
        where: { ownerAccountId },
        data: { stripeCustomerId: customerId, pendingCheckoutSessionId: session.id },
        select: { id: true },
      });

      await logActivity(tx, {
        entityType: ENTITY_TYPES.SUBSCRIPTION,
        entityId: current.id,
        action: ACTIVITY_ACTIONS.CHECKOUT_STARTED,
        performedByUserId: actorId,
        metadata: { ownerAccountId, plan, interval, trial: withTrial },
      });

      return { url: session.url };
    },
    { timeout: CHECKOUT_TRANSACTION_TIMEOUT_MS },
  );
}

/**
 * Creates a Stripe Customer Portal session (plan changes, cancellation, payment methods)
 * and returns `{ url }`. Throws ConflictError when the account has no Stripe customer yet.
 */
export async function openBillingPortal(context, { ownerAccountId }) {
  const subscription = await context.prisma.subscription.findUnique({
    where: { ownerAccountId },
    select: { stripeCustomerId: true },
  });

  if (!subscription?.stripeCustomerId) {
    throw new ConflictError(MESSAGES.NO_CUSTOMER);
  }

  const session = await context.billingGateway.createPortalSession({
    customer: subscription.stripeCustomerId,
    returnUrl: config.stripePortalReturnUrl,
  });

  return { url: session.url };
}

/**
 * Turns the enterprise override on or off for an account (super admin only), logs it and
 * updates readOnlySince. Returns the owner account. Throws NotFoundError for a missing
 * account and ConflictError when the flag already has that value.
 */
export function setEnterprise(context, { actorId, ownerAccountId, enterprise }) {
  return context.prisma.$transaction(async (tx) => {
    const account = await lockOwnerAccount(tx, ownerAccountId);

    if (!account) {
      throw new NotFoundError(MESSAGES.OWNER_ACCOUNT_NOT_FOUND);
    }

    const current = await lockSubscription(tx, ownerAccountId);

    if (current.enterprise === enterprise) {
      throw new ConflictError(
        enterprise ? MESSAGES.ENTERPRISE_ALREADY_SET : MESSAGES.ENTERPRISE_NOT_SET,
      );
    }

    await tx.subscription.update({
      where: { ownerAccountId },
      data: { enterprise },
      select: { id: true },
    });

    await logActivity(tx, {
      entityType: ENTITY_TYPES.SUBSCRIPTION,
      entityId: current.id,
      action: enterprise ? ACTIVITY_ACTIONS.ENTERPRISE_SET : ACTIVITY_ACTIONS.ENTERPRISE_CLEARED,
      performedByUserId: actorId,
      metadata: { ownerAccountId },
    });

    await syncReadOnlySince(tx, ownerAccountId);

    const updated = await tx.ownerAccount.findUnique({
      where: { id: ownerAccountId },
      select: OWNER_ACCOUNT_SELECT,
    });

    return toPublicOwnerAccount(updated);
  });
}

/**
 * Applies a Stripe subscription snapshot to the account's row. Ignores the snapshot when the
 * row already tracks a different subscription that is still live, so an event for an old,
 * ended subscription cannot overwrite the current one. Records trialUsedAt the first time a
 * trial is seen. Returns the mapped values, or null when ignored. Call under lockOwnerAccount.
 */
export async function applyStripeSubscription(tx, { ownerAccountId, stripeSubscription, now }) {
  const current = await lockSubscription(tx, ownerAccountId);
  const mapped = mapStripeSubscription(stripeSubscription);

  if (
    current.stripeSubscriptionId &&
    current.stripeSubscriptionId !== mapped.stripeSubscriptionId &&
    isLiveStatus(current.stripeStatus)
  ) {
    return null;
  }

  const { hadTrial, ...columns } = mapped;

  await tx.subscription.update({
    where: { ownerAccountId },
    data: {
      ...columns,
      stripeCustomerId: columns.stripeCustomerId ?? current.stripeCustomerId,
      trialUsedAt: current.trialUsedAt ?? (hadTrial ? now : null),
    },
    select: { id: true },
  });

  return { subscriptionRowId: current.id, ...mapped };
}

/**
 * Moves a PENDING account to APPROVED after a completed checkout with full access, and logs
 * it with no acting user. BLOCKED and PENDING_DELETION accounts are left alone: a super
 * admin's block always wins. Returns true when the account was approved.
 */
export async function approveAfterCheckout(tx, { ownerAccountId, stripeStatus }) {
  if (!isFullAccessStatus(stripeStatus)) {
    return false;
  }

  const { count } = await tx.ownerAccount.updateMany({
    where: { id: ownerAccountId, status: OwnerAccountStatus.PENDING },
    data: { status: OwnerAccountStatus.APPROVED },
  });

  if (count === 0) {
    return false;
  }

  await logActivity(tx, {
    entityType: ENTITY_TYPES.OWNER_ACCOUNT,
    entityId: ownerAccountId,
    action: ACTIVITY_ACTIONS.APPROVED,
    performedByUserId: null,
    metadata: {
      fromStatus: OwnerAccountStatus.PENDING,
      toStatus: OwnerAccountStatus.APPROVED,
      reason: CHECKOUT_COMPLETED_REASON,
    },
  });

  return true;
}

/** Clears the pending Checkout session id when it is the given session. */
export async function clearPendingSession(tx, { ownerAccountId, checkoutSessionId }) {
  await tx.subscription.updateMany({
    where: { ownerAccountId, pendingCheckoutSessionId: checkoutSessionId },
    data: { pendingCheckoutSessionId: null },
  });
}

/** Finds the owner account that owns a Stripe customer id, or null. */
export async function ownerAccountIdForCustomer(prisma, stripeCustomerId) {
  if (!stripeCustomerId) {
    return null;
  }

  const row = await prisma.subscription.findUnique({
    where: { stripeCustomerId },
    select: { ownerAccountId: true },
  });

  return row?.ownerAccountId ?? null;
}

/** The Stripe subscription id an account currently tracks, or null. */
export async function trackedSubscriptionId(prisma, ownerAccountId) {
  const row = await prisma.subscription.findUnique({
    where: { ownerAccountId },
    select: { stripeSubscriptionId: true },
  });

  return row?.stripeSubscriptionId ?? null;
}
