import {
  ACCOUNT_STATUSES,
  requireHouseAccess,
  requireInvitationAccess,
  requireUser,
} from "../../lib/auth.js";
import { validate } from "../../lib/validate.js";
import {
  createInvitationSchema,
  invitationIdSchema,
  invitationsByHouseSchema,
  myInvitationsSchema,
} from "./schemasInvitation.js";
import * as invitationService from "./serviceInvitation.js";

const OWNER_READ = Object.freeze({
  statuses: ACCOUNT_STATUSES.MEMBER_TENANT_READ,
});

const OWNER_WRITE = Object.freeze({
  statuses: ACCOUNT_STATUSES.MEMBER_TENANT_WRITE,
});

export const invitationResolvers = {
  Query: {
    invitationsByHouse: async (_parent, args, context) => {
      await requireHouseAccess(context, args.houseId, OWNER_READ);
      const input = validate(invitationsByHouseSchema, args);
      return invitationService.listInvitationsByHouse(context, input);
    },

    myInvitations: async (_parent, args, context) => {
      const user = await requireUser(context);
      const input = validate(myInvitationsSchema, args);
      return invitationService.listMyInvitations(context, {
        ...input,
        actorEmail: user.email,
      });
    },
  },

  Mutation: {
    createInvitation: async (_parent, args, context) => {
      const { user } = await requireHouseAccess(
        context,
        args.input.houseId,
        OWNER_WRITE,
      );
      const { input } = validate(createInvitationSchema, args);
      return invitationService.createInvitation(context, {
        ...input,
        actorId: user.id,
      });
    },

    revokeInvitation: async (_parent, args, context) => {
      const { user, invitation } = await requireInvitationAccess(
        context,
        args.id,
        OWNER_WRITE,
      );
      validate(invitationIdSchema, args);
      return invitationService.revokeInvitation(context, {
        actorId: user.id,
        invitation,
      });
    },

    acceptInvitation: async (_parent, args, context) => {
      const user = await requireUser(context);
      const { id } = validate(invitationIdSchema, args);
      return invitationService.acceptInvitation(context, {
        actorId: user.id,
        actorEmail: user.email,
        id,
      });
    },

    declineInvitation: async (_parent, args, context) => {
      const user = await requireUser(context);
      const { id } = validate(invitationIdSchema, args);
      return invitationService.declineInvitation(context, {
        actorId: user.id,
        actorEmail: user.email,
        id,
      });
    },
  },
};
