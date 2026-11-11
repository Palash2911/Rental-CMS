import { z } from "zod";

import { paginationFields } from "../../lib/pagination.js";
import { cuidIdSchema } from "../../lib/validate.js";

export const assignmentIdSchema = z.object({ id: cuidIdSchema });

export const assignmentsByHouseSchema = z.object({
  houseId: cuidIdSchema,
  ...paginationFields,
});

export const myAssignmentsSchema = z.object(paginationFields);
