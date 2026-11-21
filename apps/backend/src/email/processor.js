import { UnrecoverableError, Worker } from "bullmq";

import {
  InvitationStatus,
  LeaveRequestStatus,
  OwnerMemberRole,
} from "../generated/prisma/enums.ts";
import { EMAIL_TYPES } from "./events.js";
import { EMAIL_FAILURES, EmailDeliveryError } from "./gateway.js";
import * as accountReadOnly from "./templates/accountReadOnly.js";
import * as deletionScheduled from "./templates/deletionScheduled.js";
import * as leaveRequestResponded from "./templates/leaveRequestResponded.js";
import * as leaveRequestSubmitted from "./templates/leaveRequestSubmitted.js";
import * as memberInvitation from "./templates/memberInvitation.js";
import * as noticeGiven from "./templates/noticeGiven.js";
import * as noticeWithdrawn from "./templates/noticeWithdrawn.js";
import * as paymentFailed from "./templates/paymentFailed.js";
import * as tenantInvitation from "./templates/tenantInvitation.js";
import * as trialEnding from "./templates/trialEnding.js";

/**
 * A job still unsent this long after it was queued is failed for good. Rate limits and
 * quotas pause the queue without using attempts, so this is what bounds them.
 */
export const EMAIL_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const MESSAGES = Object.freeze({
  SKIPPED: "Email skipped: its recipient or subject no longer applies.",
  PERMANENT: "Email not sent and not retried: Resend refused the request.",
  TOO_OLD: "Email not sent: still unsent after the maximum age.",
  UNKNOWN_TYPE: "Email not sent: unknown email type.",
  RATE_LIMITED: "Email sending paused: Resend rate limit or quota reached.",
});

const USER_CONTACT = Object.freeze({ select: { email: true, name: true } });

function isOpenInvitation(invitation, now) {
  return invitation?.status === InvitationStatus.PENDING && invitation.expiresAt > now;
}

async function tenantFor(prisma, tenantAssignmentId) {
  return prisma.tenantAssignment.findUnique({
    where: { id: tenantAssignmentId },
    select: {
      id: true,
      house: { select: { name: true } },
      tenantProfile: { select: { user: USER_CONTACT } },
    },
  });
}

// Account emails go to the current PRIMARY; nothing is sent for a deleted account.
async function primaryOf(prisma, ownerAccountId) {
  const member = await prisma.ownerAccountMember.findFirst({
    where: { ownerAccountId, role: OwnerMemberRole.PRIMARY },
    select: { user: USER_CONTACT, ownerAccount: { select: { name: true, deletionExecutedAt: true } } },
  });

  if (!member || member.ownerAccount.deletionExecutedAt) {
    return null;
  }

  return { to: member.user.email, recipientName: member.user.name, accountName: member.ownerAccount.name };
}

async function accountEmail(prisma, { ownerAccountId, ...extra }) {
  const primary = await primaryOf(prisma, ownerAccountId);

  if (!primary) {
    return null;
  }

  const { to, ...values } = primary;
  return { to, values: { ...values, ownerAccountId, ...extra } };
}

// Each resolver reads what the email needs when it is sent and returns `{ to, values }`, or
// null when the email no longer applies (the invitation was answered, the owner left).
const RESOLVERS = Object.freeze({
  async [EMAIL_TYPES.TENANT_INVITATION](prisma, { invitationId }, now) {
    const invitation = await prisma.invitation.findUnique({
      where: { id: invitationId },
      select: {
        email: true,
        status: true,
        expiresAt: true,
        leaseStartDate: true,
        leaseEndDate: true,
        house: { select: { name: true, ownerAccount: { select: { name: true } } } },
      },
    });

    if (!isOpenInvitation(invitation, now)) {
      return null;
    }

    return {
      to: invitation.email,
      values: {
        houseName: invitation.house.name,
        accountName: invitation.house.ownerAccount.name,
        leaseStartDate: invitation.leaseStartDate,
        leaseEndDate: invitation.leaseEndDate,
        expiresAt: invitation.expiresAt,
      },
    };
  },

  async [EMAIL_TYPES.MEMBER_INVITATION](prisma, { memberInvitationId }, now) {
    const invitation = await prisma.memberInvitation.findUnique({
      where: { id: memberInvitationId },
      select: {
        email: true,
        status: true,
        expiresAt: true,
        ownerAccount: { select: { name: true } },
        invitedBy: { select: { name: true } },
      },
    });

    if (!isOpenInvitation(invitation, now)) {
      return null;
    }

    return {
      to: invitation.email,
      values: {
        accountName: invitation.ownerAccount.name,
        inviterName: invitation.invitedBy.name,
        expiresAt: invitation.expiresAt,
      },
    };
  },

  async [EMAIL_TYPES.LEAVE_REQUEST_SUBMITTED](prisma, { leaveRequestId, recipientUserId }) {
    const request = await prisma.leaveRequest.findUnique({
      where: { id: leaveRequestId },
      select: {
        status: true,
        requestedExitDate: true,
        reason: true,
        houseId: true,
        house: { select: { name: true, ownerAccountId: true } },
        tenantAssignment: { select: { tenantProfile: { select: { user: { select: { name: true } } } } } },
      },
    });

    if (request?.status !== LeaveRequestStatus.PENDING) {
      return null;
    }

    const member = await prisma.ownerAccountMember.findUnique({
      where: { userId_ownerAccountId: { userId: recipientUserId, ownerAccountId: request.house.ownerAccountId } },
      select: { user: USER_CONTACT },
    });

    if (!member) {
      return null;
    }

    return {
      to: member.user.email,
      values: {
        recipientName: member.user.name,
        tenantName: request.tenantAssignment.tenantProfile.user.name,
        houseName: request.house.name,
        houseId: request.houseId,
        requestedExitDate: request.requestedExitDate,
        reason: request.reason,
      },
    };
  },

  async [EMAIL_TYPES.LEAVE_REQUEST_RESPONDED](prisma, { leaveRequestId, status }) {
    const request = await prisma.leaveRequest.findUnique({
      where: { id: leaveRequestId },
      select: { requestedExitDate: true, tenantAssignmentId: true },
    });
    const assignment = request ? await tenantFor(prisma, request.tenantAssignmentId) : null;

    if (!assignment) {
      return null;
    }

    const { user } = assignment.tenantProfile;
    return {
      to: user.email,
      values: {
        tenantName: user.name,
        houseName: assignment.house.name,
        status,
        requestedExitDate: request.requestedExitDate,
        tenantAssignmentId: assignment.id,
      },
    };
  },

  async [EMAIL_TYPES.NOTICE_GIVEN](prisma, { tenantAssignmentId, plannedExitDate }) {
    const assignment = await tenantFor(prisma, tenantAssignmentId);

    if (!assignment) {
      return null;
    }

    const { user } = assignment.tenantProfile;
    return {
      to: user.email,
      values: { tenantName: user.name, houseName: assignment.house.name, plannedExitDate, tenantAssignmentId },
    };
  },

  async [EMAIL_TYPES.NOTICE_WITHDRAWN](prisma, { tenantAssignmentId }) {
    const assignment = await tenantFor(prisma, tenantAssignmentId);

    if (!assignment) {
      return null;
    }

    const { user } = assignment.tenantProfile;
    return { to: user.email, values: { tenantName: user.name, houseName: assignment.house.name, tenantAssignmentId } };
  },

  [EMAIL_TYPES.TRIAL_ENDING]: (prisma, { ownerAccountId, trialEnd }) => accountEmail(prisma, { ownerAccountId, trialEnd }),
  [EMAIL_TYPES.PAYMENT_FAILED]: (prisma, { ownerAccountId }) => accountEmail(prisma, { ownerAccountId }),
  [EMAIL_TYPES.ACCOUNT_READ_ONLY]: (prisma, { ownerAccountId }) => accountEmail(prisma, { ownerAccountId }),
  [EMAIL_TYPES.DELETION_SCHEDULED]: (prisma, { ownerAccountId, deletionScheduledAt, reason }) =>
    accountEmail(prisma, { ownerAccountId, deletionScheduledAt, reason }),
});

const TEMPLATES = Object.freeze({
  [EMAIL_TYPES.TENANT_INVITATION]: tenantInvitation,
  [EMAIL_TYPES.MEMBER_INVITATION]: memberInvitation,
  [EMAIL_TYPES.LEAVE_REQUEST_SUBMITTED]: leaveRequestSubmitted,
  [EMAIL_TYPES.LEAVE_REQUEST_RESPONDED]: leaveRequestResponded,
  [EMAIL_TYPES.NOTICE_GIVEN]: noticeGiven,
  [EMAIL_TYPES.NOTICE_WITHDRAWN]: noticeWithdrawn,
  [EMAIL_TYPES.TRIAL_ENDING]: trialEnding,
  [EMAIL_TYPES.PAYMENT_FAILED]: paymentFailed,
  [EMAIL_TYPES.ACCOUNT_READ_ONLY]: accountReadOnly,
  [EMAIL_TYPES.DELETION_SCHEDULED]: deletionScheduled,
});

/** Builds `{ to, subject, html, text }` for a job, or null when it no longer applies. */
export async function renderEmailJob({ prisma, frontendUrl, devRedirect = null }, { name, data }, now = new Date()) {
  const resolve = RESOLVERS[name];

  if (!resolve) {
    return undefined;
  }

  const resolved = await resolve(prisma, data, now);

  if (!resolved) {
    return null;
  }

  const content = TEMPLATES[name].render(resolved.values, {
    frontendUrl,
    originalRecipient: devRedirect ? resolved.to : null,
  });

  return { to: devRedirect ?? resolved.to, ...content };
}

/**
 * Returns the BullMQ processor for the email queue. The job id is the idempotency key, so a
 * retried job never sends twice. A rate limit or quota pauses the whole queue through
 * `rateLimit(ms)` (the worker's) and uses no attempt; a permanent refusal is logged and not
 * retried; anything else is retried with the job's exponential backoff.
 * Logs carry the email type, key and error name, never an address.
 */
export function createEmailProcessor({ prisma, emailGateway, from, devRedirect = null, frontendUrl, log, rateLimit, now = () => new Date() }) {
  return async function processEmail(job) {
    const context = { emailType: job.name, emailKey: job.id };
    const current = now();

    if (current.getTime() - job.timestamp > EMAIL_MAX_AGE_MS) {
      log.error(context, MESSAGES.TOO_OLD);
      throw new UnrecoverableError(MESSAGES.TOO_OLD);
    }

    const email = await renderEmailJob({ prisma, frontendUrl, devRedirect }, job, current);

    if (email === undefined) {
      log.error(context, MESSAGES.UNKNOWN_TYPE);
      throw new UnrecoverableError(MESSAGES.UNKNOWN_TYPE);
    }

    if (email === null) {
      log.info(context, MESSAGES.SKIPPED);
      return { sent: false, skipped: true };
    }

    try {
      const result = await emailGateway.send({ from, ...email, idempotencyKey: job.id });
      return { sent: true, alreadySent: result.alreadySent };
    } catch (error) {
      if (!(error instanceof EmailDeliveryError)) {
        throw error;
      }

      if (error.kind === EMAIL_FAILURES.RATE_LIMITED) {
        log.warn({ ...context, errorName: error.errorName, retryAfterMs: error.retryAfterMs }, MESSAGES.RATE_LIMITED);
        await rateLimit(error.retryAfterMs);
        throw Worker.RateLimitError();
      }

      if (error.kind === EMAIL_FAILURES.PERMANENT) {
        log.error({ ...context, errorName: error.errorName, statusCode: error.statusCode }, MESSAGES.PERMANENT);
        throw new UnrecoverableError(MESSAGES.PERMANENT);
      }

      throw error;
    }
  };
}
