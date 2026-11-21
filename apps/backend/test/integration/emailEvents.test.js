import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { EMAIL_TYPES } from "../../src/email/events.js";
import { renderEmailJob } from "../../src/email/processor.js";
import { runBillingGrace } from "../../src/jobs/billingGrace.js";
import { processStripeWebhook } from "../../src/stripe/webhook.js";
import { prisma, resetDatabase } from "../support/db.js";
import { emailJob, recordingNotifier } from "../support/email.js";
import {
  addMember,
  contextFor,
  createAssignment,
  createHouse,
  createLeaveRequest,
  createOwnerAccount,
  createUser,
  recordingLogger,
} from "../support/factories.js";
import { expectData, expectError, run } from "../support/graphql.js";
import {
  recordingStripeGateway,
  secondsFromNow,
  signWebhook,
  stripeEvent,
  stripeSubscription,
  TEST_WEBHOOK_SECRET,
} from "../support/stripe.js";

const FRONTEND_URL = "https://app.example.test";
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const OPS = Object.freeze({
  CREATE_INVITATION: `mutation ($input: CreateInvitationInput!) { createInvitation(input: $input) { id } }`,
  CREATE_MEMBER_INVITATION: `mutation ($id: ID!, $email: String!) { createMemberInvitation(ownerAccountId: $id, email: $email) { id } }`,
  CREATE_LEAVE_REQUEST: `mutation ($input: CreateLeaveRequestInput!) { createLeaveRequest(input: $input) { id } }`,
  APPROVE: `mutation ($id: ID!) { approveLeaveRequest(id: $id) { id } }`,
  REJECT: `mutation ($id: ID!) { rejectLeaveRequest(id: $id) { id } }`,
  WITHDRAW: `mutation ($id: ID!) { withdrawLeaveRequest(id: $id) { id } }`,
  GIVE_NOTICE: `mutation ($id: ID!, $date: Date!) { giveNotice(tenantAssignmentId: $id, plannedExitDate: $date) { id } }`,
  WITHDRAW_NOTICE: `mutation ($id: ID!) { withdrawNotice(tenantAssignmentId: $id) { id } }`,
  SCHEDULE_DELETION: `mutation ($id: ID!) { scheduleOwnerAccountDeletion(id: $id) { id } }`,
  ADMIN_SCHEDULE_DELETION: `mutation ($id: ID!) { adminScheduleOwnerAccountDeletion(id: $id) { id } }`,
  APPROVE_ACCOUNT: `mutation ($id: ID!) { approveOwnerAccount(id: $id) { id } }`,
  BLOCK_ACCOUNT: `mutation ($id: ID!) { blockOwnerAccount(id: $id) { id } }`,
  CLEAR_ENTERPRISE: `mutation ($id: ID!) { clearEnterprisePlan(ownerAccountId: $id) { id } }`,
});

/** Runs `source` as `user` with a fresh recording notifier; returns `{ result, notifier }`. */
async function runAs(user, source, variables, options = {}) {
  const notifier = recordingNotifier();
  const result = await run(contextFor(user, { notifier, ...options }), source, variables);
  return { result, notifier };
}

function render(email) {
  return renderEmailJob({ prisma, frontendUrl: FRONTEND_URL }, emailJob(email));
}

/** Asserts exactly one email was queued, of `type`, and returns it rendered with its key. */
async function onlyEmail(notifier, type) {
  assert.deepEqual(notifier.emails.map((email) => email.type), [type]);
  const [email] = notifier.emails;
  return { key: email.key, ...(await render(email)) };
}

async function lease() {
  const [owner, coOwner, tenant] = await Promise.all([
    createUser({ name: "Priya Primary" }),
    createUser({ name: "Cole Owner" }),
    createUser({ name: "Tess Tenant" }),
  ]);
  const account = await createOwnerAccount(owner, { name: "Harbour Rentals" });
  await addMember(account, coOwner);
  const house = await createHouse(account, { name: "Unit 4" });
  const assignment = await createAssignment(house, tenant);
  return { owner, coOwner, tenant, account, house, assignment };
}

beforeEach(resetDatabase);

describe("tenant and member invitation emails", () => {
  it("queues one email to the invitee when a tenant invitation is created, and none when it fails", async () => {
    const { owner, house } = await lease();
    const input = { houseId: house.id, email: "new.tenant@example.test", leaseStartDate: "2027-01-01" };

    const { result, notifier } = await runAs(owner, OPS.CREATE_INVITATION, { input });
    const invitation = expectData(result).createInvitation;
    const email = await onlyEmail(notifier, EMAIL_TYPES.TENANT_INVITATION);

    assert.equal(email.key, `tenant-invitation/${invitation.id}`);
    assert.equal(email.to, "new.tenant@example.test");
    assert.equal(email.subject, "Harbour Rentals invited you to rent Unit 4");
    assert.match(email.text, /Lease starts: 1 January 2027/);
    assert.match(email.text, new RegExp(`${FRONTEND_URL}/invitations`));

    const duplicate = await runAs(owner, OPS.CREATE_INVITATION, { input });
    expectError(duplicate.result, "CONFLICT");
    assert.deepEqual(duplicate.notifier.emails, []);
  });

  it("queues one email to the invitee of a co-owner invitation, and none when it fails", async () => {
    const { owner, coOwner, account } = await lease();

    const { result, notifier } = await runAs(owner, OPS.CREATE_MEMBER_INVITATION, { id: account.id, email: "partner@example.test" });
    const invitation = expectData(result).createMemberInvitation;
    const email = await onlyEmail(notifier, EMAIL_TYPES.MEMBER_INVITATION);

    assert.equal(email.key, `member-invitation/${invitation.id}`);
    assert.equal(email.to, "partner@example.test");
    assert.match(email.text, /Priya Primary has invited you to help manage Harbour Rentals/);

    const existingMember = await runAs(owner, OPS.CREATE_MEMBER_INVITATION, { id: account.id, email: coOwner.email });
    expectError(existingMember.result, "CONFLICT");
    assert.deepEqual(existingMember.notifier.emails, []);
  });
});

describe("lease lifecycle emails", () => {
  it("queues one email per owner, each with its own key, when a tenant asks to leave; none on failure", async () => {
    const { owner, coOwner, tenant, house, assignment } = await lease();
    const input = { tenantAssignmentId: assignment.id, requestedExitDate: "2027-06-30", reason: "Moving <north>" };

    const { result, notifier } = await runAs(tenant, OPS.CREATE_LEAVE_REQUEST, { input });
    const request = expectData(result).createLeaveRequest;

    assert.deepEqual(notifier.emails.map((email) => email.type), [EMAIL_TYPES.LEAVE_REQUEST_SUBMITTED, EMAIL_TYPES.LEAVE_REQUEST_SUBMITTED]);
    assert.equal(new Set(notifier.emails.map((email) => email.key)).size, 2);

    const rendered = await Promise.all(notifier.emails.map(render));
    assert.deepEqual(rendered.map((email) => email.to).sort(), [owner.email, coOwner.email].sort());
    assert.ok(notifier.emails.every((email) => email.key.startsWith(`leave-request-submitted/${request.id}/`)));
    assert.match(rendered[0].text, /Tess Tenant has asked to end their lease at Unit 4/);
    assert.match(rendered[0].html, /Moving &lt;north&gt;/);
    assert.match(rendered[0].text, new RegExp(`${FRONTEND_URL}/houses/${house.id}/leave-requests`));

    const second = await runAs(tenant, OPS.CREATE_LEAVE_REQUEST, { input });
    expectError(second.result, "CONFLICT");
    assert.deepEqual(second.notifier.emails, []);
  });

  it("emails the tenant once on approval (no separate notice email) and once on rejection, not on withdrawal", async () => {
    const { owner, tenant, assignment } = await lease();
    const toApprove = await createLeaveRequest(assignment);

    const approved = await runAs(owner, OPS.APPROVE, { id: toApprove.id });
    expectData(approved.result);
    const approval = await onlyEmail(approved.notifier, EMAIL_TYPES.LEAVE_REQUEST_RESPONDED);
    assert.equal(approval.to, tenant.email);
    assert.equal(approval.key, `leave-request-responded/${toApprove.id}`);
    assert.match(approval.subject, /was approved/);
    assert.match(approval.text, /Planned exit date: 30 June 2027/);

    const other = await lease();
    const toReject = await createLeaveRequest(other.assignment);
    const rejected = await runAs(other.owner, OPS.REJECT, { id: toReject.id });
    expectData(rejected.result);
    assert.match((await onlyEmail(rejected.notifier, EMAIL_TYPES.LEAVE_REQUEST_RESPONDED)).subject, /was rejected/);

    const third = await lease();
    const toWithdraw = await createLeaveRequest(third.assignment);
    const withdrawn = await runAs(third.tenant, OPS.WITHDRAW, { id: toWithdraw.id });
    expectData(withdrawn.result);
    assert.deepEqual(withdrawn.notifier.emails, []);

    const again = await runAs(owner, OPS.APPROVE, { id: toApprove.id });
    expectError(again.result, "CONFLICT");
    assert.deepEqual(again.notifier.emails, []);
  });

  it("emails the tenant when notice is given and withdrawn, with a new key each time; none on failure", async () => {
    const { owner, tenant, assignment } = await lease();

    const given = await runAs(owner, OPS.GIVE_NOTICE, { id: assignment.id, date: "2027-03-31" });
    expectData(given.result);
    const notice = await onlyEmail(given.notifier, EMAIL_TYPES.NOTICE_GIVEN);
    assert.equal(notice.to, tenant.email);
    assert.match(notice.text, /Planned exit date: 31 March 2027/);
    assert.match(notice.text, new RegExp(`${FRONTEND_URL}/tenancies/${assignment.id}`));

    const twice = await runAs(owner, OPS.GIVE_NOTICE, { id: assignment.id, date: "2027-03-31" });
    expectError(twice.result, "CONFLICT");
    assert.deepEqual(twice.notifier.emails, []);

    const withdrawn = await runAs(owner, OPS.WITHDRAW_NOTICE, { id: assignment.id });
    expectData(withdrawn.result);
    const withdrawal = await onlyEmail(withdrawn.notifier, EMAIL_TYPES.NOTICE_WITHDRAWN);
    assert.equal(withdrawal.to, tenant.email);

    const regiven = await runAs(owner, OPS.GIVE_NOTICE, { id: assignment.id, date: "2027-03-31" });
    const renotice = await onlyEmail(regiven.notifier, EMAIL_TYPES.NOTICE_GIVEN);
    assert.notEqual(renotice.key, notice.key);
  });
});

describe("account emails to the PRIMARY", () => {
  it("emails the PRIMARY when the owner schedules deletion, and nothing about read-only on a paid account", async () => {
    const { owner, account } = await lease();

    const { result, notifier } = await runAs(owner, OPS.SCHEDULE_DELETION, { id: account.id });
    expectData(result);
    const email = await onlyEmail(notifier, EMAIL_TYPES.DELETION_SCHEDULED);

    assert.equal(email.to, owner.email);
    assert.match(email.text, /You asked for the account to be deleted/);
    assert.match(email.subject, /Harbour Rentals is scheduled for deletion/);
  });

  it("emails the PRIMARY, not the acting admin, when a super admin schedules deletion", async () => {
    const { owner, account } = await lease();
    const admin = await createUser();

    const { result, notifier } = await runAs(admin, OPS.ADMIN_SCHEDULE_DELETION, { id: account.id }, { superAdmin: true });
    expectData(result);
    const email = await onlyEmail(notifier, EMAIL_TYPES.DELETION_SCHEDULED);

    assert.equal(email.to, owner.email);
    assert.match(email.text, /administrator scheduled the deletion/);
  });

  it("emails the PRIMARY when the billingGrace job schedules deletion, after its transaction", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner, {
      billing: { plan: "STARTER", interval: "MONTH", stripeStatus: "canceled", readOnlySince: new Date(Date.now() - 40 * MS_PER_DAY) },
    });
    const notifier = recordingNotifier();

    const summary = await runBillingGrace({ prisma, notifier, log: recordingLogger() });

    assert.equal(summary.done, 1);
    const email = await onlyEmail(notifier, EMAIL_TYPES.DELETION_SCHEDULED);
    assert.equal(email.to, owner.email);
    assert.match(email.text, /read-only for more than 30 days/);
    assert.equal(notifier.emails[0].data.ownerAccountId, account.id);
  });

  it("emails the PRIMARY when approving an account without a subscription makes it read-only", async () => {
    const owner = await createUser();
    const admin = await createUser();
    const account = await createOwnerAccount(owner, { status: "PENDING", billing: null });

    const { result, notifier } = await runAs(admin, OPS.APPROVE_ACCOUNT, { id: account.id }, { superAdmin: true });
    expectData(result);
    const email = await onlyEmail(notifier, EMAIL_TYPES.ACCOUNT_READ_ONLY);
    const { readOnlySince } = await prisma.subscription.findUnique({ where: { ownerAccountId: account.id } });

    assert.equal(email.to, owner.email);
    assert.equal(email.key, `account-read-only/${account.id}/${readOnlySince.getTime()}`);
  });

  it("emails the PRIMARY when clearing the enterprise plan leaves no subscription", async () => {
    const owner = await createUser();
    const admin = await createUser();
    const account = await createOwnerAccount(owner, { billing: { enterprise: true } });

    const { result, notifier } = await runAs(admin, OPS.CLEAR_ENTERPRISE, { id: account.id }, { superAdmin: true });
    expectData(result);

    assert.equal((await onlyEmail(notifier, EMAIL_TYPES.ACCOUNT_READ_ONLY)).to, owner.email);
  });

  it("sends no read-only email when a block makes an unpaid account read-only", async () => {
    const owner = await createUser();
    const admin = await createUser();
    const account = await createOwnerAccount(owner, { status: "PENDING", billing: null });

    const { result, notifier } = await runAs(admin, OPS.BLOCK_ACCOUNT, { id: account.id }, { superAdmin: true });
    expectData(result);

    assert.deepEqual(notifier.emails, []);
  });
});

describe("billing emails from the Stripe webhook", () => {
  async function subscribedAccount(status = "trialing") {
    const owner = await createUser({ name: "Priya Primary" });
    const customer = `cus_test_${owner.id.slice(0, 8).toLowerCase()}`;
    const trialEnd = secondsFromNow(3);
    const subscription = stripeSubscription({ customer, status, trialEnd: status === "trialing" ? trialEnd : null });
    const account = await createOwnerAccount(owner, {
      name: "Harbour Rentals",
      billing: { plan: "STARTER", interval: "MONTH", stripeStatus: status, stripeCustomerId: customer, stripeSubscriptionId: subscription.id },
    });
    const stripe = recordingStripeGateway({ subscriptions: new Map([[subscription.id, subscription]]) });
    return { owner, account, customer, subscription, stripe, trialEnd };
  }

  function deliver(stripe, event, notifier) {
    return processStripeWebhook({ prisma, gateway: stripe.gateway, notifier, webhookSecret: TEST_WEBHOOK_SECRET }, signWebhook(event));
  }

  it("emails the PRIMARY on trial_will_end, keyed by the event, with the trial end date", async () => {
    const { owner, subscription, stripe, trialEnd } = await subscribedAccount("trialing");
    const notifier = recordingNotifier();
    const event = stripeEvent("customer.subscription.trial_will_end", subscription);

    await deliver(stripe, event, notifier);

    const email = await onlyEmail(notifier, EMAIL_TYPES.TRIAL_ENDING);
    assert.equal(email.to, owner.email);
    assert.equal(email.key, `trial-ending/${event.id}`);
    assert.equal(notifier.emails[0].data.trialEnd, new Date(trialEnd * 1000).toISOString());

    const redelivered = recordingNotifier();
    await deliver(stripe, event, redelivered);
    assert.deepEqual(redelivered.emails, []);
  });

  it("emails the PRIMARY on invoice.payment_failed", async () => {
    const { owner, customer, stripe } = await subscribedAccount("past_due");
    const notifier = recordingNotifier();
    const event = stripeEvent("invoice.payment_failed", { id: "in_test_1", object: "invoice", customer });

    await deliver(stripe, event, notifier);

    const email = await onlyEmail(notifier, EMAIL_TYPES.PAYMENT_FAILED);
    assert.equal(email.to, owner.email);
    assert.equal(email.key, `payment-failed/${event.id}`);
  });

  it("emails the PRIMARY once when a cancelled subscription makes the account read-only", async () => {
    const { owner, subscription, stripe } = await subscribedAccount("active");
    stripe.subscriptions.set(subscription.id, { ...subscription, status: "canceled" });
    const notifier = recordingNotifier();

    await deliver(stripe, stripeEvent("customer.subscription.deleted", subscription), notifier);
    assert.equal((await onlyEmail(notifier, EMAIL_TYPES.ACCOUNT_READ_ONLY)).to, owner.email);

    const later = recordingNotifier();
    await deliver(stripe, stripeEvent("customer.subscription.updated", subscription), later);
    assert.deepEqual(later.emails, []);
  });
});
