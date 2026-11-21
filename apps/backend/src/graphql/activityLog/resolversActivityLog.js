import {
  ACCOUNT_STATUSES,
  requireOwnerMember,
  requireSuperAdmin,
  ROLES,
} from "../../lib/auth.js";
import { validate } from "../../lib/validate.js";
import {
  activityLogByAccountSchema,
  adminActivityLogSchema,
} from "./schemasActivityLog.js";
import * as activityLogService from "./serviceActivityLog.js";

export const activityLogResolvers = {
  Query: {
    activityLogByAccount: async (_parent, args, context) => {
      await requireOwnerMember(context, args.ownerAccountId, {
        roles: ROLES.ANY,
        statuses: ACCOUNT_STATUSES.MEMBER_ACCOUNT_READ,
      });
      const input = validate(activityLogByAccountSchema, args);
      return activityLogService.listActivityByAccount(context, input);
    },

    adminActivityLog: async (_parent, args, context) => {
      await requireSuperAdmin(context);
      const input = validate(adminActivityLogSchema, args);
      return activityLogService.listAdminActivity(context, input);
    },
  },
};
