import { OwnerAccountStatus } from "../generated/prisma/enums.ts";
import { ENTERPRISE_PLAN, PLANS } from "./plans.js";

/**
 * What billing allows an owner account to do:
 * - FULL: every write its account status allows.
 * - SETUP: a PENDING account with no paid access yet; its status rules apply unchanged.
 * - READ_ONLY: every write is refused except billing and account deletion.
 */
export const ACCESS = Object.freeze({
  FULL: "FULL",
  SETUP: "SETUP",
  READ_ONLY: "READ_ONLY",
});

/** Client message for a write refused because billing made the account read-only. */
export const READ_ONLY_MESSAGE =
  "This owner account is read-only until its billing is resolved.";

// Stripe keeps a past_due subscription while it retries the payment; access continues.
const FULL_ACCESS_STATUSES = Object.freeze(["trialing", "active", "past_due"]);

// A subscription in any other status has ended for good and cannot be reused.
const ENDED_STATUSES = Object.freeze(["canceled", "incomplete_expired"]);

/** The Subscription columns entitlement needs; guards select exactly these. */
export const ENTITLEMENT_FIELDS = Object.freeze({
  plan: true,
  stripeStatus: true,
  enterprise: true,
});

/** True when Stripe's status grants full access (trialing, active, past_due). */
export function isFullAccessStatus(stripeStatus) {
  return FULL_ACCESS_STATUSES.includes(stripeStatus);
}

/**
 * True when a Stripe subscription still exists and can change (any status except canceled or
 * incomplete_expired). Such an account changes plans through the portal, not a new Checkout.
 */
export function isLiveStatus(stripeStatus) {
  return typeof stripeStatus === "string" && !ENDED_STATUSES.includes(stripeStatus);
}

/**
 * The single place billing access is computed. `subscription` is a Subscription row (or null)
 * with at least ENTITLEMENT_FIELDS. Returns `{ access, plan, tenantLimit }`, where plan is a
 * BillingPlan, ENTERPRISE or null, and tenantLimit is null for no limit.
 * A BLOCKED status is enforced by the guards before entitlement and always wins.
 */
export function computeEntitlement(accountStatus, subscription) {
  if (subscription?.enterprise) {
    return { access: ACCESS.FULL, plan: ENTERPRISE_PLAN, tenantLimit: null };
  }

  if (subscription?.plan && isFullAccessStatus(subscription.stripeStatus)) {
    return {
      access: ACCESS.FULL,
      plan: subscription.plan,
      tenantLimit: PLANS[subscription.plan].tenantLimit,
    };
  }

  if (accountStatus === OwnerAccountStatus.PENDING) {
    return { access: ACCESS.SETUP, plan: null, tenantLimit: 0 };
  }

  return { access: ACCESS.READ_ONLY, plan: null, tenantLimit: 0 };
}
