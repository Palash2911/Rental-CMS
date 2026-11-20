import { InvitationStatus } from "../generated/prisma/enums.ts";
import { daysBefore, DEFAULT_BATCH_SIZE } from "./batch.js";

export const CLEANUP_JOB = "cleanup";

/** PENDING invitations are deleted once they have been expired for this long. */
export const EXPIRED_INVITATION_RETENTION_DAYS = 30;

/**
 * Processed Stripe event ids are kept this long for redelivery detection; Stripe retries a
 * delivery for up to 3 days, so 90 days leaves a wide margin.
 */
export const STRIPE_EVENT_RETENTION_DAYS = 90;

// Deletes in batches of ids so no statement touches an unbounded number of rows. The
// predicate is applied again in the delete, so a row that changed since the read stays.
async function deleteInBatches(delegate, where, batchSize) {
  let deleted = 0;

  for (;;) {
    const rows = await delegate.findMany({ where, orderBy: { id: "asc" }, take: batchSize, select: { id: true } });

    if (rows.length === 0) {
      return deleted;
    }

    const result = await delegate.deleteMany({
      where: { AND: [where, { id: { in: rows.map(({ id }) => id) } }] },
    });
    deleted += result.count;

    if (rows.length < batchSize) {
      return deleted;
    }
  }
}

/**
 * Deletes PENDING tenant and member invitations expired more than
 * EXPIRED_INVITATION_RETENTION_DAYS ago (answered invitations are kept as history) and
 * StripeEvent rows processed more than STRIPE_EVENT_RETENTION_DAYS ago. Each batch is one
 * statement with no dependent rows, so no transaction is needed. Idempotent by nature.
 * Returns `{ job, tenantInvitations, memberInvitations, stripeEvents }` deleted counts.
 */
export async function runCleanup({ prisma }, { now = new Date(), batchSize = DEFAULT_BATCH_SIZE } = {}) {
  const invitationCutoff = daysBefore(now, EXPIRED_INVITATION_RETENTION_DAYS);
  const expiredPending = { status: InvitationStatus.PENDING, expiresAt: { lt: invitationCutoff } };

  return {
    job: CLEANUP_JOB,
    tenantInvitations: await deleteInBatches(prisma.invitation, expiredPending, batchSize),
    memberInvitations: await deleteInBatches(prisma.memberInvitation, expiredPending, batchSize),
    stripeEvents: await deleteInBatches(
      prisma.stripeEvent,
      { processedAt: { lt: daysBefore(now, STRIPE_EVENT_RETENTION_DAYS) } },
      batchSize,
    ),
  };
}
