import {
  ACCOUNT_STATUSES,
  requireAssignmentAccess,
  requireHouseAccess,
  requireUser,
} from "../../lib/auth.js";
import { validate } from "../../lib/validate.js";
import {
  assignmentIdSchema,
  assignmentsByHouseSchema,
  myAssignmentsSchema,
} from "./schemasTenantAssignment.js";
import * as assignmentService from "./serviceTenantAssignment.js";

const READ_ACCESS = Object.freeze({
  owner: { statuses: ACCOUNT_STATUSES.MEMBER_TENANT_READ },
  tenant: { statuses: ACCOUNT_STATUSES.TENANT_READ },
});

const EXIT_ACCESS = Object.freeze({
  owner: { statuses: ACCOUNT_STATUSES.MEMBER_TENANT_WRITE },
});

export const tenantAssignmentResolvers = {
  Query: {
    tenantAssignment: async (_parent, args, context) => {
      const { assignment } = await requireAssignmentAccess(
        context,
        args.id,
        READ_ACCESS,
      );
      validate(assignmentIdSchema, args);
      return assignmentService.toPublicAssignment(assignment);
    },

    tenantAssignmentsByHouse: async (_parent, args, context) => {
      await requireHouseAccess(context, args.houseId, {
        statuses: ACCOUNT_STATUSES.MEMBER_TENANT_READ,
      });
      const input = validate(assignmentsByHouseSchema, args);
      return assignmentService.listAssignmentsByHouse(context, input);
    },

    myTenantAssignments: async (_parent, args, context) => {
      const user = await requireUser(context);
      const input = validate(myAssignmentsSchema, args);
      return assignmentService.listMyAssignments(context, {
        ...input,
        actorId: user.id,
        accountStatuses: ACCOUNT_STATUSES.TENANT_READ,
      });
    },
  },

  Mutation: {
    exitTenantAssignment: async (_parent, args, context) => {
      const { user, assignment } = await requireAssignmentAccess(
        context,
        args.id,
        EXIT_ACCESS,
      );
      const { id } = validate(assignmentIdSchema, args);
      return assignmentService.exitAssignment(context, {
        actorId: user.id,
        id,
        houseId: assignment.houseId,
      });
    },
  },
};
