import { catalogPrices, PLAN_CURRENCY, PLANS, productIdFor, stripeIntervalFor } from "../lib/plans.js";

// GST inclusive: the listed price is what the customer pays.
const TAX_BEHAVIOR = "inclusive";
const INTERVAL_COUNT = 1;
const RESOURCE_MISSING = "resource_missing";
const LIVE_KEY_PATTERN = /^(sk|rk)_live_/;
const TEST_KEY_PATTERN = /^(sk|rk)_test_\S+$/;

/**
 * Throws unless `secretKey` is a Stripe test-mode key. The sync script must never touch the
 * live catalogue; that is a separate, deliberate step.
 */
export function assertTestModeKey(secretKey) {
  if (typeof secretKey !== "string" || !secretKey) {
    throw new Error("STRIPE_SECRET_KEY is not set.");
  }

  if (LIVE_KEY_PATTERN.test(secretKey)) {
    throw new Error("Refusing to run with a live Stripe key. Use a test-mode key (sk_test_ or rk_test_).");
  }

  if (!TEST_KEY_PATTERN.test(secretKey)) {
    throw new Error("STRIPE_SECRET_KEY must be a Stripe test-mode key (sk_test_ or rk_test_).");
  }
}

function priceMatches(price, desired) {
  const product = typeof price.product === "string" ? price.product : price.product?.id;

  return (
    product === desired.productId &&
    price.unit_amount === desired.amount &&
    price.currency === PLAN_CURRENCY &&
    price.recurring?.interval === stripeIntervalFor(desired.interval) &&
    price.recurring?.interval_count === INTERVAL_COUNT &&
    price.tax_behavior === TAX_BEHAVIOR
  );
}

async function syncProduct(stripe, plan) {
  const id = productIdFor(plan);
  const { name } = PLANS[plan];

  try {
    const product = await stripe.products.retrieve(id);

    if (product.name === name && product.active) {
      return "unchanged";
    }

    await stripe.products.update(id, { name, active: true, metadata: { plan } });
    return "updated";
  } catch (error) {
    if (error?.code !== RESOURCE_MISSING) {
      throw error;
    }

    await stripe.products.create({ id, name, metadata: { plan } });
    return "created";
  }
}

// Stripe prices are immutable in amount and interval, so a changed price is replaced: the
// new price takes the lookup key (transfer_lookup_key) and the old one is archived.
async function syncPrice(stripe, desired) {
  const existing = await stripe.prices.list({
    lookup_keys: [desired.lookupKey],
    active: true,
    limit: 1,
  });
  const current = existing.data[0] ?? null;

  if (current && priceMatches(current, desired)) {
    return "unchanged";
  }

  await stripe.prices.create(
    {
      product: desired.productId,
      currency: PLAN_CURRENCY,
      unit_amount: desired.amount,
      recurring: { interval: stripeIntervalFor(desired.interval), interval_count: INTERVAL_COUNT },
      tax_behavior: TAX_BEHAVIOR,
      lookup_key: desired.lookupKey,
      transfer_lookup_key: true,
      nickname: desired.lookupKey,
      metadata: { plan: desired.plan, interval: desired.interval },
    },
    { idempotencyKey: `price-${desired.lookupKey}-${desired.amount}-${TAX_BEHAVIOR}` },
  );

  if (current) {
    await stripe.prices.update(current.id, { active: false });
    return "replaced";
  }

  return "created";
}

/**
 * Creates or updates the three plan products and six prices, keyed by fixed product ids and
 * price lookup keys, so no price ids need to be configured. Safe to run repeatedly: an
 * unchanged catalogue makes no writes. Returns one `{ kind, key, result }` entry per item.
 */
export async function syncPlans(stripe) {
  const results = [];

  for (const plan of Object.keys(PLANS)) {
    results.push({ kind: "product", key: productIdFor(plan), result: await syncProduct(stripe, plan) });
  }

  for (const desired of catalogPrices()) {
    results.push({ kind: "price", key: desired.lookupKey, result: await syncPrice(stripe, desired) });
  }

  return results;
}
