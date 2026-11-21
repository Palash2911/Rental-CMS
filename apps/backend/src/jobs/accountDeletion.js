import { OwnerAccountStatus } from "../generated/prisma/enums.ts";
import { lockOwnerAccount } from "../graphql/billing/subscriptionStore.js";
import { accountFilePrefix } from "../graphql/receipts/receiptFiles.js";
import {
  ACTIVITY_ACTIONS,
  ENTITY_TYPES,
  logActivity,
} from "../lib/activity.js";
import { isLiveStatus } from "../lib/entitlement.js";
import {
  afterIdFilter,
  DEFAULT_BATCH_SIZE,
  forEachAccount,
  OUTCOMES,
} from "./batch.js";

export const ACCOUNT_DELETION_JOB = "accountDeletion";

// Deleting a large account's rows can take longer than Prisma's 5-second default.
const DELETION_TRANSACTION_TIMEOUT_MS = 60_000;
const STRIPE_MISSING_CODE = "resource_missing";
const OPEN_CHECKOUT_STATUS = "open";
const TOMBSTONE_NAME = "";

const MESSAGES = Object.freeze({
  STRIPE_FAILED:
    "Account deletion deferred: Stripe could not cancel billing. The next run retries.",
  STORAGE_FAILED:
    "Account deletion deferred: stored receipt files could not be deleted. The next run retries.",
  SUBSCRIPTION_CHANGED:
    "Account deletion deferred: the subscription changed during the run. The next run retries.",
});

function fetchBatch(prisma, now) {
  return async ({ afterId, take }) => {
    const rows = await prisma.ownerAccount.findMany({
      where: {
        status: OwnerAccountStatus.PENDING_DELETION,
        deletionScheduledAt: { lte: now },
        deletionExecutedAt: null,
        ...afterIdFilter("id", afterId),
      },
      orderBy: { id: "asc" },
      take,
      select: { id: true },
    });

    return rows.map(({ id }) => id);
  };
}

function isMissing(error) {
  return error?.code === STRIPE_MISSING_CODE;
}

async function cancelStripeSubscription(
  gateway,
  { ownerAccountId, stripeSubscriptionId },
) {
  let subscription;

  try {
    subscription = await gateway.retrieveSubscription(stripeSubscriptionId);
  } catch (error) {
    if (isMissing(error)) {
      return false;
    }

    throw error;
  }

  if (!isLiveStatus(subscription.status)) {
    return false;
  }

  await gateway.cancelSubscription(stripeSubscriptionId, {
    idempotencyKey: `owner-account-${ownerAccountId}-deletion-${stripeSubscriptionId}`,
  });

  return true;
}

// An open Checkout could otherwise still be paid after the account is gone.
async function expireOpenCheckout(gateway, sessionId) {
  try {
    const session = await gateway.retrieveCheckoutSession(sessionId);

    if (session.status === OPEN_CHECKOUT_STATUS) {
      await gateway.expireCheckoutSession(sessionId);
    }
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
}

// Runs before the transaction, so no row lock is held during the network calls. Every
// call is safe to repeat, so a run that fails halfway simply repeats it next time.
async function stopBilling(gateway, ownerAccountId, subscription) {
  const canceled = subscription?.stripeSubscriptionId
    ? await cancelStripeSubscription(gateway, {
        ownerAccountId,
        stripeSubscriptionId: subscription.stripeSubscriptionId,
      })
    : false;

  if (subscription?.pendingCheckoutSessionId) {
    await expireOpenCheckout(gateway, subscription.pendingCheckoutSessionId);
  }

  return canceled;
}

// Before the transaction, like stopBilling: no lock is held during the storage calls, and
// deleting a key twice is harmless, so a run that fails halfway repeats it next time. Lists
// the account's whole prefix (orphaned uploads included), one page per delete batch.
// Returns how many objects were deleted.
async function deleteStoredFiles(storageGateway, ownerAccountId) {
  const prefix = accountFilePrefix(ownerAccountId);
  let deleted = 0;
  let continuationToken = null;

  do {
    const page = await storageGateway.listKeys({ prefix, continuationToken });
    await storageGateway.deleteObjects(page.keys);
    deleted += page.keys.length;
    continuationToken = page.nextToken;
  } while (continuationToken);

  return deleted;
}

async function lockHousesOfAccount(tx, ownerAccountId) {
  const rows = await tx.$queryRaw`
    SELECT id FROM "House" WHERE "ownerAccountId" = ${ownerAccountId}
    ORDER BY id FOR UPDATE`;

  return rows.map(({ id }) => id);
}

async function lockSubscriptionRow(tx, ownerAccountId) {
  const rows = await tx.$queryRaw`
    SELECT "stripeSubscriptionId" FROM "Subscription"
    WHERE "ownerAccountId" = ${ownerAccountId} FOR UPDATE`;

  return rows[0] ?? null;
}

async function isStillDue(tx, ownerAccountId, now) {
  const locked = await lockOwnerAccount(tx, ownerAccountId);

  if (locked?.status !== OwnerAccountStatus.PENDING_DELETION) {
    return false;
  }

  const account = await tx.ownerAccount.findUnique({
    where: { id: ownerAccountId },
    select: { deletionScheduledAt: true, deletionExecutedAt: true },
  });

  return (
    account.deletionExecutedAt === null &&
    account.deletionScheduledAt !== null &&
    account.deletionScheduledAt.getTime() <= now.getTime()
  );
}

// Children before parents, because every foreign key is ON DELETE RESTRICT. Invitations go
// before assignments (Invitation.acceptedAssignmentId). Users and TenantProfiles are never
// deleted: a tenant keeps their account and any leases with other owners.
async function deleteAccountData(tx, ownerAccountId, houseIds) {
  const byHouse = { houseId: { in: houseIds } };
  const counts = {};

  counts.issues = (await tx.issue.deleteMany({ where: byHouse })).count;
  counts.receipts = (
    await tx.receipt.deleteMany({ where: { tenantAssignment: byHouse } })
  ).count;
  counts.receiptUploads = (
    await tx.receiptUpload.deleteMany({ where: { ownerAccountId } })
  ).count;
  counts.leaveRequests = (
    await tx.leaveRequest.deleteMany({ where: byHouse })
  ).count;
  counts.invitations = (
    await tx.invitation.deleteMany({ where: byHouse })
  ).count;
  counts.tenantAssignments = (
    await tx.tenantAssignment.deleteMany({ where: byHouse })
  ).count;
  counts.houses = (
    await tx.house.deleteMany({ where: { ownerAccountId } })
  ).count;
  counts.memberInvitations = (
    await tx.memberInvitation.deleteMany({ where: { ownerAccountId } })
  ).count;
  counts.members = (
    await tx.ownerAccountMember.deleteMany({ where: { ownerAccountId } })
  ).count;
  counts.subscriptions = (
    await tx.subscription.deleteMany({ where: { ownerAccountId } })
  ).count;

  return counts;
}

function deleteAccount({ prisma, billingGateway, storageGateway, log }, now) {
  return async (ownerAccountId) => {
    const subscription = await prisma.subscription.findUnique({
      where: { ownerAccountId },
      select: { stripeSubscriptionId: true, pendingCheckoutSessionId: true },
    });

    let stripeSubscriptionCanceled;

    try {
      stripeSubscriptionCanceled = await stopBilling(
        billingGateway,
        ownerAccountId,
        subscription,
      );
    } catch (error) {
      log.warn(
        { err: error, job: ACCOUNT_DELETION_JOB, ownerAccountId },
        MESSAGES.STRIPE_FAILED,
      );
      return OUTCOMES.DEFERRED;
    }

    let storageObjectsDeleted;

    try {
      storageObjectsDeleted = await deleteStoredFiles(storageGateway, ownerAccountId);
    } catch (error) {
      log.warn(
        { err: error, job: ACCOUNT_DELETION_JOB, ownerAccountId },
        MESSAGES.STORAGE_FAILED,
      );
      return OUTCOMES.DEFERRED;
    }

    return prisma.$transaction(
      async (tx) => {
        // Lock order: House, then OwnerAccount, then Subscription.
        const houseIds = await lockHousesOfAccount(tx, ownerAccountId);

        if (!(await isStillDue(tx, ownerAccountId, now))) {
          return OUTCOMES.SKIPPED;
        }

        // The owner may have subscribed again (billing stays open in PENDING_DELETION)
        // after Stripe was called above; that subscription is cancelled next run.
        const locked = await lockSubscriptionRow(tx, ownerAccountId);

        if (
          (locked?.stripeSubscriptionId ?? null) !==
          (subscription?.stripeSubscriptionId ?? null)
        ) {
          log.warn(
            { job: ACCOUNT_DELETION_JOB, ownerAccountId },
            MESSAGES.SUBSCRIPTION_CHANGED,
          );
          return OUTCOMES.DEFERRED;
        }

        const deleted = await deleteAccountData(tx, ownerAccountId, houseIds);

        await tx.ownerAccount.update({
          where: {
            id: ownerAccountId,
            status: OwnerAccountStatus.PENDING_DELETION,
          },
          data: { name: TOMBSTONE_NAME, deletionExecutedAt: now },
          select: { id: true },
        });

        await logActivity(tx, {
          entityType: ENTITY_TYPES.OWNER_ACCOUNT,
          entityId: ownerAccountId,
          action: ACTIVITY_ACTIONS.DELETION_EXECUTED,
          ownerAccountId,
          performedByUserId: null,
          metadata: { deleted, stripeSubscriptionCanceled, storageObjectsDeleted },
        });

        return OUTCOMES.DONE;
      },
      { timeout: DELETION_TRANSACTION_TIMEOUT_MS },
    );
  };
}

/**
 * Deletes every PENDING_DELETION account whose deletionScheduledAt has passed: cancels its
 * Stripe subscription and any open Checkout (deferring the account to the next run when
 * Stripe fails), then, in one transaction per account, deletes its houses, assignments,
 * receipts, issues, leave requests, invitations, member invitations, members and
 * subscription. The OwnerAccount row stays as a tombstone (name cleared, deletionExecutedAt
 * set) and the activity log is kept. Idempotent: a tombstone is never selected again.
 * Returns the run summary.
 */
export function runAccountDeletion(
  dependencies,
  { now = new Date(), batchSize = DEFAULT_BATCH_SIZE } = {},
) {
  return forEachAccount({
    job: ACCOUNT_DELETION_JOB,
    log: dependencies.log,
    batchSize,
    fetchBatch: fetchBatch(dependencies.prisma, now),
    processAccount: deleteAccount(dependencies, now),
  });
}
