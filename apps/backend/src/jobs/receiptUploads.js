import { DELETE_BATCH_SIZE } from "../storage/gateway.js";
import { DEFAULT_BATCH_SIZE } from "./batch.js";

export const RECEIPT_UPLOAD_VERIFY_JOB = "receiptUploadVerify";
export const RECEIPT_UPLOAD_CLEANUP_JOB = "receiptUploadCleanup";

/**
 * The hourly check looks at unattached uploads this old: the presigned PUT is valid for
 * 10 minutes, so by then no new bytes can arrive and the stored object is final.
 */
export const UPLOAD_VERIFY_AFTER_MINUTES = 15;

/** Uploads never attached to a receipt are deleted after this long. */
export const UNATTACHED_UPLOAD_RETENTION_HOURS = 24;

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;

const MESSAGES = Object.freeze({
  VERIFY_FAILED: "Receipt upload check failed for one upload; the next run retries it.",
  DELETE_FAILED: "Receipt upload deletion failed for one batch; the next run retries it.",
});

function minutesBefore(date, minutes) {
  return new Date(date.getTime() - minutes * MS_PER_MINUTE);
}

function hoursBefore(date, hours) {
  return new Date(date.getTime() - hours * MS_PER_HOUR);
}

// Compare-and-set on the row itself, the opposite of createReceipt's attach, so an upload
// is either attached or discarded, never both. Returns how many rows this call claimed.
async function claimForDeletion(prisma, ids, now) {
  if (ids.length === 0) {
    return 0;
  }

  const { count } = await prisma.receiptUpload.updateMany({
    where: { id: { in: ids }, attachedAt: null, discardedAt: null },
    data: { discardedAt: now },
  });

  return count;
}

/**
 * Deletes the objects of every discarded upload, then their rows, in batches. A storage
 * failure leaves the batch discarded (never attachable) for the next run. Returns the
 * number of uploads removed.
 */
async function purgeDiscarded({ prisma, storageGateway, log, job, batchSize }) {
  let removed = 0;
  let afterId = null;
  const take = Math.min(batchSize, DELETE_BATCH_SIZE);

  for (;;) {
    const rows = await prisma.receiptUpload.findMany({
      where: { discardedAt: { not: null }, attachedAt: null, ...(afterId ? { id: { gt: afterId } } : {}) },
      orderBy: { id: "asc" },
      take,
      select: { id: true, key: true },
    });

    if (rows.length === 0) {
      return removed;
    }

    afterId = rows.at(-1).id;

    try {
      await storageGateway.deleteObjects(rows.map(({ key }) => key));
      const { count } = await prisma.receiptUpload.deleteMany({
        where: { id: { in: rows.map(({ id }) => id) }, attachedAt: null, discardedAt: { not: null } },
      });
      removed += count;
    } catch (error) {
      log.warn({ err: error, job, uploads: rows.length }, MESSAGES.DELETE_FAILED);
    }

    if (rows.length < take) {
      return removed;
    }
  }
}

function matchesRequest(stored, upload) {
  return (
    stored !== null &&
    stored.contentType === upload.contentType &&
    stored.sizeBytes === upload.sizeBytes
  );
}

/**
 * Hourly. Checks every unattached, unchecked upload older than UPLOAD_VERIFY_AFTER_MINUTES
 * against its stored object (HeadObject): a match is marked verified, so it is not checked
 * again; a missing or mismatched object (wrong type or size) is discarded and deleted at
 * once, as is anything an earlier run discarded but could not delete. Each check is
 * independent: a storage error on one upload is logged and retried next hour.
 * Returns `{ job, checked, verified, discarded, removed, failed }`.
 */
export async function runReceiptUploadVerify(
  { prisma, storageGateway, log },
  { now = new Date(), batchSize = DEFAULT_BATCH_SIZE } = {},
) {
  const summary = { job: RECEIPT_UPLOAD_VERIFY_JOB, checked: 0, verified: 0, discarded: 0, removed: 0, failed: 0 };
  const cutoff = minutesBefore(now, UPLOAD_VERIFY_AFTER_MINUTES);
  let afterId = null;

  for (;;) {
    const uploads = await prisma.receiptUpload.findMany({
      where: {
        attachedAt: null,
        verifiedAt: null,
        discardedAt: null,
        createdAt: { lt: cutoff },
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      orderBy: { id: "asc" },
      take: batchSize,
      select: { id: true, key: true, contentType: true, sizeBytes: true },
    });

    // One HeadObject per upload is the point of this job: each result decides that row.
    for (const upload of uploads) {
      summary.checked += 1;

      try {
        const stored = await storageGateway.headObject(upload.key);

        if (matchesRequest(stored, upload)) {
          const { count } = await prisma.receiptUpload.updateMany({
            where: { id: upload.id, attachedAt: null, discardedAt: null, verifiedAt: null },
            data: { verifiedAt: now },
          });
          summary.verified += count;
        } else {
          summary.discarded += await claimForDeletion(prisma, [upload.id], now);
        }
      } catch (error) {
        summary.failed += 1;
        log.warn({ err: error, job: RECEIPT_UPLOAD_VERIFY_JOB, receiptUploadId: upload.id }, MESSAGES.VERIFY_FAILED);
      }
    }

    if (uploads.length < batchSize) {
      break;
    }

    afterId = uploads.at(-1).id;
  }

  summary.removed = await purgeDiscarded({
    prisma,
    storageGateway,
    log,
    job: RECEIPT_UPLOAD_VERIFY_JOB,
    batchSize,
  });

  return summary;
}

/**
 * Daily. Discards every upload still unattached UNATTACHED_UPLOAD_RETENTION_HOURS after it
 * was requested, then deletes the discarded objects and rows in batches. A storage failure
 * leaves the batch discarded for the next run. Idempotent.
 * Returns `{ job, discarded, removed }`.
 */
export async function runReceiptUploadCleanup(
  { prisma, storageGateway, log },
  { now = new Date(), batchSize = DEFAULT_BATCH_SIZE } = {},
) {
  const cutoff = hoursBefore(now, UNATTACHED_UPLOAD_RETENTION_HOURS);
  let discarded = 0;

  for (;;) {
    const rows = await prisma.receiptUpload.findMany({
      where: { attachedAt: null, discardedAt: null, createdAt: { lt: cutoff } },
      orderBy: { id: "asc" },
      take: batchSize,
      select: { id: true },
    });

    discarded += await claimForDeletion(prisma, rows.map(({ id }) => id), now);

    if (rows.length < batchSize) {
      break;
    }
  }

  const removed = await purgeDiscarded({
    prisma,
    storageGateway,
    log,
    job: RECEIPT_UPLOAD_CLEANUP_JOB,
    batchSize,
  });

  return { job: RECEIPT_UPLOAD_CLEANUP_JOB, discarded, removed };
}
