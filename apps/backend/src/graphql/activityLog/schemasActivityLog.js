import { z } from "zod";

import { ENTITY_TYPES } from "../../lib/activity.js";
import { paginationFields } from "../../lib/pagination.js";
import { cuidIdSchema, userIdSchema } from "../../lib/validate.js";

const MESSAGES = Object.freeze({
  UNKNOWN_ENTITY_TYPE: "Unknown entity type.",
  ENTITY_ID_NEEDS_TYPE: "Filter by entity type when filtering by entity id.",
});

const entityTypeSchema = z.enum(Object.values(ENTITY_TYPES), {
  error: MESSAGES.UNKNOWN_ENTITY_TYPE,
});

export const activityLogByAccountSchema = z.object({
  ownerAccountId: cuidIdSchema,
  entityType: entityTypeSchema.nullish(),
  ...paginationFields,
});

// entityId only together with entityType, so the query always matches the
// (entityType, entityId, createdAt) index.
const adminFilterSchema = z
  .object({
    ownerAccountId: cuidIdSchema.nullish(),
    entityType: entityTypeSchema.nullish(),
    entityId: cuidIdSchema.nullish(),
    performedByUserId: userIdSchema.nullish(),
  })
  .refine((filter) => !filter.entityId || Boolean(filter.entityType), {
    message: MESSAGES.ENTITY_ID_NEEDS_TYPE,
    path: ["entityType"],
  });

export const adminActivityLogSchema = z.object({
  filter: adminFilterSchema.nullish(),
  ...paginationFields,
});
