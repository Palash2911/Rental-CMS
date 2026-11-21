import { InvitationStatus, OwnerMemberRole } from "../../generated/prisma/enums.ts";
import {
  ACTIVITY_ACTIONS,
  ENTITY_TYPES,
  logActivity,
} from "../../lib/activity.js";
import { ACCOUNT_STATUSES } from "../../lib/auth.js";
import {
  ACCESS,
  computeEntitlement,
  ENTITLEMENT_FIELDS,
  READ_ONLY_MESSAGE,
} from "../../lib/entitlement.js";
import {
  ConflictError,
  ForbiddenError,
  isRecordNotFound,
  isUniqueViolation,
  NotFoundError,
} from "../../lib/errors.js";
import { memberInvitationEmail } from "../../email/events.js";
import { withEmails } from "../../email/queue.js";
import { buildPageQuery, toPage } from "../../lib/pagination.js";
import { lockOwnerAccount } from "../billing/subscriptionStore.js";
import { INVITATION_EXPIRY_DAYS } from "../invitation/serviceInvitation.js";
import { lockUser, MAX_PRIMARY_ACCOUNTS } from "../ownerAccount/serviceOwnerAccount.js";

export const MAX_MEMBERS_PER_ACCOUNT = 10;
export const MAX_PENDING_MEMBER_INVITATIONS_PER_ACCOUNT = 20;
const MS_PER_DAY = 24 * 60 * 60 * 1000;
const EXPIRED_SUPERSEDED_REASON = "EXPIRED_SUPERSEDED";

const MEMBER_SELECT = Object.freeze({
  id: true,
  userId: true,
  role: true,
  createdAt: true,
  user: { select: { name: true, email: true } },
});

const MEMBER_INVITATION_SELECT = Object.freeze({
  id: true,
  ownerAccountId: true,
  email: true,
  status: true,
  expiresAt: true,
  respondedAt: true,
  createdAt: true,
  updatedAt: true,
  ownerAccount: { select: { name: true } },
});

const MESSAGES = Object.freeze({
  INVITATION_NOT_FOUND: "Invitation not found.",
  OWNER_ACCOUNT_NOT_FOUND: "Owner account not found.",
  MEMBER_NOT_FOUND: "Member not found.",
  ALREADY_MEMBER: "This email address already belongs to a member of this owner account.",
  YOU_ARE_MEMBER: "You are already a member of this owner account.",
  ALREADY_INVITED: "This email address already has a pending invitation for this owner account.",
  MEMBER_LIMIT: `An owner account can have at most ${MAX_MEMBERS_PER_ACCOUNT} members.`,
  PENDING_LIMIT: `An owner account can have at most ${MAX_PENDING_MEMBER_INVITATIONS_PER_ACCOUNT} pending member invitations.`,
  NOT_PENDING: "This invitation is no longer pending.",
  EXPIRED: "This invitation has expired.",
  STATUS_NOT_ALLOWED: "This action is not available for the owner account in its current state.",
  ROLE_NOT_ALLOWED: "Your role on this owner account does not allow this action.",
  PRIMARY_CANNOT_BE_REMOVED: "The primary owner cannot be removed.",
  PRIMARY_CANNOT_LEAVE: "The primary owner cannot leave the owner account. Transfer ownership first.",
  ALREADY_PRIMARY: "You are already the primary owner of this owner account.",
  NEW_PRIMARY_LIMIT: `The new primary owner already owns the maximum of ${MAX_PRIMARY_ACCOUNTS} owner accounts.`,
  OWNERSHIP_CHANGED: "The ownership of this owner account changed while this request was running. Try again.",
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

/** Converts an OwnerAccountMember row selected with MEMBER_SELECT to the client shape. */
export function toPublicMember(member) {
  return {
    id: member.id,
    name: member.user.name,
    email: member.user.email,
    role: member.role,
    joinedAt: member.createdAt.toISOString(),
  };
}

/** Converts a MemberInvitation row selected with MEMBER_INVITATION_SELECT to the client shape. */
export function toPublicMemberInvitation(invitation, now = new Date()) {
  return {
    id: invitation.id,
    ownerAccountId: invitation.ownerAccountId,
    ownerAccountName: invitation.ownerAccount.name,
    email: invitation.email,
    status: invitation.status,
    expired: isExpired(invitation, now),
    expiresAt: invitation.expiresAt.toISOString(),
    respondedAt: invitation.respondedAt ? invitation.respondedAt.toISOString() : null,
    createdAt: invitation.createdAt.toISOString(),
    updatedAt: invitation.updatedAt.toISOString(),
  };
}

/** Lists an account's members, newest first. */
export async function listMembersByAccount(context, { ownerAccountId, first, after }) {
  const page = buildPageQuery({ first, after });

  const rows = await context.prisma.ownerAccountMember.findMany({
    where: { AND: [{ ownerAccountId }, page.where] },
    orderBy: page.orderBy,
    take: page.take,
    select: MEMBER_SELECT,
  });

  return toPage(rows, first, toPublicMember);
}

async function listInvitationPage(prisma, filter, { first, after }) {
  const now = new Date();
  const page = buildPageQuery({ first, after });

  const rows = await prisma.memberInvitation.findMany({
    where: { AND: [filter, page.where] },
    orderBy: page.orderBy,
    take: page.take,
    select: MEMBER_INVITATION_SELECT,
  });

  return toPage(rows, first, (row) => toPublicMemberInvitation(row, now));
}

/** Lists an account's member invitations, optionally filtered by stored status, newest first. */
export function listMemberInvitationsByAccount(context, { ownerAccountId, status, first, after }) {
  const filter = status ? { ownerAccountId, status } : { ownerAccountId };
  return listInvitationPage(context.prisma, filter, { first, after });
}

/** Lists the PENDING, unexpired member invitations sent to the actor's email, newest first. */
export function listMyMemberInvitations(context, { actorEmail, first, after }) {
  // Only accounts whose status lets a member join are listed, since accepting refuses others.
  return listInvitationPage(
    context.prisma,
    {
      email: normaliseEmail(actorEmail),
      status: InvitationStatus.PENDING,
      expiresAt: { gt: new Date() },
      ownerAccount: { status: { in: ACCOUNT_STATUSES.MEMBER_ACCOUNT_WRITE } },
    },
    { first, after },
  );
}

/**
 * Locks the owner account, then re-checks under the lock what the guard checked before it:
 * a status that allows member writes and billing that is not read-only. A block, deletion
 * schedule or webhook that committed after the guard is therefore always seen.
 */
// `allowReadOnly` skips the billing check, matching the guard option of the same name.
async function lockWritableAccount(
  tx,
  ownerAccountId,
  { allowReadOnly = false, statuses = ACCOUNT_STATUSES.MEMBER_ACCOUNT_WRITE } = {},
) {
  const account = await lockOwnerAccount(tx, ownerAccountId);

  if (!account) {
    throw new NotFoundError(MESSAGES.OWNER_ACCOUNT_NOT_FOUND);
  }

  if (!statuses.includes(account.status)) {
    throw new ForbiddenError(MESSAGES.STATUS_NOT_ALLOWED);
  }

  if (allowReadOnly) {
    return;
  }

  const subscription = await tx.subscription.findUnique({
    where: { ownerAccountId },
    select: ENTITLEMENT_FIELDS,
  });

  if (computeEntitlement(account.status, subscription).access === ACCESS.READ_ONLY) {
    throw new ForbiddenError(READ_ONLY_MESSAGE);
  }
}

function findMembership(tx, ownerAccountId, userId) {
  return tx.ownerAccountMember.findUnique({
    where: { userId_ownerAccountId: { userId, ownerAccountId } },
    select: MEMBER_SELECT,
  });
}

// A membership id from another account is reported as missing, like one that never existed.
async function findMembershipById(tx, ownerAccountId, memberId) {
  const member = await tx.ownerAccountMember.findUnique({
    where: { id: memberId },
    select: { ...MEMBER_SELECT, ownerAccountId: true },
  });

  return member?.ownerAccountId === ownerAccountId ? member : null;
}

// The guard read the actor's role before the account lock; a transfer that committed since
// may have made them a CO_OWNER.
async function assertStillPrimary(tx, ownerAccountId, actorId) {
  const actor = await findMembership(tx, ownerAccountId, actorId);

  if (actor?.role !== OwnerMemberRole.PRIMARY) {
    throw new ForbiddenError(MESSAGES.ROLE_NOT_ALLOWED);
  }

  return actor;
}

async function assertMemberCapacity(tx, ownerAccountId) {
  const count = await tx.ownerAccountMember.count({ where: { ownerAccountId } });

  if (count >= MAX_MEMBERS_PER_ACCOUNT) {
    throw new ConflictError(MESSAGES.MEMBER_LIMIT);
  }
}

// User.email keeps the casing Firebase supplied, so members are compared in memory; the
// set is bounded by MAX_MEMBERS_PER_ACCOUNT.
async function assertNotMemberEmail(tx, ownerAccountId, email) {
  const members = await tx.ownerAccountMember.findMany({
    where: { ownerAccountId },
    select: { user: { select: { email: true } } },
  });

  if (members.some(({ user }) => normaliseEmail(user.email) === email)) {
    throw new ConflictError(MESSAGES.ALREADY_MEMBER);
  }
}

async function supersedeExpiredInvitation(tx, { ownerAccountId, email, actorId, now }) {
  const pending = await tx.memberInvitation.findFirst({
    where: { ownerAccountId, email, status: InvitationStatus.PENDING },
    select: { id: true, status: true, expiresAt: true },
  });

  if (!pending) {
    return;
  }

  if (!isExpired(pending, now)) {
    throw new ConflictError(MESSAGES.ALREADY_INVITED);
  }

  await tx.memberInvitation.update({
    where: { id: pending.id, status: InvitationStatus.PENDING },
    data: { status: InvitationStatus.REVOKED, respondedAt: now },
    select: { id: true },
  });

  await logActivity(tx, {
    entityType: ENTITY_TYPES.MEMBER_INVITATION,
    entityId: pending.id,
    action: ACTIVITY_ACTIONS.REVOKED,
    ownerAccountId,
    performedByUserId: actorId,
    metadata: {
      reason: EXPIRED_SUPERSEDED_REASON,
      fromStatus: InvitationStatus.PENDING,
      toStatus: InvitationStatus.REVOKED,
    },
  });
}

async function assertPendingCapacity(tx, ownerAccountId, now) {
  const count = await tx.memberInvitation.count({
    where: { ownerAccountId, status: InvitationStatus.PENDING, expiresAt: { gt: now } },
  });

  if (count >= MAX_PENDING_MEMBER_INVITATIONS_PER_ACCOUNT) {
    throw new ConflictError(MESSAGES.PENDING_LIMIT);
  }
}

async function insertInvitation(tx, data) {
  try {
    return await tx.memberInvitation.create({ data, select: MEMBER_INVITATION_SELECT });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(MESSAGES.ALREADY_INVITED);
    }

    throw error;
  }
}

/**
 * Creates a PENDING co-owner invitation under the OwnerAccount lock. An expired PENDING
 * invitation for the same account and email is first moved to REVOKED. Throws ForbiddenError
 * when the account no longer allows member writes, and ConflictError for an existing member,
 * an unexpired pending invitation, a full account or too many pending invitations.
 */
export function createMemberInvitation(context, { actorId, ownerAccountId, email }) {
  return withEmails(context.notifier, (emails) => context.prisma.$transaction(async (tx) => {
    await lockWritableAccount(tx, ownerAccountId, { statuses: ACCOUNT_STATUSES.MEMBER_INVITE });
    await assertStillPrimary(tx, ownerAccountId, actorId);
    await assertNotMemberEmail(tx, ownerAccountId, email);
    await assertMemberCapacity(tx, ownerAccountId);

    const now = new Date();
    await supersedeExpiredInvitation(tx, { ownerAccountId, email, actorId, now });
    await assertPendingCapacity(tx, ownerAccountId, now);

    const invitation = await insertInvitation(tx, {
      ownerAccountId,
      email,
      invitedByUserId: actorId,
      status: InvitationStatus.PENDING,
      expiresAt: expiryDate(now),
    });

    await logActivity(tx, {
      entityType: ENTITY_TYPES.MEMBER_INVITATION,
      entityId: invitation.id,
      action: ACTIVITY_ACTIONS.CREATED,
      ownerAccountId,
      performedByUserId: actorId,
      metadata: { ownerAccountId, expiresAt: invitation.expiresAt.toISOString() },
    });

    emails.push(memberInvitationEmail({ ownerAccountId, memberInvitationId: invitation.id }));

    return toPublicMemberInvitation(invitation, now);
  }));
}

function assertRespondable(invitation, now) {
  if (invitation.status !== InvitationStatus.PENDING) {
    throw new ConflictError(MESSAGES.NOT_PENDING);
  }

  if (isExpired(invitation, now)) {
    throw new ConflictError(MESSAGES.EXPIRED);
  }
}

// Compare-and-set: a concurrent response, or expiry since the read, matches no row (P2025).
async function respond(tx, { id, now, data }) {
  try {
    return await tx.memberInvitation.update({
      where: { id, status: InvitationStatus.PENDING, expiresAt: { gt: now } },
      data: { ...data, respondedAt: now },
      select: MEMBER_INVITATION_SELECT,
    });
  } catch (error) {
    if (isRecordNotFound(error)) {
      throw new ConflictError(MESSAGES.NOT_PENDING);
    }

    throw error;
  }
}

function logResponse(tx, { invitation, action, actorId, metadata = {} }) {
  return logActivity(tx, {
    entityType: ENTITY_TYPES.MEMBER_INVITATION,
    entityId: invitation.id,
    action,
    ownerAccountId: invitation.ownerAccountId,
    performedByUserId: actorId,
    metadata: { fromStatus: InvitationStatus.PENDING, toStatus: invitation.status, ...metadata },
  });
}

/**
 * Moves a PENDING, unexpired member invitation to REVOKED. `invitation` is the row the guard
 * read. Throws ConflictError when it is no longer pending or has expired.
 */
export function revokeMemberInvitation(context, { actorId, invitation: current }) {
  const now = new Date();
  assertRespondable(current, now);

  return context.prisma.$transaction(async (tx) => {
    const invitation = await respond(tx, {
      id: current.id,
      now,
      data: { status: InvitationStatus.REVOKED },
    });

    await logResponse(tx, { invitation, action: ACTIVITY_ACTIONS.REVOKED, actorId });

    return toPublicMemberInvitation(invitation, now);
  });
}

// Invitations addressed to another email are reported as missing, so a caller can never
// learn that an invitation id exists.
async function findInviteeInvitation(tx, id, actorEmail) {
  const invitation = await tx.memberInvitation.findUnique({
    where: { id },
    select: { id: true, ownerAccountId: true, email: true },
  });

  if (!invitation || invitation.email !== normaliseEmail(actorEmail)) {
    throw new NotFoundError(MESSAGES.INVITATION_NOT_FOUND);
  }

  return invitation;
}

async function loadRespondable(tx, id, now) {
  const current = await tx.memberInvitation.findUnique({
    where: { id },
    select: { status: true, expiresAt: true },
  });
  assertRespondable(current, now);
}

/**
 * Moves a PENDING, unexpired member invitation addressed to the actor's email to DECLINED.
 * Allowed in any account state. Throws NotFoundError for any other email and ConflictError
 * when it is no longer pending or has expired.
 */
export function declineMemberInvitation(context, { actorId, actorEmail, id }) {
  return context.prisma.$transaction(async (tx) => {
    await findInviteeInvitation(tx, id, actorEmail);

    const now = new Date();
    await loadRespondable(tx, id, now);

    const invitation = await respond(tx, {
      id,
      now,
      data: { status: InvitationStatus.DECLINED },
    });

    await logResponse(tx, { invitation, action: ACTIVITY_ACTIONS.DECLINED, actorId });

    return toPublicMemberInvitation(invitation, now);
  });
}

async function insertMember(tx, data) {
  try {
    return await tx.ownerAccountMember.create({ data, select: MEMBER_SELECT });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(MESSAGES.YOU_ARE_MEMBER);
    }

    throw error;
  }
}

/**
 * Accepts a member invitation addressed to the actor's email: under the OwnerAccount lock it
 * re-checks the invitation, the account's status and billing, membership and the member cap,
 * then creates a CO_OWNER membership and marks the invitation ACCEPTED, in one transaction.
 * Throws NotFoundError for any other email, ForbiddenError when the account does not allow
 * member writes, and ConflictError when not pending, expired, already a member or full.
 */
export function acceptMemberInvitation(context, { actorId, actorEmail, id }) {
  return context.prisma.$transaction(async (tx) => {
    const { ownerAccountId } = await findInviteeInvitation(tx, id, actorEmail);

    await lockWritableAccount(tx, ownerAccountId);

    const now = new Date();
    await loadRespondable(tx, id, now);

    if (await findMembership(tx, ownerAccountId, actorId)) {
      throw new ConflictError(MESSAGES.YOU_ARE_MEMBER);
    }

    await assertMemberCapacity(tx, ownerAccountId);

    const member = await insertMember(tx, {
      ownerAccountId,
      userId: actorId,
      role: OwnerMemberRole.CO_OWNER,
    });

    const invitation = await respond(tx, {
      id,
      now,
      data: { status: InvitationStatus.ACCEPTED },
    });

    await logResponse(tx, {
      invitation,
      action: ACTIVITY_ACTIONS.ACCEPTED,
      actorId,
      metadata: { memberId: member.id },
    });

    await logActivity(tx, {
      entityType: ENTITY_TYPES.OWNER_ACCOUNT_MEMBER,
      entityId: member.id,
      action: ACTIVITY_ACTIONS.CREATED,
      ownerAccountId,
      performedByUserId: actorId,
      metadata: { ownerAccountId, userId: actorId, role: member.role, memberInvitationId: id },
    });

    return toPublicMember(member);
  });
}

async function deleteMember(tx, { member, ownerAccountId, actorId, action }) {
  await tx.ownerAccountMember.delete({ where: { id: member.id }, select: { id: true } });

  await logActivity(tx, {
    entityType: ENTITY_TYPES.OWNER_ACCOUNT_MEMBER,
    entityId: member.id,
    action,
    ownerAccountId,
    performedByUserId: actorId,
    metadata: { ownerAccountId, userId: member.userId, role: member.role },
  });

  return toPublicMember(member);
}

/**
 * Removes a CO_OWNER from the account (the actor must still be PRIMARY under the lock).
 * Returns the removed member. Throws NotFoundError for a non-member and ForbiddenError for
 * the PRIMARY member or an account that does not allow member writes.
 */
// Allowed on a read-only account (project owner, like leaveAccount): removing a co-owner
// must not depend on paying.
export function removeMember(context, { actorId, ownerAccountId, memberId }) {
  return context.prisma.$transaction(async (tx) => {
    await lockWritableAccount(tx, ownerAccountId, { allowReadOnly: true });
    await assertStillPrimary(tx, ownerAccountId, actorId);

    const member = await findMembershipById(tx, ownerAccountId, memberId);

    if (!member) {
      throw new NotFoundError(MESSAGES.MEMBER_NOT_FOUND);
    }

    if (member.role === OwnerMemberRole.PRIMARY) {
      throw new ForbiddenError(MESSAGES.PRIMARY_CANNOT_BE_REMOVED);
    }

    return deleteMember(tx, { member, ownerAccountId, actorId, action: ACTIVITY_ACTIONS.REMOVED });
  });
}

/**
 * Removes the actor's own CO_OWNER membership. Returns it. Throws ForbiddenError for the
 * PRIMARY member or an account that does not allow member writes, and NotFoundError when the
 * actor is no longer a member.
 */
// Allowed while billing makes the account read-only (project owner); status is still checked.
export function leaveAccount(context, { actorId, ownerAccountId }) {
  return context.prisma.$transaction(async (tx) => {
    await lockWritableAccount(tx, ownerAccountId, { allowReadOnly: true });

    const member = await findMembership(tx, ownerAccountId, actorId);

    if (!member) {
      throw new NotFoundError(MESSAGES.OWNER_ACCOUNT_NOT_FOUND);
    }

    if (member.role === OwnerMemberRole.PRIMARY) {
      throw new ForbiddenError(MESSAGES.PRIMARY_CANNOT_LEAVE);
    }

    return deleteMember(tx, { member, ownerAccountId, actorId, action: ACTIVITY_ACTIONS.LEFT });
  });
}

async function assertBelowPrimaryLimit(tx, userId) {
  await lockUser(tx, userId);

  const count = await tx.ownerAccountMember.count({
    where: { userId, role: OwnerMemberRole.PRIMARY },
  });

  if (count >= MAX_PRIMARY_ACCOUNTS) {
    throw new ConflictError(MESSAGES.NEW_PRIMARY_LIMIT);
  }
}

// Demote first: the one-PRIMARY partial unique index is checked per statement, so promoting
// first would violate it. A violation still means a concurrent change slipped past the lock.
async function swapRoles(tx, { previous, next }) {
  try {
    const previousPrimary = await tx.ownerAccountMember.update({
      where: { id: previous.id },
      data: { role: OwnerMemberRole.CO_OWNER },
      select: MEMBER_SELECT,
    });
    const newPrimary = await tx.ownerAccountMember.update({
      where: { id: next.id },
      data: { role: OwnerMemberRole.PRIMARY },
      select: MEMBER_SELECT,
    });

    return { previousPrimary, newPrimary };
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(MESSAGES.OWNERSHIP_CHANGED);
    }

    throw error;
  }
}

function findCustomerEmailTarget(prisma, ownerAccountId) {
  return Promise.all([
    prisma.subscription.findUnique({
      where: { ownerAccountId },
      select: { stripeCustomerId: true },
    }),
    prisma.ownerAccountMember.findFirst({
      where: { ownerAccountId, role: OwnerMemberRole.PRIMARY },
      select: { userId: true, user: { select: { email: true } } },
    }),
  ]);
}

/**
 * Points the account's Stripe customer at the current PRIMARY's email. Runs after the
 * transfer commits, so no row lock is held during the network call, and it reads the
 * PRIMARY afresh so a later transfer's sync can never be overwritten by this one's stale
 * email. A Stripe failure never undoes the transfer: it is recorded as
 * CUSTOMER_EMAIL_SYNC_FAILED on the Subscription for a later retry.
 */
async function syncCustomerEmail(context, { ownerAccountId, actorId }) {
  const [subscription, primary] = await findCustomerEmailTarget(context.prisma, ownerAccountId);

  if (!subscription?.stripeCustomerId || !primary) {
    return;
  }

  try {
    await context.billingGateway.updateCustomerEmail({
      customerId: subscription.stripeCustomerId,
      email: primary.user.email,
    });
  } catch (error) {
    await recordCustomerEmailSyncFailure(context, {
      ownerAccountId,
      actorId,
      stripeCustomerId: subscription.stripeCustomerId,
      primaryUserId: primary.userId,
      errorType: typeof error?.type === "string" ? error.type : null,
    });
  }
}

// The transfer has already committed, so a failure here must not fail the request (project
// owner). The server log is then the only record; it names ids, never the email.
async function recordCustomerEmailSyncFailure(context, { actorId, ...metadata }) {
  try {
    await context.prisma.$transaction((tx) =>
      logActivity(tx, {
        entityType: ENTITY_TYPES.SUBSCRIPTION,
        entityId: metadata.ownerAccountId,
        action: ACTIVITY_ACTIONS.CUSTOMER_EMAIL_SYNC_FAILED,
        ownerAccountId: metadata.ownerAccountId,
        performedByUserId: actorId,
        metadata,
      }),
    );
  } catch (error) {
    // context.log is Yoga's request-scoped logger (graphql-yoga 6 puts it on the server
    // context; createContext's fields are merged onto it).
    context.log.error(
      {
        err: error,
        ownerAccountId: metadata.ownerAccountId,
        primaryUserId: metadata.primaryUserId,
      },
      "Could not record CUSTOMER_EMAIL_SYNC_FAILED after an ownership transfer.",
    );
  }
}

/**
 * Makes an existing CO_OWNER the PRIMARY member and the actor a CO_OWNER, in one transaction
 * under the OwnerAccount lock, then the new PRIMARY's User lock for the primary-account cap.
 * Throws ForbiddenError when the actor is no longer PRIMARY or the account does not allow
 * member writes, NotFoundError when the target is not a member, and ConflictError for a
 * transfer to oneself or a target at MAX_PRIMARY_ACCOUNTS.
 */
// After the commit, updates the Stripe customer's email (see syncCustomerEmail).
export async function transferOwnership(context, { actorId, ownerAccountId, newPrimaryMemberId }) {
  const transfer = await commitOwnershipTransfer(context, {
    actorId,
    ownerAccountId,
    newPrimaryMemberId,
  });

  await syncCustomerEmail(context, { ownerAccountId, actorId });

  return transfer;
}

function commitOwnershipTransfer(context, { actorId, ownerAccountId, newPrimaryMemberId }) {
  return context.prisma.$transaction(async (tx) => {
    await lockWritableAccount(tx, ownerAccountId);
    const previous = await assertStillPrimary(tx, ownerAccountId, actorId);

    const next = await findMembershipById(tx, ownerAccountId, newPrimaryMemberId);

    if (!next) {
      throw new NotFoundError(MESSAGES.MEMBER_NOT_FOUND);
    }

    if (next.userId === actorId) {
      throw new ConflictError(MESSAGES.ALREADY_PRIMARY);
    }

    const newPrimaryUserId = next.userId;
    await assertBelowPrimaryLimit(tx, newPrimaryUserId);

    const { previousPrimary, newPrimary } = await swapRoles(tx, { previous, next });

    await logActivity(tx, {
      entityType: ENTITY_TYPES.OWNER_ACCOUNT,
      entityId: ownerAccountId,
      action: ACTIVITY_ACTIONS.OWNERSHIP_TRANSFERRED,
      ownerAccountId,
      performedByUserId: actorId,
      metadata: { fromUserId: actorId, toUserId: newPrimaryUserId },
    });

    return {
      previousPrimary: toPublicMember(previousPrimary),
      newPrimary: toPublicMember(newPrimary),
    };
  });
}
