import { Resend } from "resend";

// Passed explicitly: the SDK would otherwise read RESEND_BASE_URL from process.env itself,
// outside lib/config.js.
const RESEND_BASE_URL = "https://api.resend.com";

// resend 6.39.0 sets no timeout on its fetch; an aborted request comes back as
// application_error with statusCode null, which is retried.
const SEND_TIMEOUT_MS = 10_000;

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const DEFAULT_RATE_LIMIT_DELAY_MS = 2 * MS_PER_SECOND;
// Resend's daily quota resets at midnight UTC; a few minutes' margin avoids hitting it again.
const QUOTA_RESET_MARGIN_MS = 5 * MS_PER_MINUTE;
const RETRY_AFTER_HEADER = "retry-after";
const RATE_LIMIT_RESET_HEADER = "ratelimit-reset";

/** How a failed send is handled. */
export const EMAIL_FAILURES = Object.freeze({
  // Too many requests or a quota: pause the whole queue for `retryAfterMs`, no attempt used.
  RATE_LIMITED: "RATE_LIMITED",
  // Resend or the network failed: retry this job with exponential backoff.
  RETRYABLE: "RETRYABLE",
  // The request itself is wrong (address, sender, key): never retried.
  PERMANENT: "PERMANENT",
});

// Error names from resend 6.39.0 (RESEND_ERROR_CODE_KEY in dist/index.d.mts). Any name not
// listed here is treated as permanent, so an unknown error never loops.
const RATE_LIMITED_ERRORS = new Set(["rate_limit_exceeded"]);
const QUOTA_ERRORS = new Set(["daily_quota_exceeded", "monthly_quota_exceeded"]);
const RETRYABLE_ERRORS = new Set([
  "application_error",
  "internal_server_error",
  "concurrent_idempotent_requests",
]);
// The key was already used with a different body within Resend's 24 hours: the first
// request was accepted, so this email has been sent.
const ALREADY_SENT_ERRORS = new Set(["invalid_idempotent_request"]);

/** A send that did not go through, with how to handle it (EMAIL_FAILURES). */
export class EmailDeliveryError extends Error {
  constructor(kind, { errorName, statusCode = null, retryAfterMs = null }) {
    super(`Email delivery failed: ${errorName}`);
    this.name = "EmailDeliveryError";
    this.kind = kind;
    this.errorName = errorName;
    this.statusCode = statusCode;
    this.retryAfterMs = retryAfterMs;
  }
}

function headerSeconds(headers, name) {
  const value = Number.parseInt(headers?.[name] ?? "", 10);
  return Number.isFinite(value) && value >= 0 ? value * MS_PER_SECOND : null;
}

/** Milliseconds from `now` until a few minutes past the next midnight UTC. */
export function untilQuotaReset(now) {
  const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return nextMidnight + QUOTA_RESET_MARGIN_MS - now.getTime();
}

/**
 * Maps a Resend `{ error, headers }` result to EmailDeliveryError, or returns null when the
 * error means the email was already sent.
 */
export function classifyResendError(error, headers, now = new Date()) {
  const errorName = error?.name ?? "unknown";
  const details = { errorName, statusCode: error?.statusCode ?? null };

  if (ALREADY_SENT_ERRORS.has(errorName)) {
    return null;
  }

  if (RATE_LIMITED_ERRORS.has(errorName)) {
    const retryAfterMs =
      headerSeconds(headers, RETRY_AFTER_HEADER) ??
      headerSeconds(headers, RATE_LIMIT_RESET_HEADER) ??
      DEFAULT_RATE_LIMIT_DELAY_MS;
    return new EmailDeliveryError(EMAIL_FAILURES.RATE_LIMITED, { ...details, retryAfterMs });
  }

  if (QUOTA_ERRORS.has(errorName)) {
    return new EmailDeliveryError(EMAIL_FAILURES.RATE_LIMITED, {
      ...details,
      retryAfterMs: untilQuotaReset(now),
    });
  }

  if (RETRYABLE_ERRORS.has(errorName)) {
    return new EmailDeliveryError(EMAIL_FAILURES.RETRYABLE, details);
  }

  return new EmailDeliveryError(EMAIL_FAILURES.PERMANENT, details);
}

/** Creates the Resend client the worker sends with. */
export function createEmailClient(apiKey) {
  return new Resend(apiKey, { baseUrl: RESEND_BASE_URL });
}

/**
 * The one email call the app makes, injected into the worker like the Stripe and storage
 * gateways, so tests pass a fake and never reach the network.
 */
export function createEmailGateway(resend) {
  return Object.freeze({
    /**
     * Sends one email with `idempotencyKey` (Resend keeps it 24 hours). Returns
     * `{ id, alreadySent }`. Throws EmailDeliveryError for any failure.
     */
    async send({ from, to, subject, html, text, idempotencyKey }) {
      const { data, error, headers } = await resend.emails.send(
        { from, to, subject, html, text },
        { idempotencyKey, signal: AbortSignal.timeout(SEND_TIMEOUT_MS) },
      );

      if (!error) {
        return { id: data?.id ?? null, alreadySent: false };
      }

      const failure = classifyResendError(error, headers);

      if (!failure) {
        return { id: null, alreadySent: true };
      }

      throw failure;
    },
  });
}
