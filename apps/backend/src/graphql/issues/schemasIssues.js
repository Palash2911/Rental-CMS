import { z } from "zod";

import { IssueStatus } from "../../generated/prisma/enums.ts";
import { paginationFields } from "../../lib/pagination.js";
import { cuidIdSchema } from "../../lib/validate.js";

const TITLE_MAX_LENGTH = 120;
const DESCRIPTION_MAX_LENGTH = 5000;

const statusSchema = z.enum(Object.values(IssueStatus));

export const issueIdSchema = z.object({ id: cuidIdSchema });

export const createIssueSchema = z.object({
  input: z.object({
    tenantAssignmentId: cuidIdSchema,
    title: z.string().trim().min(1).max(TITLE_MAX_LENGTH),
    description: z.string().trim().min(1).max(DESCRIPTION_MAX_LENGTH),
  }),
});

export const updateIssueStatusSchema = z.object({
  input: z.object({
    id: cuidIdSchema,
    status: statusSchema,
  }),
});

export const issuesByAssignmentSchema = z.object({
  tenantAssignmentId: cuidIdSchema,
  status: statusSchema.nullish(),
  ...paginationFields,
});

export const issuesByHouseSchema = z.object({
  houseId: cuidIdSchema,
  status: statusSchema.nullish(),
  ...paginationFields,
});
