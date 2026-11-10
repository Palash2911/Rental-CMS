import { z } from "zod";

import { paginationFields } from "../../lib/pagination.js";
import { cuidIdSchema } from "../../lib/validate.js";

export const MAX_TENANTS_RANGE = Object.freeze({ MIN: 1, MAX: 50 });

const HOUSE_NAME_MAX_LENGTH = 100;
const HOUSE_LOCATION_MAX_LENGTH = 200;
const NOTHING_TO_UPDATE_MESSAGE = "Provide at least one field to update.";
const UPDATABLE_FIELDS = Object.freeze(["name", "location", "maxTenants", "inactive"]);

const nameSchema = z.string().trim().min(1).max(HOUSE_NAME_MAX_LENGTH);
const locationSchema = z.string().trim().min(1).max(HOUSE_LOCATION_MAX_LENGTH);
const maxTenantsSchema = z
  .number()
  .int()
  .min(MAX_TENANTS_RANGE.MIN)
  .max(MAX_TENANTS_RANGE.MAX);

export const housesSchema = z.object({
  ownerAccountId: cuidIdSchema,
  ...paginationFields,
});

export const houseIdSchema = z.object({ id: cuidIdSchema });

export const createHouseSchema = z.object({
  input: z.object({
    ownerAccountId: cuidIdSchema,
    name: nameSchema,
    location: locationSchema,
    maxTenants: maxTenantsSchema,
  }),
});

export const updateHouseSchema = z.object({
  input: z
    .object({
      id: cuidIdSchema,
      name: nameSchema.nullish(),
      location: locationSchema.nullish(),
      maxTenants: maxTenantsSchema.nullish(),
      inactive: z.boolean().nullish(),
    })
    .refine(
      (input) => UPDATABLE_FIELDS.some((field) => input[field] != null),
      NOTHING_TO_UPDATE_MESSAGE,
    ),
});
