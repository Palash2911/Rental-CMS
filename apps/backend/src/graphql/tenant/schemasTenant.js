import { z } from "zod";

import { paginationFields } from "../../lib/pagination.js";
import { cuidIdSchema } from "../../lib/validate.js";

export const tenantProfileIdSchema = z.object({ id: cuidIdSchema });

export const tenantProfilesByOwnerSchema = z.object({
  ownerAccountId: cuidIdSchema,
  ...paginationFields,
});
