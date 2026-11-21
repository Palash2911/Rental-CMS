import { ACCOUNT_DELETION_JOB, runAccountDeletion } from "./accountDeletion.js";
import { BILLING_GRACE_JOB, runBillingGrace } from "./billingGrace.js";
import { CLEANUP_JOB, runCleanup } from "./cleanup.js";
import {
  RECEIPT_UPLOAD_CLEANUP_JOB,
  RECEIPT_UPLOAD_VERIFY_JOB,
  runReceiptUploadCleanup,
  runReceiptUploadVerify,
} from "./receiptUploads.js";

/** The one BullMQ queue the maintenance jobs share. */
export const MAINTENANCE_QUEUE = "maintenance";

const SCHEDULE_TIMEZONE = "UTC";

// Daily, an hour apart, in this order: an account scheduled by billingGrace is due only
// DELETION_GRACE_DAYS later, so the order is for log readability, not correctness.
export const JOB_SCHEDULES = Object.freeze([
  Object.freeze({ name: BILLING_GRACE_JOB, pattern: "0 2 * * *" }),
  Object.freeze({ name: ACCOUNT_DELETION_JOB, pattern: "0 3 * * *" }),
  Object.freeze({ name: CLEANUP_JOB, pattern: "0 4 * * *" }),
  Object.freeze({ name: RECEIPT_UPLOAD_CLEANUP_JOB, pattern: "0 5 * * *" }),
  // The one hourly job: unattached receipt uploads are checked soon after their URL expires.
  Object.freeze({ name: RECEIPT_UPLOAD_VERIFY_JOB, pattern: "15 * * * *" }),
]);

// Every job is idempotent and runs again tomorrow, so a failed run is not retried in place.
const JOB_OPTIONS = Object.freeze({
  attempts: 1,
  removeOnComplete: { count: 100 },
  removeOnFail: { count: 500 },
});

const RUNNERS = Object.freeze({
  [BILLING_GRACE_JOB]: runBillingGrace,
  [ACCOUNT_DELETION_JOB]: runAccountDeletion,
  [CLEANUP_JOB]: runCleanup,
  [RECEIPT_UPLOAD_CLEANUP_JOB]: runReceiptUploadCleanup,
  [RECEIPT_UPLOAD_VERIFY_JOB]: runReceiptUploadVerify,
});

/**
 * Creates or updates one job scheduler per entry in JOB_SCHEDULES, keyed by the job name,
 * and removes schedulers for names no longer listed. A scheduler id is stored once in Redis,
 * so however many workers call this, each job is enqueued once per tick.
 */
export async function registerJobSchedulers(queue) {
  const names = new Set(JOB_SCHEDULES.map(({ name }) => name));

  for (const { name, pattern } of JOB_SCHEDULES) {
    await queue.upsertJobScheduler(
      name,
      { pattern, tz: SCHEDULE_TIMEZONE },
      { name, opts: JOB_OPTIONS },
    );
  }

  for (const scheduler of await queue.getJobSchedulers()) {
    if (!names.has(scheduler.key)) {
      await queue.removeJobScheduler(scheduler.key);
    }
  }
}

/**
 * Returns the BullMQ processor: runs the job service named by `job.name` with
 * `dependencies` (`{ prisma, billingGateway, storageGateway, notifier, log }`), logs and returns its summary.
 * Throws for an unknown job name, which BullMQ records as a failed job.
 */
export function createJobProcessor(dependencies) {
  return async function processJob(job) {
    const run = RUNNERS[job.name];

    if (!run) {
      throw new Error(`Unknown maintenance job: ${job.name}`);
    }

    const summary = await run(dependencies);
    dependencies.log.info({ ...summary, jobId: job.id }, "Maintenance job finished.");
    return summary;
  };
}
