import { z } from "zod";

import { OwnerAccountStatus } from "../../generated/prisma/enums.ts";
import { paginationFields } from "../../lib/pagination.js";
import { cuidIdSchema } from "../../lib/validate.js";

const OWNER_ACCOUNT_NAME_MAX_LENGTH = 100;
const BLOCK_REASON_MAX_LENGTH = 500;

const nameSchema = z.string().trim().min(1).max(OWNER_ACCOUNT_NAME_MAX_LENGTH);

export const myOwnerAccountsSchema = z.object(paginationFields);

export const adminOwnerAccountsSchema = z.object({
  status: z.enum(Object.values(OwnerAccountStatus)).nullish(),
  ...paginationFields,
});

export const ownerAccountIdSchema = z.object({ id: cuidIdSchema });

export const createOwnerAccountSchema = z.object({ name: nameSchema });

export const updateOwnerAccountSchema = z.object({
  id: cuidIdSchema,
  name: nameSchema,
});

export const blockOwnerAccountSchema = z.object({
  id: cuidIdSchema,
  reason: z.string().trim().min(1).max(BLOCK_REASON_MAX_LENGTH).nullish(),
});
