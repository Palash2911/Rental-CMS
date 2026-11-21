import { z } from "zod";

import { cuidIdSchema } from "../../lib/validate.js";

export const tenancyExportSchema = z.object({ tenantAssignmentId: cuidIdSchema });
