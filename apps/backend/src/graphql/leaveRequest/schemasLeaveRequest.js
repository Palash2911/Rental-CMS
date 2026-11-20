import { z } from "zod";

import { LeaveRequestStatus } from "../../generated/prisma/enums.ts";
import { paginationFields } from "../../lib/pagination.js";
import { cuidIdSchema, parsedCalendarDateSchema } from "../../lib/validate.js";

const REASON_MAX_LENGTH = 1000;
const EXIT_DATE_BUFFER_DAYS = 1;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const MESSAGES = Object.freeze({
  EXIT_DATE_PAST: "The exit date cannot be in the past.",
});

// One day before the current UTC date, so "today" in a timezone behind UTC is never
// rejected once UTC has already moved on to the next day.
function earliestExitDate() {
  const now = new Date();
  const todayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  return todayUtc - EXIT_DATE_BUFFER_DAYS * MS_PER_DAY;
}

function isNotPast(date) {
  if (!(date instanceof Date)) {
    return true;
  }

  return date.getTime() >= earliestExitDate();
}

const exitDateSchema = parsedCalendarDateSchema.refine(isNotPast, MESSAGES.EXIT_DATE_PAST);

const statusSchema = z.enum(Object.values(LeaveRequestStatus));

export const leaveRequestIdSchema = z.object({ id: cuidIdSchema });

export const createLeaveRequestSchema = z.object({
  input: z.object({
    tenantAssignmentId: cuidIdSchema,
    requestedExitDate: exitDateSchema,
    reason: z.string().trim().min(1).max(REASON_MAX_LENGTH).nullish(),
  }),
});

export const giveNoticeSchema = z.object({
  tenantAssignmentId: cuidIdSchema,
  plannedExitDate: exitDateSchema,
});

export const withdrawNoticeSchema = z.object({ tenantAssignmentId: cuidIdSchema });

export const leaveRequestsByAssignmentSchema = z.object({
  tenantAssignmentId: cuidIdSchema,
  status: statusSchema.nullish(),
  ...paginationFields,
});

export const leaveRequestsByHouseSchema = z.object({
  houseId: cuidIdSchema,
  status: statusSchema.nullish(),
  ...paginationFields,
});
