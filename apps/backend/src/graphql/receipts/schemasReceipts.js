import { z } from "zod";

import { paginationFields } from "../../lib/pagination.js";
import { calendarDateSchema, cuidIdSchema } from "../../lib/validate.js";

export const AMOUNT_CENTS_RANGE = Object.freeze({ MIN: 1, MAX: 10_000_000 });
export const DEFAULT_CURRENCY = "AUD";

const CURRENCY_PATTERN = /^[A-Z]{3}$/;
const NOTE_MAX_LENGTH = 500;
const PAID_AT_BUFFER_DAYS = 1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const MESSAGES = Object.freeze({
  CURRENCY: "Use a three-letter uppercase currency code, such as AUD.",
  PAID_AT_FUTURE: "The payment date cannot be in the future.",
});

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

const paidAtSchema = calendarDateSchema.refine(isNotFuture, MESSAGES.PAID_AT_FUTURE);

export const receiptIdSchema = z.object({ id: cuidIdSchema });

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
  }),
});

export const receiptsByAssignmentSchema = z.object({
  tenantAssignmentId: cuidIdSchema,
  ...paginationFields,
});
