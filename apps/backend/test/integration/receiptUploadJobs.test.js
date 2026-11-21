import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { runAccountDeletion } from "../../src/jobs/accountDeletion.js";
import {
  runReceiptUploadCleanup,
  runReceiptUploadVerify,
  UNATTACHED_UPLOAD_RETENTION_HOURS,
  UPLOAD_VERIFY_AFTER_MINUTES,
} from "../../src/jobs/receiptUploads.js";
import { prisma, resetDatabase } from "../support/db.js";
import {
  createAssignment,
  createHouse,
  createOwnerAccount,
  createReceipt,
  createReceiptUpload,
  createUser,
  recordingLogger,
} from "../support/factories.js";
import { fakeStorageGateway } from "../support/storage.js";
import { recordingStripeGateway } from "../support/stripe.js";

const NOW = new Date("2027-04-01T05:00:00.000Z");
const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const PDF = Object.freeze({ contentType: "application/pdf", sizeBytes: 2048 });

function minutesAgo(minutes) {
  return new Date(NOW.getTime() - minutes * MS_PER_MINUTE);
}

function hoursAgo(hours) {
  return new Date(NOW.getTime() - hours * MS_PER_HOUR);
}

async function lease(accountOptions = {}) {
  const [owner, tenant] = await Promise.all([createUser(), createUser()]);
  const account = await createOwnerAccount(owner, accountOptions);
  const house = await createHouse(account);
  const assignment = await createAssignment(house, tenant);
  return { owner, tenant, account, house, assignment };
}

/** An upload row with its stored object (`stored`: what was really uploaded, or null). */
async function upload(setup, storage, { stored = PDF, ...options } = {}) {
  const row = await createReceiptUpload(setup.assignment, setup.tenant, { ...PDF, ...options });

  if (stored) {
    storage.put(row.key, stored);
  }

  return row;
}

function deps(storage, log = recordingLogger()) {
  return { prisma, storageGateway: storage.gateway, log };
}

function stored(row) {
  return prisma.receiptUpload.findUnique({ where: { id: row.id } });
}

beforeEach(resetDatabase);

describe(`receiptUploadVerify (hourly, uploads older than ${UPLOAD_VERIFY_AFTER_MINUTES} minutes)`, () => {
  it("marks a matching upload verified and keeps its object", async () => {
    const setup = await lease();
    const storage = fakeStorageGateway();
    const row = await upload(setup, storage, { createdAt: minutesAgo(20) });

    const summary = await runReceiptUploadVerify(deps(storage), { now: NOW });

    assert.deepEqual(summary, { job: "receiptUploadVerify", checked: 1, verified: 1, discarded: 0, removed: 0, failed: 0 });
    assert.equal((await stored(row)).verifiedAt.toISOString(), NOW.toISOString());
    assert.ok(storage.objects.has(row.key));

    const again = await runReceiptUploadVerify(deps(storage), { now: NOW });
    assert.equal(again.checked, 0);
  });

  for (const [label, actual] of [
    ["larger than requested", { contentType: "application/pdf", sizeBytes: 50_000_000 }],
    ["of another content type", { contentType: "text/html", sizeBytes: 2048 }],
  ]) {
    it(`deletes the object and row when the stored object is ${label}`, async () => {
      const setup = await lease();
      const storage = fakeStorageGateway();
      const row = await upload(setup, storage, { createdAt: minutesAgo(20), stored: actual });

      const summary = await runReceiptUploadVerify(deps(storage), { now: NOW });

      assert.deepEqual(summary, { job: "receiptUploadVerify", checked: 1, verified: 0, discarded: 1, removed: 1, failed: 0 });
      assert.equal(storage.objects.has(row.key), false);
      assert.equal(await stored(row), null);
    });
  }

  it("removes the row of an upload that never arrived", async () => {
    const setup = await lease();
    const storage = fakeStorageGateway();
    const row = await upload(setup, storage, { createdAt: minutesAgo(20), stored: null });

    await runReceiptUploadVerify(deps(storage), { now: NOW });

    assert.equal(await stored(row), null);
  });

  it("leaves uploads younger than the cutoff, attached uploads and verified ones alone", async () => {
    const setup = await lease();
    const storage = fakeStorageGateway();
    const young = await upload(setup, storage, { createdAt: minutesAgo(5), stored: { contentType: "text/html", sizeBytes: 1 } });
    const attached = await upload(setup, storage, { createdAt: minutesAgo(30), attachedAt: minutesAgo(25), stored: { contentType: "text/html", sizeBytes: 1 } });
    const verified = await upload(setup, storage, { createdAt: minutesAgo(90), verifiedAt: minutesAgo(30) });

    const summary = await runReceiptUploadVerify(deps(storage), { now: NOW });

    assert.equal(summary.checked, 0);
    for (const row of [young, attached, verified]) {
      assert.ok(await stored(row));
      assert.ok(storage.objects.has(row.key));
    }
  });

  it("logs a storage failure on the check, leaves the upload unchecked and retries it next hour", async () => {
    const setup = await lease();
    const storage = fakeStorageGateway();
    const log = recordingLogger();
    const row = await upload(setup, storage, { createdAt: minutesAgo(20), stored: { contentType: "application/pdf", sizeBytes: 1 } });
    storage.fail("headObject");

    const failed = await runReceiptUploadVerify(deps(storage, log), { now: NOW });

    assert.equal(failed.failed, 1);
    assert.equal(log.entries[0].level, "warn");
    assert.equal((await stored(row)).discardedAt, null);

    storage.heal("headObject");
    const retried = await runReceiptUploadVerify(deps(storage), { now: NOW });
    assert.equal(retried.removed, 1);
    assert.equal(await stored(row), null);
  });

  it("keeps a mismatched upload discarded (never attachable) when the delete fails, and removes it next run", async () => {
    const setup = await lease();
    const storage = fakeStorageGateway();
    const row = await upload(setup, storage, { createdAt: minutesAgo(20), stored: { contentType: "application/pdf", sizeBytes: 1 } });
    storage.fail("deleteObjects");

    const first = await runReceiptUploadVerify(deps(storage), { now: NOW });

    assert.deepEqual({ discarded: first.discarded, removed: first.removed }, { discarded: 1, removed: 0 });
    assert.ok((await stored(row)).discardedAt);
    assert.ok(storage.objects.has(row.key));

    storage.heal("deleteObjects");
    const second = await runReceiptUploadVerify(deps(storage), { now: NOW });
    assert.equal(second.removed, 1);
    assert.equal(storage.objects.has(row.key), false);
    assert.equal(await stored(row), null);
  });
});

describe(`receiptUploadCleanup (daily, unattached after ${UNATTACHED_UPLOAD_RETENTION_HOURS} hours)`, () => {
  it("deletes unattached uploads past the retention, verified or not, and keeps the rest", async () => {
    const setup = await lease();
    const storage = fakeStorageGateway();
    const stale = await upload(setup, storage, { createdAt: hoursAgo(25) });
    const staleVerified = await upload(setup, storage, { createdAt: hoursAgo(30), verifiedAt: hoursAgo(29) });
    const recent = await upload(setup, storage, { createdAt: hoursAgo(23) });
    const attached = await upload(setup, storage, { createdAt: hoursAgo(48), attachedAt: hoursAgo(47) });
    await createReceipt(setup.assignment, { receiptUploadId: attached.id });

    const summary = await runReceiptUploadCleanup(deps(storage), { now: NOW });

    assert.deepEqual(summary, { job: "receiptUploadCleanup", discarded: 2, removed: 2 });
    for (const row of [stale, staleVerified]) {
      assert.equal(await stored(row), null);
      assert.equal(storage.objects.has(row.key), false);
    }
    for (const row of [recent, attached]) {
      assert.ok(await stored(row));
      assert.ok(storage.objects.has(row.key));
    }
  });

  it("works through more uploads than one batch", async () => {
    const setup = await lease();
    const storage = fakeStorageGateway();

    for (let index = 0; index < 5; index += 1) {
      await upload(setup, storage, { createdAt: hoursAgo(25) });
    }

    const summary = await runReceiptUploadCleanup(deps(storage), { now: NOW, batchSize: 2 });

    assert.deepEqual(summary, { job: "receiptUploadCleanup", discarded: 5, removed: 5 });
    assert.equal(storage.objects.size, 0);
    assert.deepEqual(storage.callsTo("deleteObjects").map((call) => call.args.keys.length), [2, 2, 1]);
  });

  it("keeps uploads discarded on a storage failure and retries them next run", async () => {
    const setup = await lease();
    const storage = fakeStorageGateway();
    const row = await upload(setup, storage, { createdAt: hoursAgo(25) });
    storage.fail("deleteObjects");

    const failed = await runReceiptUploadCleanup(deps(storage), { now: NOW });

    assert.deepEqual(failed, { job: "receiptUploadCleanup", discarded: 1, removed: 0 });
    assert.ok((await stored(row)).discardedAt);

    storage.heal("deleteObjects");
    const retried = await runReceiptUploadCleanup(deps(storage), { now: NOW });
    assert.deepEqual(retried, { job: "receiptUploadCleanup", discarded: 0, removed: 1 });
    assert.equal(await stored(row), null);
  });
});

describe("accountDeletion and stored receipt files", () => {
  const MS_PER_DAY = 24 * MS_PER_HOUR;

  async function doomed() {
    const setup = await lease({
      status: "PENDING_DELETION",
      statusBeforeDeletion: "APPROVED",
      deletionScheduledAt: new Date(NOW.getTime() - MS_PER_DAY),
      billing: null,
    });
    return setup;
  }

  function runDeletion(storage) {
    return runAccountDeletion(
      { prisma, billingGateway: recordingStripeGateway().gateway, storageGateway: storage.gateway, log: recordingLogger() },
      { now: NOW },
    );
  }

  it("deletes every object under the account's prefix in batches, orphans included, and only that account's", async () => {
    const setup = await doomed();
    const healthy = await lease();
    const storage = fakeStorageGateway({ pageSize: 2 });
    const attached = await upload(setup, storage, { attachedAt: hoursAgo(1) });
    await createReceipt(setup.assignment, { receiptUploadId: attached.id });
    await upload(setup, storage);
    await upload(setup, storage, { discardedAt: hoursAgo(1) });
    storage.put(`receipts/${setup.account.id}/${setup.assignment.id}/stray-object.pdf`, PDF);
    storage.put(`receipts/${setup.account.id}/elsewhere/another.png`, PDF);
    const kept = await upload(healthy, storage);

    const summary = await runDeletion(storage);

    assert.equal(summary.done, 1);
    assert.deepEqual([...storage.objects.keys()], [kept.key]);
    assert.deepEqual(storage.callsTo("deleteObjects").map((call) => call.args.keys.length), [2, 2, 1]);
    assert.equal(await prisma.receiptUpload.count({ where: { ownerAccountId: setup.account.id } }), 0);
    assert.equal(await prisma.receiptUpload.count({ where: { ownerAccountId: healthy.account.id } }), 1);

    const log = await prisma.activityLog.findFirst({ where: { entityId: setup.account.id, action: "DELETION_EXECUTED" } });
    assert.equal(log.metadata.storageObjectsDeleted, 5);
    assert.equal(log.metadata.deleted.receiptUploads, 3);
  });

  for (const method of ["listKeys", "deleteObjects"]) {
    it(`defers the account when ${method} fails, keeps all its data, and finishes on the next run`, async () => {
      const setup = await doomed();
      const storage = fakeStorageGateway();
      const row = await upload(setup, storage);
      storage.fail(method);

      const deferred = await runDeletion(storage);

      assert.deepEqual({ done: deferred.done, deferred: deferred.deferred }, { done: 0, deferred: 1 });
      assert.ok(await stored(row));
      assert.equal(await prisma.house.count({ where: { ownerAccountId: setup.account.id } }), 1);
      assert.equal((await prisma.ownerAccount.findUnique({ where: { id: setup.account.id } })).deletionExecutedAt, null);

      storage.heal(method);
      const retried = await runDeletion(storage);

      assert.equal(retried.done, 1);
      assert.equal(storage.objects.size, 0);
      assert.equal(await stored(row), null);
    });
  }
});
