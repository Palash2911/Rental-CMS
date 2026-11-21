import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  classifyResendError,
  createEmailGateway,
  EMAIL_FAILURES,
  EmailDeliveryError,
  untilQuotaReset,
} from "../../src/email/gateway.js";

// The resend 6.39.0 result shape, verified in node_modules/resend/dist/index.mjs:
// `{ data, error: { name, message, statusCode } | null, headers }`, never a throw.
function resendReturning(result) {
  const calls = [];
  return {
    calls,
    client: { emails: { send: async (payload, options) => { calls.push({ payload, options }); return result; } } },
  };
}

const MESSAGE = Object.freeze({
  from: "Rental CMS <notifications@example.test>",
  to: "tenant@example.test",
  subject: "Subject",
  html: "<p>Hi</p>",
  text: "Hi",
  idempotencyKey: "tenant-invitation/cinv0001",
});

describe("classifyResendError", () => {
  const now = new Date("2026-11-21T22:30:00.000Z");

  it("pauses for Retry-After on rate_limit_exceeded, with a default when the header is missing", () => {
    const withHeader = classifyResendError({ name: "rate_limit_exceeded", statusCode: 429 }, { "retry-after": "3" }, now);
    const withoutHeader = classifyResendError({ name: "rate_limit_exceeded", statusCode: 429 }, null, now);

    assert.deepEqual([withHeader.kind, withHeader.retryAfterMs], [EMAIL_FAILURES.RATE_LIMITED, 3000]);
    assert.deepEqual([withoutHeader.kind, withoutHeader.retryAfterMs], [EMAIL_FAILURES.RATE_LIMITED, 2000]);
  });

  it("pauses until 00:05 UTC on a daily or monthly quota", () => {
    for (const name of ["daily_quota_exceeded", "monthly_quota_exceeded"]) {
      const failure = classifyResendError({ name, statusCode: 429 }, {}, now);
      assert.equal(failure.kind, EMAIL_FAILURES.RATE_LIMITED);
      assert.equal(failure.retryAfterMs, (90 + 5) * 60 * 1000, name);
    }

    assert.equal(untilQuotaReset(new Date("2026-11-21T00:00:00.000Z")), (24 * 60 + 5) * 60 * 1000);
  });

  it("retries Resend-side and network errors, including a timeout (statusCode null)", () => {
    for (const error of [
      { name: "application_error", statusCode: 500 },
      { name: "application_error", statusCode: null },
      { name: "internal_server_error", statusCode: 500 },
      { name: "concurrent_idempotent_requests", statusCode: 409 },
    ]) {
      assert.equal(classifyResendError(error, {}, now).kind, EMAIL_FAILURES.RETRYABLE, error.name);
    }
  });

  it("never retries a bad request, a bad key or an error name it does not know", () => {
    for (const name of ["validation_error", "missing_required_field", "invalid_from_address", "invalid_api_key", "restricted_api_key", "invalid_idempotency_key", "something_new"]) {
      assert.equal(classifyResendError({ name, statusCode: 422 }, {}, now).kind, EMAIL_FAILURES.PERMANENT, name);
    }
  });

  it("treats a reused idempotency key with a different body as already sent", () => {
    assert.equal(classifyResendError({ name: "invalid_idempotent_request", statusCode: 422 }, {}, now), null);
  });
});

describe("email gateway send", () => {
  it("sends the message with the idempotency key and a timeout signal", async () => {
    const resend = resendReturning({ data: { id: "email_1" }, error: null, headers: {} });

    const result = await createEmailGateway(resend.client).send(MESSAGE);

    assert.deepEqual(result, { id: "email_1", alreadySent: false });
    const [{ payload, options }] = resend.calls;
    assert.deepEqual(payload, { from: MESSAGE.from, to: MESSAGE.to, subject: MESSAGE.subject, html: MESSAGE.html, text: MESSAGE.text });
    assert.equal(options.idempotencyKey, MESSAGE.idempotencyKey);
    assert.ok(options.signal instanceof AbortSignal);
  });

  it("reports an already-sent email as success and throws EmailDeliveryError otherwise", async () => {
    const duplicate = resendReturning({ data: null, error: { name: "invalid_idempotent_request", statusCode: 422, message: "x" }, headers: {} });
    assert.deepEqual(await createEmailGateway(duplicate.client).send(MESSAGE), { id: null, alreadySent: true });

    const refused = resendReturning({ data: null, error: { name: "validation_error", statusCode: 422, message: "Invalid `to` field." }, headers: {} });
    await assert.rejects(createEmailGateway(refused.client).send(MESSAGE), (error) => {
      assert.ok(error instanceof EmailDeliveryError);
      assert.equal(error.kind, EMAIL_FAILURES.PERMANENT);
      assert.equal(error.errorName, "validation_error");
      return true;
    });
  });
});
