export async function logActivity(
  prisma,
  { entityType, entityId, action, performedByUserId, metadata = {} },
) {
  return prisma.activityLog.create({
    data: {
      entityType,
      entityId,
      action,
      performedByUserId,
      metadata,
    },
  });
}
