import { randomBytes } from "node:crypto";

import {
  HouseStatus,
  InvitationStatus,
  OwnerAccountStatus,
  OwnerMemberRole,
  TenantAssignmentStatus,
} from "../../src/generated/prisma/enums.ts";
import { prisma } from "./db.js";

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

/**
 * Builds a request context for a token, the way createContext would after verifying it.
 * Each call returns a new object, so the per-request user cache never leaks between calls.
 */
export function tokenContext({
  userId,
  email = null,
  emailVerified = true,
  name = null,
  superAdmin = false,
  liveSuperAdmin = superAdmin,
}) {
  return {
    prisma,
    userId,
    email,
    emailVerified,
    name,
    isSuperAdmin: superAdmin,
    hasLiveSuperAdminClaim: async () => liveSuperAdmin,
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

/** Creates an owner account with `owner` as a member (PRIMARY by default). */
export function createOwnerAccount(
  owner,
  { status = OwnerAccountStatus.APPROVED, name = "Test Rentals", role = OwnerMemberRole.PRIMARY, ...extra } = {},
) {
  return prisma.ownerAccount.create({
    data: { name, status, ...extra, members: { create: { userId: owner.id, role } } },
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
export async function createAssignment(house, tenant, { status = TenantAssignmentStatus.ACTIVE } = {}) {
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
