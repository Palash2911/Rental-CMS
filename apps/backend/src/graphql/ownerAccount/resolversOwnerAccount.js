import {
  ACCOUNT_STATUSES,
  requireOwnerMember,
  requireSuperAdmin,
  requireUser,
  ROLES,
} from "../../lib/auth.js";
import { validate } from "../../lib/validate.js";
import {
  adminOwnerAccountsSchema,
  blockOwnerAccountSchema,
  createOwnerAccountSchema,
  myOwnerAccountsSchema,
  ownerAccountIdSchema,
  updateOwnerAccountSchema,
} from "./schemasOwnerAccount.js";
import * as ownerAccountService from "./serviceOwnerAccount.js";

const PRIMARY_DELETION_REQUEST = Object.freeze({
  roles: ROLES.PRIMARY_ONLY,
  statuses: ACCOUNT_STATUSES.MEMBER_ACCOUNT_WRITE,
});

const PRIMARY_DELETION_CANCEL = Object.freeze({
  roles: ROLES.PRIMARY_ONLY,
  statuses: ACCOUNT_STATUSES.MEMBER_DELETION_CANCEL,
});

export const ownerAccountResolvers = {
  Query: {
    myOwnerAccounts: async (_parent, args, context) => {
      const user = await requireUser(context);
      const input = validate(myOwnerAccountsSchema, args);
      return ownerAccountService.listMyOwnerAccounts(context, {
        ...input,
        actorId: user.id,
      });
    },

    ownerAccount: async (_parent, args, context) => {
      const { ownerAccount } = await requireOwnerMember(context, args.id, {
        statuses: ACCOUNT_STATUSES.MEMBER_ACCOUNT_READ,
      });
      validate(ownerAccountIdSchema, args);
      return ownerAccountService.toPublicOwnerAccount(ownerAccount);
    },

    adminOwnerAccounts: async (_parent, args, context) => {
      await requireSuperAdmin(context);
      const input = validate(adminOwnerAccountsSchema, args);
      return ownerAccountService.listAdminOwnerAccounts(context, input);
    },
  },

  Mutation: {
    createOwnerAccount: async (_parent, args, context) => {
      const user = await requireUser(context);
      const input = validate(createOwnerAccountSchema, args);
      return ownerAccountService.createOwnerAccount(context, {
        ...input,
        actorId: user.id,
      });
    },

    updateOwnerAccount: async (_parent, args, context) => {
      const { user } = await requireOwnerMember(context, args.id, {
        roles: ROLES.PRIMARY_ONLY,
        statuses: ACCOUNT_STATUSES.MEMBER_ACCOUNT_WRITE,
      });
      const input = validate(updateOwnerAccountSchema, args);
      return ownerAccountService.renameOwnerAccount(context, {
        ...input,
        actorId: user.id,
      });
    },

    scheduleOwnerAccountDeletion: async (_parent, args, context) => {
      const { user } = await requireOwnerMember(
        context,
        args.id,
        PRIMARY_DELETION_REQUEST,
      );
      const input = validate(ownerAccountIdSchema, args);
      return ownerAccountService.scheduleDeletionByOwner(context, {
        ...input,
        actorId: user.id,
      });
    },

    cancelOwnerAccountDeletion: async (_parent, args, context) => {
      const { user } = await requireOwnerMember(
        context,
        args.id,
        PRIMARY_DELETION_CANCEL,
      );
      const input = validate(ownerAccountIdSchema, args);
      return ownerAccountService.cancelDeletion(context, {
        ...input,
        actorId: user.id,
      });
    },

    approveOwnerAccount: async (_parent, args, context) => {
      const user = await requireSuperAdmin(context);
      const input = validate(ownerAccountIdSchema, args);
      return ownerAccountService.approveOwnerAccount(context, {
        ...input,
        actorId: user.id,
      });
    },

    blockOwnerAccount: async (_parent, args, context) => {
      const user = await requireSuperAdmin(context);
      const input = validate(blockOwnerAccountSchema, args);
      return ownerAccountService.blockOwnerAccount(context, {
        ...input,
        actorId: user.id,
      });
    },

    unblockOwnerAccount: async (_parent, args, context) => {
      const user = await requireSuperAdmin(context);
      const input = validate(ownerAccountIdSchema, args);
      return ownerAccountService.unblockOwnerAccount(context, {
        ...input,
        actorId: user.id,
      });
    },

    adminScheduleOwnerAccountDeletion: async (_parent, args, context) => {
      const user = await requireSuperAdmin(context);
      const input = validate(ownerAccountIdSchema, args);
      return ownerAccountService.scheduleDeletionByAdmin(context, {
        ...input,
        actorId: user.id,
      });
    },

    adminCancelOwnerAccountDeletion: async (_parent, args, context) => {
      const user = await requireSuperAdmin(context);
      const input = validate(ownerAccountIdSchema, args);
      return ownerAccountService.cancelDeletion(context, {
        ...input,
        actorId: user.id,
      });
    },
  },
};
