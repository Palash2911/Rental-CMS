import {
  leaveRequestRespondedEmail,
  leaveRequestSubmittedEmail,
  noticeGivenEmail,
  noticeWithdrawnEmail,
} from "../../email/events.js";
import { withEmails } from "../../email/queue.js";
import {
  LeaveRequestStatus,
  TenantAssignmentStatus,
} from "../../generated/prisma/enums.ts";
import {
  ACTIVITY_ACTIONS,
  ENTITY_TYPES,
  logActivity,
} from "../../lib/activity.js";
import {
  ConflictError,
  isRecordNotFound,
  isUniqueViolation,
} from "../../lib/errors.js";
import { buildPageQuery, toPage } from "../../lib/pagination.js";
import { lockHouse } from "../house/serviceHouse.js";
import {
  ASSIGNMENT_SELECT,
  toCalendarDate,
  toPublicAssignment,
} from "../tenantAssignment/serviceTenantAssignment.js";

const { PENDING, APPROVED, REJECTED, WITHDRAWN } = LeaveRequestStatus;
const { ACTIVE, NOTICE_PERIOD } = TenantAssignmentStatus;

const NOTICE_WITHDRAWN_REASON = "NOTICE_WITHDRAWN";

export const LEAVE_REQUEST_SELECT = Object.freeze({
  id: true,
  tenantAssignmentId: true,
  houseId: true,
  status: true,
  requestedExitDate: true,
  reason: true,
  respondedAt: true,
  createdAt: true,
  updatedAt: true,
});

const MESSAGES = Object.freeze({
  REQUEST_NEEDS_ACTIVE:
    "A leave request can only be made on an active tenant assignment.",
  ALREADY_PENDING:
    "This tenant assignment already has a pending leave request.",
  NOT_PENDING: "This leave request is no longer pending.",
  NOTICE_NEEDS_ACTIVE: "Only an active tenant assignment can be given notice.",
  NOT_IN_NOTICE:
    "Only a tenant assignment in its notice period can have its notice withdrawn.",
});

/** Converts a LeaveRequest row to the client shape. */
export function toPublicLeaveRequest(request) {
  return {
    id: request.id,
    tenantAssignmentId: request.tenantAssignmentId,
    houseId: request.houseId,
    status: request.status,
    requestedExitDate: toCalendarDate(request.requestedExitDate),
    reason: request.reason,
    respondedAt: request.respondedAt ? request.respondedAt.toISOString() : null,
    createdAt: request.createdAt.toISOString(),
    updatedAt: request.updatedAt.toISOString(),
  };
}

async function listPage(prisma, filter, { status, first, after }) {
  const page = buildPageQuery({ first, after });
  const statusFilter = status ? { status } : {};

  const rows = await prisma.leaveRequest.findMany({
    where: { AND: [filter, statusFilter, page.where] },
    orderBy: page.orderBy,
    take: page.take,
    select: LEAVE_REQUEST_SELECT,
  });

  return toPage(rows, first, toPublicLeaveRequest);
}

/** Lists an assignment's leave requests, optionally filtered by status, newest first. */
export function listLeaveRequestsByAssignment(
  context,
  { tenantAssignmentId, ...options },
) {
  return listPage(context.prisma, { tenantAssignmentId }, options);
}

/** Lists the leave requests on every assignment of a house, optionally filtered by status, newest first. */
export function listLeaveRequestsByHouse(context, { houseId, ...options }) {
  return listPage(context.prisma, { houseId }, options);
}

async function assertActiveAssignment(tx, tenantAssignmentId) {
  const assignment = await tx.tenantAssignment.findUnique({
    where: { id: tenantAssignmentId },
    select: { status: true },
  });

  if (assignment?.status !== ACTIVE) {
    throw new ConflictError(MESSAGES.REQUEST_NEEDS_ACTIVE);
  }
}

async function assertNoPendingRequest(tx, tenantAssignmentId) {
  const pending = await tx.leaveRequest.findFirst({
    where: { tenantAssignmentId, status: PENDING },
    select: { id: true },
  });

  if (pending) {
    throw new ConflictError(MESSAGES.ALREADY_PENDING);
  }
}

async function insertLeaveRequest(tx, data) {
  try {
    return await tx.leaveRequest.create({ data, select: LEAVE_REQUEST_SELECT });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(MESSAGES.ALREADY_PENDING);
    }

    throw error;
  }
}

/**
 * Creates a PENDING leave request on an ACTIVE assignment, under the house row lock.
 * Throws ConflictError when the assignment is not ACTIVE or already has a pending request.
 */
export function createLeaveRequest(
  context,
  {
    actorId,
    ownerAccountId,
    tenantAssignmentId,
    houseId,
    requestedExitDate,
    reason,
  },
) {
  return withEmails(context.notifier, (emails) =>
    context.prisma.$transaction(async (tx) => {
      await lockHouse(tx, houseId);
      await assertActiveAssignment(tx, tenantAssignmentId);
      await assertNoPendingRequest(tx, tenantAssignmentId);

      const request = await insertLeaveRequest(tx, {
        tenantAssignmentId,
        houseId,
        requestedExitDate,
        reason: reason ?? null,
        status: PENDING,
      });

      await logActivity(tx, {
        entityType: ENTITY_TYPES.LEAVE_REQUEST,
        entityId: request.id,
        action: ACTIVITY_ACTIONS.CREATED,
        ownerAccountId,
        performedByUserId: actorId,
        metadata: {
          tenantAssignmentId,
          requestedExitDate: toCalendarDate(request.requestedExitDate),
        },
      });

      // One email per owner, PRIMARY and CO_OWNER alike (project owner), each with its own key.
      const owners = await tx.ownerAccountMember.findMany({
        where: { ownerAccountId },
        select: { userId: true },
      });

      for (const { userId } of owners) {
        emails.push(
          leaveRequestSubmittedEmail({
            leaveRequestId: request.id,
            recipientUserId: userId,
          }),
        );
      }

      return toPublicLeaveRequest(request);
    }),
  );
}

// Compare-and-set: a concurrent response matches no row (P2025).
async function respond(tx, { id, actorId, toStatus, now }) {
  try {
    return await tx.leaveRequest.update({
      where: { id, status: PENDING },
      data: { status: toStatus, respondedAt: now, respondedByUserId: actorId },
      select: LEAVE_REQUEST_SELECT,
    });
  } catch (error) {
    if (isRecordNotFound(error)) {
      throw new ConflictError(MESSAGES.NOT_PENDING);
    }

    throw error;
  }
}

function logResponse(tx, { request, action, actorId, ownerAccountId }) {
  return logActivity(tx, {
    entityType: ENTITY_TYPES.LEAVE_REQUEST,
    entityId: request.id,
    action,
    ownerAccountId,
    performedByUserId: actorId,
    metadata: {
      tenantAssignmentId: request.tenantAssignmentId,
      fromStatus: PENDING,
      toStatus: request.status,
    },
  });
}

// `notifyTenant` sends the tenant the response email: owners' answers only, not the tenant's
// own withdrawal (project owner).
function respondUnderHouseLock(
  context,
  { id, houseId, actorId, ownerAccountId, toStatus, action, notifyTenant },
) {
  return withEmails(context.notifier, (emails) =>
    context.prisma.$transaction(async (tx) => {
      await lockHouse(tx, houseId);

      const request = await respond(tx, {
        id,
        actorId,
        toStatus,
        now: new Date(),
      });
      await logResponse(tx, { request, action, actorId, ownerAccountId });

      if (notifyTenant) {
        emails.push(
          leaveRequestRespondedEmail({
            leaveRequestId: request.id,
            status: request.status,
          }),
        );
      }

      return toPublicLeaveRequest(request);
    }),
  );
}

/**
 * Moves the tenant's PENDING leave request to WITHDRAWN, under the house row lock.
 * Throws ConflictError when it is no longer pending.
 */
export function withdrawLeaveRequest(
  context,
  { actorId, ownerAccountId, id, houseId },
) {
  return respondUnderHouseLock(context, {
    id,
    houseId,
    actorId,
    ownerAccountId,
    toStatus: WITHDRAWN,
    action: ACTIVITY_ACTIONS.WITHDRAWN,
    notifyTenant: false,
  });
}

/**
 * Moves a PENDING leave request to REJECTED, under the house row lock. The assignment is not
 * changed. Throws ConflictError when it is no longer pending.
 */
export function rejectLeaveRequest(
  context,
  { actorId, ownerAccountId, id, houseId },
) {
  return respondUnderHouseLock(context, {
    id,
    houseId,
    actorId,
    ownerAccountId,
    toStatus: REJECTED,
    action: ACTIVITY_ACTIONS.REJECTED,
    notifyTenant: true,
  });
}

// Compare-and-set on the assignment status, so a concurrent exit or notice matches no row.
async function moveAssignment(tx, { id, fromStatus, data, conflictMessage }) {
  try {
    return await tx.tenantAssignment.update({
      where: { id, status: fromStatus },
      data,
      select: ASSIGNMENT_SELECT,
    });
  } catch (error) {
    if (isRecordNotFound(error)) {
      throw new ConflictError(conflictMessage);
    }

    throw error;
  }
}

async function startNoticePeriod(
  tx,
  {
    tenantAssignmentId,
    plannedExitDate,
    actorId,
    ownerAccountId,
    leaveRequestId,
  },
) {
  const assignment = await moveAssignment(tx, {
    id: tenantAssignmentId,
    fromStatus: ACTIVE,
    data: { status: NOTICE_PERIOD, plannedExitDate },
    conflictMessage: MESSAGES.NOTICE_NEEDS_ACTIVE,
  });

  const log = await logActivity(tx, {
    entityType: ENTITY_TYPES.TENANT_ASSIGNMENT,
    entityId: tenantAssignmentId,
    action: ACTIVITY_ACTIONS.NOTICE_GIVEN,
    ownerAccountId,
    performedByUserId: actorId,
    metadata: {
      fromStatus: ACTIVE,
      toStatus: NOTICE_PERIOD,
      plannedExitDate: toCalendarDate(plannedExitDate),
      leaveRequestId: leaveRequestId ?? null,
    },
  });

  return { assignment, activityLogId: log.id };
}

/**
 * Approves a PENDING leave request and moves its ACTIVE assignment to NOTICE_PERIOD with
 * plannedExitDate set to the requested date, in one transaction under the house row lock.
 * Throws ConflictError when the request is no longer pending or the assignment is not ACTIVE.
 */
// Only the response email: it already names the planned exit date, so no separate
// notice-given email is sent for an approval.
export function approveLeaveRequest(
  context,
  { actorId, ownerAccountId, id, houseId },
) {
  return withEmails(context.notifier, (emails) =>
    context.prisma.$transaction(async (tx) => {
      await lockHouse(tx, houseId);

      const request = await respond(tx, {
        id,
        actorId,
        toStatus: APPROVED,
        now: new Date(),
      });
      await logResponse(tx, {
        request,
        action: ACTIVITY_ACTIONS.APPROVED,
        actorId,
        ownerAccountId,
      });

      await startNoticePeriod(tx, {
        tenantAssignmentId: request.tenantAssignmentId,
        plannedExitDate: request.requestedExitDate,
        actorId,
        ownerAccountId,
        leaveRequestId: request.id,
      });

      emails.push(
        leaveRequestRespondedEmail({
          leaveRequestId: request.id,
          status: request.status,
        }),
      );

      return toPublicLeaveRequest(request);
    }),
  );
}

/**
 * Moves an ACTIVE assignment to NOTICE_PERIOD with the owner's planned exit date, under the
 * house row lock. Throws ConflictError when the assignment is not ACTIVE.
 */
export function giveNotice(
  context,
  { actorId, ownerAccountId, tenantAssignmentId, houseId, plannedExitDate },
) {
  return withEmails(context.notifier, (emails) =>
    context.prisma.$transaction(async (tx) => {
      await lockHouse(tx, houseId);

      const { assignment, activityLogId } = await startNoticePeriod(tx, {
        tenantAssignmentId,
        plannedExitDate,
        actorId,
        ownerAccountId,
      });

      emails.push(
        noticeGivenEmail({
          activityLogId,
          tenantAssignmentId,
          plannedExitDate: toCalendarDate(assignment.plannedExitDate),
        }),
      );

      return toPublicAssignment(assignment);
    }),
  );
}

async function withdrawApprovedRequests(
  tx,
  { tenantAssignmentId, actorId, ownerAccountId },
) {
  const approved = await tx.leaveRequest.findMany({
    where: { tenantAssignmentId, status: APPROVED },
    select: { id: true },
  });
  const ids = approved.map(({ id }) => id);

  if (ids.length === 0) {
    return ids;
  }

  await tx.leaveRequest.updateMany({
    where: { id: { in: ids }, status: APPROVED },
    data: { status: WITHDRAWN },
  });

  // Approval needs an ACTIVE assignment and moves it to NOTICE_PERIOD, and this is the only
  // way back to ACTIVE, so an assignment has at most one APPROVED request at a time.
  for (const id of ids) {
    await logActivity(tx, {
      entityType: ENTITY_TYPES.LEAVE_REQUEST,
      entityId: id,
      action: ACTIVITY_ACTIONS.WITHDRAWN,
      ownerAccountId,
      performedByUserId: actorId,
      metadata: {
        tenantAssignmentId,
        fromStatus: APPROVED,
        toStatus: WITHDRAWN,
        reason: NOTICE_WITHDRAWN_REASON,
      },
    });
  }

  return ids;
}

/**
 * Moves a NOTICE_PERIOD assignment back to ACTIVE, clears plannedExitDate and marks any
 * APPROVED leave request on it WITHDRAWN, in one transaction under the house row lock.
 * Throws ConflictError when the assignment is not in its notice period.
 */
export function withdrawNotice(
  context,
  { actorId, ownerAccountId, tenantAssignmentId, houseId },
) {
  return withEmails(context.notifier, (emails) =>
    context.prisma.$transaction(async (tx) => {
      await lockHouse(tx, houseId);

      const previous = await tx.tenantAssignment.findUnique({
        where: { id: tenantAssignmentId },
        select: { plannedExitDate: true },
      });

      const assignment = await moveAssignment(tx, {
        id: tenantAssignmentId,
        fromStatus: NOTICE_PERIOD,
        data: { status: ACTIVE, plannedExitDate: null },
        conflictMessage: MESSAGES.NOT_IN_NOTICE,
      });

      const withdrawnLeaveRequestIds = await withdrawApprovedRequests(tx, {
        tenantAssignmentId,
        actorId,
        ownerAccountId,
      });

      const log = await logActivity(tx, {
        entityType: ENTITY_TYPES.TENANT_ASSIGNMENT,
        entityId: tenantAssignmentId,
        action: ACTIVITY_ACTIONS.NOTICE_WITHDRAWN,
        ownerAccountId,
        performedByUserId: actorId,
        metadata: {
          fromStatus: NOTICE_PERIOD,
          toStatus: ACTIVE,
          previousPlannedExitDate: previous?.plannedExitDate
            ? toCalendarDate(previous.plannedExitDate)
            : null,
          withdrawnLeaveRequestIds,
        },
      });

      emails.push(
        noticeWithdrawnEmail({ activityLogId: log.id, tenantAssignmentId }),
      );

      return toPublicAssignment(assignment);
    }),
  );
}
