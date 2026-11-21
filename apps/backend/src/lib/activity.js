export const ENTITY_TYPES = Object.freeze({
  OWNER_ACCOUNT: "OwnerAccount",
  HOUSE: "House",
  INVITATION: "Invitation",
  TENANT_PROFILE: "TenantProfile",
  TENANT_ASSIGNMENT: "TenantAssignment",
  RECEIPT: "Receipt",
  ISSUE: "Issue",
  SUBSCRIPTION: "Subscription",
  MEMBER_INVITATION: "MemberInvitation",
  OWNER_ACCOUNT_MEMBER: "OwnerAccountMember",
  LEAVE_REQUEST: "LeaveRequest",
  RECEIPT_UPLOAD: "ReceiptUpload",
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
  CHECKOUT_STARTED: "CHECKOUT_STARTED",
  SYNCED: "SYNCED",
  ENTERPRISE_SET: "ENTERPRISE_SET",
  ENTERPRISE_CLEARED: "ENTERPRISE_CLEARED",
  REMOVED: "REMOVED",
  LEFT: "LEFT",
  OWNERSHIP_TRANSFERRED: "OWNERSHIP_TRANSFERRED",
  CUSTOMER_EMAIL_SYNC_FAILED: "CUSTOMER_EMAIL_SYNC_FAILED",
  REJECTED: "REJECTED",
  WITHDRAWN: "WITHDRAWN",
  NOTICE_GIVEN: "NOTICE_GIVEN",
  NOTICE_WITHDRAWN: "NOTICE_WITHDRAWN",
  DELETION_EXECUTED: "DELETION_EXECUTED",
  UPLOAD_REQUESTED: "UPLOAD_REQUESTED",
});

/**
 * Writes an ActivityLog row. Call only with a transaction client, inside prisma.$transaction.
 * `ownerAccountId` is mandatory: the account the entry belongs to, or an explicit null.
 * Throws TypeError when it is omitted, so no call site can silently leave an entry unscoped.
 */
export function logActivity(
  tx,
  {
    entityType,
    entityId,
    action,
    ownerAccountId,
    performedByUserId,
    metadata = {},
  },
) {
  if (ownerAccountId === undefined) {
    throw new TypeError(
      "logActivity requires ownerAccountId (a string or null).",
    );
  }

  return tx.activityLog.create({
    data: {
      entityType,
      entityId,
      action,
      ownerAccountId,
      performedByUserId,
      metadata,
    },
    select: { id: true },
  });
}
