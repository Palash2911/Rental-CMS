import { logActivity } from "../activityLogger.js";

export const tenantResolvers = {
  Query: {
    tenantProfile: async (_, { id }, context) => {
      return context.prisma.tenantProfile.findUnique({
        where: { id },
      });
    },

    tenantProfilesByOwner: async (_, { ownerAccountId }, context) => {
      const membership = await context.prisma.ownerAccountMember.findFirst({
        where: {
          ownerAccountId,
          userId: context.userId,
        },
      });

      if (!membership) {
        throw new Error("Not authorized to view tenants for this owner");
      }

      return context.prisma.tenantProfile.findMany({
        where: {
          assignments: {
            some: {
              house: {
                ownerAccountId,
              },
            },
          },
        },
      });
    },
  },

  Mutation: {
    createTenantProfile: async (_, { userId }, context) => {
      const tenantProfile = await context.prisma.tenantProfile.create({
        data: {
          userId,
        },
      });

      await logActivity(context.prisma, {
        entityType: "TenantProfile",
        entityId: tenantProfile.id,
        action: "CREATED",
        performedByUserId: context.userId,
        metadata: {
          userId,
        },
      });

      return tenantProfile;
    },
  },
};
