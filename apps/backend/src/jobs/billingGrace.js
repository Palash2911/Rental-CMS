import { deletionScheduledEmail } from "../email/events.js";
import { withEmails } from "../email/queue.js";
import {
  DeletionReason,
  OwnerAccountStatus,
} from "../generated/prisma/enums.ts";
import {
  lockOwnerAccount,
  syncReadOnlySince,
} from "../graphql/billing/subscriptionStore.js";
import { DELETION_GRACE_DAYS } from "../graphql/ownerAccount/serviceOwnerAccount.js";
import {
  ACTIVITY_ACTIONS,
  ENTITY_TYPES,
  logActivity,
} from "../lib/activity.js";
import { ACCESS, computeEntitlement } from "../lib/entitlement.js";
import {
  afterIdFilter,
  daysAfter,
  daysBefore,
  DEFAULT_BATCH_SIZE,
  forEachAccount,
  OUTCOMES,
} from "./batch.js";

/** How long an account may stay read-only through billing before its deletion is scheduled. */
export const BILLING_GRACE_DAYS = 30;

export const BILLING_GRACE_JOB = "billingGrace";
export const BILLING_GRACE_REASON = "BILLING_GRACE_EXPIRED";

// Never BLOCKED: a super admin's block always wins over billing. PENDING_DELETION is
// already scheduled.
const SCHEDULABLE_STATUSES = Object.freeze([
  OwnerAccountStatus.PENDING,
  OwnerAccountStatus.APPROVED,
]);

function fetchBatch(prisma, cutoff) {
  return async ({ afterId, take }) => {
    const rows = await prisma.subscription.findMany({
      where: {
        readOnlySince: { lt: cutoff },
        ownerAccount: {
          status: { in: SCHEDULABLE_STATUSES },
          deletionExecutedAt: null,
        },
        ...afterIdFilter("ownerAccountId", afterId),
      },
      orderBy: { ownerAccountId: "asc" },
      take,
      select: { ownerAccountId: true },
    });

    return rows.map(({ ownerAccountId }) => ownerAccountId);
  };
}

async function lockSubscriptionRow(tx, ownerAccountId) {
  const rows = await tx.$queryRaw`
    SELECT plan::text AS plan, "stripeStatus", enterprise, "readOnlySince"
    FROM "Subscription" WHERE "ownerAccountId" = ${ownerAccountId}
    FOR UPDATE`;

  return rows[0] ?? null;
}

// Everything the batch query saw is re-checked under the OwnerAccount, then Subscription,
// locks (the documented order): a payment, block or deletion request since then wins.
async function stillEligible(tx, ownerAccountId, cutoff) {
  const account = await lockOwnerAccount(tx, ownerAccountId);

  if (!account || !SCHEDULABLE_STATUSES.includes(account.status)) {
    return null;
  }

  const subscription = await lockSubscriptionRow(tx, ownerAccountId);
  const readOnlySince = subscription?.readOnlySince ?? null;
  const readOnly =
    computeEntitlement(account.status, subscription).access ===
    ACCESS.READ_ONLY;

  if (
    !readOnly ||
    !readOnlySince ||
    readOnlySince.getTime() >= cutoff.getTime()
  ) {
    return null;
  }

  return { status: account.status, readOnlySince };
}

// Project owner: cancelling a billing-grace deletion while still read-only must not buy
// another 30 days. Every scheduling for the same lapse logs the same readOnlySince (it only
// resets once access returns), so the first one's date is reused; a new lapse gets a new date.
// Returns null when this lapse was never scheduled.
async function originalDeletionDate(tx, ownerAccountId, readOnlySince) {
  const first = await tx.activityLog.findFirst({
    where: {
      entityType: ENTITY_TYPES.OWNER_ACCOUNT,
      entityId: ownerAccountId,
      action: ACTIVITY_ACTIONS.DELETION_SCHEDULED,
      AND: [
        { metadata: { path: ["reason"], equals: BILLING_GRACE_REASON } },
        { metadata: { path: ["readOnlySince"], equals: readOnlySince.toISOString() } },
      ],
    },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    select: { metadata: true },
  });

  const original = first?.metadata?.deletionScheduledAt;
  return original ? new Date(original) : null;
}

function scheduleDeletion(prisma, notifier, { cutoff, now }) {
  return (ownerAccountId) =>
    withEmails(notifier, (emails) => prisma.$transaction(async (tx) => {
      const eligible = await stillEligible(tx, ownerAccountId, cutoff);

      if (!eligible) {
        return OUTCOMES.SKIPPED;
      }

      const deletionScheduledAt =
        (await originalDeletionDate(tx, ownerAccountId, eligible.readOnlySince)) ??
        daysAfter(now, DELETION_GRACE_DAYS);

      await tx.ownerAccount.update({
        where: { id: ownerAccountId, status: eligible.status },
        data: {
          status: OwnerAccountStatus.PENDING_DELETION,
          statusBeforeDeletion: eligible.status,
          deletionScheduledAt,
          deletionReason: DeletionReason.BILLING_GRACE,
        },
        select: { id: true },
      });

      const log = await logActivity(tx, {
        entityType: ENTITY_TYPES.OWNER_ACCOUNT,
        entityId: ownerAccountId,
        action: ACTIVITY_ACTIONS.DELETION_SCHEDULED,
        ownerAccountId,
        performedByUserId: null,
        metadata: {
          fromStatus: eligible.status,
          toStatus: OwnerAccountStatus.PENDING_DELETION,
          reason: BILLING_GRACE_REASON,
          readOnlySince: eligible.readOnlySince.toISOString(),
          deletionScheduledAt: deletionScheduledAt.toISOString(),
        },
      });

      await syncReadOnlySince(tx, ownerAccountId, now);

      emails.push(
        deletionScheduledEmail({
          activityLogId: log.id,
          ownerAccountId,
          deletionScheduledAt: deletionScheduledAt.toISOString(),
          reason: DeletionReason.BILLING_GRACE,
        }),
      );

      return OUTCOMES.DONE;
    }));
}

/**
 * Moves every PENDING or APPROVED account that billing has kept read-only for more than
 * BILLING_GRACE_DAYS to PENDING_DELETION, due DELETION_GRACE_DAYS after `now` (project
 * owner: the owner keeps the usual deletion window to pay or cancel), one account per
 * transaction. Idempotent: a scheduled account is no longer selected. Returns the run summary.
 */
export function runBillingGrace(
  { prisma, notifier, log },
  { now = new Date(), batchSize = DEFAULT_BATCH_SIZE } = {},
) {
  const cutoff = daysBefore(now, BILLING_GRACE_DAYS);

  return forEachAccount({
    job: BILLING_GRACE_JOB,
    log,
    batchSize,
    fetchBatch: fetchBatch(prisma, cutoff),
    processAccount: scheduleDeletion(prisma, notifier, { cutoff, now }),
  });
}
