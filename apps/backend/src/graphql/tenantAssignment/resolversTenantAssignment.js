export const tenantAssignmentResolvers = {
  Query: {
    tenantAssignmentsByHouse: async (_, { houseId }, context) => {
      const house = await context.prisma.house.findFirst({
        where: {
          id: houseId,
          ownerAccount: {
            members: {
              some: { userId: context.userId },
            },
          },
        },
      });

      if (!house) {
        throw new Error("Not authorized to view tenants for this house");
      }

      return context.prisma.tenantAssignment.findMany({
        where: { houseId },
        orderBy: { createdAt: "desc" },
      });
    },

    tenantAssignment: async (_, { id }, context) => {
      return context.prisma.tenantAssignment.findFirst({
        where: {
          id,
          house: {
            ownerAccount: {
              members: {
                some: { userId: context.userId },
              },
            },
          },
        },
      });
    },
  },

  Mutation: {
    createTenantAssignment: async (
      _,
      { tenantProfileId, houseId, leaseStartDate },
      context,
    ) => {
      // Ownership check via house
      const house = await context.prisma.house.findFirst({
        where: {
          id: houseId,
          ownerAccount: {
            members: {
              some: { userId: context.userId },
            },
          },
        },
      });

      if (!house) {
        throw new Error("Not authorized to assign tenant to this house");
      }

      return context.prisma.tenantAssignment.create({
        data: {
          tenantProfileId,
          houseId,
          leaseStartDate: new Date(leaseStartDate),
          status: "ACTIVE",
        },
      });
    },

    exitTenantAssignment: async (_, { id }, context) => {
      const assignment = await context.prisma.tenantAssignment.findFirst({
        where: {
          id,
          house: {
            ownerAccount: {
              members: {
                some: { userId: context.userId },
              },
            },
          },
        },
      });

      if (!assignment) {
        throw new Error("Not authorized to exit this tenant");
      }

      const deletionDate = new Date();
      deletionDate.setDate(deletionDate.getDate() + 30);

      return context.prisma.tenantAssignment.update({
        where: { id },
        data: {
          status: "EXITED",
          actualExitDate: new Date(),
          deletionScheduledAt: deletionDate,
        },
      });
    },
  },
};
