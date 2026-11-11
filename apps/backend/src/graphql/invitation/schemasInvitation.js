import { z } from "zod";

import { InvitationStatus } from "../../generated/prisma/enums.ts";
import { paginationFields } from "../../lib/pagination.js";
import { calendarDateSchema, cuidIdSchema } from "../../lib/validate.js";

const EMAIL_MAX_LENGTH = 254;

const MESSAGES = Object.freeze({
  END_BEFORE_START: "The lease end date must be after the lease start date.",
});

function isEndAfterStart({ leaseStartDate, leaseEndDate }) {
  if (!(leaseStartDate instanceof Date) || !(leaseEndDate instanceof Date)) {
    return true;
  }

  return leaseEndDate.getTime() > leaseStartDate.getTime();
}

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
