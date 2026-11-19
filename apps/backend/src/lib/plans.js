import { BillingInterval, BillingPlan } from "../generated/prisma/enums.ts";

/** The effective plan of an account set to enterprise by a super admin. Not a Stripe plan. */
export const ENTERPRISE_PLAN = "ENTERPRISE";

export const PLAN_CURRENCY = "aud";
export const TRIAL_PERIOD_DAYS = 7;

const LOOKUP_KEY_PREFIX = "rental_cms";
const PRODUCT_ID_PREFIX = "rental_cms";

const STRIPE_INTERVALS = Object.freeze({
  [BillingInterval.MONTH]: "month",
  [BillingInterval.YEAR]: "year",
});

/**
 * Stripe-sold plans: tenant limit (ACTIVE or NOTICE_PERIOD assignments across the account)
 * and prices in cents, GST inclusive.
 */
export const PLANS = Object.freeze({
  [BillingPlan.STARTER]: Object.freeze({
    name: "Starter",
    tenantLimit: 8,
    amounts: Object.freeze({ [BillingInterval.MONTH]: 1900, [BillingInterval.YEAR]: 20900 }),
  }),
  [BillingPlan.GROWTH]: Object.freeze({
    name: "Growth",
    tenantLimit: 26,
    amounts: Object.freeze({ [BillingInterval.MONTH]: 3900, [BillingInterval.YEAR]: 42900 }),
  }),
  [BillingPlan.PRO]: Object.freeze({
    name: "Pro",
    tenantLimit: 80,
    amounts: Object.freeze({ [BillingInterval.MONTH]: 8900, [BillingInterval.YEAR]: 97900 }),
  }),
});

/** The Stripe price lookup key for a plan and interval, for example rental_cms_starter_month. */
export function lookupKeyFor(plan, interval) {
  return `${LOOKUP_KEY_PREFIX}_${plan.toLowerCase()}_${STRIPE_INTERVALS[interval]}`;
}

/** The fixed Stripe product id for a plan, for example rental_cms_starter. */
export function productIdFor(plan) {
  return `${PRODUCT_ID_PREFIX}_${plan.toLowerCase()}`;
}

/** The Stripe recurring interval ("month" or "year") for a BillingInterval. */
export function stripeIntervalFor(interval) {
  return STRIPE_INTERVALS[interval];
}

const PLAN_BY_LOOKUP_KEY = new Map(
  Object.keys(PLANS).flatMap((plan) =>
    Object.values(BillingInterval).map((interval) => [
      lookupKeyFor(plan, interval),
      Object.freeze({ plan, interval }),
    ]),
  ),
);

/** `{ plan, interval }` for one of our price lookup keys, or null for anything else. */
export function planForLookupKey(lookupKey) {
  return PLAN_BY_LOOKUP_KEY.get(lookupKey) ?? null;
}

/** Every price the catalogue needs: `{ plan, interval, lookupKey, productId, amount }`. */
export function catalogPrices() {
  return [...PLAN_BY_LOOKUP_KEY.entries()].map(([lookupKey, { plan, interval }]) => ({
    plan,
    interval,
    lookupKey,
    productId: productIdFor(plan),
    amount: PLANS[plan].amounts[interval],
  }));
}
