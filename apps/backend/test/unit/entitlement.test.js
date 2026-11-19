import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  ACCESS,
  computeEntitlement,
  isFullAccessStatus,
  isLiveStatus,
} from "../../src/lib/entitlement.js";
import {
  catalogPrices,
  lookupKeyFor,
  planForLookupKey,
  PLANS,
  productIdFor,
} from "../../src/lib/plans.js";

describe("computeEntitlement", () => {
  for (const stripeStatus of ["trialing", "active", "past_due"]) {
    it(`gives FULL access with the plan's limit while Stripe says ${stripeStatus}`, () => {
      for (const accountStatus of ["PENDING", "APPROVED", "PENDING_DELETION"]) {
        assert.deepEqual(computeEntitlement(accountStatus, { plan: "GROWTH", stripeStatus, enterprise: false }), {
          access: ACCESS.FULL,
          plan: "GROWTH",
          tenantLimit: 26,
        });
      }
    });
  }

  for (const stripeStatus of ["canceled", "unpaid", "incomplete", "incomplete_expired", "paused", "some_future_status", null]) {
    it(`is READ_ONLY for an APPROVED account when Stripe says ${stripeStatus}`, () => {
      assert.deepEqual(computeEntitlement("APPROVED", { plan: "PRO", stripeStatus, enterprise: false }), {
        access: ACCESS.READ_ONLY,
        plan: null,
        tenantLimit: 0,
      });
    });
  }

  it("is SETUP for a PENDING account with no paid access, with no tenant places", () => {
    for (const subscription of [null, { plan: null, stripeStatus: null, enterprise: false }, { plan: "STARTER", stripeStatus: "canceled", enterprise: false }]) {
      assert.deepEqual(computeEntitlement("PENDING", subscription), { access: ACCESS.SETUP, plan: null, tenantLimit: 0 });
    }
  });

  it("is READ_ONLY for an APPROVED account with no subscription row", () => {
    assert.equal(computeEntitlement("APPROVED", null).access, ACCESS.READ_ONLY);
  });

  it("gives enterprise FULL access with no limit, whatever Stripe says", () => {
    for (const stripeStatus of [null, "canceled", "active"]) {
      assert.deepEqual(computeEntitlement("APPROVED", { plan: null, stripeStatus, enterprise: true }), {
        access: ACCESS.FULL,
        plan: "ENTERPRISE",
        tenantLimit: null,
      });
    }
  });

  it("needs a known plan for FULL access, so an unknown price never grants access", () => {
    assert.equal(computeEntitlement("APPROVED", { plan: null, stripeStatus: "active", enterprise: false }).access, ACCESS.READ_ONLY);
  });
});

describe("Stripe status helpers", () => {
  it("treats only canceled and incomplete_expired as ended", () => {
    for (const status of ["trialing", "active", "past_due", "unpaid", "incomplete", "paused"]) {
      assert.equal(isLiveStatus(status), true, status);
    }

    for (const status of ["canceled", "incomplete_expired", null, undefined]) {
      assert.equal(isLiveStatus(status), false, String(status));
    }
  });

  it("grants full access only for trialing, active and past_due", () => {
    assert.deepEqual(
      ["trialing", "active", "past_due", "unpaid", "canceled", "incomplete"].filter(isFullAccessStatus),
      ["trialing", "active", "past_due"],
    );
  });
});

describe("plans", () => {
  it("has the agreed limits and GST-inclusive AUD prices in cents", () => {
    assert.deepEqual(
      Object.fromEntries(Object.entries(PLANS).map(([plan, { tenantLimit, amounts }]) => [plan, { tenantLimit, ...amounts }])),
      {
        STARTER: { tenantLimit: 8, MONTH: 1900, YEAR: 20900 },
        GROWTH: { tenantLimit: 26, MONTH: 3900, YEAR: 42900 },
        PRO: { tenantLimit: 80, MONTH: 8900, YEAR: 97900 },
      },
    );
  });

  it("maps every plan and interval to a lookup key and back", () => {
    assert.equal(lookupKeyFor("STARTER", "MONTH"), "rental_cms_starter_month");
    assert.equal(lookupKeyFor("PRO", "YEAR"), "rental_cms_pro_year");
    assert.equal(productIdFor("GROWTH"), "rental_cms_growth");

    for (const { plan, interval, lookupKey } of catalogPrices()) {
      assert.deepEqual({ ...planForLookupKey(lookupKey) }, { plan, interval });
    }

    assert.equal(catalogPrices().length, 6);
    assert.equal(planForLookupKey("someone_elses_price"), null);
    assert.equal(planForLookupKey(null), null);
  });
});
