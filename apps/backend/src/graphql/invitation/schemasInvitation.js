import { z } from "zod";

import { InvitationStatus } from "../../generated/prisma/enums.ts";
import { paginationFields } from "../../lib/pagination.js";
import { cuidIdSchema } from "../../lib/validate.js";

const EMAIL_MAX_LENGTH = 254;
const LEASE_YEAR_RANGE = Object.freeze({ MIN: 2000, MAX: 2100 });
const UTC_MIDNIGHT_SUFFIX = "T00:00:00.000Z";
const YEAR_LENGTH = 4;

const MESSAGES = Object.freeze({
  INVALID_DATE: "Enter a valid calendar date as YYYY-MM-DD.",
  YEAR_OUT_OF_RANGE: `Lease dates must fall between ${LEASE_YEAR_RANGE.MIN} and ${LEASE_YEAR_RANGE.MAX}.`,
  END_BEFORE_START: "The lease end date must be after the lease start date.",
});

function toUtcMidnight(value) {
  return new Date(`${value}${UTC_MIDNIGHT_SUFFIX}`);
}

function isRealCalendarDate(value) {
  const date = toUtcMidnight(value);
  return !Number.isNaN(date.getTime()) && date.toISOString().startsWith(value);
}

function isYearInRange(value) {
  const year = Number(value.slice(0, YEAR_LENGTH));
  return year >= LEASE_YEAR_RANGE.MIN && year <= LEASE_YEAR_RANGE.MAX;
}

function isEndAfterStart({ leaseStartDate, leaseEndDate }) {
  if (!(leaseStartDate instanceof Date) || !(leaseEndDate instanceof Date)) {
    return true;
  }

  return leaseEndDate.getTime() > leaseStartDate.getTime();
}

const calendarDateSchema = z.iso
  .date({ error: MESSAGES.INVALID_DATE, abort: true })
  .refine(isRealCalendarDate, { message: MESSAGES.INVALID_DATE, abort: true })
  .refine(isYearInRange, MESSAGES.YEAR_OUT_OF_RANGE)
  .transform(toUtcMidnight);

/** Trimmed, lowercased email; invitations store and compare emails in this form. */
export const normalisedEmailSchema = z
  .string()
  .trim()
  .toLowerCase()
  .max(EMAIL_MAX_LENGTH)
  .pipe(z.email());

export const invitationIdSchema = z.object({ id: cuidIdSchema });

export const createInvitationSchema = z.object({
  input: z
    .object({
      houseId: cuidIdSchema,
      email: normalisedEmailSchema,
      leaseStartDate: calendarDateSchema,
      leaseEndDate: calendarDateSchema.nullish(),
    })
    .refine(isEndAfterStart, {
      message: MESSAGES.END_BEFORE_START,
      path: ["leaseEndDate"],
    }),
});

export const invitationsByHouseSchema = z.object({
  houseId: cuidIdSchema,
  status: z.enum(Object.values(InvitationStatus)).nullish(),
  ...paginationFields,
});

export const myInvitationsSchema = z.object(paginationFields);
