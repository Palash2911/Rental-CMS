import {
  ACCOUNT_STATUSES,
  requireMemberInvitationAccess,
  requireOwnerMember,
  requireUser,
  ROLES,
} from "../../lib/auth.js";
import { validate } from "../../lib/validate.js";
import {
  createMemberInvitationSchema,
  memberInvitationIdSchema,
  memberInvitationsByAccountSchema,
  membersByAccountSchema,
  myMemberInvitationsSchema,
  ownerAccountIdSchema,
  removeMemberSchema,
  transferOwnershipSchema,
} from "./schemasMember.js";
import * as memberService from "./serviceMember.js";

const ANY_MEMBER_READ = Object.freeze({
  roles: ROLES.ANY,
  statuses: ACCOUNT_STATUSES.MEMBER_ACCOUNT_READ,
});

const PRIMARY_READ = Object.freeze({
  roles: ROLES.PRIMARY_ONLY,
  statuses: ACCOUNT_STATUSES.MEMBER_ACCOUNT_READ,
});

const PRIMARY_WRITE = Object.freeze({
  roles: ROLES.PRIMARY_ONLY,
  statuses: ACCOUNT_STATUSES.MEMBER_ACCOUNT_WRITE,
});

const ANY_MEMBER_WRITE = Object.freeze({
  roles: ROLES.ANY,
  statuses: ACCOUNT_STATUSES.MEMBER_ACCOUNT_WRITE,
});

export const memberResolvers = {
  Query: {
    membersByAccount: async (_parent, args, context) => {
      await requireOwnerMember(context, args.ownerAccountId, ANY_MEMBER_READ);
      const input = validate(membersByAccountSchema, args);
      return memberService.listMembersByAccount(context, input);
    },

    memberInvitationsByAccount: async (_parent, args, context) => {
      await requireOwnerMember(context, args.ownerAccountId, PRIMARY_READ);
      const input = validate(memberInvitationsByAccountSchema, args);
      return memberService.listMemberInvitationsByAccount(context, input);
    },

    myMemberInvitations: async (_parent, args, context) => {
      const user = await requireUser(context);
      const input = validate(myMemberInvitationsSchema, args);
      return memberService.listMyMemberInvitations(context, {
        ...input,
        actorEmail: user.email,
      });
    },
  },

  Mutation: {
    createMemberInvitation: async (_parent, args, context) => {
      const { user } = await requireOwnerMember(context, args.ownerAccountId, PRIMARY_WRITE);
      const input = validate(createMemberInvitationSchema, args);
      return memberService.createMemberInvitation(context, { ...input, actorId: user.id });
    },

    revokeMemberInvitation: async (_parent, args, context) => {
      const { user, invitation } = await requireMemberInvitationAccess(
        context,
        args.id,
        PRIMARY_WRITE,
      );
      validate(memberInvitationIdSchema, args);
      return memberService.revokeMemberInvitation(context, { actorId: user.id, invitation });
    },

    acceptMemberInvitation: async (_parent, args, context) => {
      const user = await requireUser(context);
      const { id } = validate(memberInvitationIdSchema, args);
      return memberService.acceptMemberInvitation(context, {
        actorId: user.id,
        actorEmail: user.email,
        id,
      });
    },

    declineMemberInvitation: async (_parent, args, context) => {
      const user = await requireUser(context);
      const { id } = validate(memberInvitationIdSchema, args);
      return memberService.declineMemberInvitation(context, {
        actorId: user.id,
        actorEmail: user.email,
        id,
      });
    },

    removeMember: async (_parent, args, context) => {
      const { user } = await requireOwnerMember(context, args.ownerAccountId, PRIMARY_WRITE);
      const input = validate(removeMemberSchema, args);
      return memberService.removeMember(context, { ...input, actorId: user.id });
    },

    leaveAccount: async (_parent, args, context) => {
      const { user } = await requireOwnerMember(context, args.ownerAccountId, ANY_MEMBER_WRITE);
      const input = validate(ownerAccountIdSchema, args);
      return memberService.leaveAccount(context, { ...input, actorId: user.id });
    },

    transferOwnership: async (_parent, args, context) => {
      const { user } = await requireOwnerMember(context, args.ownerAccountId, PRIMARY_WRITE);
      const input = validate(transferOwnershipSchema, args);
      return memberService.transferOwnership(context, { ...input, actorId: user.id });
    },
  },
};
