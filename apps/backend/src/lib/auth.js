import { AuthErrorCode, FirebaseAuthError } from "firebase-admin/auth";

import { firebaseAuth } from "../firebase/admin.js";
import {
  OwnerAccountStatus,
  OwnerMemberRole,
} from "../generated/prisma/enums.ts";
import { syncUserFromToken } from "../graphql/user/serviceUser.js";
import { ForbiddenError, NotFoundError, UnauthenticatedError } from "./errors.js";

const { APPROVED, PENDING, BLOCKED, PENDING_DELETION } = OwnerAccountStatus;

export const ROLES = Object.freeze({
  PRIMARY_ONLY: Object.freeze([OwnerMemberRole.PRIMARY]),
  ANY: Object.freeze([OwnerMemberRole.PRIMARY, OwnerMemberRole.CO_OWNER]),
});

/** Owner account statuses each kind of operation allows, per the account status policy. */
export const ACCOUNT_STATUSES = Object.freeze({
  MEMBER_ACCOUNT_READ: Object.freeze([APPROVED, PENDING, PENDING_DELETION]),
  MEMBER_ACCOUNT_WRITE: Object.freeze([APPROVED, PENDING]),
  MEMBER_TENANT_READ: Object.freeze([APPROVED, PENDING_DELETION]),
  MEMBER_TENANT_WRITE: Object.freeze([APPROVED]),
  MEMBER_DELETION_CANCEL: Object.freeze([PENDING_DELETION]),
  TENANT_READ: Object.freeze([APPROVED, BLOCKED, PENDING_DELETION]),
  TENANT_WRITE: Object.freeze([APPROVED]),
});

export const ACCESS_TYPES = Object.freeze({
  OWNER: "OWNER",
  TENANT: "TENANT",
});

const DEFAULT_STATUSES = Object.freeze([APPROVED]);

const MESSAGES = Object.freeze({
  SUSPENDED: "This account has been suspended.",
  ADMIN_REQUIRED: "This action requires an administrator.",
  ACCESS_NOT_ALLOWED: "This action is not available to you.",
  ROLE_NOT_ALLOWED: "Your role on this owner account does not allow this action.",
  STATUS_NOT_ALLOWED:
    "This action is not available for the owner account in its current state.",
  OWNER_ACCOUNT_NOT_FOUND: "Owner account not found.",
  HOUSE_NOT_FOUND: "House not found.",
  ASSIGNMENT_NOT_FOUND: "Tenant assignment not found.",
  ISSUE_NOT_FOUND: "Issue not found.",
  INVITATION_NOT_FOUND: "Invitation not found.",
  TENANT_PROFILE_NOT_FOUND: "Tenant profile not found.",
});

const HOUSE_FIELDS = Object.freeze({
  id: true,
  ownerAccountId: true,
  name: true,
  location: true,
  maxTenants: true,
  status: true,
  createdAt: true,
  updatedAt: true,
});

const ASSIGNMENT_FIELDS = Object.freeze({
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

const INVITATION_FIELDS = Object.freeze({
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
});

const TENANT_PROFILE_FIELDS = Object.freeze({
  id: true,
  userId: true,
  createdAt: true,
  user: { select: { name: true, email: true } },
});

const ISSUE_FIELDS = Object.freeze({
  id: true,
  tenantAssignmentId: true,
  title: true,
  description: true,
  status: true,
  createdAt: true,
  updatedAt: true,
});

const userCache = new WeakMap();

function ownerAccountSelect(userId) {
  return {
    select: {
      id: true,
      name: true,
      status: true,
      members: {
        where: { userId },
        select: { id: true, role: true },
        take: 1,
      },
    },
  };
}

function assignmentSelect(userId) {
  return {
    ...ASSIGNMENT_FIELDS,
    tenantProfile: { select: { userId: true } },
    house: { select: { ownerAccount: ownerAccountSelect(userId) } },
  };
}

function splitOwnerAccount({ members, ...ownerAccount }) {
  return { ownerAccount, membership: members[0] ?? null };
}

function splitAssignment({ tenantProfile, house, ...assignment }) {
  return {
    assignment,
    tenantUserId: tenantProfile.userId,
    ...splitOwnerAccount(house.ownerAccount),
  };
}

function memberAccessError(membership, accountStatus, policy) {
  if (!policy) {
    return new ForbiddenError(MESSAGES.ACCESS_NOT_ALLOWED);
  }

  const statuses = policy.statuses ?? DEFAULT_STATUSES;
  const roles = policy.roles ?? ROLES.ANY;

  if (!statuses.includes(accountStatus)) {
    return new ForbiddenError(MESSAGES.STATUS_NOT_ALLOWED);
  }

  if (!roles.includes(membership.role)) {
    return new ForbiddenError(MESSAGES.ROLE_NOT_ALLOWED);
  }

  return null;
}

function tenantAccessError(accountStatus, policy) {
  if (!policy) {
    return new ForbiddenError(MESSAGES.ACCESS_NOT_ALLOWED);
  }

  const statuses = policy.statuses ?? DEFAULT_STATUSES;

  if (!statuses.includes(accountStatus)) {
    return new ForbiddenError(MESSAGES.STATUS_NOT_ALLOWED);
  }

  return null;
}

function resolveAssignmentAccess(user, parts, options, notFoundMessage) {
  const { tenantUserId, ownerAccount, membership } = parts;
  const isTenant = tenantUserId === user.id;

  if (!membership && !isTenant) {
    throw new NotFoundError(notFoundMessage);
  }

  const ownerError = membership
    ? memberAccessError(membership, ownerAccount.status, options.owner)
    : null;

  if (membership && !ownerError) {
    return { accessAs: ACCESS_TYPES.OWNER, membership };
  }

  const tenantError = isTenant
    ? tenantAccessError(ownerAccount.status, options.tenant)
    : null;

  if (isTenant && !tenantError) {
    return { accessAs: ACCESS_TYPES.TENANT, membership: null };
  }

  throw ownerError ?? tenantError;
}

async function loadActiveUser(context) {
  const user = await syncUserFromToken(context);

  if (user.isBlocked) {
    throw new ForbiddenError(MESSAGES.SUSPENDED);
  }

  return user;
}

/**
 * Returns the signed-in User, creating it on first sign-in. Cached per request.
 * Throws UnauthenticatedError for anonymous requests and ForbiddenError for blocked users.
 */
export async function requireUser(context) {
  if (!context.userId) {
    throw new UnauthenticatedError();
  }

  let pending = userCache.get(context);

  if (!pending) {
    pending = loadActiveUser(context);
    userCache.set(context, pending);
  }

  return pending;
}

// A claim stays in the ID token until it expires (up to an hour), so the token alone
// would keep a revoked super admin's access. The live read makes revocation immediate.
async function hasLiveSuperAdminClaim(uid) {
  try {
    const record = await firebaseAuth.getUser(uid);
    return record.customClaims?.superAdmin === true;
  } catch (error) {
    if (
      error instanceof FirebaseAuthError &&
      error.hasCode(AuthErrorCode.USER_NOT_FOUND)
    ) {
      return false;
    }

    throw error;
  }
}

/**
 * Returns the signed-in User. Throws ForbiddenError unless both the token and a live
 * Firebase read show the superAdmin claim.
 */
export async function requireSuperAdmin(context) {
  const user = await requireUser(context);

  if (!context.isSuperAdmin || !(await hasLiveSuperAdminClaim(user.id))) {
    throw new ForbiddenError(MESSAGES.ADMIN_REQUIRED);
  }

  return user;
}

/**
 * Returns `{ user, membership, ownerAccount }` for a member of the account.
 * Options: `roles` (default ROLES.ANY), `statuses` (default APPROVED only).
 * Throws NotFoundError for non-members and ForbiddenError for a disallowed role or status.
 */
export async function requireOwnerMember(context, ownerAccountId, options = {}) {
  const user = await requireUser(context);

  const row = await context.prisma.ownerAccountMember.findUnique({
    where: { userId_ownerAccountId: { userId: user.id, ownerAccountId } },
    select: {
      id: true,
      role: true,
      ownerAccount: {
        select: {
          id: true,
          name: true,
          status: true,
          createdAt: true,
          updatedAt: true,
        },
      },
    },
  });

  if (!row) {
    throw new NotFoundError(MESSAGES.OWNER_ACCOUNT_NOT_FOUND);
  }

  const { ownerAccount, ...membership } = row;
  const error = memberAccessError(membership, ownerAccount.status, options);

  if (error) {
    throw error;
  }

  return { user, membership, ownerAccount };
}

/**
 * Returns `{ user, house, membership, ownerAccount }` for a member of the house's account.
 * Options as requireOwnerMember. Throws NotFoundError for non-members.
 */
export async function requireHouseAccess(context, houseId, options = {}) {
  const user = await requireUser(context);

  const row = await context.prisma.house.findUnique({
    where: { id: houseId },
    select: { ...HOUSE_FIELDS, ownerAccount: ownerAccountSelect(user.id) },
  });

  if (!row) {
    throw new NotFoundError(MESSAGES.HOUSE_NOT_FOUND);
  }

  const { ownerAccount: accountRow, ...house } = row;
  const { ownerAccount, membership } = splitOwnerAccount(accountRow);

  if (!membership) {
    throw new NotFoundError(MESSAGES.HOUSE_NOT_FOUND);
  }

  const error = memberAccessError(membership, ownerAccount.status, options);

  if (error) {
    throw error;
  }

  return { user, house, membership, ownerAccount };
}

/**
 * Returns `{ user, assignment, ownerAccount, accessAs, membership }`.
 * Options: `owner: { roles, statuses }` and/or `tenant: { statuses }`; a path is allowed only
 * when its key is given, and statuses default to APPROVED only.
 * Throws NotFoundError for unrelated users and ForbiddenError for a disallowed path, role or status.
 */
export async function requireAssignmentAccess(context, assignmentId, options = {}) {
  const user = await requireUser(context);

  const row = await context.prisma.tenantAssignment.findUnique({
    where: { id: assignmentId },
    select: assignmentSelect(user.id),
  });

  if (!row) {
    throw new NotFoundError(MESSAGES.ASSIGNMENT_NOT_FOUND);
  }

  const parts = splitAssignment(row);
  const access = resolveAssignmentAccess(
    user,
    parts,
    options,
    MESSAGES.ASSIGNMENT_NOT_FOUND,
  );

  return {
    user,
    assignment: parts.assignment,
    ownerAccount: parts.ownerAccount,
    ...access,
  };
}

/**
 * Returns `{ user, issue, assignment, ownerAccount, accessAs, membership }`.
 * Options and errors as requireAssignmentAccess, resolved through the issue's assignment.
 */
export async function requireIssueAccess(context, issueId, options = {}) {
  const user = await requireUser(context);

  const row = await context.prisma.issue.findUnique({
    where: { id: issueId },
    select: {
      ...ISSUE_FIELDS,
      tenantAssignment: { select: assignmentSelect(user.id) },
    },
  });

  if (!row) {
    throw new NotFoundError(MESSAGES.ISSUE_NOT_FOUND);
  }

  const { tenantAssignment, ...issue } = row;
  const parts = splitAssignment(tenantAssignment);
  const access = resolveAssignmentAccess(
    user,
    parts,
    options,
    MESSAGES.ISSUE_NOT_FOUND,
  );

  return {
    user,
    issue,
    assignment: parts.assignment,
    ownerAccount: parts.ownerAccount,
    ...access,
  };
}

/**
 * Returns `{ user, invitation, houseName, membership, ownerAccount }` for a member of the
 * account that owns the invitation's house. Options as requireOwnerMember.
 * Throws NotFoundError for non-members and ForbiddenError for a disallowed role or status.
 */
export async function requireInvitationAccess(context, invitationId, options = {}) {
  const user = await requireUser(context);

  const row = await context.prisma.invitation.findUnique({
    where: { id: invitationId },
    select: {
      ...INVITATION_FIELDS,
      house: { select: { name: true, ownerAccount: ownerAccountSelect(user.id) } },
    },
  });

  if (!row) {
    throw new NotFoundError(MESSAGES.INVITATION_NOT_FOUND);
  }

  const { house, ...invitation } = row;
  const { ownerAccount, membership } = splitOwnerAccount(house.ownerAccount);

  if (!membership) {
    throw new NotFoundError(MESSAGES.INVITATION_NOT_FOUND);
  }

  const error = memberAccessError(membership, ownerAccount.status, options);

  if (error) {
    throw error;
  }

  return { user, invitation, houseName: house.name, membership, ownerAccount };
}

function memberAssignmentFilter(userId, roles, statuses) {
  const ownerAccount = { members: { some: { userId, role: { in: roles } } } };

  if (statuses) {
    ownerAccount.status = { in: statuses };
  }

  return { house: { ownerAccount } };
}

function toProfile({ id, createdAt, user }) {
  return { id, createdAt, name: user.name, email: user.email };
}

/**
 * Returns `{ user, profile, accessAs }` where profile is `{ id, name, email, createdAt }`.
 * The tenant can always read their own profile. With `owner: { roles, statuses }`, a member
 * of any account where the tenant has an assignment (EXITED included) can read it when that
 * account's status is allowed. Throws NotFoundError for unrelated users and ForbiddenError
 * when every linked account has a disallowed status or role.
 */
export async function requireTenantProfileAccess(context, profileId, options = {}) {
  const user = await requireUser(context);
  const roles = options.owner?.roles ?? ROLES.ANY;
  const statuses = options.owner?.statuses ?? DEFAULT_STATUSES;

  const row = await context.prisma.tenantProfile.findUnique({
    where: { id: profileId },
    select: {
      ...TENANT_PROFILE_FIELDS,
      assignments: {
        where: memberAssignmentFilter(user.id, roles, statuses),
        select: { id: true },
        take: 1,
      },
    },
  });

  if (!row) {
    throw new NotFoundError(MESSAGES.TENANT_PROFILE_NOT_FOUND);
  }

  if (row.userId === user.id) {
    return { user, profile: toProfile(row), accessAs: ACCESS_TYPES.TENANT };
  }

  if (options.owner && row.assignments.length > 0) {
    return { user, profile: toProfile(row), accessAs: ACCESS_TYPES.OWNER };
  }

  const linked = await context.prisma.tenantAssignment.findFirst({
    where: {
      tenantProfileId: profileId,
      ...memberAssignmentFilter(user.id, ROLES.ANY, null),
    },
    select: { id: true },
  });

  if (!linked) {
    throw new NotFoundError(MESSAGES.TENANT_PROFILE_NOT_FOUND);
  }

  throw new ForbiddenError(
    options.owner ? MESSAGES.STATUS_NOT_ALLOWED : MESSAGES.ACCESS_NOT_ALLOWED,
  );
}
