import { TenantAssignmentStatus } from "../../generated/prisma/enums.ts";
import {
  ACTIVITY_ACTIONS,
  ENTITY_TYPES,
  logActivity,
} from "../../lib/activity.js";
import { ConflictError, isRecordNotFound } from "../../lib/errors.js";
import { buildPageQuery, toPage } from "../../lib/pagination.js";
import {
  ACTIVE_ASSIGNMENT_STATUSES,
  lockHouse,
  syncOccupancy,
} from "../house/serviceHouse.js";

const ISO_DATE_LENGTH = 10;

/** Columns every service selects for a TenantAssignment returned to clients. */
export const ASSIGNMENT_SELECT = Object.freeze({
  id: true,
  tenantProfileId: true,
  houseId: true,
  status: true,
  leaseStartDate: true,
  leaseEndDate: true,
  actualExitDate: true,
  createdAt: true,
  updatedAt: true,
});

const MESSAGES = Object.freeze({
  NOT_ACTIVE: "Only an active tenant assignment can be exited.",
});

/** Formats a calendar date stored as UTC midnight as YYYY-MM-DD. */
export function toCalendarDate(date) {
  return date.toISOString().slice(0, ISO_DATE_LENGTH);
}

/** Converts a TenantAssignment row to the client shape. */
export function toPublicAssignment(assignment) {
  return {
    id: assignment.id,
    tenantProfileId: assignment.tenantProfileId,
    houseId: assignment.houseId,
    status: assignment.status,
    leaseStartDate: toCalendarDate(assignment.leaseStartDate),
    leaseEndDate: assignment.leaseEndDate
      ? toCalendarDate(assignment.leaseEndDate)
      : null,
    actualExitDate: assignment.actualExitDate
      ? assignment.actualExitDate.toISOString()
      : null,
    createdAt: assignment.createdAt.toISOString(),
    updatedAt: assignment.updatedAt.toISOString(),
  };
}

async function listPage(prisma, filter, { first, after }) {
  const page = buildPageQuery({ first, after });

  const rows = await prisma.tenantAssignment.findMany({
    where: { AND: [filter, page.where] },
    orderBy: page.orderBy,
    take: page.take,
    select: ASSIGNMENT_SELECT,
  });

  return toPage(rows, first, toPublicAssignment);
}

/** Lists a house's assignments in every status, newest first. */
export function listAssignmentsByHouse(context, { houseId, first, after }) {
  return listPage(context.prisma, { houseId }, { first, after });
}

/**
 * Lists the actor's own assignments across all owner accounts, newest first, limited to
 * accounts whose status is in `accountStatuses`.
 */
export async function listMyAssignments(
  context,
  { actorId, accountStatuses, first, after },
) {
  const profile = await context.prisma.tenantProfile.findUnique({
    where: { userId: actorId },
    select: { id: true },
  });

  if (!profile) {
    return toPage([], first, toPublicAssignment);
  }

  return listPage(
    context.prisma,
    {
      tenantProfileId: profile.id,
      house: { ownerAccount: { status: { in: accountStatuses } } },
    },
    { first, after },
  );
}

async function markExited(tx, id, now) {
  try {
    return await tx.tenantAssignment.update({
      where: { id, status: { in: ACTIVE_ASSIGNMENT_STATUSES } },
      data: { status: TenantAssignmentStatus.EXITED, actualExitDate: now },
      select: ASSIGNMENT_SELECT,
    });
  } catch (error) {
    if (isRecordNotFound(error)) {
      throw new ConflictError(MESSAGES.NOT_ACTIVE);
    }

    throw error;
  }
}

/**
 * Exits an ACTIVE or NOTICE_PERIOD assignment under the house row lock, then sets the house
 * VACANT when no active assignment remains. Throws ConflictError for an EXITED assignment.
 */
export function exitAssignment(context, { actorId, id, houseId }) {
  return context.prisma.$transaction(async (tx) => {
    await lockHouse(tx, houseId);

    const current = await tx.tenantAssignment.findUnique({
      where: { id },
      select: { status: true },
    });

    if (!ACTIVE_ASSIGNMENT_STATUSES.includes(current.status)) {
      throw new ConflictError(MESSAGES.NOT_ACTIVE);
    }

    const now = new Date();
    const assignment = await markExited(tx, id, now);

    await logActivity(tx, {
      entityType: ENTITY_TYPES.TENANT_ASSIGNMENT,
      entityId: id,
      action: ACTIVITY_ACTIONS.EXITED,
      performedByUserId: actorId,
      metadata: {
        fromStatus: current.status,
        toStatus: assignment.status,
        actualExitDate: now.toISOString(),
      },
    });

    await syncOccupancy(tx, { houseId, actorId });

    return toPublicAssignment(assignment);
  });
}
