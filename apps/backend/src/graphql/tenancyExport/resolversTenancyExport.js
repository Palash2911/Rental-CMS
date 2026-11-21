import { ACCOUNT_STATUSES, requireAssignmentAccess } from "../../lib/auth.js";
import { validate } from "../../lib/validate.js";
import { tenancyExportSchema } from "./schemasTenancyExport.js";
import * as tenancyExportService from "./serviceTenancyExport.js";

// The tenant path only: owners read the same data through the per-list queries.
const TENANT_READ_ACCESS = Object.freeze({
  tenant: { statuses: ACCOUNT_STATUSES.TENANT_READ },
});

export const tenancyExportResolvers = {
  Query: {
    tenancyExport: async (_parent, args, context) => {
      await requireAssignmentAccess(context, args.tenantAssignmentId, TENANT_READ_ACCESS);
      const input = validate(tenancyExportSchema, args);
      return tenancyExportService.exportTenancy(context, input);
    },
  },
};
