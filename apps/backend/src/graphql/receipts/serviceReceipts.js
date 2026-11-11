import {
  ACTIVITY_ACTIONS,
  ENTITY_TYPES,
  logActivity,
} from "../../lib/activity.js";
import { buildPageQuery, toPage } from "../../lib/pagination.js";
import {
  lockActiveAssignment,
  toCalendarDate,
} from "../tenantAssignment/serviceTenantAssignment.js";

const RECEIPT_SELECT = Object.freeze({
  id: true,
  tenantAssignmentId: true,
  amountCents: true,
  currency: true,
  paidAt: true,
  note: true,
  createdAt: true,
});

/** Converts a Receipt row to the client shape. fileUrl is never exposed. */
export function toPublicReceipt(receipt) {
  return {
    id: receipt.id,
    tenantAssignmentId: receipt.tenantAssignmentId,
    amountCents: receipt.amountCents,
    currency: receipt.currency,
    paidAt: toCalendarDate(receipt.paidAt),
    note: receipt.note,
    createdAt: receipt.createdAt.toISOString(),
  };
}

/** Lists an assignment's receipts, newest recorded first. */
export async function listReceiptsByAssignment(
  context,
  { tenantAssignmentId, first, after },
) {
  const page = buildPageQuery({ first, after });

  const rows = await context.prisma.receipt.findMany({
    where: { AND: [{ tenantAssignmentId }, page.where] },
    orderBy: page.orderBy,
    take: page.take,
    select: RECEIPT_SELECT,
  });

  return toPage(rows, first, toPublicReceipt);
}

/**
 * Records an immutable receipt on an ACTIVE or NOTICE_PERIOD assignment and logs it, in one
 * transaction. Throws ConflictError when the assignment is no longer active.
 */
export function createReceipt(
  context,
  { actorId, tenantAssignmentId, amountCents, currency, paidAt, note },
) {
  return context.prisma.$transaction(async (tx) => {
    await lockActiveAssignment(tx, tenantAssignmentId);

    const receipt = await tx.receipt.create({
      data: {
        tenantAssignmentId,
        amountCents,
        currency,
        paidAt,
        note: note ?? null,
      },
      select: RECEIPT_SELECT,
    });

    await logActivity(tx, {
      entityType: ENTITY_TYPES.RECEIPT,
      entityId: receipt.id,
      action: ACTIVITY_ACTIONS.CREATED,
      performedByUserId: actorId,
      metadata: {
        tenantAssignmentId,
        amountCents,
        currency,
        paidAt: toCalendarDate(receipt.paidAt),
      },
    });

    return toPublicReceipt(receipt);
  });
}
