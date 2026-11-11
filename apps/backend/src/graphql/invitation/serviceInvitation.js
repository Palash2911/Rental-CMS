import {
  HouseStatus,
  InvitationStatus,
  OwnerAccountStatus,
  TenantAssignmentStatus,
} from "../../generated/prisma/enums.ts";
import {
  ACTIVITY_ACTIONS,
  ENTITY_TYPES,
  logActivity,
} from "../../lib/activity.js";
import {
  ConflictError,
  ForbiddenError,
  isRecordNotFound,
  isUniqueViolation,
  NotFoundError,
} from "../../lib/errors.js";
import { buildPageQuery, toPage } from "../../lib/pagination.js";
import {
  ACTIVE_ASSIGNMENT_STATUSES,
  lockHouse,
  syncOccupancy,
} from "../house/serviceHouse.js";
import {
  ASSIGNMENT_SELECT,
  toCalendarDate,
  toPublicAssignment,
} from "../tenantAssignment/serviceTenantAssignment.js";

export const INVITATION_EXPIRY_DAYS = 14;
export const MAX_PENDING_INVITATIONS_PER_HOUSE = 50;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const EXPIRED_SUPERSEDED_REASON = "EXPIRED_SUPERSEDED";

const INVITATION_SELECT = Object.freeze({
  id: true,
  houseId: true,
  email: true,
  status: true,
  leaseStartDate: true,
  leaseEndDate: true,
  expiresAt: true,
  respondedAt: true,
  acceptedAssignmentId: true,
  createdAt: true,
  updatedAt: true,
  house: { select: { name: true, ownerAccount: { select: { name: true } } } },
});

const MESSAGES = Object.freeze({
  NOT_FOUND: "Invitation not found.",
  HOUSE_INACTIVE: "This house is inactive and cannot take new tenants.",
  ALREADY_TENANT: "This email address already has an active tenancy on this house.",
  ALREADY_INVITED: "This email address already has a pending invitation for this house.",
  PENDING_LIMIT: `A house can have at most ${MAX_PENDING_INVITATIONS_PER_HOUSE} pending invitations.`,
  NOT_PENDING: "This invitation is no longer pending.",
  EXPIRED: "This invitation has expired.",
  ACCOUNT_NOT_APPROVED:
    "This action is not available for the owner account in its current state.",
  HOUSE_FULL: "This house has no free tenant places.",
  ALREADY_ASSIGNED: "You already have an active tenancy on this house.",
});

function normaliseEmail(email) {
  return email.trim().toLowerCase();
}

function expiryDate(now) {
  return new Date(now.getTime() + INVITATION_EXPIRY_DAYS * MS_PER_DAY);
}

function isExpired(invitation, now) {
  return (
    invitation.status === InvitationStatus.PENDING &&
    invitation.expiresAt.getTime() <= now.getTime()
  );
}

function toIsoOrNull(date) {
  return date ? date.toISOString() : null;
}

/** Converts an Invitation row selected with INVITATION_SELECT to the client shape. */
export function toPublicInvitation(invitation, now = new Date()) {
  return {
    id: invitation.id,
    houseId: invitation.houseId,
    houseName: invitation.house.name,
    ownerAccountName: invitation.house.ownerAccount.name,
    email: invitation.email,
    status: invitation.status,
    expired: isExpired(invitation, now),
    leaseStartDate: toCalendarDate(invitation.leaseStartDate),
    leaseEndDate: invitation.leaseEndDate
      ? toCalendarDate(invitation.leaseEndDate)
      : null,
    expiresAt: invitation.expiresAt.toISOString(),
    respondedAt: toIsoOrNull(invitation.respondedAt),
    acceptedAssignmentId: invitation.acceptedAssignmentId,
    createdAt: invitation.createdAt.toISOString(),
    updatedAt: invitation.updatedAt.toISOString(),
  };
}

async function listPage(prisma, filter, { first, after }) {
  const now = new Date();
  const page = buildPageQuery({ first, after });

  const rows = await prisma.invitation.findMany({
    where: { AND: [filter, page.where] },
    orderBy: page.orderBy,
    take: page.take,
    select: INVITATION_SELECT,
  });

  return toPage(rows, first, (row) => toPublicInvitation(row, now));
}

/** Lists a house's invitations, optionally filtered by stored status, newest first. */
export function listInvitationsByHouse(context, { houseId, status, first, after }) {
  const filter = status ? { houseId, status } : { houseId };
  return listPage(context.prisma, filter, { first, after });
}

/** Lists the PENDING, unexpired invitations sent to the actor's email, newest first. */
export function listMyInvitations(context, { actorEmail, first, after }) {
  // Only invitations from APPROVED accounts are listed: acceptInvitation refuses any
  // other account status, so showing them would offer the tenant an action that fails.
  return listPage(
    context.prisma,
    {
      email: normaliseEmail(actorEmail),
      status: InvitationStatus.PENDING,
      expiresAt: { gt: new Date() },
      house: { ownerAccount: { status: OwnerAccountStatus.APPROVED } },
    },
    { first, after },
  );
}

async function assertHouseAcceptsTenants(tx, houseId) {
  const house = await tx.house.findUnique({
    where: { id: houseId },
    select: { status: true },
  });

  if (house.status === HouseStatus.INACTIVE) {
    throw new ConflictError(MESSAGES.HOUSE_INACTIVE);
  }
}

// User.email keeps the casing Firebase supplied, so it cannot be matched against the
// normalised invitation email with the unique index. The active set is bounded by
// maxTenants, so comparing in memory stays cheap.
async function assertNotActiveTenant(tx, houseId, email) {
  const active = await tx.tenantAssignment.findMany({
    where: { houseId, status: { in: ACTIVE_ASSIGNMENT_STATUSES } },
    select: { tenantProfile: { select: { user: { select: { email: true } } } } },
  });

  const isTenant = active.some(
    ({ tenantProfile }) => normaliseEmail(tenantProfile.user.email) === email,
  );

  if (isTenant) {
    throw new ConflictError(MESSAGES.ALREADY_TENANT);
  }
}

async function supersedeExpiredInvitation(tx, { houseId, email, actorId, now }) {
  const pending = await tx.invitation.findFirst({
    where: { houseId, email, status: InvitationStatus.PENDING },
    select: { id: true, expiresAt: true, status: true },
  });

  if (!pending) {
    return;
  }

  if (!isExpired(pending, now)) {
    throw new ConflictError(MESSAGES.ALREADY_INVITED);
  }

  await tx.invitation.update({
    where: { id: pending.id, status: InvitationStatus.PENDING },
    data: { status: InvitationStatus.REVOKED, respondedAt: now },
    select: { id: true },
  });

  await logActivity(tx, {
    entityType: ENTITY_TYPES.INVITATION,
    entityId: pending.id,
    action: ACTIVITY_ACTIONS.REVOKED,
    performedByUserId: actorId,
    metadata: {
      reason: EXPIRED_SUPERSEDED_REASON,
      fromStatus: InvitationStatus.PENDING,
      toStatus: InvitationStatus.REVOKED,
    },
  });
}

async function assertPendingCapacity(tx, houseId, now) {
  const pendingCount = await tx.invitation.count({
    where: {
      houseId,
      status: InvitationStatus.PENDING,
      expiresAt: { gt: now },
    },
  });

  if (pendingCount >= MAX_PENDING_INVITATIONS_PER_HOUSE) {
    throw new ConflictError(MESSAGES.PENDING_LIMIT);
  }
}

async function insertInvitation(tx, data) {
  try {
    return await tx.invitation.create({ data, select: INVITATION_SELECT });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(MESSAGES.ALREADY_INVITED);
    }

    throw error;
  }
}

/**
 * Creates a PENDING invitation under the house row lock. An expired PENDING invitation for
 * the same house and email is first moved to REVOKED. Throws ConflictError for an INACTIVE
 * house, an email with an active tenancy on the house, an unexpired pending invitation, or
 * MAX_PENDING_INVITATIONS_PER_HOUSE unexpired pending invitations.
 */
export function createInvitation(
  context,
  { actorId, houseId, email, leaseStartDate, leaseEndDate },
) {
  return context.prisma.$transaction(async (tx) => {
    await lockHouse(tx, houseId);
    await assertHouseAcceptsTenants(tx, houseId);
    await assertNotActiveTenant(tx, houseId, email);

    const now = new Date();
    await supersedeExpiredInvitation(tx, { houseId, email, actorId, now });
    await assertPendingCapacity(tx, houseId, now);

    const invitation = await insertInvitation(tx, {
      houseId,
      email,
      invitedByUserId: actorId,
      leaseStartDate,
      leaseEndDate: leaseEndDate ?? null,
      status: InvitationStatus.PENDING,
      expiresAt: expiryDate(now),
    });

    await logActivity(tx, {
      entityType: ENTITY_TYPES.INVITATION,
      entityId: invitation.id,
      action: ACTIVITY_ACTIONS.CREATED,
      performedByUserId: actorId,
      metadata: {
        houseId,
        leaseStartDate: toCalendarDate(invitation.leaseStartDate),
        leaseEndDate: invitation.leaseEndDate
          ? toCalendarDate(invitation.leaseEndDate)
          : null,
        expiresAt: invitation.expiresAt.toISOString(),
      },
    });

    return toPublicInvitation(invitation, now);
  });
}

function assertRespondable(invitation, now) {
  if (invitation.status !== InvitationStatus.PENDING) {
    throw new ConflictError(MESSAGES.NOT_PENDING);
  }

  if (isExpired(invitation, now)) {
    throw new ConflictError(MESSAGES.EXPIRED);
  }
}

// Compare-and-set: a concurrent accept, decline or revoke, or expiry since the read,
// makes the update match no row (P2025), reported as a conflict.
async function respond(tx, { id, now, data }) {
  try {
    return await tx.invitation.update({
      where: { id, status: InvitationStatus.PENDING, expiresAt: { gt: now } },
      data: { ...data, respondedAt: now },
      select: INVITATION_SELECT,
    });
  } catch (error) {
    if (isRecordNotFound(error)) {
      throw new ConflictError(MESSAGES.NOT_PENDING);
    }

    throw error;
  }
}

function logResponse(tx, { invitation, action, actorId }) {
  return logActivity(tx, {
    entityType: ENTITY_TYPES.INVITATION,
    entityId: invitation.id,
    action,
    performedByUserId: actorId,
    metadata: {
      fromStatus: InvitationStatus.PENDING,
      toStatus: invitation.status,
      ...(invitation.acceptedAssignmentId
        ? { acceptedAssignmentId: invitation.acceptedAssignmentId }
        : {}),
    },
  });
}

/**
 * Moves a PENDING, unexpired invitation to REVOKED. `invitation` is the row the guard read.
 * Throws ConflictError when it is no longer pending or has expired.
 */
export function revokeInvitation(context, { actorId, invitation: current }) {
  const now = new Date();
  assertRespondable(current, now);

  return context.prisma.$transaction(async (tx) => {
    const invitation = await respond(tx, {
      id: current.id,
      now,
      data: { status: InvitationStatus.REVOKED },
    });

    await logResponse(tx, { invitation, action: ACTIVITY_ACTIONS.REVOKED, actorId });

    return toPublicInvitation(invitation, now);
  });
}

// Invitations addressed to another email are reported as missing, so a caller can never
// learn that an invitation id exists.
async function findInviteeInvitation(tx, id, actorEmail) {
  const invitation = await tx.invitation.findUnique({
    where: { id },
    select: { id: true, houseId: true, email: true },
  });

  if (!invitation || invitation.email !== normaliseEmail(actorEmail)) {
    throw new NotFoundError(MESSAGES.NOT_FOUND);
  }

  return invitation;
}

/**
 * Moves a PENDING, unexpired invitation addressed to the actor's email to DECLINED.
 * Throws NotFoundError for any other email and ConflictError when no longer pending or expired.
 */
export function declineInvitation(context, { actorId, actorEmail, id }) {
  return context.prisma.$transaction(async (tx) => {
    await findInviteeInvitation(tx, id, actorEmail);

    const now = new Date();
    const current = await tx.invitation.findUnique({
      where: { id },
      select: { status: true, expiresAt: true },
    });
    assertRespondable(current, now);

    const invitation = await respond(tx, {
      id,
      now,
      data: { status: InvitationStatus.DECLINED },
    });

    await logResponse(tx, { invitation, action: ACTIVITY_ACTIONS.DECLINED, actorId });

    return toPublicInvitation(invitation, now);
  });
}

// Lock order is always House, then User. Locking the User row serializes one user's
// concurrent accepts on different houses, so the TenantProfile find-or-create cannot race.
async function lockUser(tx, userId) {
  await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
}

async function loadAcceptTarget(tx, id) {
  return tx.invitation.findUnique({
    where: { id },
    select: {
      status: true,
      expiresAt: true,
      leaseStartDate: true,
      leaseEndDate: true,
      house: {
        select: {
          id: true,
          status: true,
          maxTenants: true,
          ownerAccount: { select: { status: true } },
        },
      },
    },
  });
}

function assertHouseOpen(house) {
  if (house.ownerAccount.status !== OwnerAccountStatus.APPROVED) {
    throw new ForbiddenError(MESSAGES.ACCOUNT_NOT_APPROVED);
  }

  if (house.status === HouseStatus.INACTIVE) {
    throw new ConflictError(MESSAGES.HOUSE_INACTIVE);
  }
}

async function findOrCreateProfile(tx, userId) {
  const existing = await tx.tenantProfile.findUnique({
    where: { userId },
    select: { id: true },
  });

  if (existing) {
    return { id: existing.id, created: false };
  }

  const profile = await tx.tenantProfile.create({
    data: { userId },
    select: { id: true },
  });

  return { id: profile.id, created: true };
}

async function assertCanJoin(tx, { house, tenantProfileId }) {
  const active = await tx.tenantAssignment.findMany({
    where: { houseId: house.id, status: { in: ACTIVE_ASSIGNMENT_STATUSES } },
    select: { tenantProfileId: true },
  });

  if (active.some((row) => row.tenantProfileId === tenantProfileId)) {
    throw new ConflictError(MESSAGES.ALREADY_ASSIGNED);
  }

  if (active.length >= house.maxTenants) {
    throw new ConflictError(MESSAGES.HOUSE_FULL);
  }
}

async function insertAssignment(tx, data) {
  try {
    return await tx.tenantAssignment.create({ data, select: ASSIGNMENT_SELECT });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(MESSAGES.ALREADY_ASSIGNED);
    }

    throw error;
  }
}

async function logAcceptance(tx, { actorId, invitation, assignment, profile }) {
  await logResponse(tx, { invitation, action: ACTIVITY_ACTIONS.ACCEPTED, actorId });

  if (profile.created) {
    await logActivity(tx, {
      entityType: ENTITY_TYPES.TENANT_PROFILE,
      entityId: profile.id,
      action: ACTIVITY_ACTIONS.CREATED,
      performedByUserId: actorId,
      metadata: { invitationId: invitation.id },
    });
  }

  await logActivity(tx, {
    entityType: ENTITY_TYPES.TENANT_ASSIGNMENT,
    entityId: assignment.id,
    action: ACTIVITY_ACTIONS.CREATED,
    performedByUserId: actorId,
    metadata: {
      invitationId: invitation.id,
      houseId: assignment.houseId,
      tenantProfileId: assignment.tenantProfileId,
      leaseStartDate: toCalendarDate(assignment.leaseStartDate),
      leaseEndDate: assignment.leaseEndDate
        ? toCalendarDate(assignment.leaseEndDate)
        : null,
    },
  });
}

/**
 * Accepts an invitation addressed to the actor's email in one transaction under the house
 * row lock: re-checks the invitation, account status, house status, capacity and existing
 * tenancy, then creates the TenantProfile if missing and an ACTIVE TenantAssignment, sets
 * the house OCCUPIED and marks the invitation ACCEPTED. Returns the assignment.
 * Throws NotFoundError for any other email, ForbiddenError when the account is not
 * APPROVED and ConflictError for every other failed check.
 */
export function acceptInvitation(context, { actorId, actorEmail, id }) {
  return context.prisma.$transaction(async (tx) => {
    const { houseId } = await findInviteeInvitation(tx, id, actorEmail);

    await lockHouse(tx, houseId);
    await lockUser(tx, actorId);

    const now = new Date();
    const target = await loadAcceptTarget(tx, id);
    assertRespondable(target, now);
    assertHouseOpen(target.house);

    const profile = await findOrCreateProfile(tx, actorId);
    await assertCanJoin(tx, { house: target.house, tenantProfileId: profile.id });

    const assignment = await insertAssignment(tx, {
      tenantProfileId: profile.id,
      houseId,
      status: TenantAssignmentStatus.ACTIVE,
      leaseStartDate: target.leaseStartDate,
      leaseEndDate: target.leaseEndDate,
    });

    await syncOccupancy(tx, { houseId, actorId });

    const invitation = await respond(tx, {
      id,
      now,
      data: {
        status: InvitationStatus.ACCEPTED,
        acceptedAssignmentId: assignment.id,
      },
    });

    await logAcceptance(tx, { actorId, invitation, assignment, profile });

    return toPublicAssignment(assignment);
  });
}
