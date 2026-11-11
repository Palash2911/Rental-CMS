import { buildPageQuery, toPage } from "../../lib/pagination.js";

const PROFILE_SELECT = Object.freeze({
  id: true,
  createdAt: true,
  user: { select: { name: true, email: true } },
});

/** Converts a flattened profile `{ id, name, email, createdAt }` to the client shape. */
export function toPublicProfile(profile) {
  return {
    id: profile.id,
    name: profile.name,
    email: profile.email,
    createdAt: profile.createdAt.toISOString(),
  };
}

function rowToPublicProfile({ user, ...profile }) {
  return toPublicProfile({ ...profile, name: user.name, email: user.email });
}

/**
 * Lists, newest profile first, every tenant with an assignment in any status on one of the
 * owner account's houses.
 */
export async function listProfilesByOwner(context, { ownerAccountId, first, after }) {
  const page = buildPageQuery({ first, after });

  const rows = await context.prisma.tenantProfile.findMany({
    where: {
      AND: [
        { assignments: { some: { house: { ownerAccountId } } } },
        page.where,
      ],
    },
    orderBy: page.orderBy,
    take: page.take,
    select: PROFILE_SELECT,
  });

  return toPage(rows, first, rowToPublicProfile);
}
