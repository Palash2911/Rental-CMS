import { randomBytes } from "node:crypto";

import {
  BillingInterval,
  BillingPlan,
  HouseStatus,
  InvitationStatus,
  IssueStatus,
  LeaveRequestStatus,
  OwnerAccountStatus,
  OwnerMemberRole,
  TenantAssignmentStatus,
} from "../../src/generated/prisma/enums.ts";
import { newReceiptFileKey } from "../../src/graphql/receipts/receiptFiles.js";
import { prisma } from "./db.js";
import { redis as testRedis } from "./redis.js";
import { unexpectedStorageGateway } from "./storage.js";
import { unexpectedStripeGateway } from "./stripe.js";

const FIREBASE_UID_LENGTH = 28;
const EMAIL_DOMAIN = "example.test";
const DEFAULT_LEASE_START = new Date("2026-01-01T00:00:00.000Z");
const DEFAULT_INVITATION_LEASE_START = new Date("2026-12-01T00:00:00.000Z");
const INVITATION_EXPIRY_MS = 14 * 24 * 60 * 60 * 1000;
const EXPIRED_AGO_MS = 60 * 1000;

/** A random id shaped like a Firebase UID: 28 characters of letters, digits, "_" and "-". */
export function firebaseUid() {
  return randomBytes(FIREBASE_UID_LENGTH).toString("base64url").slice(0, FIREBASE_UID_LENGTH);
}

/** A unique email address on a reserved test domain. */
export function uniqueEmail(label = "user") {
  return `${label}-${firebaseUid().toLowerCase()}@${EMAIL_DOMAIN}`;
}

/** Inserts a User row directly, as if the person had signed in before. */
export function createUser({ email = uniqueEmail(), name = "Test User", isBlocked = false } = {}) {
  return prisma.user.create({
    data: { id: firebaseUid(), email, name, isBlocked },
  });
}

const LOG_LEVELS = Object.freeze(["trace", "debug", "info", "warn", "error"]);

/**
 * A stand-in for Yoga's request-scoped logger (`context.log`): silent, and records each call
 * as `{ level, args }` in `entries` so tests can assert on it.
 */
export function recordingLogger() {
  const entries = [];
  const logger = { entries };

  for (const level of LOG_LEVELS) {
    logger[level] = (...args) => {
      entries.push({ level, args });
    };
  }

  return logger;
}

/**
 * Builds a request context for a token, the way createContext would after verifying it.
 * Each call returns a new object, so the per-request user cache never leaks between calls.
 */
// It also carries the `log` Yoga adds to every request's context, and the shared test Redis.
export function tokenContext({
  userId,
  email = null,
  emailVerified = true,
  name = null,
  superAdmin = false,
  liveSuperAdmin = superAdmin,
  billingGateway = unexpectedStripeGateway(),
  storageGateway = unexpectedStorageGateway(),
  log = recordingLogger(),
  redis = testRedis,
}) {
  return {
    log,
    prisma,
    userId,
    email,
    emailVerified,
    name,
    isSuperAdmin: superAdmin,
    hasLiveSuperAdminClaim: async () => liveSuperAdmin,
    billingGateway,
    storageGateway,
    redis,
  };
}

/** A context for an existing user whose token matches the stored row. */
export function contextFor(user, options = {}) {
  return tokenContext({
    userId: user.id,
    email: user.email,
    name: user.name,
    ...options,
  });
}

/** A request with no Authorization header. */
export function anonymousContext() {
  return tokenContext({ userId: null, emailVerified: false });
}

/**
 * A paid subscription with full access and the largest Stripe plan, so tests that are not
 * about billing are never limited by it. Billing tests pass their own `billing`, or null.
 */
export const DEFAULT_BILLING = Object.freeze({
  plan: BillingPlan.PRO,
  interval: BillingInterval.MONTH,
  stripeStatus: "active",
});

/**
 * Creates an owner account with `owner` as a member (PRIMARY by default), and a Subscription
 * row from `billing` (DEFAULT_BILLING unless given; null creates no row).
 */
export function createOwnerAccount(
  owner,
  {
    status = OwnerAccountStatus.APPROVED,
    name = "Test Rentals",
    role = OwnerMemberRole.PRIMARY,
    billing = DEFAULT_BILLING,
    ...extra
  } = {},
) {
  return prisma.ownerAccount.create({
    data: {
      name,
      status,
      ...extra,
      members: { create: { userId: owner.id, role } },
      ...(billing ? { subscription: { create: { ...billing } } } : {}),
    },
  });
}

/** Replaces an account's Subscription columns directly (test setup only). */
export function setBilling(account, billing) {
  return prisma.subscription.upsert({
    where: { ownerAccountId: account.id },
    create: { ownerAccountId: account.id, ...billing },
    update: billing,
  });
}

/** Adds `user` to an owner account with the given role. */
export function addMember(account, user, role = OwnerMemberRole.CO_OWNER) {
  return prisma.ownerAccountMember.create({
    data: { ownerAccountId: account.id, userId: user.id, role },
  });
}

/** Creates a house on an owner account. */
export function createHouse(
  account,
  { name = "Unit 1", location = "1 Test Street", maxTenants = 3, status = HouseStatus.VACANT } = {},
) {
  return prisma.house.create({
    data: { ownerAccountId: account.id, name, location, maxTenants, status },
  });
}

/**
 * Gives `tenant` an assignment on `house` directly (test setup only; the API creates
 * assignments through acceptInvitation). Sets the house OCCUPIED for an active assignment.
 */
export async function createAssignment(
  house,
  tenant,
  { status = TenantAssignmentStatus.ACTIVE, plannedExitDate = null } = {},
) {
  const profile = await prisma.tenantProfile.upsert({
    where: { userId: tenant.id },
    create: { userId: tenant.id },
    update: {},
  });

  const assignment = await prisma.tenantAssignment.create({
    data: {
      tenantProfileId: profile.id,
      houseId: house.id,
      status,
      leaseStartDate: DEFAULT_LEASE_START,
      plannedExitDate,
    },
  });

  if (status !== TenantAssignmentStatus.EXITED) {
    await prisma.house.update({ where: { id: house.id }, data: { status: HouseStatus.OCCUPIED } });
  }

  return assignment;
}

/** Inserts an invitation directly (test setup only). Defaults: PENDING, expiring in 14 days. */
export function createInvitation(
  house,
  inviter,
  {
    email = uniqueEmail("invitee"),
    status = InvitationStatus.PENDING,
    expiresAt = new Date(Date.now() + INVITATION_EXPIRY_MS),
    leaseStartDate = DEFAULT_INVITATION_LEASE_START,
    leaseEndDate = null,
    respondedAt = null,
  } = {},
) {
  return prisma.invitation.create({
    data: {
      houseId: house.id,
      email,
      invitedByUserId: inviter.id,
      status,
      expiresAt,
      leaseStartDate,
      leaseEndDate,
      respondedAt,
    },
  });
}

/** Inserts a member invitation directly (test setup only). Defaults: PENDING, expiring in 14 days. */
export function createMemberInvitation(
  account,
  inviter,
  {
    email = uniqueEmail("member-invitee"),
    status = InvitationStatus.PENDING,
    expiresAt = new Date(Date.now() + INVITATION_EXPIRY_MS),
    respondedAt = null,
  } = {},
) {
  return prisma.memberInvitation.create({
    data: { ownerAccountId: account.id, email, invitedByUserId: inviter.id, status, expiresAt, respondedAt },
  });
}

/** Inserts `count` PENDING, unexpired invitations to distinct emails in one statement. */
export function createPendingInvitations(house, inviter, count) {
  const expiresAt = new Date(Date.now() + INVITATION_EXPIRY_MS);

  return prisma.invitation.createMany({
    data: Array.from({ length: count }, () => ({
      houseId: house.id,
      email: uniqueEmail("pending"),
      invitedByUserId: inviter.id,
      status: InvitationStatus.PENDING,
      expiresAt,
      leaseStartDate: DEFAULT_INVITATION_LEASE_START,
    })),
  });
}

/** Moves an invitation's expiry one minute into the past. */
export function expireInvitation(invitation) {
  return prisma.invitation.update({
    where: { id: invitation.id },
    data: { expiresAt: new Date(Date.now() - EXPIRED_AGO_MS) },
  });
}

/** Sets an owner account's status directly (test setup only). */
export function setAccountStatus(account, status) {
  return prisma.ownerAccount.update({ where: { id: account.id }, data: { status } });
}

/**
 * Inserts an issue on an assignment directly (test setup only), with houseId copied from it.
 * Pass `createdAt` to fix the paging order.
 */
export function createIssue(
  assignment,
  { status = IssueStatus.OPEN, title = "Leaking tap", description = "The kitchen tap drips.", createdAt } = {},
) {
  return prisma.issue.create({
    data: {
      tenantAssignmentId: assignment.id,
      houseId: assignment.houseId,
      title,
      description,
      status,
      ...(createdAt ? { createdAt } : {}),
    },
  });
}

/**
 * Inserts a leave request on an assignment directly (test setup only), with houseId copied
 * from it. Pass `createdAt` to fix the paging order.
 */
export function createLeaveRequest(
  assignment,
  {
    status = LeaveRequestStatus.PENDING,
    requestedExitDate = new Date("2027-06-30T00:00:00.000Z"),
    reason = null,
    respondedAt = null,
    respondedByUserId = null,
    createdAt,
  } = {},
) {
  return prisma.leaveRequest.create({
    data: {
      tenantAssignmentId: assignment.id,
      houseId: assignment.houseId,
      status,
      requestedExitDate,
      reason,
      respondedAt,
      respondedByUserId,
      ...(createdAt ? { createdAt } : {}),
    },
  });
}

/** Inserts a receipt on an assignment directly (test setup only). Pass `createdAt` to fix the paging order. */
export function createReceipt(
  assignment,
  { amountCents = 50_000, currency = "AUD", paidAt = new Date("2026-11-01T00:00:00.000Z"), note = null, createdAt, receiptUploadId = null } = {},
) {
  return prisma.receipt.create({
    data: {
      tenantAssignmentId: assignment.id,
      amountCents,
      currency,
      paidAt,
      note,
      receiptUploadId,
      ...(createdAt ? { createdAt } : {}),
    },
  });
}

/**
 * Inserts a requested receipt upload directly (test setup only), keyed under the
 * assignment's prefix like requestReceiptUpload. Pass lifecycle timestamps to place it.
 */
export async function createReceiptUpload(
  assignment,
  requester,
  {
    contentType = "application/pdf",
    sizeBytes = 2048,
    createdAt,
    attachedAt = null,
    verifiedAt = null,
    discardedAt = null,
  } = {},
) {
  const { ownerAccountId } = await prisma.house.findUnique({
    where: { id: assignment.houseId },
    select: { ownerAccountId: true },
  });

  return prisma.receiptUpload.create({
    data: {
      key: newReceiptFileKey({ ownerAccountId, tenantAssignmentId: assignment.id, contentType }),
      ownerAccountId,
      tenantAssignmentId: assignment.id,
      requestedByUserId: requester.id,
      contentType,
      sizeBytes,
      attachedAt,
      verifiedAt,
      discardedAt,
      ...(createdAt ? { createdAt } : {}),
    },
  });
}
