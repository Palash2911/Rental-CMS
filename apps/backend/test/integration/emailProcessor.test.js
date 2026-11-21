import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { RateLimitError, UnrecoverableError } from "bullmq";

import {
  deletionScheduledEmail,
  paymentFailedEmail,
  tenantInvitationEmail,
} from "../../src/email/events.js";
import { EMAIL_FAILURES, EmailDeliveryError } from "../../src/email/gateway.js";
import { createEmailProcessor, EMAIL_MAX_AGE_MS } from "../../src/email/processor.js";
import { prisma, resetDatabase } from "../support/db.js";
import { emailJob, fakeEmailGateway } from "../support/email.js";
import {
  createHouse,
  createInvitation,
  createOwnerAccount,
  createUser,
  recordingLogger,
} from "../support/factories.js";

const FROM = "Rental CMS <notifications@example.test>";
const FRONTEND_URL = "https://app.example.test";
const REDIRECT = "dev-inbox@example.test";

function processor(email, { devRedirect = null, log = recordingLogger(), now } = {}) {
  const rateLimits = [];
  const process = createEmailProcessor({
    prisma,
    emailGateway: email.gateway,
    from: FROM,
    devRedirect,
    frontendUrl: FRONTEND_URL,
    log,
    rateLimit: async (ms) => rateLimits.push(ms),
    ...(now ? { now } : {}),
  });
  return { process, rateLimits, log };
}

async function invitationJob() {
  const owner = await createUser({ name: "Priya Primary" });
  const account = await createOwnerAccount(owner, { name: "Harbour Rentals" });
  const house = await createHouse(account, { name: "Unit 4" });
  const invitation = await createInvitation(house, owner, { email: "invitee@example.test" });
  return { owner, account, invitation, job: emailJob(tenantInvitationEmail({ invitationId: invitation.id })) };
}

function failure(kind, { retryAfterMs = null, errorName = "validation_error" } = {}) {
  return new EmailDeliveryError(kind, { errorName, statusCode: 429, retryAfterMs });
}

function logged(log) {
  return JSON.stringify(log.entries);
}

beforeEach(resetDatabase);

describe("email processor", () => {
  it("sends to the resolved recipient from EMAIL_FROM with the job id as idempotency key", async () => {
    const { job } = await invitationJob();
    const email = fakeEmailGateway();

    const result = await processor(email).process(job);

    assert.deepEqual(result, { sent: true, alreadySent: false });
    const [sent] = email.sent;
    assert.deepEqual(
      { from: sent.from, to: sent.to, idempotencyKey: sent.idempotencyKey },
      { from: FROM, to: "invitee@example.test", idempotencyKey: job.id },
    );
    assert.equal(sent.subject, "Harbour Rentals invited you to rent Unit 4");
    assert.ok(sent.html.startsWith("<!doctype html>"));
    assert.ok(sent.text.length > 0);
  });

  it("sends a retried job with the same idempotency key and payload, so Resend sends it once", async () => {
    const { job } = await invitationJob();
    const email = fakeEmailGateway([failure(EMAIL_FAILURES.RETRYABLE, { errorName: "application_error" }), "alreadySent"]);
    const { process } = processor(email);

    await assert.rejects(process(job), (error) => error instanceof EmailDeliveryError && error.kind === EMAIL_FAILURES.RETRYABLE);
    const retried = await process({ ...job, attemptsMade: 1 });

    assert.deepEqual(retried, { sent: true, alreadySent: true });
    assert.equal(email.sent.length, 2);
    assert.deepEqual(email.sent[0], email.sent[1]);
  });

  it("with a development redirect, sends to the redirect and names the real recipient in the body", async () => {
    const { job } = await invitationJob();
    const email = fakeEmailGateway();

    await processor(email, { devRedirect: REDIRECT }).process(job);

    const [sent] = email.sent;
    assert.equal(sent.to, REDIRECT);
    assert.match(sent.text, /meant for invitee@example\.test/);
    assert.match(sent.html, /meant for invitee@example\.test/);
    assert.equal(sent.idempotencyKey, job.id);
  });

  it("pauses the whole queue for the rate limit's delay and gives the job back without using an attempt", async () => {
    const { job } = await invitationJob();
    const email = fakeEmailGateway([failure(EMAIL_FAILURES.RATE_LIMITED, { retryAfterMs: 3000, errorName: "rate_limit_exceeded" })]);
    const { process, rateLimits, log } = processor(email);

    await assert.rejects(process(job), (error) => error instanceof RateLimitError);

    assert.deepEqual(rateLimits, [3000]);
    assert.equal(log.entries[0].level, "warn");
  });

  it("does not retry a permanent refusal, and logs it without the address", async () => {
    const { job } = await invitationJob();
    const email = fakeEmailGateway([failure(EMAIL_FAILURES.PERMANENT)]);
    const { process, rateLimits, log } = processor(email);

    await assert.rejects(process(job), (error) => error instanceof UnrecoverableError);

    assert.deepEqual(rateLimits, []);
    assert.equal(log.entries[0].level, "error");
    assert.match(logged(log), /validation_error/);
    assert.match(logged(log), new RegExp(job.id));
    assert.doesNotMatch(logged(log), /invitee@example\.test/);
  });

  it("skips an invitation answered before the email went out", async () => {
    const { invitation, job } = await invitationJob();
    await prisma.invitation.update({ where: { id: invitation.id }, data: { status: "REVOKED" } });
    const email = fakeEmailGateway();

    const result = await processor(email).process(job);

    assert.deepEqual(result, { sent: false, skipped: true });
    assert.equal(email.sent.length, 0);
  });

  it("sends account emails to the current PRIMARY and skips a deleted account", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner);
    const job = emailJob(paymentFailedEmail({ stripeEventId: "evt_test_1", ownerAccountId: account.id }));
    const email = fakeEmailGateway();

    await processor(email).process(job);
    assert.equal(email.sent[0].to, owner.email);

    await prisma.ownerAccount.update({ where: { id: account.id }, data: { deletionExecutedAt: new Date() } });
    const deleted = emailJob(
      deletionScheduledEmail({ activityLogId: "clog00001", ownerAccountId: account.id, deletionScheduledAt: new Date().toISOString(), reason: "OWNER_REQUEST" }),
    );
    assert.deepEqual(await processor(email).process(deleted), { sent: false, skipped: true });
    assert.equal(email.sent.length, 1);
  });

  it("fails a job for good once it is older than the maximum age, or of an unknown type", async () => {
    const { job } = await invitationJob();
    const email = fakeEmailGateway();
    const { process, log } = processor(email);

    await assert.rejects(process({ ...job, timestamp: Date.now() - EMAIL_MAX_AGE_MS - 1 }), UnrecoverableError);
    await assert.rejects(process({ ...job, name: "notAnEmail" }), UnrecoverableError);

    assert.equal(email.sent.length, 0);
    assert.deepEqual(log.entries.map((entry) => entry.level), ["error", "error"]);
  });
});
