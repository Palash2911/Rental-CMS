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

const MESSAGES = Object.freeze({
  ENQUEUE_FAILED: "Email not queued: Redis is unavailable. The email is lost (no outbox yet).",
});

function withTimeout(promise, timeoutMs) {
  let timer;

  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Timed out after ${timeoutMs} ms`)), timeoutMs);
  });

  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Wraps a BullMQ queue as the notifier the API, the webhook and the jobs use. `enqueue`
 * adds each `{ type, key, data }` (job id = key) and never throws: a failure is logged at
 * `warn` with the type and key only, and the caller's write stands (project owner, option A).
 */
export function createEmailNotifier(queue, log) {
  return Object.freeze({
    async enqueue(emails) {
      for (const email of emails) {
        try {
          await withTimeout(
            queue.add(email.type, email.data, { ...EMAIL_JOB_OPTIONS, jobId: email.key }),
            ENQUEUE_TIMEOUT_MS,
          );
        } catch (error) {
          log.warn({ err: error, emailType: email.type, emailKey: email.key }, MESSAGES.ENQUEUE_FAILED);
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
