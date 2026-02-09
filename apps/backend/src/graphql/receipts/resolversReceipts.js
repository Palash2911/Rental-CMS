import { logActivity } from "../activityLogger.js";

export const receiptResolvers = {
  Query: {
    receiptsByAssignment: async (_, { tenantAssignmentId }, context) => {
      // owner OR the tenant who owns the assignment can read
      const assignment = await context.prisma.tenantAssignment.findFirst({
        where: {
          id: tenantAssignmentId,
          OR: [
            { tenantProfile: { userId: context.userId } },
            {
              house: {
                ownerAccount: {
                  members: { some: { userId: context.userId } },
                },
              },
            },
          ],
        },
      });

      if (!assignment) {
        throw new Error("Not authorized to view receipts");
      }

      return context.prisma.receipt.findMany({
        where: { tenantAssignmentId },
        orderBy: { createdAt: "desc" },
      });
    },
  },

  Mutation: {
    uploadReceipt: async (
      _,
      { tenantAssignmentId, amount, paidAt, fileUrl },
      context,
    ) => {
      const assignment = await context.prisma.tenantAssignment.findFirst({
        where: {
          id: tenantAssignmentId,
          tenantProfile: { userId: context.userId },
          status: { in: ["ACTIVE", "NOTICE_PERIOD"] },
        },
      });

      if (!assignment) {
        throw new Error("Not allowed to upload receipt");
      }

      const receipt = await context.prisma.receipt.create({
        data: {
          tenantAssignmentId,
          amount,
          paidAt: new Date(paidAt),
          fileUrl,
        },
      });

      await logActivity(context.prisma, {
        entityType: "Receipt",
        entityId: receipt.id,
        action: "CREATED",
        performedByUserId: context.userId,
        metadata: { amount },
      });

      return receipt;
    },
  },
};
