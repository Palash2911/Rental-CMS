import { logActivity } from "../activityLogger.js";

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

      const assignment = await context.prisma.tenantAssignment.create({
        data: {
          tenantProfileId,
          houseId,
          leaseStartDate: new Date(leaseStartDate),
          status: "ACTIVE",
        },
      });

      await logActivity(context.prisma, {
        entityType: "TenantAssignment",
        entityId: assignment.id,
        action: "CREATED",
        performedByUserId: context.userId,
        metadata: {
          tenantProfileId,
          houseId,
          leaseStartDate,
        },
      });

      return assignment;
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

      const updated = await context.prisma.tenantAssignment.update({
        where: { id },
        data: {
          status: "EXITED",
          actualExitDate: new Date(),
          deletionScheduledAt: deletionDate,
        },
      });

      await logActivity(context.prisma, {
        entityType: "TenantAssignment",
        entityId: id,
        action: "EXITED",
        performedByUserId: context.userId,
        metadata: {
          deletionScheduledAt: deletionDate,
        },
      });

      return updated;
    },
  },
};
