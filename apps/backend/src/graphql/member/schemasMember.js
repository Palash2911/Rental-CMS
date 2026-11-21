import { z } from "zod";

import { InvitationStatus } from "../../generated/prisma/enums.ts";
import { paginationFields } from "../../lib/pagination.js";
import { cuidIdSchema } from "../../lib/validate.js";
import { normalisedEmailSchema } from "../invitation/schemasInvitation.js";

export const ownerAccountIdSchema = z.object({ ownerAccountId: cuidIdSchema });

export const memberInvitationIdSchema = z.object({ id: cuidIdSchema });

export const createMemberInvitationSchema = z.object({
  ownerAccountId: cuidIdSchema,
  email: normalisedEmailSchema,
});

export const removeMemberSchema = z.object({
  ownerAccountId: cuidIdSchema,
  memberId: cuidIdSchema,
});

export const transferOwnershipSchema = z.object({
  ownerAccountId: cuidIdSchema,
  newPrimaryMemberId: cuidIdSchema,
});

export const membersByAccountSchema = z.object({
  ownerAccountId: cuidIdSchema,
  ...paginationFields,
});

export const memberInvitationsByAccountSchema = z.object({
  ownerAccountId: cuidIdSchema,
  status: z.enum(Object.values(InvitationStatus)).nullish(),
  ...paginationFields,
});

export const myMemberInvitationsSchema = z.object(paginationFields);
