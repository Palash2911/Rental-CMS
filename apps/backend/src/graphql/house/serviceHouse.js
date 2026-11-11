import {
  HouseStatus,
  TenantAssignmentStatus,
} from "../../generated/prisma/enums.ts";
import {
  ACTIVITY_ACTIONS,
  ENTITY_TYPES,
  logActivity,
} from "../../lib/activity.js";
import { ConflictError, NotFoundError } from "../../lib/errors.js";
import { buildPageQuery, toPage } from "../../lib/pagination.js";

/** Assignment statuses that count as an active lease for capacity and occupancy. */
export const ACTIVE_ASSIGNMENT_STATUSES = Object.freeze([
  TenantAssignmentStatus.ACTIVE,
  TenantAssignmentStatus.NOTICE_PERIOD,
]);

const HOUSE_SELECT = Object.freeze({
  id: true,
  ownerAccountId: true,
  name: true,
  location: true,
  maxTenants: true,
  status: true,
  createdAt: true,
  updatedAt: true,
});

const MESSAGES = Object.freeze({
  NOT_FOUND: "House not found.",
  HAS_ACTIVE_ASSIGNMENTS:
    "A house with active tenant assignments cannot be made inactive.",
  MAX_TENANTS_BELOW_ACTIVE:
    "maxTenants cannot be lower than the number of active tenant assignments.",
});

/** Converts a House row to the client shape, with ISO 8601 dates. */
export function toPublicHouse(house) {
  return {
    id: house.id,
    ownerAccountId: house.ownerAccountId,
    name: house.name,
    location: house.location,
    maxTenants: house.maxTenants,
    status: house.status,
    createdAt: house.createdAt.toISOString(),
    updatedAt: house.updatedAt.toISOString(),
  };
}

/** Lists an owner account's houses, newest first. */
export async function listHouses(context, { ownerAccountId, first, after }) {
  const page = buildPageQuery({ first, after });

  const rows = await context.prisma.house.findMany({
    where: { AND: [{ ownerAccountId }, page.where] },
    orderBy: page.orderBy,
    take: page.take,
    select: HOUSE_SELECT,
  });

  return toPage(rows, first, toPublicHouse);
}

/** Creates a VACANT house and logs it, in one transaction. */
export function createHouse(
  context,
  { actorId, ownerAccountId, name, location, maxTenants },
) {
  return context.prisma.$transaction(async (tx) => {
    const house = await tx.house.create({
      data: {
        ownerAccountId,
        name,
        location,
        maxTenants,
        status: HouseStatus.VACANT,
      },
      select: HOUSE_SELECT,
    });

    await logActivity(tx, {
      entityType: ENTITY_TYPES.HOUSE,
      entityId: house.id,
      action: ACTIVITY_ACTIONS.CREATED,
      performedByUserId: actorId,
      metadata: { ownerAccountId, name, location, maxTenants },
    });

    return toPublicHouse(house);
  });
}

// The per-house serialization point: every write that depends on a house's active
// assignment count (house updates here, assignment create and exit in 6b) takes this
// row lock first, so the count cannot change before the transaction commits.
/**
 * Takes the house row lock inside the caller's transaction.
 * Throws NotFoundError when the house does not exist.
 */
export async function lockHouse(tx, houseId) {
  const rows = await tx.$queryRaw`SELECT id FROM "House" WHERE id = ${houseId} FOR UPDATE`;

  if (rows.length === 0) {
    throw new NotFoundError(MESSAGES.NOT_FOUND);
  }
}

function countActiveAssignments(tx, houseId) {
  return tx.tenantAssignment.count({
    where: { houseId, status: { in: ACTIVE_ASSIGNMENT_STATUSES } },
  });
}

function occupancyStatus(currentStatus, activeCount) {
  if (currentStatus === HouseStatus.INACTIVE) {
    return currentStatus;
  }

  return activeCount > 0 ? HouseStatus.OCCUPIED : HouseStatus.VACANT;
}

/**
 * Sets OCCUPIED or VACANT from the active assignment count and logs the change.
 * The only automatic house status writer. Call under lockHouse, after the assignment write.
 */
export async function syncOccupancy(tx, { houseId, actorId }) {
  const house = await tx.house.findUnique({
    where: { id: houseId },
    select: { status: true },
  });
  const activeCount = await countActiveAssignments(tx, houseId);
  const status = occupancyStatus(house.status, activeCount);

  if (status === house.status) {
    return;
  }

  await tx.house.update({
    where: { id: houseId },
    data: { status },
    select: { id: true },
  });

  await logActivity(tx, {
    entityType: ENTITY_TYPES.HOUSE,
    entityId: houseId,
    action: ACTIVITY_ACTIONS.STATUS_CHANGED,
    performedByUserId: actorId,
    metadata: { status: { from: house.status, to: status } },
  });
}

function nextStatus(currentStatus, inactive, activeCount) {
  if (inactive === true) {
    if (currentStatus === HouseStatus.INACTIVE) {
      return currentStatus;
    }

    if (activeCount > 0) {
      throw new ConflictError(MESSAGES.HAS_ACTIVE_ASSIGNMENTS);
    }

    return HouseStatus.INACTIVE;
  }

  if (inactive === false && currentStatus === HouseStatus.INACTIVE) {
    return HouseStatus.VACANT;
  }

  return currentStatus;
}

function houseChanges(house, input, activeCount) {
  const changes = {};

  if (input.name != null && input.name !== house.name) {
    changes.name = input.name;
  }

  if (input.location != null && input.location !== house.location) {
    changes.location = input.location;
  }

  if (input.maxTenants != null && input.maxTenants !== house.maxTenants) {
    if (input.maxTenants < activeCount) {
      throw new ConflictError(MESSAGES.MAX_TENANTS_BELOW_ACTIVE);
    }

    changes.maxTenants = input.maxTenants;
  }

  const status = nextStatus(house.status, input.inactive, activeCount);

  if (status !== house.status) {
    changes.status = status;
  }

  return changes;
}

function changeMetadata(house, changes) {
  return Object.fromEntries(
    Object.entries(changes).map(([field, to]) => [field, { from: house[field], to }]),
  );
}

/**
 * Updates name, location, maxTenants and the INACTIVE flag under the house row lock.
 * Throws ConflictError when making a house with active assignments inactive, or when
 * maxTenants would drop below the active assignment count.
 */
export function updateHouse(context, { actorId, id, ...input }) {
  return context.prisma.$transaction(async (tx) => {
    await lockHouse(tx, id);

    const house = await tx.house.findUnique({
      where: { id },
      select: HOUSE_SELECT,
    });

    const needsCount = input.maxTenants != null || input.inactive === true;
    const activeCount = needsCount ? await countActiveAssignments(tx, id) : 0;
    const changes = houseChanges(house, input, activeCount);

    if (Object.keys(changes).length === 0) {
      return toPublicHouse(house);
    }

    const updated = await tx.house.update({
      where: { id },
      data: changes,
      select: HOUSE_SELECT,
    });

    await logActivity(tx, {
      entityType: ENTITY_TYPES.HOUSE,
      entityId: id,
      action: changes.status
        ? ACTIVITY_ACTIONS.STATUS_CHANGED
        : ACTIVITY_ACTIONS.UPDATED,
      performedByUserId: actorId,
      metadata: changeMetadata(house, changes),
    });

    return toPublicHouse(updated);
  });
}
