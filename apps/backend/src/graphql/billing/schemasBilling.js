import { z } from "zod";

import { BillingInterval, BillingPlan } from "../../generated/prisma/enums.ts";
import { cuidIdSchema } from "../../lib/validate.js";

export const startCheckoutSchema = z.object({
  ownerAccountId: cuidIdSchema,
  plan: z.enum(Object.values(BillingPlan)),
  interval: z.enum(Object.values(BillingInterval)),
});

export const billingAccountIdSchema = z.object({ ownerAccountId: cuidIdSchema });
