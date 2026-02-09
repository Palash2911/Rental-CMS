import { logActivity } from "../activityLogger.js";

export const issueResolvers = {
  Query: {
    issuesByAssignment: async (_, { tenantAssignmentId }, context) => {
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
        throw new Error("Not authorized to view issues");
      }

      return context.prisma.issue.findMany({
        where: { tenantAssignmentId },
        orderBy: { createdAt: "desc" },
      });
    },
  },

  Mutation: {
    createIssue: async (
      _,
      { tenantAssignmentId, title, description },
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
        throw new Error("Not allowed to create issue");
      }

      const issue = await context.prisma.issue.create({
        data: {
          tenantAssignmentId,
          title,
          description,
          status: "OPEN",
        },
      });

      await logActivity(context.prisma, {
        entityType: "Issue",
        entityId: issue.id,
        action: "CREATED",
        performedByUserId: context.userId,
        metadata: { title },
      });

      return issue;
    },

    updateIssueStatus: async (_, { id, status }, context) => {
      // owners only
      const issue = await context.prisma.issue.findFirst({
        where: {
          id,
          tenantAssignment: {
            house: {
              ownerAccount: {
                members: { some: { userId: context.userId } },
              },
            },
          },
        },
      });

      if (!issue) {
        throw new Error("Not authorized to update issue");
      }

      const updated = await context.prisma.issue.update({
        where: { id },
        data: { status },
      });

      await logActivity(context.prisma, {
        entityType: "Issue",
        entityId: id,
        action: "STATUS_CHANGED",
        performedByUserId: context.userId,
        metadata: { to: status },
      });

      return updated;
    },
  },
};
