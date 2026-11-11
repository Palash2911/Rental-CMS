import {
  ACCOUNT_STATUSES,
  requireOwnerMember,
  requireTenantProfileAccess,
} from "../../lib/auth.js";
import { validate } from "../../lib/validate.js";
import {
  tenantProfileIdSchema,
  tenantProfilesByOwnerSchema,
} from "./schemasTenant.js";
import * as tenantService from "./serviceTenant.js";

export const tenantResolvers = {
  Query: {
    tenantProfile: async (_parent, args, context) => {
      const { profile } = await requireTenantProfileAccess(context, args.id, {
        owner: { statuses: ACCOUNT_STATUSES.MEMBER_TENANT_READ },
      });
      validate(tenantProfileIdSchema, args);
      return tenantService.toPublicProfile(profile);
    },

    tenantProfilesByOwner: async (_parent, args, context) => {
      await requireOwnerMember(context, args.ownerAccountId, {
        statuses: ACCOUNT_STATUSES.MEMBER_TENANT_READ,
      });
      const input = validate(tenantProfilesByOwnerSchema, args);
      return tenantService.listProfilesByOwner(context, input);
    },
  },
};
