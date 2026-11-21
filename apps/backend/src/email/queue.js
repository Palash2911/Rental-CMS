/** The BullMQ queue emails go through; the worker is its only consumer. */
export const EMAIL_QUEUE = "email";

const MS_PER_SECOND = 1000;

/**
 * Exponential backoff from 30 seconds over 8 attempts (about two hours in all), well inside
 * the 24 hours Resend remembers an idempotency key. Rate limits and quotas pause the queue
 * instead and use no attempt (see the processor).
 */
export const EMAIL_JOB_OPTIONS = Object.freeze({
  attempts: 8,
  backoff: Object.freeze({ type: "exponential", delay: 30 * MS_PER_SECOND }),
  // Kept for a week, so a duplicate enqueue of the same event (same job id) is dropped.
  removeOnComplete: Object.freeze({ age: 7 * 24 * 60 * 60 }),
  removeOnFail: Object.freeze({ age: 30 * 24 * 60 * 60 }),
});

// BullMQ waits for the connection while Redis reconnects, so an enqueue could otherwise hold
// a request for as long as Redis is down.
const ENQUEUE_TIMEOUT_MS = 1000;

/**
 * Most emails one owner account may trigger per UTC day. Past it emails are dropped (and
 * logged), so one account cannot use up the sending quota every other account depends on.
 */
export const DAILY_EMAIL_BUDGET_PER_ACCOUNT = 20;

const BUDGET_KEY_PREFIX = "email-budget";
// One key per account per UTC day; it outlives its day by an hour, then expires.
const BUDGET_WINDOW_MS = 25 * 60 * 60 * 1000;
const ISO_DATE_LENGTH = 10;

const MESSAGES = Object.freeze({
  ENQUEUE_FAILED:
    "Email not queued: Redis is unavailable. The email is lost (no outbox yet).",
  OVER_BUDGET:
    "Email dropped: the owner account has used its daily email budget.",
  NO_ACCOUNT: "Email dropped: it names no owner account to charge.",
  BUDGET_SKIPPED:
    "Email budget not checked: Redis is unavailable. The email is queued anyway.",
});

function budgetKey(ownerAccountId, now) {
  return `${BUDGET_KEY_PREFIX}:${ownerAccountId}:${now.toISOString().slice(0, ISO_DATE_LENGTH)}`;
}

// Fails open like the rate limit: with Redis down the budget cannot be counted, and the
// enqueue right after would fail too, so nothing extra gets through.
async function withinBudget({ redis, log, email, now }) {
  try {
    const [count] = await withTimeout(
      redis.rateLimitHit(
        budgetKey(email.ownerAccountId, now),
        1,
        BUDGET_WINDOW_MS,
      ),
      ENQUEUE_TIMEOUT_MS,
    );
    return count <= DAILY_EMAIL_BUDGET_PER_ACCOUNT;
  } catch (error) {
    log.warn(
      { err: error, emailType: email.type, emailKey: email.key },
      MESSAGES.BUDGET_SKIPPED,
    );
    return true;
  }
}

function withTimeout(promise, timeoutMs) {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`Timed out after ${timeoutMs} ms`)),
      timeoutMs,
    );
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Wraps a BullMQ queue as the notifier the API, the webhook and the jobs use. `enqueue`
 * charges each `{ type, key, ownerAccountId, data }` to its account's daily budget
 * (`redis` must have `rateLimitHit`), then adds it (job id = key). It never throws: a
 * failure or a dropped email is logged at `warn` with the type and key only, and the
 * caller's write stands (project owner, option A).
 */
export function createEmailNotifier({
  queue,
  redis,
  log,
  now = () => new Date(),
}) {
  return Object.freeze({
    async enqueue(emails) {
      for (const email of emails) {
        const context = {
          emailType: email.type,
          emailKey: email.key,
          ownerAccountId: email.ownerAccountId,
        };

        if (!email.ownerAccountId) {
          log.error(context, MESSAGES.NO_ACCOUNT);
          continue;
        }

        if (!(await withinBudget({ redis, log, email, now: now() }))) {
          log.warn(context, MESSAGES.OVER_BUDGET);
          continue;
        }

        try {
          await withTimeout(
            queue.add(email.type, email.data, {
              ...EMAIL_JOB_OPTIONS,
              jobId: email.key,
            }),
            ENQUEUE_TIMEOUT_MS,
          );
        } catch (error) {
          log.warn(
            { err: error, emailType: email.type, emailKey: email.key },
            MESSAGES.ENQUEUE_FAILED,
          );
        }
      }
    },
  });
}

/**
 * Runs `work(emails)`, which pushes `{ type, key, data }` entries into `emails` while it
 * writes, and enqueues them only once `work` has resolved, that is, after its transaction
 * committed. If `work` throws (a rolled-back transaction), nothing is enqueued.
 */
export async function withEmails(notifier, work) {
  const emails = [];
  const result = await work(emails);

  if (emails.length > 0) {
    await notifier.enqueue(emails);
  }

  return result;
}
