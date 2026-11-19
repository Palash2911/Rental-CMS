import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { config } from "../../src/lib/config.js";
import { READ_ONLY_MESSAGE } from "../../src/lib/entitlement.js";
import { TRIAL_PERIOD_DAYS } from "../../src/lib/plans.js";
import { prisma, resetDatabase } from "../support/db.js";
import {
  addMember,
  contextFor,
  createAssignment,
  createHouse,
  createInvitation,
  createOwnerAccount,
  createUser,
  setBilling,
} from "../support/factories.js";
import { expectData, expectError, run } from "../support/graphql.js";
import { recordingStripeGateway } from "../support/stripe.js";

const BILLING_FIELDS = `
  plan interval status trialEnd currentPeriodEnd cancelAtPeriodEnd access readOnly
  readOnlySince activeTenants tenantLimit enterprise trialAvailable`;
const BILLING = `query ($id: ID!) { ownerAccount(id: $id) { id billing { ${BILLING_FIELDS} } } }`;
const MY_BILLING = `query { myOwnerAccounts { items { id billing { plan tenantLimit activeTenants } } } }`;
const START_CHECKOUT = `mutation ($ownerAccountId: ID!, $plan: CheckoutPlan!, $interval: BillingInterval!) {
  startCheckout(ownerAccountId: $ownerAccountId, plan: $plan, interval: $interval) { url } }`;
const PORTAL = `mutation ($ownerAccountId: ID!) { openBillingPortal(ownerAccountId: $ownerAccountId) { url } }`;
const SET_ENTERPRISE = `mutation ($ownerAccountId: ID!) { setEnterprisePlan(ownerAccountId: $ownerAccountId) { id status billing { plan enterprise tenantLimit access } } }`;
const CLEAR_ENTERPRISE = `mutation ($ownerAccountId: ID!) { clearEnterprisePlan(ownerAccountId: $ownerAccountId) { id status billing { plan enterprise tenantLimit access readOnly } } }`;

const MESSAGES = Object.freeze({
  ROLE_NOT_ALLOWED: "Your role on this owner account does not allow this action.",
  STATUS_NOT_ALLOWED: "This action is not available for the owner account in its current state.",
  OWNER_ACCOUNT_NOT_FOUND: "Owner account not found.",
  ADMIN_REQUIRED: "This action requires an administrator.",
  ENTERPRISE: "This account is on an enterprise plan, which is billed manually.",
  ALREADY_SUBSCRIBED: "This account already has a subscription. Use the billing portal to change it.",
  CHECKOUT_ALREADY_COMPLETED:
    "A checkout for this account has already completed. Use the billing portal once it is confirmed.",
  NO_CUSTOMER: "This account has no billing details yet. Start a subscription first.",
  ENTERPRISE_ALREADY_SET: "This account is already on the enterprise plan.",
  ENTERPRISE_NOT_SET: "This account is not on the enterprise plan.",
});

const MISSING_ID = "cjld2cjxh0000qzrmn831i7rn";
const DEFAULT_ACTIVE = Object.freeze({ plan: "STARTER", interval: "MONTH", stripeStatus: "active" });
const CANCELED = Object.freeze({ ...DEFAULT_ACTIVE, stripeStatus: "canceled" });

function storedSubscription(account) {
  return prisma.subscription.findUnique({ where: { ownerAccountId: account.id } });
}

function callsNamed(calls, name) {
  return calls.filter((call) => call.name === name);
}

async function billingOf(user, account) {
  const data = expectData(await run(contextFor(user), BILLING, { id: account.id }));
  return data.ownerAccount.billing;
}

function checkout(user, account, gateway, { plan = "STARTER", interval = "MONTH" } = {}) {
  return run(contextFor(user, { billingGateway: gateway }), START_CHECKOUT, {
    ownerAccountId: account.id,
    plan,
    interval,
  });
}

beforeEach(resetDatabase);

describe("OwnerAccount.billing", () => {
  it("reports full access and the plan limit for a paid subscription", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner);
    const house = await createHouse(account);
    await createAssignment(house, await createUser());
    await createAssignment(house, await createUser(), { status: "NOTICE_PERIOD" });
    await createAssignment(house, await createUser(), { status: "EXITED" });

    const billing = await billingOf(owner, account);

    assert.deepEqual(
      { ...billing },
      {
        plan: "PRO",
        interval: "MONTH",
        status: "active",
        trialEnd: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        access: "FULL",
        readOnly: false,
        readOnlySince: null,
        activeTenants: 2,
        tenantLimit: 80,
        enterprise: false,
        trialAvailable: true,
      },
    );
  });

  it("reports SETUP with no plan and a tenant limit of 0 for a PENDING account without a subscription", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner, { status: "PENDING", billing: null });

    const billing = await billingOf(owner, account);

    assert.equal(billing.access, "SETUP");
    assert.equal(billing.readOnly, false);
    assert.equal(billing.plan, null);
    assert.equal(billing.status, null);
    assert.equal(billing.tenantLimit, 0);
    assert.equal(billing.trialAvailable, true);
  });

  it("reports READ_ONLY for an APPROVED account without a subscription", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner, { billing: null });

    const billing = await billingOf(owner, account);

    assert.equal(billing.access, "READ_ONLY");
    assert.equal(billing.readOnly, true);
    assert.equal(billing.tenantLimit, 0);
  });

  it("treats past_due as full access and unpaid, canceled and incomplete as read-only", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner);
    const cases = [
      ["past_due", "FULL"],
      ["unpaid", "READ_ONLY"],
      ["canceled", "READ_ONLY"],
      ["incomplete", "READ_ONLY"],
      ["incomplete_expired", "READ_ONLY"],
      ["paused", "READ_ONLY"],
      ["trialing", "FULL"],
    ];

    for (const [stripeStatus, access] of cases) {
      await setBilling(account, { plan: "STARTER", interval: "MONTH", stripeStatus });
      const billing = await billingOf(owner, account);
      assert.equal(billing.access, access, stripeStatus);
      assert.equal(billing.tenantLimit, access === "FULL" ? 8 : 0, stripeStatus);
    }
  });

  it("reports ENTERPRISE with no tenant limit and no trial when the override is on", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner, { billing: { enterprise: true } });

    const billing = await billingOf(owner, account);

    assert.equal(billing.plan, "ENTERPRISE");
    assert.equal(billing.interval, null);
    assert.equal(billing.enterprise, true);
    assert.equal(billing.access, "FULL");
    assert.equal(billing.tenantLimit, null);
    assert.equal(billing.trialAvailable, false);
  });

  it("reports no trial once one was used or a subscription exists", async () => {
    const owner = await createUser();
    const used = await createOwnerAccount(owner, { billing: { ...CANCELED, trialUsedAt: new Date() } });
    const subscribed = await createOwnerAccount(owner, {
      billing: { ...CANCELED, stripeSubscriptionId: "sub_test_old" },
    });

    assert.equal((await billingOf(owner, used)).trialAvailable, false);
    assert.equal((await billingOf(owner, subscribed)).trialAvailable, false);
  });

  it("resolves billing for every account in a list", async () => {
    const owner = await createUser();
    const pro = await createOwnerAccount(owner, { name: "Pro Rentals" });
    const starter = await createOwnerAccount(owner, {
      name: "Starter Rentals",
      billing: { plan: "STARTER", interval: "YEAR", stripeStatus: "active" },
    });
    await createAssignment(await createHouse(starter), await createUser());

    const data = expectData(await run(contextFor(owner), MY_BILLING));
    const byId = new Map(data.myOwnerAccounts.items.map((item) => [item.id, item.billing]));

    assert.deepEqual({ ...byId.get(pro.id) }, { plan: "PRO", tenantLimit: 80, activeTenants: 0 });
    assert.deepEqual({ ...byId.get(starter.id) }, { plan: "STARTER", tenantLimit: 8, activeTenants: 1 });
  });
});

describe("startCheckout", () => {
  it("creates a customer and a trial Checkout session for a new PENDING account", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner, { status: "PENDING", name: "Harbour Rentals", billing: null });
    const { gateway, calls } = recordingStripeGateway();

    const data = expectData(await checkout(owner, account, gateway, { plan: "GROWTH", interval: "YEAR" }));

    const [customerCall] = callsNamed(calls, "createCustomer");
    assert.deepEqual(customerCall.args, [
      { ownerAccountId: account.id, email: owner.email, name: "Harbour Rentals" },
      { idempotencyKey: `owner-account-${account.id}-customer` },
    ]);
    assert.deepEqual(callsNamed(calls, "findPriceIdByLookupKey")[0].args, ["rental_cms_growth_year"]);

    const [sessionCall] = callsNamed(calls, "createCheckoutSession");
    const [params] = sessionCall.args;
    assert.equal(params.mode, "subscription");
    assert.equal(params.client_reference_id, account.id);
    assert.deepEqual(params.line_items, [{ price: "price_test_rental_cms_growth_year", quantity: 1 }]);
    assert.deepEqual(params.subscription_data, {
      metadata: { ownerAccountId: account.id },
      trial_period_days: TRIAL_PERIOD_DAYS,
    });
    assert.deepEqual(params.metadata, { ownerAccountId: account.id });
    assert.equal(params.success_url, config.stripeCheckoutSuccessUrl);
    assert.equal(params.cancel_url, config.stripeCheckoutCancelUrl);

    const stored = await storedSubscription(account);
    assert.match(data.startCheckout.url, new RegExp(`${stored.pendingCheckoutSessionId}$`));
    assert.match(stored.stripeCustomerId, /^cus_test_/);
    assert.equal(stored.trialUsedAt, null, "the trial is recorded only once Stripe reports it");

    const log = await prisma.activityLog.findFirst({ where: { entityId: stored.id, action: "CHECKOUT_STARTED" } });
    assert.equal(log.performedByUserId, owner.id);
    assert.deepEqual(log.metadata, { ownerAccountId: account.id, plan: "GROWTH", interval: "YEAR", trial: true });
  });

  it("is open to an APPROVED account that billing made read-only", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner, { billing: null });
    const { gateway } = recordingStripeGateway();

    expectData(await checkout(owner, account, gateway));
  });

  it("is open to a PENDING_DELETION account", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner, { status: "PENDING_DELETION", billing: null });
    const { gateway } = recordingStripeGateway();

    expectData(await checkout(owner, account, gateway));
  });

  it("offers no trial once the account has used one", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner, {
      billing: { ...CANCELED, trialUsedAt: new Date(), stripeCustomerId: "cus_test_existing" },
    });
    const { gateway, calls } = recordingStripeGateway();

    expectData(await checkout(owner, account, gateway));

    const [params] = callsNamed(calls, "createCheckoutSession")[0].args;
    assert.deepEqual(params.subscription_data, { metadata: { ownerAccountId: account.id } });
    assert.equal(params.customer, "cus_test_existing");
    assert.equal(callsNamed(calls, "createCustomer").length, 0);
  });

  it("offers no trial once the account had any subscription, even without a recorded trial", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner, {
      billing: { ...CANCELED, stripeSubscriptionId: "sub_test_old", stripeCustomerId: "cus_test_existing" },
    });
    const { gateway, calls } = recordingStripeGateway();

    expectData(await checkout(owner, account, gateway));

    const [params] = callsNamed(calls, "createCheckoutSession")[0].args;
    assert.equal(params.subscription_data.trial_period_days, undefined);
  });

  it("expires the previous open session and reuses the customer", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner, { status: "PENDING", billing: null });
    const { gateway, calls, sessions } = recordingStripeGateway();

    expectData(await checkout(owner, account, gateway));
    const first = await storedSubscription(account);
    expectData(await checkout(owner, account, gateway, { plan: "PRO" }));
    const second = await storedSubscription(account);

    assert.equal(callsNamed(calls, "createCustomer").length, 1);
    assert.deepEqual(callsNamed(calls, "expireCheckoutSession")[0].args, [first.pendingCheckoutSessionId]);
    assert.equal(sessions.get(first.pendingCheckoutSessionId).status, "expired");
    assert.notEqual(second.pendingCheckoutSessionId, first.pendingCheckoutSessionId);
    assert.equal(second.stripeCustomerId, first.stripeCustomerId);
  });

  it("refuses when the previous session already completed", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner, {
      status: "PENDING",
      billing: { stripeCustomerId: "cus_test_existing", pendingCheckoutSessionId: "cs_test_done" },
    });
    const { gateway, calls } = recordingStripeGateway({ sessions: new Map([["cs_test_done", { status: "complete" }]]) });

    expectError(await checkout(owner, account, gateway), "CONFLICT", MESSAGES.CHECKOUT_ALREADY_COMPLETED);
    assert.equal(callsNamed(calls, "createCheckoutSession").length, 0);
    assert.equal((await storedSubscription(account)).pendingCheckoutSessionId, "cs_test_done");
  });

  it("refuses an account with a live subscription", async () => {
    const owner = await createUser();
    const { gateway, calls } = recordingStripeGateway();

    for (const stripeStatus of ["active", "trialing", "past_due", "unpaid", "incomplete", "paused"]) {
      const account = await createOwnerAccount(owner, {
        billing: { plan: "STARTER", interval: "MONTH", stripeStatus, stripeSubscriptionId: `sub_test_${stripeStatus}` },
      });
      expectError(await checkout(owner, account, gateway), "CONFLICT", MESSAGES.ALREADY_SUBSCRIBED);
    }

    assert.equal(calls.length, 0);
  });

  it("refuses an enterprise account", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner, { billing: { enterprise: true } });
    const { gateway, calls } = recordingStripeGateway();

    expectError(await checkout(owner, account, gateway), "CONFLICT", MESSAGES.ENTERPRISE);
    assert.equal(calls.length, 0);
  });

  it("is PRIMARY only: a CO_OWNER is refused before any Stripe call", async () => {
    const [owner, coOwner] = await Promise.all([createUser(), createUser()]);
    const account = await createOwnerAccount(owner, { billing: null });
    await addMember(account, coOwner);
    const { gateway, calls } = recordingStripeGateway();

    expectError(await checkout(coOwner, account, gateway), "FORBIDDEN", MESSAGES.ROLE_NOT_ALLOWED);
    assert.equal(calls.length, 0);
    assert.equal(await storedSubscription(account), null);
  });

  it("hides the account from non-members and refuses a BLOCKED account", async () => {
    const [owner, stranger] = await Promise.all([createUser(), createUser()]);
    const account = await createOwnerAccount(owner, { billing: null });
    const blocked = await createOwnerAccount(owner, { status: "BLOCKED", billing: null });
    const { gateway, calls } = recordingStripeGateway();

    expectError(await checkout(stranger, account, gateway), "NOT_FOUND", MESSAGES.OWNER_ACCOUNT_NOT_FOUND);
    expectError(await checkout(owner, blocked, gateway), "FORBIDDEN", MESSAGES.STATUS_NOT_ALLOWED);
    assert.equal(calls.length, 0);
  });

  it("stores nothing when no Stripe price has the lookup key", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner, { status: "PENDING", billing: null });
    const { gateway, calls } = recordingStripeGateway({ overrides: { findPriceIdByLookupKey: async () => null } });

    const result = await checkout(owner, account, gateway);

    assert.ok(result.errors?.length);
    assert.equal(result.errors[0].extensions?.code, undefined, "a deployment problem is masked, not a client error");
    assert.equal(callsNamed(calls, "createCheckoutSession").length, 0);
    assert.equal(await storedSubscription(account), null, "the transaction rolled back, row insert included");
  });
});

describe("openBillingPortal", () => {
  it("returns a portal URL for the account's Stripe customer", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner, { billing: { ...CANCELED, stripeCustomerId: "cus_test_portal" } });
    const { gateway, calls } = recordingStripeGateway();

    const data = expectData(await run(contextFor(owner, { billingGateway: gateway }), PORTAL, { ownerAccountId: account.id }));

    assert.match(data.openBillingPortal.url, /^https:\/\/billing\.stripe\.test\//);
    assert.deepEqual(callsNamed(calls, "createPortalSession")[0].args, [
      { customer: "cus_test_portal", returnUrl: config.stripePortalReturnUrl },
    ]);
  });

  it("refuses an account with no Stripe customer", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner, { status: "PENDING", billing: null });
    const { gateway, calls } = recordingStripeGateway();

    expectError(
      await run(contextFor(owner, { billingGateway: gateway }), PORTAL, { ownerAccountId: account.id }),
      "CONFLICT",
      MESSAGES.NO_CUSTOMER,
    );
    assert.equal(calls.length, 0);
  });

  it("is PRIMARY only", async () => {
    const [owner, coOwner] = await Promise.all([createUser(), createUser()]);
    const account = await createOwnerAccount(owner, { billing: { ...DEFAULT_ACTIVE, stripeCustomerId: "cus_test_portal" } });
    await addMember(account, coOwner);
    const { gateway, calls } = recordingStripeGateway();

    expectError(
      await run(contextFor(coOwner, { billingGateway: gateway }), PORTAL, { ownerAccountId: account.id }),
      "FORBIDDEN",
      MESSAGES.ROLE_NOT_ALLOWED,
    );
    assert.equal(calls.length, 0);
  });
});

describe("setEnterprisePlan and clearEnterprisePlan", () => {
  it("turns the override on and off, logs both and keeps readOnlySince in step", async () => {
    const [owner, admin] = await Promise.all([createUser(), createUser()]);
    const account = await createOwnerAccount(owner, { billing: null });
    // A new context per request: OwnerAccount.billing is cached for the life of a context.
    const adminContext = () => contextFor(admin, { superAdmin: true });

    const set = expectData(await run(adminContext(), SET_ENTERPRISE, { ownerAccountId: account.id }));
    assert.deepEqual({ ...set.setEnterprisePlan.billing }, { plan: "ENTERPRISE", enterprise: true, tenantLimit: null, access: "FULL" });
    assert.equal((await storedSubscription(account)).readOnlySince, null);

    const cleared = expectData(await run(adminContext(), CLEAR_ENTERPRISE, { ownerAccountId: account.id }));
    assert.deepEqual(
      { ...cleared.clearEnterprisePlan.billing },
      { plan: null, enterprise: false, tenantLimit: 0, access: "READ_ONLY", readOnly: true },
    );
    assert.ok((await storedSubscription(account)).readOnlySince instanceof Date);

    const stored = await storedSubscription(account);
    const logs = await prisma.activityLog.findMany({ where: { entityId: stored.id }, orderBy: { createdAt: "asc" } });
    assert.deepEqual(logs.map((log) => log.action), ["ENTERPRISE_SET", "ENTERPRISE_CLEARED"]);
    assert.ok(logs.every((log) => log.performedByUserId === admin.id));
  });

  it("clears readOnlySince when the override restores access", async () => {
    const [owner, admin] = await Promise.all([createUser(), createUser()]);
    const account = await createOwnerAccount(owner, { billing: { ...CANCELED, readOnlySince: new Date() } });

    expectData(await run(contextFor(admin, { superAdmin: true }), SET_ENTERPRISE, { ownerAccountId: account.id }));

    assert.equal((await storedSubscription(account)).readOnlySince, null);
  });

  it("lifts the tenant limit", async () => {
    const [owner, admin, invitee] = await Promise.all([createUser(), createUser(), createUser()]);
    const account = await createOwnerAccount(owner, { billing: DEFAULT_ACTIVE });
    const full = await createHouse(account, { maxTenants: 10 });

    for (let index = 0; index < 8; index += 1) {
      await createAssignment(full, await createUser());
    }

    const invitation = await createInvitation(await createHouse(account, { name: "Unit 2" }), owner, { email: invitee.email });
    const accept = `mutation ($id: ID!) { acceptInvitation(id: $id) { id } }`;
    expectError(await run(contextFor(invitee), accept, { id: invitation.id }), "CONFLICT");

    expectData(await run(contextFor(admin, { superAdmin: true }), SET_ENTERPRISE, { ownerAccountId: account.id }));
    expectData(await run(contextFor(invitee), accept, { id: invitation.id }));
  });

  it("refuses a value the account already has", async () => {
    const [owner, admin] = await Promise.all([createUser(), createUser()]);
    const plain = await createOwnerAccount(owner);
    const enterprise = await createOwnerAccount(owner, { billing: { enterprise: true } });
    const adminContext = () => contextFor(admin, { superAdmin: true });

    expectError(await run(adminContext(), SET_ENTERPRISE, { ownerAccountId: enterprise.id }), "CONFLICT", MESSAGES.ENTERPRISE_ALREADY_SET);
    expectError(await run(adminContext(), CLEAR_ENTERPRISE, { ownerAccountId: plain.id }), "CONFLICT", MESSAGES.ENTERPRISE_NOT_SET);
  });

  it("returns NOT_FOUND for a missing account and creates nothing", async () => {
    const admin = await createUser();

    expectError(
      await run(contextFor(admin, { superAdmin: true }), SET_ENTERPRISE, { ownerAccountId: MISSING_ID }),
      "NOT_FOUND",
      MESSAGES.OWNER_ACCOUNT_NOT_FOUND,
    );
    assert.equal(await prisma.subscription.count(), 0);
  });

  it("is super admin only, including for the account's PRIMARY member", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner);

    expectError(await run(contextFor(owner), SET_ENTERPRISE, { ownerAccountId: account.id }), "FORBIDDEN", MESSAGES.ADMIN_REQUIRED);
    expectError(await run(contextFor(owner), CLEAR_ENTERPRISE, { ownerAccountId: account.id }), "FORBIDDEN", MESSAGES.ADMIN_REQUIRED);
    assert.equal((await storedSubscription(account)).enterprise, false);
  });
});

describe("read-only accounts", () => {
  const RENAME = `mutation ($id: ID!, $name: String!) { updateOwnerAccount(id: $id, name: $name) { id } }`;
  const SCHEDULE = `mutation ($id: ID!) { scheduleOwnerAccountDeletion(id: $id) { id status } }`;
  const CANCEL = `mutation ($id: ID!) { cancelOwnerAccountDeletion(id: $id) { id status } }`;
  const CREATE_HOUSE = `mutation ($input: CreateHouseInput!) { createHouse(input: $input) { id } }`;
  const UPDATE_HOUSE = `mutation ($input: UpdateHouseInput!) { updateHouse(input: $input) { id } }`;
  const CREATE_INVITATION = `mutation ($input: CreateInvitationInput!) { createInvitation(input: $input) { id } }`;
  const REVOKE = `mutation ($id: ID!) { revokeInvitation(id: $id) { id } }`;
  const ACCEPT = `mutation ($id: ID!) { acceptInvitation(id: $id) { id } }`;
  const DECLINE = `mutation ($id: ID!) { declineInvitation(id: $id) { id status } }`;
  const EXIT = `mutation ($id: ID!) { exitTenantAssignment(id: $id) { id } }`;
  const CREATE_RECEIPT = `mutation ($input: CreateReceiptInput!) { createReceipt(input: $input) { id } }`;
  const CREATE_ISSUE = `mutation ($input: CreateIssueInput!) { createIssue(input: $input) { id } }`;
  const HOUSES = `query ($ownerAccountId: ID!) { houses(ownerAccountId: $ownerAccountId) { items { id } } }`;
  const ASSIGNMENT = `query ($id: ID!) { tenantAssignment(id: $id) { id } }`;

  async function readOnlyFixture(billing = CANCELED) {
    const [owner, tenant, invitee] = await Promise.all([createUser(), createUser(), createUser()]);
    const account = await createOwnerAccount(owner, { billing });
    const house = await createHouse(account);
    const assignment = await createAssignment(house, tenant);
    const invitation = await createInvitation(house, owner, { email: invitee.email });
    return { owner, tenant, invitee, account, house, assignment, invitation };
  }

  it("refuses every member and tenant write with the read-only message", async () => {
    const { owner, tenant, invitee, account, house, assignment, invitation } = await readOnlyFixture();
    const ownerContext = contextFor(owner);

    const attempts = [
      run(ownerContext, RENAME, { id: account.id, name: "New Name" }),
      run(ownerContext, CREATE_HOUSE, { input: { ownerAccountId: account.id, name: "Unit 9", location: "9 Test Street", maxTenants: 2 } }),
      run(ownerContext, UPDATE_HOUSE, { input: { id: house.id, name: "Renamed" } }),
      run(ownerContext, CREATE_INVITATION, { input: { houseId: house.id, email: "someone@example.test", leaseStartDate: "2026-12-01" } }),
      run(ownerContext, REVOKE, { id: invitation.id }),
      run(ownerContext, EXIT, { id: assignment.id }),
      run(contextFor(tenant), CREATE_RECEIPT, { input: { tenantAssignmentId: assignment.id, amountCents: 1000, paidAt: "2026-11-01" } }),
      run(contextFor(tenant), CREATE_ISSUE, { input: { tenantAssignmentId: assignment.id, title: "Leak", description: "Drips." } }),
      run(contextFor(invitee), ACCEPT, { id: invitation.id }),
    ];

    for (const result of await Promise.all(attempts)) {
      expectError(result, "FORBIDDEN", READ_ONLY_MESSAGE);
    }

    assert.equal((await prisma.house.count()), 1);
    assert.equal((await prisma.invitation.findUnique({ where: { id: invitation.id } })).status, "PENDING");
    assert.equal((await prisma.tenantAssignment.findUnique({ where: { id: assignment.id } })).status, "ACTIVE");
  });

  it("keeps reads open for members and tenants", async () => {
    const { owner, tenant, account, assignment } = await readOnlyFixture();

    expectData(await run(contextFor(owner), HOUSES, { ownerAccountId: account.id }));
    expectData(await run(contextFor(owner), ASSIGNMENT, { id: assignment.id }));
    expectData(await run(contextFor(tenant), ASSIGNMENT, { id: assignment.id }));
  });

  it("lets the PRIMARY member schedule and cancel the account's deletion", async () => {
    const { owner, account } = await readOnlyFixture();

    assert.equal(expectData(await run(contextFor(owner), SCHEDULE, { id: account.id })).scheduleOwnerAccountDeletion.status, "PENDING_DELETION");
    assert.equal(expectData(await run(contextFor(owner), CANCEL, { id: account.id })).cancelOwnerAccountDeletion.status, "APPROVED");
  });

  it("lets an invitee decline", async () => {
    const { invitee, invitation } = await readOnlyFixture();

    assert.equal(expectData(await run(contextFor(invitee), DECLINE, { id: invitation.id })).declineInvitation.status, "DECLINED");
  });

  it("applies to an unpaid subscription and to an APPROVED account with none", async () => {
    for (const billing of [{ ...DEFAULT_ACTIVE, stripeStatus: "unpaid" }, null]) {
      const { owner, house } = await readOnlyFixture(billing);
      expectError(await run(contextFor(owner), UPDATE_HOUSE, { input: { id: house.id, name: "Renamed" } }), "FORBIDDEN", READ_ONLY_MESSAGE);
    }
  });

  it("lifts as soon as billing grants access again", async () => {
    const { owner, account, house } = await readOnlyFixture();

    await setBilling(account, { ...DEFAULT_ACTIVE, stripeStatus: "past_due" });

    expectData(await run(contextFor(owner), UPDATE_HOUSE, { input: { id: house.id, name: "Renamed" } }));
  });

  it("reports a BLOCKED status before billing", async () => {
    const { owner, tenant, account, assignment } = await readOnlyFixture();
    await prisma.ownerAccount.update({ where: { id: account.id }, data: { status: "BLOCKED" } });

    expectError(await run(contextFor(owner), HOUSES, { ownerAccountId: account.id }), "FORBIDDEN", MESSAGES.STATUS_NOT_ALLOWED);
    expectError(
      await run(contextFor(tenant), CREATE_ISSUE, { input: { tenantAssignmentId: assignment.id, title: "Leak", description: "Drips." } }),
      "FORBIDDEN",
      MESSAGES.STATUS_NOT_ALLOWED,
    );
  });

  it("does not apply to a PENDING account: setup stays open, tenant-facing writes stay closed by status", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner, { status: "PENDING", billing: null });
    const ownerContext = contextFor(owner);

    expectData(await run(ownerContext, RENAME, { id: account.id, name: "Renamed" }));
    const created = expectData(
      await run(ownerContext, CREATE_HOUSE, { input: { ownerAccountId: account.id, name: "Unit 1", location: "1 Test Street", maxTenants: 2 } }),
    );
    expectData(await run(ownerContext, UPDATE_HOUSE, { input: { id: created.createHouse.id, name: "Unit 1A" } }));
    expectError(
      await run(ownerContext, CREATE_INVITATION, { input: { houseId: created.createHouse.id, email: "someone@example.test", leaseStartDate: "2026-12-01" } }),
      "FORBIDDEN",
      MESSAGES.STATUS_NOT_ALLOWED,
    );
  });

  it("records readOnlySince when a super admin approves an account that has no subscription", async () => {
    const [owner, admin] = await Promise.all([createUser(), createUser()]);
    const account = await createOwnerAccount(owner, { status: "PENDING", billing: null });
    const approve = `mutation ($id: ID!) { approveOwnerAccount(id: $id) { id status } }`;

    expectData(await run(contextFor(admin, { superAdmin: true }), approve, { id: account.id }));

    assert.ok((await storedSubscription(account)).readOnlySince instanceof Date);
    assert.equal((await billingOf(owner, account)).access, "READ_ONLY");
  });
});

describe("tenant limits per plan", () => {
  const ACCEPT = `mutation ($id: ID!) { acceptInvitation(id: $id) { id } }`;
  const PLAN_LIMIT = "This owner account has reached the tenant limit of its plan.";
  const LIMITS = Object.freeze({ STARTER: 8, GROWTH: 26, PRO: 80 });

  // Inserts `count` ACTIVE assignments spread over two houses of the account, in bulk.
  async function fillAccount(account, count, status = "ACTIVE") {
    const houses = await Promise.all([
      createHouse(account, { name: "Fill A", maxTenants: count }),
      createHouse(account, { name: "Fill B", maxTenants: count }),
    ]);
    const users = await Promise.all(Array.from({ length: count }, () => createUser()));
    await prisma.tenantProfile.createMany({ data: users.map((user) => ({ userId: user.id })) });
    const profiles = await prisma.tenantProfile.findMany({ where: { userId: { in: users.map((user) => user.id) } } });
    await prisma.tenantAssignment.createMany({
      data: profiles.map((profile, index) => ({
        tenantProfileId: profile.id,
        houseId: houses[index % 2].id,
        status,
        leaseStartDate: new Date("2026-01-01T00:00:00.000Z"),
      })),
    });
  }

  async function inviteToNewHouse(account, owner) {
    const invitee = await createUser();
    const house = await createHouse(account, { name: "Open", maxTenants: 3 });
    const invitation = await createInvitation(house, owner, { email: invitee.email });
    return { invitee, invitation };
  }

  for (const [plan, limit] of Object.entries(LIMITS)) {
    it(`${plan} allows ${limit} active tenants across the account and refuses the next`, async () => {
      const owner = await createUser();
      const account = await createOwnerAccount(owner, { billing: { plan, interval: "MONTH", stripeStatus: "active" } });
      await fillAccount(account, limit - 1);

      const last = await inviteToNewHouse(account, owner);
      expectData(await run(contextFor(last.invitee), ACCEPT, { id: last.invitation.id }));

      const over = await inviteToNewHouse(account, owner);
      expectError(await run(contextFor(over.invitee), ACCEPT, { id: over.invitation.id }), "CONFLICT", PLAN_LIMIT);
      assert.equal((await prisma.invitation.findUnique({ where: { id: over.invitation.id } })).status, "PENDING");
      assert.equal((await billingOf(owner, account)).activeTenants, limit);
    });
  }

  it("counts NOTICE_PERIOD assignments and ignores EXITED ones", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner, { billing: DEFAULT_ACTIVE });
    await fillAccount(account, 8, "NOTICE_PERIOD");
    const refused = await inviteToNewHouse(account, owner);
    expectError(await run(contextFor(refused.invitee), ACCEPT, { id: refused.invitation.id }), "CONFLICT", PLAN_LIMIT);

    const other = await createOwnerAccount(owner, { billing: DEFAULT_ACTIVE });
    await fillAccount(other, 20, "EXITED");
    const accepted = await inviteToNewHouse(other, owner);
    expectData(await run(contextFor(accepted.invitee), ACCEPT, { id: accepted.invitation.id }));
  });

  it("removes nobody on a downgrade below the current count, and blocks new accepts", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner, { billing: { plan: "GROWTH", interval: "MONTH", stripeStatus: "active" } });
    await fillAccount(account, 10);

    await setBilling(account, DEFAULT_ACTIVE);

    const billing = await billingOf(owner, account);
    assert.equal(billing.activeTenants, 10);
    assert.equal(billing.tenantLimit, 8);
    const refused = await inviteToNewHouse(account, owner);
    expectError(await run(contextFor(refused.invitee), ACCEPT, { id: refused.invitation.id }), "CONFLICT", PLAN_LIMIT);
    assert.equal(await prisma.tenantAssignment.count({ where: { status: "ACTIVE" } }), 10);
  });

  it("checks the house's own capacity before the plan limit", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner, { billing: DEFAULT_ACTIVE });
    await fillAccount(account, 8);
    const invitee = await createUser();
    const house = await createHouse(account, { name: "Tiny", maxTenants: 1 });
    await createAssignment(house, await createUser());
    const invitation = await createInvitation(house, owner, { email: invitee.email });

    expectError(await run(contextFor(invitee), ACCEPT, { id: invitation.id }), "CONFLICT", "This house has no free tenant places.");
  });
});
