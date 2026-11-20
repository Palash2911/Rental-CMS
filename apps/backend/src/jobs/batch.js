/** Accounts fetched per query by the per-account jobs. */
export const DEFAULT_BATCH_SIZE = 100;

export const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** What processing one account did. */
export const OUTCOMES = Object.freeze({
  DONE: "DONE",
  // No longer eligible once locked (for example paid or cancelled since the batch was read).
  SKIPPED: "SKIPPED",
  // Eligible but not done this run (a Stripe call failed); the next run retries it.
  DEFERRED: "DEFERRED",
});

const SUMMARY_FIELDS = Object.freeze({
  [OUTCOMES.DONE]: "done",
  [OUTCOMES.SKIPPED]: "skipped",
  [OUTCOMES.DEFERRED]: "deferred",
});

const FAILURE_MESSAGE = "Job failed for one owner account; continuing with the rest.";

/** `date` minus `days` whole days. */
export function daysBefore(date, days) {
  return new Date(date.getTime() - days * MS_PER_DAY);
}

/** `date` plus `days` whole days. */
export function daysAfter(date, days) {
  return new Date(date.getTime() + days * MS_PER_DAY);
}

/**
 * Runs `processAccount(ownerAccountId)` for every id `fetchBatch({ afterId, take })` returns,
 * in ascending keyset batches of `batchSize`. An account that throws is logged through `log`
 * and counted as failed; the run always continues with the rest. Returns
 * `{ job, processed, done, skipped, deferred, failed }`.
 */
export async function forEachAccount({ job, log, batchSize, fetchBatch, processAccount }) {
  const summary = { job, processed: 0, done: 0, skipped: 0, deferred: 0, failed: 0 };
  let afterId = null;

  for (;;) {
    const ids = await fetchBatch({ afterId, take: batchSize });

    // One account per transaction is the point of these jobs (a failure stays local), so
    // the per-account queries in this loop are intended.
    for (const ownerAccountId of ids) {
      summary.processed += 1;

      try {
        const outcome = await processAccount(ownerAccountId);
        summary[SUMMARY_FIELDS[outcome]] += 1;
      } catch (error) {
        summary.failed += 1;
        log.error({ err: error, job, ownerAccountId }, FAILURE_MESSAGE);
      }
    }

    if (ids.length < batchSize) {
      return summary;
    }

    afterId = ids.at(-1);
  }
}

/** The `where` fragment for keyset paging on an id column after `afterId`. */
export function afterIdFilter(field, afterId) {
  return afterId ? { [field]: { gt: afterId } } : {};
}
