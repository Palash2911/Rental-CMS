import { IssueStatus } from "../../generated/prisma/enums.ts";
import {
  ACTIVITY_ACTIONS,
  ENTITY_TYPES,
  logActivity,
} from "../../lib/activity.js";
import { ConflictError, isRecordNotFound } from "../../lib/errors.js";
import { buildPageQuery, toPage } from "../../lib/pagination.js";
import { shareLockHouse } from "../house/serviceHouse.js";
import { lockActiveAssignment } from "../tenantAssignment/serviceTenantAssignment.js";

const { OPEN, IN_PROGRESS, RESOLVED, CLOSED } = IssueStatus;

export const ISSUE_ACTOR_ROLES = Object.freeze({
  OWNER: "OWNER",
  TENANT: "TENANT",
});

/** Allowed status changes per actor role: `{ role: { from: [to, ...] } }`. Anything else is refused. */
const TRANSITIONS = Object.freeze({
  [ISSUE_ACTOR_ROLES.OWNER]: Object.freeze({
    [OPEN]: Object.freeze([IN_PROGRESS, RESOLVED]),
    [IN_PROGRESS]: Object.freeze([RESOLVED]),
  }),
  [ISSUE_ACTOR_ROLES.TENANT]: Object.freeze({
    [RESOLVED]: Object.freeze([CLOSED, OPEN]),
    [OPEN]: Object.freeze([CLOSED]),
  }),
});

const ISSUE_SELECT = Object.freeze({
  id: true,
  tenantAssignmentId: true,
  houseId: true,
  title: true,
  description: true,
  status: true,
  createdAt: true,
  updatedAt: true,
});

const MESSAGES = Object.freeze({
  TRANSITION_NOT_ALLOWED: "This status change is not allowed for this issue.",
  STATUS_CHANGED: "The issue changed while this request was running. Try again.",
});

/** Converts an Issue row to the client shape, with ISO 8601 dates. */
export function toPublicIssue(issue) {
  return {
    id: issue.id,
    tenantAssignmentId: issue.tenantAssignmentId,
    houseId: issue.houseId,
    title: issue.title,
    description: issue.description,
    status: issue.status,
    createdAt: issue.createdAt.toISOString(),
    updatedAt: issue.updatedAt.toISOString(),
  };
}

async function listPage(prisma, filter, { status, first, after }) {
  const page = buildPageQuery({ first, after });
  const statusFilter = status ? { status } : {};

  const rows = await prisma.issue.findMany({
    where: { AND: [filter, statusFilter, page.where] },
    orderBy: page.orderBy,
    take: page.take,
    select: ISSUE_SELECT,
  });

  return toPage(rows, first, toPublicIssue);
}

/** Lists an assignment's issues, optionally filtered by status, newest first. */
export function listIssuesByAssignment(context, { tenantAssignmentId, ...options }) {
  return listPage(context.prisma, { tenantAssignmentId }, options);
}

/** Lists a house's issues across all its assignments, optionally filtered by status, newest first. */
export function listIssuesByHouse(context, { houseId, ...options }) {
  return listPage(context.prisma, { houseId }, options);
}

/**
 * Creates an OPEN issue on an ACTIVE or NOTICE_PERIOD assignment and logs it, in one
 * transaction. `houseId` is the assignment's house, copied onto the issue.
 * Throws ConflictError when the assignment is no longer active.
 */
export function createIssue(
  context,
  { actorId, tenantAssignmentId, houseId, title, description },
) {
  return context.prisma.$transaction(async (tx) => {
    await shareLockHouse(tx, houseId);
    await lockActiveAssignment(tx, tenantAssignmentId);

    const issue = await tx.issue.create({
      data: { tenantAssignmentId, houseId, title, description, status: OPEN },
      select: ISSUE_SELECT,
    });

    await logActivity(tx, {
      entityType: ENTITY_TYPES.ISSUE,
      entityId: issue.id,
      action: ACTIVITY_ACTIONS.CREATED,
      performedByUserId: actorId,
      metadata: { tenantAssignmentId, houseId, title },
    });

    return toPublicIssue(issue);
  });
}

function transitionRole(actorRoles, from, to) {
  return actorRoles.find((role) => TRANSITIONS[role][from]?.includes(to)) ?? null;
}

async function updateIfStatusUnchanged(tx, id, from, to) {
  try {
    return await tx.issue.update({
      where: { id, status: from },
      data: { status: to },
      select: ISSUE_SELECT,
    });
  } catch (error) {
    if (isRecordNotFound(error)) {
      throw new ConflictError(MESSAGES.STATUS_CHANGED);
    }

    throw error;
  }
}

/**
 * Changes an issue's status when the transition table allows it for one of `actorRoles`
 * (ISSUE_ACTOR_ROLES the caller holds). Tenant transitions also require the assignment to
 * be ACTIVE or NOTICE_PERIOD. Compare-and-set on the current status.
 * Throws ConflictError for a disallowed transition, an inactive assignment on a tenant
 * transition, or a concurrent change.
 */
export function updateIssueStatus(
  context,
  { actorId, actorRoles, id, tenantAssignmentId, status },
) {
  return context.prisma.$transaction(async (tx) => {
    const current = await tx.issue.findUnique({
      where: { id },
      select: { status: true },
    });
    const role = transitionRole(actorRoles, current.status, status);

    if (!role) {
      throw new ConflictError(MESSAGES.TRANSITION_NOT_ALLOWED);
    }

    if (role === ISSUE_ACTOR_ROLES.TENANT) {
      await lockActiveAssignment(tx, tenantAssignmentId);
    }

    const issue = await updateIfStatusUnchanged(tx, id, current.status, status);

    await logActivity(tx, {
      entityType: ENTITY_TYPES.ISSUE,
      entityId: id,
      action: ACTIVITY_ACTIONS.STATUS_CHANGED,
      performedByUserId: actorId,
      metadata: { fromStatus: current.status, toStatus: issue.status, actorRole: role },
    });

    return toPublicIssue(issue);
  });
}
