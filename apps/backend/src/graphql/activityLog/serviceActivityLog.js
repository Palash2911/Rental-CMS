import { buildPageQuery, toPage } from "../../lib/pagination.js";

// Raw metadata and the actor's Firebase UID are left out on purpose: members see only what
// happened, to what, by whom (by name) and when.
const ENTRY_SELECT = Object.freeze({
  id: true,
  action: true,
  entityType: true,
  entityId: true,
  performedByUserId: true,
  createdAt: true,
});

const ADMIN_ENTRY_SELECT = Object.freeze({
  ...ENTRY_SELECT,
  ownerAccountId: true,
  metadata: true,
});

// One query for the whole page, not one per entry. A missing User row gives null.
async function actorNames(prisma, rows) {
  const ids = [...new Set(rows.map((row) => row.performedByUserId).filter(Boolean))];

  if (ids.length === 0) {
    return new Map();
  }

  const users = await prisma.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, name: true },
  });

  return new Map(users.map((user) => [user.id, user.name]));
}

function actorName(names, row) {
  return row.performedByUserId ? (names.get(row.performedByUserId) ?? null) : null;
}

async function listPage(prisma, { filters, select, first, after, toItem }) {
  const page = buildPageQuery({ first, after });

  const rows = await prisma.activityLog.findMany({
    where: { AND: [...filters, page.where] },
    orderBy: page.orderBy,
    take: page.take,
    select,
  });

  const names = await actorNames(prisma, rows.slice(0, first));
  return toPage(rows, first, (row) => toItem(row, actorName(names, row)));
}

function toEntry(row, name) {
  return {
    id: row.id,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    actorName: name,
    createdAt: row.createdAt.toISOString(),
  };
}

function toAdminEntry(row, name) {
  return {
    ...toEntry(row, name),
    ownerAccountId: row.ownerAccountId,
    performedByUserId: row.performedByUserId,
    metadata: row.metadata ?? null,
  };
}

/** Lists an owner account's activity, optionally for one entity type, newest first. */
export function listActivityByAccount(context, { ownerAccountId, entityType, first, after }) {
  const filters = [{ ownerAccountId }, ...(entityType ? [{ entityType }] : [])];

  return listPage(context.prisma, {
    filters,
    select: ENTRY_SELECT,
    first,
    after,
    toItem: toEntry,
  });
}

function adminFilters(filter) {
  if (!filter) {
    return [];
  }

  return Object.entries(filter)
    .filter(([, value]) => value != null)
    .map(([field, value]) => ({ [field]: value }));
}

/** Lists activity across all accounts, with metadata, narrowed by the given filters, newest first. */
export function listAdminActivity(context, { filter, first, after }) {
  return listPage(context.prisma, {
    filters: adminFilters(filter),
    select: ADMIN_ENTRY_SELECT,
    first,
    after,
    toItem: toAdminEntry,
  });
}
