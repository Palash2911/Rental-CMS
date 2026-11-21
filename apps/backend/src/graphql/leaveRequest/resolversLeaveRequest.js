import {
  ACCOUNT_STATUSES,
  requireAssignmentAccess,
  requireHouseAccess,
  requireLeaveRequestAccess,
  ROLES,
} from "../../lib/auth.js";
import { validate } from "../../lib/validate.js";
import {
  createLeaveRequestSchema,
  giveNoticeSchema,
  leaveRequestIdSchema,
  leaveRequestsByAssignmentSchema,
  leaveRequestsByHouseSchema,
  withdrawNoticeSchema,
} from "./schemasLeaveRequest.js";
import * as leaveRequestService from "./serviceLeaveRequest.js";

const READ_ACCESS = Object.freeze({
  owner: { statuses: ACCOUNT_STATUSES.MEMBER_TENANT_READ },
  tenant: { statuses: ACCOUNT_STATUSES.TENANT_READ },
});

const TENANT_WRITE_ACCESS = Object.freeze({
  tenant: { statuses: ACCOUNT_STATUSES.TENANT_WRITE },
});

const OWNER_WRITE_ACCESS = Object.freeze({
  owner: { roles: ROLES.ANY, statuses: ACCOUNT_STATUSES.MEMBER_TENANT_WRITE },
});

export const leaveRequestResolvers = {
  Query: {
    leaveRequestsByAssignment: async (_parent, args, context) => {
      await requireAssignmentAccess(context, args.tenantAssignmentId, READ_ACCESS);
      const input = validate(leaveRequestsByAssignmentSchema, args);
      return leaveRequestService.listLeaveRequestsByAssignment(context, input);
    },

    // owners only
    leaveRequestsByHouse: async (_parent, args, context) => {
      await requireHouseAccess(context, args.houseId, {
        statuses: ACCOUNT_STATUSES.MEMBER_TENANT_READ,
      });
      const input = validate(leaveRequestsByHouseSchema, args);
      return leaveRequestService.listLeaveRequestsByHouse(context, input);
    },
  },

  Mutation: {
    createLeaveRequest: async (_parent, args, context) => {
      const { user, assignment, ownerAccount } = await requireAssignmentAccess(
        context,
        args.input.tenantAssignmentId,
        TENANT_WRITE_ACCESS,
      );
      const { input } = validate(createLeaveRequestSchema, args);
      return leaveRequestService.createLeaveRequest(context, {
        ...input,
        houseId: assignment.houseId,
        actorId: user.id,
        ownerAccountId: ownerAccount.id,
      });
    },

    withdrawLeaveRequest: async (_parent, args, context) => {
      const { user, leaveRequest, ownerAccount } = await requireLeaveRequestAccess(
        context,
        args.id,
        TENANT_WRITE_ACCESS,
      );
      const { id } = validate(leaveRequestIdSchema, args);
      return leaveRequestService.withdrawLeaveRequest(context, {
        actorId: user.id,
        ownerAccountId: ownerAccount.id,
        id,
        houseId: leaveRequest.houseId,
      });
    },

    approveLeaveRequest: async (_parent, args, context) => {
      const { user, leaveRequest, ownerAccount } = await requireLeaveRequestAccess(
        context,
        args.id,
        OWNER_WRITE_ACCESS,
      );
      const { id } = validate(leaveRequestIdSchema, args);
      return leaveRequestService.approveLeaveRequest(context, {
        actorId: user.id,
        ownerAccountId: ownerAccount.id,
        id,
        houseId: leaveRequest.houseId,
      });
    },

    rejectLeaveRequest: async (_parent, args, context) => {
      const { user, leaveRequest, ownerAccount } = await requireLeaveRequestAccess(
        context,
        args.id,
        OWNER_WRITE_ACCESS,
      );
      const { id } = validate(leaveRequestIdSchema, args);
      return leaveRequestService.rejectLeaveRequest(context, {
        actorId: user.id,
        ownerAccountId: ownerAccount.id,
        id,
        houseId: leaveRequest.houseId,
      });
    },

    giveNotice: async (_parent, args, context) => {
      const { user, assignment, ownerAccount } = await requireAssignmentAccess(
        context,
        args.tenantAssignmentId,
        OWNER_WRITE_ACCESS,
      );
      const input = validate(giveNoticeSchema, args);
      return leaveRequestService.giveNotice(context, {
        ...input,
        houseId: assignment.houseId,
        actorId: user.id,
        ownerAccountId: ownerAccount.id,
      });
    },

    withdrawNotice: async (_parent, args, context) => {
      const { user, assignment, ownerAccount } = await requireAssignmentAccess(
        context,
        args.tenantAssignmentId,
        OWNER_WRITE_ACCESS,
      );
      const input = validate(withdrawNoticeSchema, args);
      return leaveRequestService.withdrawNotice(context, {
        ...input,
        houseId: assignment.houseId,
        actorId: user.id,
        ownerAccountId: ownerAccount.id,
      });
    },
  },
};
