import { z } from "zod";

import {
  ConflictError,
  ForbiddenError,
  isUniqueViolation,
} from "../../lib/errors.js";

/** How long requireUser may serve a User row from Redis without reading the database. */
export const USER_CACHE_TTL_SECONDS = 60;
export const USER_CACHE_KEY_PREFIX = "user:v1:";

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

function cacheKey(userId) {
  return `${USER_CACHE_KEY_PREFIX}${userId}`;
}

function cachedUserSchema(userId) {
  return z.object({
    id: z.literal(userId),
    email: z.string(),
    name: z.string().nullable(),
    isBlocked: z.boolean(),
    createdAt: z.iso.datetime().transform((value) => new Date(value)),
  });
}

// The cache is an optimisation only: every Redis error, and any entry that does not parse,
// falls back to the database without logging, so a Redis outage never changes behaviour.
async function readCachedUser(redis, userId) {
  try {
    const value = await redis.get(cacheKey(userId));

    if (value === null) {
      return null;
    }

    const result = cachedUserSchema(userId).safeParse(JSON.parse(value));
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

async function writeCachedUser(redis, user) {
  const entry = JSON.stringify({ ...user, createdAt: user.createdAt.toISOString() });

  try {
    await redis.set(cacheKey(user.id), entry, "EX", USER_CACHE_TTL_SECONDS);
  } catch {
    // Not cached; the next request reads the database again.
  }
}

async function invalidateCachedUser(redis, userId) {
  try {
    await redis.del(cacheKey(userId));
  } catch {
    // Redis is unreachable, so the entry cannot be read either; it expires within the TTL.
  }
}

async function loadUser({ prisma, redis, userId }) {
  const cached = await readCachedUser(redis, userId);

  if (cached) {
    return cached;
  }

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: USER_SELECT,
  });

  if (user) {
    await writeCachedUser(redis, user);
  }

  return user;
}

/**
 * Loads the User for the verified token, creating it on first sign-in and syncing
 * a changed verified email or name. Throws ForbiddenError without a verified email
 * on first sign-in, and ConflictError when the email belongs to another User.
 */
// Cache-aside: the row is cached in Redis for USER_CACHE_TTL_SECONDS and the entry is
// deleted after every write here. A change made outside this function (for example setting
// isBlocked directly in the database) takes effect only when the entry expires.
export async function syncUserFromToken(context) {
  const { prisma, redis, userId } = context;

  const user = await loadUser(context);

  if (!user) {
    const created = await createUser(context);
    await invalidateCachedUser(redis, userId);
    return created;
  }

  const changes = profileChanges(user, context);

  if (!changes) {
    return user;
  }

  const updated = await writeUser(() =>
    prisma.user.update({
      where: { id: userId },
      data: changes,
      select: USER_SELECT,
    }),
  );
  await invalidateCachedUser(redis, userId);

  return updated;
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
