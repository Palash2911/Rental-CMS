export const ENTITY_TYPES = Object.freeze({
  OWNER_ACCOUNT: "OwnerAccount",
  HOUSE: "House",
  INVITATION: "Invitation",
  TENANT_PROFILE: "TenantProfile",
  TENANT_ASSIGNMENT: "TenantAssignment",
});

export const ACTIVITY_ACTIONS = Object.freeze({
  CREATED: "CREATED",
  UPDATED: "UPDATED",
  STATUS_CHANGED: "STATUS_CHANGED",
  APPROVED: "APPROVED",
  BLOCKED: "BLOCKED",
  UNBLOCKED: "UNBLOCKED",
  DELETION_SCHEDULED: "DELETION_SCHEDULED",
  DELETION_CANCELLED: "DELETION_CANCELLED",
  REVOKED: "REVOKED",
  ACCEPTED: "ACCEPTED",
  DECLINED: "DECLINED",
  EXITED: "EXITED",
});

/** Writes an ActivityLog row. Call only with a transaction client, inside prisma.$transaction. */
export function logActivity(
  tx,
  { entityType, entityId, action, performedByUserId, metadata = {} },
) {
  return tx.activityLog.create({
    data: { entityType, entityId, action, performedByUserId, metadata },
    select: { id: true },
  });
}
