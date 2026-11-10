import {
  OwnerAccountStatus,
  OwnerMemberRole,
} from "../../generated/prisma/enums.ts";
import {
  ACTIVITY_ACTIONS,
  ENTITY_TYPES,
  logActivity,
} from "../../lib/activity.js";
import {
  ConflictError,
  isRecordNotFound,
  NotFoundError,
} from "../../lib/errors.js";
import { buildPageQuery, toPage } from "../../lib/pagination.js";

const { APPROVED, PENDING, BLOCKED, PENDING_DELETION } = OwnerAccountStatus;

export const MAX_PRIMARY_ACCOUNTS = 5;
const DELETION_GRACE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const OWNER_ACCOUNT_SELECT = Object.freeze({
  id: true,
  name: true,
  status: true,
  createdAt: true,
  updatedAt: true,
});

const MESSAGES = Object.freeze({
  NOT_FOUND: "Owner account not found.",
  PRIMARY_LIMIT: `You can be the primary owner of at most ${MAX_PRIMARY_ACCOUNTS} owner accounts.`,
  STATUS_CHANGED: "The owner account changed while this request was running. Try again.",
  INVALID_TRANSITION: "This action is not available for the owner account in its current state.",
});

function deletionDate() {
  return new Date(Date.now() + DELETION_GRACE_DAYS * MS_PER_DAY);
}

function scheduleDeletionData(current) {
  return {
    status: PENDING_DELETION,
    statusBeforeDeletion: current.status,
    deletionScheduledAt: deletionDate(),
  };
}

// Accounts scheduled before statusBeforeDeletion existed have no stored status;
// PENDING is the safe fallback because it needs a super admin to approve again.
function cancelDeletionData(current) {
  return {
    status: current.statusBeforeDeletion ?? PENDING,
    statusBeforeDeletion: null,
    deletionScheduledAt: null,
  };
}

const TRANSITIONS = Object.freeze({
  APPROVE: {
    from: [PENDING],
    data: () => ({ status: APPROVED }),
    action: ACTIVITY_ACTIONS.APPROVED,
  },
  BLOCK: {
    from: [PENDING, APPROVED],
    data: () => ({ status: BLOCKED }),
    action: ACTIVITY_ACTIONS.BLOCKED,
  },
  UNBLOCK: {
    from: [BLOCKED],
    data: () => ({ status: APPROVED }),
    action: ACTIVITY_ACTIONS.UNBLOCKED,
  },
  OWNER_SCHEDULE_DELETION: {
    from: [PENDING, APPROVED],
    data: scheduleDeletionData,
    action: ACTIVITY_ACTIONS.DELETION_SCHEDULED,
  },
  ADMIN_SCHEDULE_DELETION: {
    from: [PENDING, APPROVED, BLOCKED],
    data: scheduleDeletionData,
    action: ACTIVITY_ACTIONS.DELETION_SCHEDULED,
  },
  CANCEL_DELETION: {
    from: [PENDING_DELETION],
    data: cancelDeletionData,
    action: ACTIVITY_ACTIONS.DELETION_CANCELLED,
  },
});

/** Converts an OwnerAccount row to the client shape, with ISO 8601 dates. */
export function toPublicOwnerAccount(account) {
  return {
    id: account.id,
    name: account.name,
    status: account.status,
    createdAt: account.createdAt.toISOString(),
    updatedAt: account.updatedAt.toISOString(),
  };
}

async function listPage(prisma, filter, { first, after }) {
  const page = buildPageQuery({ first, after });

  const rows = await prisma.ownerAccount.findMany({
    where: { AND: [filter, page.where] },
    orderBy: page.orderBy,
    take: page.take,
    select: OWNER_ACCOUNT_SELECT,
  });

  return toPage(rows, first, toPublicOwnerAccount);
}

/** Lists, newest first, every owner account the actor is a member of, in any status. */
export function listMyOwnerAccounts(context, { actorId, first, after }) {
  return listPage(
    context.prisma,
    { members: { some: { userId: actorId } } },
    { first, after },
  );
}

/** Lists owner accounts for super admins, optionally filtered by status, newest first. */
export function listAdminOwnerAccounts(context, { status, first, after }) {
  return listPage(context.prisma, status ? { status } : {}, { first, after });
}

// Locking the actor's User row serializes concurrent creates by one user, so the
// primary-account count cannot be raced past MAX_PRIMARY_ACCOUNTS.
async function lockUser(tx, userId) {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
}

/**
 * Creates a PENDING owner account with the actor as PRIMARY member, in one transaction.
 * Throws ConflictError when the actor already is PRIMARY on MAX_PRIMARY_ACCOUNTS accounts.
 */
export function createOwnerAccount(context, { actorId, name }) {
  return context.prisma.$transaction(async (tx) => {
    await lockUser(tx, actorId);

    const primaryCount = await tx.ownerAccountMember.count({
      where: { userId: actorId, role: OwnerMemberRole.PRIMARY },
    });

    if (primaryCount >= MAX_PRIMARY_ACCOUNTS) {
      throw new ConflictError(MESSAGES.PRIMARY_LIMIT);
    }

    const account = await tx.ownerAccount.create({
      data: {
        name,
        status: PENDING,
        members: { create: { userId: actorId, role: OwnerMemberRole.PRIMARY } },
      },
      select: OWNER_ACCOUNT_SELECT,
    });

    await logActivity(tx, {
      entityType: ENTITY_TYPES.OWNER_ACCOUNT,
      entityId: account.id,
      action: ACTIVITY_ACTIONS.CREATED,
      performedByUserId: actorId,
      metadata: { name },
    });

    return toPublicOwnerAccount(account);
  });
}

/** Renames an owner account and logs it, in one transaction. */
export function renameOwnerAccount(context, { actorId, id, name }) {
  return context.prisma.$transaction(async (tx) => {
    const account = await tx.ownerAccount.update({
      where: { id },
      data: { name },
      select: OWNER_ACCOUNT_SELECT,
    });

    await logActivity(tx, {
      entityType: ENTITY_TYPES.OWNER_ACCOUNT,
      entityId: id,
      action: ACTIVITY_ACTIONS.UPDATED,
      performedByUserId: actorId,
      metadata: { name },
    });

    return toPublicOwnerAccount(account);
  });
}

async function updateIfStatusUnchanged(tx, id, status, data) {
  try {
    return await tx.ownerAccount.update({
      where: { id, status },
      data,
      select: OWNER_ACCOUNT_SELECT,
    });
  } catch (error) {
    if (isRecordNotFound(error)) {
      throw new ConflictError(MESSAGES.STATUS_CHANGED);
    }

    throw error;
  }
}

function applyTransition(context, transition, { actorId, id, metadata = {} }) {
  return context.prisma.$transaction(async (tx) => {
    const current = await tx.ownerAccount.findUnique({
      where: { id },
      select: { status: true, statusBeforeDeletion: true },
    });

    if (!current) {
      throw new NotFoundError(MESSAGES.NOT_FOUND);
    }

    if (!transition.from.includes(current.status)) {
      throw new ConflictError(MESSAGES.INVALID_TRANSITION);
    }

    const account = await updateIfStatusUnchanged(
      tx,
      id,
      current.status,
      transition.data(current),
    );

    await logActivity(tx, {
      entityType: ENTITY_TYPES.OWNER_ACCOUNT,
      entityId: id,
      action: transition.action,
      performedByUserId: actorId,
      metadata: { fromStatus: current.status, toStatus: account.status, ...metadata },
    });

    return toPublicOwnerAccount(account);
  });
}

/** PENDING to APPROVED. Throws NotFoundError or ConflictError for any other status. */
export function approveOwnerAccount(context, input) {
  return applyTransition(context, TRANSITIONS.APPROVE, input);
}

/** PENDING or APPROVED to BLOCKED; the optional reason is kept only in the activity log. */
export function blockOwnerAccount(context, { reason, ...input }) {
  const metadata = reason ? { reason } : {};
  return applyTransition(context, TRANSITIONS.BLOCK, { ...input, metadata });
}

/** BLOCKED to APPROVED. Throws NotFoundError or ConflictError for any other status. */
export function unblockOwnerAccount(context, input) {
  return applyTransition(context, TRANSITIONS.UNBLOCK, input);
}

/** PENDING or APPROVED to PENDING_DELETION, remembering the status for cancellation. */
export function scheduleDeletionByOwner(context, input) {
  return applyTransition(context, TRANSITIONS.OWNER_SCHEDULE_DELETION, input);
}

/** PENDING, APPROVED or BLOCKED to PENDING_DELETION, remembering the status for cancellation. */
export function scheduleDeletionByAdmin(context, input) {
  return applyTransition(context, TRANSITIONS.ADMIN_SCHEDULE_DELETION, input);
}

/** PENDING_DELETION back to the stored previous status, clearing the deletion fields. */
export function cancelDeletion(context, input) {
  return applyTransition(context, TRANSITIONS.CANCEL_DELETION, input);
}
