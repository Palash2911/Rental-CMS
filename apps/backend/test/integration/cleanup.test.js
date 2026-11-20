import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  EXPIRED_INVITATION_RETENTION_DAYS,
  runCleanup,
  STRIPE_EVENT_RETENTION_DAYS,
} from "../../src/jobs/cleanup.js";
import { prisma, resetDatabase } from "../support/db.js";
import {
  createHouse,
  createInvitation,
  createMemberInvitation,
  createOwnerAccount,
  createUser,
} from "../support/factories.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2027-05-01T04:00:00.000Z");

function daysBeforeNow(days) {
  return new Date(NOW.getTime() - days * MS_PER_DAY);
}

async function fixture() {
  const owner = await createUser();
  const account = await createOwnerAccount(owner);
  const house = await createHouse(account);
  return { owner, account, house };
}

function stripeEventAt(processedAt) {
  return prisma.stripeEvent.create({
    data: { id: `evt_test_${processedAt.getTime()}_${Math.random().toString(36).slice(2)}`, type: "invoice.paid", processedAt },
  });
}

function ids(rows) {
  return rows.map(({ id }) => id).sort();
}

beforeEach(resetDatabase);

describe("cleanup", () => {
  it("deletes PENDING invitations expired for more than 30 days and keeps everything else", async () => {
    const { owner, account, house } = await fixture();
    const old = daysBeforeNow(EXPIRED_INVITATION_RETENTION_DAYS + 1);
    const recent = daysBeforeNow(EXPIRED_INVITATION_RETENTION_DAYS - 1);

    const doomed = [
      await createInvitation(house, owner, { expiresAt: old }),
      await createMemberInvitation(account, owner, { expiresAt: old }),
    ];
    const kept = [
      await createInvitation(house, owner, { expiresAt: recent }),
      await createInvitation(house, owner, { expiresAt: new Date(NOW.getTime() + 14 * MS_PER_DAY) }),
      await createInvitation(house, owner, { expiresAt: old, status: "REVOKED", respondedAt: old }),
      await createInvitation(house, owner, { expiresAt: old, status: "DECLINED", respondedAt: old }),
      await createMemberInvitation(account, owner, { expiresAt: recent }),
      await createMemberInvitation(account, owner, { expiresAt: old, status: "ACCEPTED", respondedAt: old }),
    ];

    const summary = await runCleanup({ prisma }, { now: NOW });

    assert.deepEqual(summary, { job: "cleanup", tenantInvitations: 1, memberInvitations: 1, stripeEvents: 0 });
    const remaining = [...(await prisma.invitation.findMany()), ...(await prisma.memberInvitation.findMany())];
    assert.deepEqual(ids(remaining), ids(kept));
    assert.ok(doomed.every(({ id }) => !remaining.some((row) => row.id === id)));
  });

  it("deletes Stripe events processed more than 90 days ago", async () => {
    const old = await stripeEventAt(daysBeforeNow(STRIPE_EVENT_RETENTION_DAYS + 1));
    const kept = [
      await stripeEventAt(daysBeforeNow(STRIPE_EVENT_RETENTION_DAYS - 1)),
      await stripeEventAt(NOW),
    ];

    const summary = await runCleanup({ prisma }, { now: NOW });

    assert.equal(summary.stripeEvents, 1);
    assert.equal(await prisma.stripeEvent.findUnique({ where: { id: old.id } }), null);
    assert.deepEqual(ids(await prisma.stripeEvent.findMany()), ids(kept));
  });

  it("works through every batch and is idempotent", async () => {
    const { owner, house } = await fixture();
    const old = daysBeforeNow(EXPIRED_INVITATION_RETENTION_DAYS + 2);

    for (let index = 0; index < 5; index += 1) {
      await createInvitation(house, owner, { expiresAt: old });
      await stripeEventAt(daysBeforeNow(STRIPE_EVENT_RETENTION_DAYS + 1 + index));
    }

    const first = await runCleanup({ prisma }, { now: NOW, batchSize: 2 });
    const second = await runCleanup({ prisma }, { now: NOW, batchSize: 2 });

    assert.deepEqual([first.tenantInvitations, first.stripeEvents], [5, 5]);
    assert.deepEqual([second.tenantInvitations, second.memberInvitations, second.stripeEvents], [0, 0, 0]);
    assert.equal(await prisma.invitation.count(), 0);
  });
});
