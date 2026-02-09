import { logActivity } from "../activityLogger.js";

export const ownerAccountResolvers = {
  Query: {
    myOwnerAccounts: async (_, __, context) => {
      if (!context.userId) {
        throw new Error("Authentication required");
      }

      return context.prisma.ownerAccount.findMany({
        where: {
          members: {
            some: {
              userId: context.userId,
            },
          },
        },
        orderBy: {
          createdAt: "desc",
        },
      });
    },

    ownerAccount: async (_, { id }, context) => {
      const account = await context.prisma.ownerAccount.findFirst({
        where: {
          id,
          members: {
            some: {
              userId: context.userId,
            },
          },
        },
      });

      if (!account) {
        throw new Error("Owner account not found or access denied");
      }

      return account;
    },
  },

  Mutation: {
    createOwnerAccount: async (_, { name }, context) => {
      const account = await context.prisma.ownerAccount.create({
        data: {
          name,
          status: "PENDING",
          members: {
            create: {
              userId: context.userId,
              role: "PRIMARY",
            },
          },
        },
      });

      await logActivity(context.prisma, {
        entityType: "OwnerAccount",
        entityId: account.id,
        action: "CREATED",
        performedByUserId: context.userId,
        metadata: {
          name,
        },
      });

      return account;
    },

    updateOwnerAccount: async (_, { id, name }, context) => {
      const membership = await context.prisma.ownerAccountMember.findFirst({
        where: {
          ownerAccountId: id,
          userId: context.userId,
        },
      });

      if (!membership) {
        throw new Error("Not authorized to update this owner account");
      }

      const updated = await context.prisma.ownerAccount.update({
        where: { id },
        data: {
          name,
        },
      });

      await logActivity(context.prisma, {
        entityType: "OwnerAccount",
        entityId: id,
        action: "UPDATED",
        performedByUserId: context.userId,
        metadata: {
          name,
        },
      });

      return updated;
    },

    scheduleOwnerAccountDeletion: async (_, { id }, context) => {
      if (!context.isSuperAdmin) {
        throw new Error("Only super admin can delete owner accounts");
      }

      const deletionDate = new Date();
      deletionDate.setDate(deletionDate.getDate() + 30);

      await context.prisma.ownerAccount.update({
        where: { id },
        data: {
          status: "PENDING_DELETION",
          deletionScheduledAt: deletionDate,
        },
      });

      await logActivity(context.prisma, {
        entityType: "OwnerAccount",
        entityId: id,
        action: "DELETION_SCHEDULED",
        performedByUserId: context.userId,
        metadata: {
          deletionScheduledAt: deletionDate,
        },
      });

      return true;
    },
  },
};
