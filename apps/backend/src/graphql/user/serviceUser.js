import {
  ConflictError,
  ForbiddenError,
  isUniqueViolation,
} from "../../lib/errors.js";

const USER_SELECT = Object.freeze({
  id: true,
  email: true,
  name: true,
  isBlocked: true,
  createdAt: true,
});

const MESSAGES = Object.freeze({
  VERIFIED_EMAIL_REQUIRED: "A verified email address is required.",
  EMAIL_IN_USE: "This email address is already linked to another account.",
});

function profileChanges(user, { email, emailVerified, name }) {
  const changes = {};

  if (emailVerified && email && email !== user.email) {
    changes.email = email;
  }

  if (name && name !== user.name) {
    changes.name = name;
  }

  return Object.keys(changes).length > 0 ? changes : null;
}

async function writeUser(write) {
  try {
    return await write();
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ConflictError(MESSAGES.EMAIL_IN_USE);
    }

    throw error;
  }
}

// The upsert meets Prisma 7's conditions for a native INSERT ... ON CONFLICT ("id"):
// one unique field in `where`, the same id in `create`, a non-empty `update` and no
// relation reads or writes. Concurrent first requests for one UID therefore never
// fail or duplicate, and a unique violation can only come from the email.
function createUser({ prisma, userId, email, emailVerified, name }) {
  if (!email || !emailVerified) {
    throw new ForbiddenError(MESSAGES.VERIFIED_EMAIL_REQUIRED);
  }

  const update = name ? { email, name } : { email };

  return writeUser(() =>
    prisma.user.upsert({
      where: { id: userId },
      create: { id: userId, email, name },
      update,
      select: USER_SELECT,
    }),
  );
}

/**
 * Loads the User for the verified token, creating it on first sign-in and syncing
 * a changed verified email or name. Throws ForbiddenError without a verified email
 * on first sign-in, and ConflictError when the email belongs to another User.
 */
export async function syncUserFromToken(context) {
  const { prisma, userId } = context;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: USER_SELECT,
  });

  if (!user) {
    return createUser(context);
  }

  const changes = profileChanges(user, context);

  if (!changes) {
    return user;
  }

  return writeUser(() =>
    prisma.user.update({
      where: { id: userId },
      data: changes,
      select: USER_SELECT,
    }),
  );
}

/** Returns only the User fields that are safe to expose to the client. */
export function toPublicUser(user) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt.toISOString(),
  };
}
