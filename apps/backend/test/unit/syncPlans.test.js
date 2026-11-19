import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertTestModeKey, syncPlans } from "../../src/stripe/syncPlans.js";

// An in-memory Stripe catalogue with the product and price calls syncPlans makes. It mirrors
// Stripe's documented behaviour for these calls: a missing product throws resource_missing,
// lookup keys are unique among prices, and transfer_lookup_key moves a key to the new price.
function catalogue() {
  const products = new Map();
  const prices = [];
  const writes = [];
  let nextPrice = 1;

  const stripe = {
    products: {
      async retrieve(id) {
        if (!products.has(id)) {
          throw Object.assign(new Error(`No such product: '${id}'`), { code: "resource_missing" });
        }
        return { ...products.get(id) };
      },
      async create(params) {
        writes.push(["products.create", params.id]);
        products.set(params.id, { id: params.id, name: params.name, active: true });
        return products.get(params.id);
      },
      async update(id, params) {
        writes.push(["products.update", id]);
        products.set(id, { ...products.get(id), ...params });
        return products.get(id);
      },
    },
    prices: {
      async list({ lookup_keys: [key], active }) {
        return { data: prices.filter((price) => price.lookup_key === key && (active === undefined || price.active === active)) };
      },
      async create(params) {
        writes.push(["prices.create", params.lookup_key]);
        if (params.transfer_lookup_key) {
          for (const price of prices) {
            if (price.lookup_key === params.lookup_key) {
              price.lookup_key = null;
            }
          }
        }
        const price = { id: `price_${nextPrice++}`, active: true, ...params };
        prices.push(price);
        return price;
      },
      async update(id, params) {
        writes.push(["prices.update", id]);
        Object.assign(prices.find((price) => price.id === id), params);
      },
    },
  };

  return { stripe, products, prices, writes };
}

describe("syncPlans", () => {
  it("creates 3 products and 6 GST-inclusive AUD prices with lookup keys on the first run", async () => {
    const { stripe, products, prices } = catalogue();
    const results = await syncPlans(stripe);

    assert.deepEqual([...products.keys()].sort(), ["rental_cms_growth", "rental_cms_pro", "rental_cms_starter"]);
    assert.equal(results.filter((entry) => entry.result === "created").length, 9);

    const starterMonth = prices.find((price) => price.lookup_key === "rental_cms_starter_month");
    assert.equal(starterMonth.product, "rental_cms_starter");
    assert.equal(starterMonth.unit_amount, 1900);
    assert.equal(starterMonth.currency, "aud");
    assert.equal(starterMonth.tax_behavior, "inclusive");
    assert.deepEqual(starterMonth.recurring, { interval: "month", interval_count: 1 });

    const proYear = prices.find((price) => price.lookup_key === "rental_cms_pro_year");
    assert.equal(proYear.unit_amount, 97900);
    assert.deepEqual(proYear.recurring, { interval: "year", interval_count: 1 });
  });

  it("makes no writes when the catalogue is already in sync", async () => {
    const { stripe, writes } = catalogue();
    await syncPlans(stripe);
    writes.length = 0;

    const results = await syncPlans(stripe);

    assert.deepEqual(writes, []);
    assert.ok(results.every((entry) => entry.result === "unchanged"));
  });

  it("replaces a price whose amount drifted and archives the old one", async () => {
    const { stripe, prices } = catalogue();
    await syncPlans(stripe);
    const old = prices.find((price) => price.lookup_key === "rental_cms_growth_month");
    old.unit_amount = 4500;

    const results = await syncPlans(stripe);

    assert.deepEqual(results.filter((entry) => entry.result !== "unchanged"), [
      { kind: "price", key: "rental_cms_growth_month", result: "replaced" },
    ]);
    assert.equal(old.active, false);
    assert.equal(old.lookup_key, null);
    assert.equal(prices.find((price) => price.lookup_key === "rental_cms_growth_month").unit_amount, 3900);
  });

  it("reactivates and renames a product that was archived or renamed", async () => {
    const { stripe, products } = catalogue();
    await syncPlans(stripe);
    products.set("rental_cms_pro", { id: "rental_cms_pro", name: "Old name", active: false });

    await syncPlans(stripe);

    assert.deepEqual({ name: products.get("rental_cms_pro").name, active: products.get("rental_cms_pro").active }, { name: "Pro", active: true });
  });

  it("rethrows product errors other than a missing product", async () => {
    const { stripe } = catalogue();
    stripe.products.retrieve = async () => {
      throw Object.assign(new Error("Invalid API Key provided"), { code: "api_key_invalid" });
    };

    await assert.rejects(syncPlans(stripe), /Invalid API Key/);
  });
});

describe("assertTestModeKey", () => {
  it("accepts test-mode secret and restricted keys", () => {
    assertTestModeKey("sk_test_abc");
    assertTestModeKey("rk_test_abc");
  });

  it("refuses live keys, other key types and a missing key, without echoing the key", () => {
    for (const key of ["sk_live_SecretValue", "rk_live_SecretValue"]) {
      assert.throws(() => assertTestModeKey(key), (error) => /live Stripe key/.test(error.message) && !error.message.includes("SecretValue"));
    }

    for (const key of ["pk_test_abc", "whsec_abc", ""]) {
      assert.throws(() => assertTestModeKey(key));
    }

    assert.throws(() => assertTestModeKey(undefined), /not set/);
  });
});
