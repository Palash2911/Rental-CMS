import {
  ACTIVITY_ACTIONS,
  ENTITY_TYPES,
  logActivity,
} from "../../lib/activity.js";
import {
  BadUserInputError,
  ConflictError,
  isRecordNotFound,
  isUniqueViolation,
} from "../../lib/errors.js";
import { buildPageQuery, toPage } from "../../lib/pagination.js";
import { shareLockHouse } from "../house/serviceHouse.js";
import {
  lockActiveAssignment,
  toCalendarDate,
} from "../tenantAssignment/serviceTenantAssignment.js";
import {
  assignmentFilePrefix,
  DOWNLOAD_URL_TTL_SECONDS,
  MAX_PENDING_UPLOADS_PER_ASSIGNMENT,
  newReceiptFileKey,
  UPLOAD_URL_TTL_SECONDS,
} from "./receiptFiles.js";

const MS_PER_SECOND = 1000;

export const RECEIPT_SELECT = Object.freeze({
  id: true,
  tenantAssignmentId: true,
  amountCents: true,
  currency: true,
  paidAt: true,
  note: true,
  receiptUploadId: true,
  createdAt: true,
});

const UPLOAD_SELECT = Object.freeze({
  id: true,
  key: true,
  ownerAccountId: true,
  tenantAssignmentId: true,
  contentType: true,
  sizeBytes: true,
  attachedAt: true,
  discardedAt: true,
});

const MESSAGES = Object.freeze({
  TOO_MANY_PENDING_UPLOADS:
    "This tenant assignment has too many files waiting to be attached. Attach or wait for them to expire.",
  FILE_NOT_FOUND: "The uploaded file was not found. Request a new upload.",
  FILE_NOT_FOR_ASSIGNMENT: "This file does not belong to this tenant assignment.",
  FILE_MISMATCH: "The uploaded file does not match the requested type or size.",
  FILE_ALREADY_ATTACHED: "This file is already attached to a receipt.",
});

const FILE_KEY_PATH = "input.fileKey";

function fileError(message) {
  return new BadUserInputError(message, { fieldErrors: [{ path: FILE_KEY_PATH, message }] });
}

/** Converts a Receipt row to the client shape. fileUrl and the storage key are never exposed. */
export function toPublicReceipt(receipt) {
  return {
    id: receipt.id,
    tenantAssignmentId: receipt.tenantAssignmentId,
    amountCents: receipt.amountCents,
    currency: receipt.currency,
    paidAt: toCalendarDate(receipt.paidAt),
    note: receipt.note,
    hasFile: receipt.receiptUploadId != null,
    createdAt: receipt.createdAt.toISOString(),
  };
}

/** Lists an assignment's receipts, newest recorded first. */
export async function listReceiptsByAssignment(
  context,
  { tenantAssignmentId, first, after },
) {
  const page = buildPageQuery({ first, after });

  const rows = await context.prisma.receipt.findMany({
    where: { AND: [{ tenantAssignmentId }, page.where] },
    orderBy: page.orderBy,
    take: page.take,
    select: RECEIPT_SELECT,
  });

  return toPage(rows, first, toPublicReceipt);
}

async function assertPendingUploadCapacity(tx, tenantAssignmentId) {
  const pending = await tx.receiptUpload.count({
    where: { tenantAssignmentId, attachedAt: null, discardedAt: null },
  });

  if (pending >= MAX_PENDING_UPLOADS_PER_ASSIGNMENT) {
    throw new ConflictError(MESSAGES.TOO_MANY_PENDING_UPLOADS);
  }
}

/**
 * Records a requested upload on an ACTIVE or NOTICE_PERIOD assignment and returns a
 * presigned PUT locked to the content type and exact size. Lock order House, then
 * TenantAssignment, as in createIssue. Throws ConflictError when the assignment is no
 * longer active or holds MAX_PENDING_UPLOADS_PER_ASSIGNMENT unattached uploads.
 */
// The presigned URL is signed locally (no network call), so it is made after the commit.
export async function requestReceiptUpload(
  context,
  { actorId, ownerAccountId, houseId, tenantAssignmentId, contentType, sizeBytes },
) {
  const key = newReceiptFileKey({ ownerAccountId, tenantAssignmentId, contentType });

  const upload = await context.prisma.$transaction(async (tx) => {
    await shareLockHouse(tx, houseId);
    await lockActiveAssignment(tx, tenantAssignmentId);
    await assertPendingUploadCapacity(tx, tenantAssignmentId);

    const created = await tx.receiptUpload.create({
      data: {
        key,
        ownerAccountId,
        tenantAssignmentId,
        requestedByUserId: actorId,
        contentType,
        sizeBytes,
      },
      select: { id: true, createdAt: true },
    });

    await logActivity(tx, {
      entityType: ENTITY_TYPES.RECEIPT_UPLOAD,
      entityId: created.id,
      action: ACTIVITY_ACTIONS.UPLOAD_REQUESTED,
      ownerAccountId,
      performedByUserId: actorId,
      metadata: { tenantAssignmentId, contentType, sizeBytes },
    });

    return created;
  });

  const uploadUrl = await context.storageGateway.presignUpload({
    key,
    contentType,
    sizeBytes,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
  });

  return {
    uploadUrl,
    fileKey: key,
    contentType,
    sizeBytes,
    expiresAt: new Date(
      upload.createdAt.getTime() + UPLOAD_URL_TTL_SECONDS * MS_PER_SECOND,
    ).toISOString(),
  };
}

function assertUploadUsable(upload, { ownerAccountId, tenantAssignmentId, fileKey }) {
  if (!upload || upload.discardedAt) {
    throw fileError(MESSAGES.FILE_NOT_FOUND);
  }

  const prefix = assignmentFilePrefix(ownerAccountId, tenantAssignmentId);

  if (
    upload.tenantAssignmentId !== tenantAssignmentId ||
    upload.ownerAccountId !== ownerAccountId ||
    !fileKey.startsWith(prefix)
  ) {
    throw fileError(MESSAGES.FILE_NOT_FOR_ASSIGNMENT);
  }

  if (upload.attachedAt) {
    throw new ConflictError(MESSAGES.FILE_ALREADY_ATTACHED);
  }
}

// Network call, before the transaction (no lock is held while storage answers).
async function assertStoredObjectMatches(storageGateway, upload) {
  const stored = await storageGateway.headObject(upload.key);

  if (!stored) {
    throw fileError(MESSAGES.FILE_NOT_FOUND);
  }

  if (stored.contentType !== upload.contentType || stored.sizeBytes !== upload.sizeBytes) {
    throw fileError(MESSAGES.FILE_MISMATCH);
  }
}

/**
 * Checks `fileKey` against its upload record and the stored object before any write.
 * Returns the upload, or null when no file is given. Throws BadUserInputError for a
 * missing, foreign, expired or mismatched file and ConflictError when already attached.
 */
async function loadAttachableUpload(context, { ownerAccountId, tenantAssignmentId, fileKey }) {
  if (!fileKey) {
    return null;
  }

  const upload = await context.prisma.receiptUpload.findUnique({
    where: { key: fileKey },
    select: UPLOAD_SELECT,
  });

  assertUploadUsable(upload, { ownerAccountId, tenantAssignmentId, fileKey });
  await assertStoredObjectMatches(context.storageGateway, upload);

  return upload;
}

// Compare-and-set on the upload row itself: the cleanup jobs claim it with the opposite
// condition, so exactly one side wins even when both run at once.
async function markAttached(tx, uploadId, now) {
  try {
    await tx.receiptUpload.update({
      where: { id: uploadId, attachedAt: null, discardedAt: null },
      data: { attachedAt: now },
      select: { id: true },
    });
  } catch (error) {
    if (!isRecordNotFound(error)) {
      throw error;
    }

    const current = await tx.receiptUpload.findUnique({
      where: { id: uploadId },
      select: { attachedAt: true },
    });

    throw current?.attachedAt
      ? new ConflictError(MESSAGES.FILE_ALREADY_ATTACHED)
      : fileError(MESSAGES.FILE_NOT_FOUND);
  }
}

async function insertReceipt(tx, data) {
  try {
    return await tx.receipt.create({ data, select: RECEIPT_SELECT });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(MESSAGES.FILE_ALREADY_ATTACHED);
    }

    throw error;
  }
}

/**
 * Records an immutable receipt on an ACTIVE or NOTICE_PERIOD assignment and logs it, in one
 * transaction, optionally with an uploaded file. The file is checked first (record, prefix,
 * stored type and size), then claimed by compare-and-set inside the transaction.
 * Throws ConflictError when the assignment is no longer active or the file is already
 * attached, and BadUserInputError for any file mismatch.
 */
export async function createReceipt(
  context,
  { actorId, ownerAccountId, houseId, tenantAssignmentId, amountCents, currency, paidAt, note, fileKey },
) {
  const upload = await loadAttachableUpload(context, {
    ownerAccountId,
    tenantAssignmentId,
    fileKey,
  });

  return context.prisma.$transaction(async (tx) => {
    // House first keeps the lock order House, TenantAssignment, ReceiptUpload, and makes a
    // file attach wait for (or block) the account deletion job's House FOR UPDATE.
    if (upload) {
      await shareLockHouse(tx, houseId);
    }

    await lockActiveAssignment(tx, tenantAssignmentId);

    if (upload) {
      await markAttached(tx, upload.id, new Date());
    }

    const receipt = await insertReceipt(tx, {
      tenantAssignmentId,
      amountCents,
      currency,
      paidAt,
      note: note ?? null,
      receiptUploadId: upload?.id ?? null,
    });

    await logActivity(tx, {
      entityType: ENTITY_TYPES.RECEIPT,
      entityId: receipt.id,
      action: ACTIVITY_ACTIONS.CREATED,
      ownerAccountId,
      performedByUserId: actorId,
      metadata: {
        tenantAssignmentId,
        amountCents,
        currency,
        paidAt: toCalendarDate(receipt.paidAt),
        ...(upload
          ? { receiptUploadId: upload.id, contentType: upload.contentType, sizeBytes: upload.sizeBytes }
          : {}),
      },
    });

    return toPublicReceipt(receipt);
  });
}

/** A presigned GET for the receipt's file, valid DOWNLOAD_URL_TTL_SECONDS, or null without one. */
export async function receiptFileUrl(context, { receiptId }) {
  const row = await context.prisma.receipt.findUnique({
    where: { id: receiptId },
    select: { receiptUpload: { select: { key: true } } },
  });

  if (!row?.receiptUpload) {
    return null;
  }

  const issuedAt = Date.now();
  const url = await context.storageGateway.presignDownload({
    key: row.receiptUpload.key,
    expiresInSeconds: DOWNLOAD_URL_TTL_SECONDS,
  });

  return {
    url,
    expiresAt: new Date(issuedAt + DOWNLOAD_URL_TTL_SECONDS * MS_PER_SECOND).toISOString(),
  };
}
