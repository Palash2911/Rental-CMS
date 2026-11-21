import { randomUUID } from "node:crypto";

/** Content types a receipt file may have, with the file extension its key gets. */
export const RECEIPT_FILE_TYPES = Object.freeze({
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
});

/** Largest receipt file accepted: 10 MB. */
export const RECEIPT_FILE_MAX_BYTES = 10 * 1024 * 1024;

/** How long a presigned upload URL is valid. */
export const UPLOAD_URL_TTL_SECONDS = 10 * 60;

/** How long a presigned download URL is valid. */
export const DOWNLOAD_URL_TTL_SECONDS = 5 * 60;

/** Unattached uploads an assignment may hold at once, so storage cannot be filled with orphans. */
export const MAX_PENDING_UPLOADS_PER_ASSIGNMENT = 20;

const KEY_ROOT = "receipts";
const KEY_SEPARATOR = "/";
const EXTENSION_SEPARATOR = ".";
const CUID_PART = "[cC][0-9a-z]{6,}";
const UUID_PART = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const EXTENSION_PART = `(${Object.values(RECEIPT_FILE_TYPES).join("|")})`;

/** The shape of every receipt file key: receipts/<ownerAccountId>/<tenantAssignmentId>/<uuid>.<ext>. */
export const RECEIPT_FILE_KEY_PATTERN = new RegExp(
  `^${KEY_ROOT}/${CUID_PART}/${CUID_PART}/${UUID_PART}\\.${EXTENSION_PART}$`,
);

export const RECEIPT_FILE_KEY_MAX_LENGTH = 200;

/** The prefix holding every receipt file of an owner account, ending with "/". */
export function accountFilePrefix(ownerAccountId) {
  return `${KEY_ROOT}${KEY_SEPARATOR}${ownerAccountId}${KEY_SEPARATOR}`;
}

/** The prefix holding every receipt file of one assignment, ending with "/". */
export function assignmentFilePrefix(ownerAccountId, tenantAssignmentId) {
  return `${accountFilePrefix(ownerAccountId)}${tenantAssignmentId}${KEY_SEPARATOR}`;
}

/** A new, unguessable key under the assignment's prefix, with the content type's extension. */
export function newReceiptFileKey({ ownerAccountId, tenantAssignmentId, contentType }) {
  const extension = RECEIPT_FILE_TYPES[contentType];
  return `${assignmentFilePrefix(ownerAccountId, tenantAssignmentId)}${randomUUID()}${EXTENSION_SEPARATOR}${extension}`;
}
