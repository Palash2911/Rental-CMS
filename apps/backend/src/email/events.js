/** Every email the app sends, one template module each (src/email/templates/). */
export const EMAIL_TYPES = Object.freeze({
  TENANT_INVITATION: "tenantInvitation",
  MEMBER_INVITATION: "memberInvitation",
  LEAVE_REQUEST_SUBMITTED: "leaveRequestSubmitted",
  LEAVE_REQUEST_RESPONDED: "leaveRequestResponded",
  NOTICE_GIVEN: "noticeGiven",
  NOTICE_WITHDRAWN: "noticeWithdrawn",
  TRIAL_ENDING: "trialEnding",
  PAYMENT_FAILED: "paymentFailed",
  ACCOUNT_READ_ONLY: "accountReadOnly",
  DELETION_SCHEDULED: "deletionScheduled",
});

// BullMQ refuses ":" in job ids, and the key is also the BullMQ job id; Resend accepts
// 1 to 256 characters.
const KEY_SEPARATOR = "/";

function key(...parts) {
  return parts.join(KEY_SEPARATOR);
}

/*
 * Each builder returns `{ type, key, ownerAccountId, data }` for one email. The key is
 * stable for the event, so a duplicate enqueue is dropped by BullMQ and a retried send by
 * Resend. `ownerAccountId` is the account the email is charged to (the notifier's daily
 * budget); it is not sent to the worker. `data` holds ids and the event's own values only:
 * names and addresses are read when the email is sent, so Redis never holds an address.
 */

export function tenantInvitationEmail({ ownerAccountId, invitationId }) {
  return {
    type: EMAIL_TYPES.TENANT_INVITATION,
    key: key("tenant-invitation", invitationId),
    ownerAccountId,
    data: { invitationId },
  };
}

export function memberInvitationEmail({ ownerAccountId, memberInvitationId }) {
  return {
    type: EMAIL_TYPES.MEMBER_INVITATION,
    key: key("member-invitation", memberInvitationId),
    ownerAccountId,
    data: { memberInvitationId },
  };
}

/** One per owner (PRIMARY and every CO_OWNER), each with its own key. */
export function leaveRequestSubmittedEmail({
  ownerAccountId,
  leaveRequestId,
  recipientUserId,
}) {
  return {
    type: EMAIL_TYPES.LEAVE_REQUEST_SUBMITTED,
    key: key("leave-request-submitted", leaveRequestId, recipientUserId),
    ownerAccountId,
    data: { leaveRequestId, recipientUserId },
  };
}

/** A request leaves PENDING once, so its id identifies the response. */
export function leaveRequestRespondedEmail({
  ownerAccountId,
  leaveRequestId,
  status,
}) {
  return {
    type: EMAIL_TYPES.LEAVE_REQUEST_RESPONDED,
    key: key("leave-request-responded", leaveRequestId),
    ownerAccountId,
    data: { leaveRequestId, status },
  };
}

// Notice can be given, withdrawn and given again with the same date, so these are keyed by
// the activity log entry the event wrote.
export function noticeGivenEmail({
  ownerAccountId,
  activityLogId,
  tenantAssignmentId,
  plannedExitDate,
}) {
  return {
    type: EMAIL_TYPES.NOTICE_GIVEN,
    key: key("notice-given", activityLogId),
    ownerAccountId,
    data: { tenantAssignmentId, plannedExitDate },
  };
}

export function noticeWithdrawnEmail({
  ownerAccountId,
  activityLogId,
  tenantAssignmentId,
}) {
  return {
    type: EMAIL_TYPES.NOTICE_WITHDRAWN,
    key: key("notice-withdrawn", activityLogId),
    ownerAccountId,
    data: { tenantAssignmentId },
  };
}

/** Keyed by the Stripe event id; the webhook processes each event once. */
export function trialEndingEmail({ stripeEventId, ownerAccountId, trialEnd }) {
  return {
    type: EMAIL_TYPES.TRIAL_ENDING,
    key: key("trial-ending", stripeEventId),
    ownerAccountId,
    data: { ownerAccountId, trialEnd },
  };
}

export function paymentFailedEmail({ stripeEventId, ownerAccountId }) {
  return {
    type: EMAIL_TYPES.PAYMENT_FAILED,
    key: key("payment-failed", stripeEventId),
    ownerAccountId,
    data: { ownerAccountId },
  };
}

/** Keyed by the moment billing made the account read-only (Subscription.readOnlySince). */
export function accountReadOnlyEmail({ ownerAccountId, readOnlySince }) {
  return {
    type: EMAIL_TYPES.ACCOUNT_READ_ONLY,
    key: key(
      "account-read-only",
      ownerAccountId,
      String(readOnlySince.getTime()),
    ),
    ownerAccountId,
    data: { ownerAccountId },
  };
}

export function deletionScheduledEmail({
  activityLogId,
  ownerAccountId,
  deletionScheduledAt,
  reason,
}) {
  return {
    type: EMAIL_TYPES.DELETION_SCHEDULED,
    key: key("deletion-scheduled", activityLogId),
    ownerAccountId,
    data: { ownerAccountId, deletionScheduledAt, reason },
  };
}
