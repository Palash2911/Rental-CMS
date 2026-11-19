import { ACCESS, computeEntitlement } from "../../lib/entitlement.js";

/** Every Subscription column billing reads. */
export const SUBSCRIPTION_SELECT = Object.freeze({
  id: true,
  ownerAccountId: true,
  stripeCustomerId: true,
  stripeSubscriptionId: true,
  pendingCheckoutSessionId: true,
  plan: true,
  interval: true,
  stripeStatus: true,
  trialEnd: true,
  currentPeriodEnd: true,
  cancelAtPeriodEnd: true,
  trialUsedAt: true,
  enterprise: true,
  readOnlySince: true,
});

/**
 * Locks the owner account row FOR NO KEY UPDATE and returns `{ id, status }`, or null when
 * the account does not exist. Taken before the Subscription lock to keep the lock order
 * House, OwnerAccount, Subscription, TenantAssignment, User.
 */
export async function lockOwnerAccount(tx, ownerAccountId) {
  const rows = await tx.$queryRaw`
    SELECT id, status::text AS status FROM "OwnerAccount"
    WHERE id = ${ownerAccountId}
    FOR NO KEY UPDATE`;

  return rows[0] ?? null;
}

/**
 * Inserts the account's Subscription row if missing, then locks it FOR UPDATE and returns it.
 * The insert is ON CONFLICT DO NOTHING, so two concurrent callers cannot fail on the unique
 * ownerAccountId; both then wait on the same row lock.
 */
export async function lockSubscription(tx, ownerAccountId) {
  await tx.subscription.createMany({ data: [{ ownerAccountId }], skipDuplicates: true });
  await tx.$queryRaw`SELECT id FROM "Subscription" WHERE "ownerAccountId" = ${ownerAccountId} FOR UPDATE`;

  return tx.subscription.findUnique({
    where: { ownerAccountId },
    select: SUBSCRIPTION_SELECT,
  });
}

/**
 * Keeps Subscription.readOnlySince in step with entitlement: set (once) when billing makes
 * the account read-only, cleared when access returns. The later grace-period and deletion
 * job reads it. Call after any write that can change entitlement, inside its transaction.
 */
export async function syncReadOnlySince(tx, ownerAccountId, now = new Date()) {
  const account = await tx.ownerAccount.findUnique({
    where: { id: ownerAccountId },
    select: { status: true, subscription: { select: SUBSCRIPTION_SELECT } },
  });

  if (!account) {
    return;
  }

  const { access } = computeEntitlement(account.status, account.subscription);
  const readOnly = access === ACCESS.READ_ONLY;
  const current = account.subscription?.readOnlySince ?? null;

  if (readOnly && !current) {
    await tx.subscription.upsert({
      where: { ownerAccountId },
      create: { ownerAccountId, readOnlySince: now },
      update: { readOnlySince: now },
      select: { id: true },
    });
  } else if (!readOnly && current) {
    await tx.subscription.update({
      where: { ownerAccountId },
      data: { readOnlySince: null },
      select: { id: true },
    });
  }
}
