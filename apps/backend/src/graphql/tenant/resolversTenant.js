export const tenantResolvers = {
  Query: {
    tenantProfile: async (_, { id }, context) => {
      return context.prisma.tenantProfile.findUnique({
        where: { id },
      });
    },

    tenantProfilesByOwner: async (_, { ownerAccountId }, context) => {
      // Owner membership check
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
      // Owner creating tenant profile (implicit trust for now)
      return context.prisma.tenantProfile.create({
        data: {
          userId,
        },
      });
    },
  },
};
