import { z } from "zod";

import { paginationFields } from "../../lib/pagination.js";
import { cuidIdSchema, parsedCalendarDateSchema } from "../../lib/validate.js";
import {
  RECEIPT_FILE_KEY_MAX_LENGTH,
  RECEIPT_FILE_KEY_PATTERN,
  RECEIPT_FILE_MAX_BYTES,
  RECEIPT_FILE_TYPES,
} from "./receiptFiles.js";

export const AMOUNT_CENTS_RANGE = Object.freeze({ MIN: 1, MAX: 10_000_000 });
export const DEFAULT_CURRENCY = "AUD";

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const NOTE_MAX_LENGTH = 500;
const PAID_AT_BUFFER_DAYS = 1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const MESSAGES = Object.freeze({
  CURRENCY: "Use a three-letter uppercase currency code, such as AUD.",
  PAID_AT_FUTURE: "The payment date cannot be in the future.",
  FILE_TYPE: "Upload a PDF, JPEG or PNG file.",
  FILE_SIZE: `The file must be between 1 byte and ${RECEIPT_FILE_MAX_BYTES / (1024 * 1024)} MB.`,
  FILE_KEY: "Invalid file key.",
});

const contentTypeSchema = z.enum(Object.keys(RECEIPT_FILE_TYPES), { error: MESSAGES.FILE_TYPE });

const sizeBytesSchema = z
  .number({ error: MESSAGES.FILE_SIZE })
  .int(MESSAGES.FILE_SIZE)
  .min(1, MESSAGES.FILE_SIZE)
  .max(RECEIPT_FILE_MAX_BYTES, MESSAGES.FILE_SIZE);

const fileKeySchema = z
  .string()
  .max(RECEIPT_FILE_KEY_MAX_LENGTH, MESSAGES.FILE_KEY)
  .regex(RECEIPT_FILE_KEY_PATTERN, MESSAGES.FILE_KEY);

// One day past the current UTC date, so a payment made "today" in a timezone ahead of UTC
// (Melbourne is UTC+11) is never rejected.
function latestPaidAt() {
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return todayUtc + PAID_AT_BUFFER_DAYS * MS_PER_DAY;
}

function isNotFuture(date) {
  if (!(date instanceof Date)) {
    return true;
  }

  return date.getTime() <= latestPaidAt();
}

const paidAtSchema = parsedCalendarDateSchema.refine(isNotFuture, MESSAGES.PAID_AT_FUTURE);

export const receiptIdSchema = z.object({ id: cuidIdSchema });

export const receiptFileUrlSchema = z.object({ receiptId: cuidIdSchema });

export const createReceiptSchema = z.object({
  input: z.object({
    tenantAssignmentId: cuidIdSchema,
    amountCents: z
      .number()
      .int()
      .min(AMOUNT_CENTS_RANGE.MIN)
      .max(AMOUNT_CENTS_RANGE.MAX),
    currency: z
      .string()
      .regex(CURRENCY_PATTERN, MESSAGES.CURRENCY)
      .nullish()
      .transform((value) => value ?? DEFAULT_CURRENCY),
    paidAt: paidAtSchema,
    note: z.string().trim().min(1).max(NOTE_MAX_LENGTH).nullish(),
    fileKey: fileKeySchema.nullish(),
  }),
});

export const requestReceiptUploadSchema = z.object({
  input: z.object({
    tenantAssignmentId: cuidIdSchema,
    contentType: contentTypeSchema,
    sizeBytes: sizeBytesSchema,
  }),
});

export const receiptsByAssignmentSchema = z.object({
  tenantAssignmentId: cuidIdSchema,
  ...paginationFields,
});
