import { logActivity } from "../activityLogger.js";

export const houseResolvers = {
  Query: {
    houses: async (_, { ownerAccountId }, context) => {
      if (!context.userId) {
        throw new Error("Authentication required");
      }

      const membership = await context.prisma.ownerAccountMember.findFirst({
        where: {
          ownerAccountId,
          userId: context.userId,
        },
      });

      if (!membership) {
        throw new Error("Not authorized to view houses for this owner account");
      }

      return context.prisma.house.findMany({
        where: { ownerAccountId },
        orderBy: { createdAt: "desc" },
      });
    },

    house: async (_, { id }, context) => {
      const house = await context.prisma.house.findFirst({
        where: {
          id,
          ownerAccount: {
            members: {
              some: {
                userId: context.userId,
              },
            },
          },
        },
      });

      if (!house) {
        throw new Error("House not found or access denied");
      }

      return house;
    },
  },

  Mutation: {
    createHouse: async (
      _,
      { ownerAccountId, name, location, maxTenants },
      context,
    ) => {
      const membership = await context.prisma.ownerAccountMember.findFirst({
        where: {
          ownerAccountId,
          userId: context.userId,
        },
      });

      if (!membership) {
        throw new Error(
          "Not authorized to create house for this owner account",
        );
      }

      const house = await context.prisma.house.create({
        data: {
          ownerAccountId,
          name,
          location,
          maxTenants,
          status: "VACANT",
        },
      });

      await logActivity(context.prisma, {
        entityType: "House",
        entityId: house.id,
        action: "CREATED",
        performedByUserId: context.userId,
        metadata: {
          ownerAccountId,
          name,
          location,
          maxTenants,
        },
      });

      return house;
    },

    updateHouse: async (_, { id, ...updates }, context) => {
      const house = await context.prisma.house.findFirst({
        where: {
          id,
          ownerAccount: {
            members: {
              some: {
                userId: context.userId,
              },
            },
          },
        },
      });

      if (!house) {
        throw new Error("Not authorized to update this house");
      }

      const updatedHouse = await context.prisma.house.update({
        where: { id },
        data: updates,
      });

      await logActivity(context.prisma, {
        entityType: "House",
        entityId: id,
        action: updates.status ? "STATUS_CHANGED" : "UPDATED",
        performedByUserId: context.userId,
        metadata: {
          fromStatus: updates.status ? house.status : undefined,
          toStatus: updates.status ?? undefined,
          ...updates,
        },
      });

      return updatedHouse;
    },
  },
};
