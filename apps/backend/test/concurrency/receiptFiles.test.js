import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { runAccountDeletion } from "../../src/jobs/accountDeletion.js";
import { runReceiptUploadCleanup } from "../../src/jobs/receiptUploads.js";
import { prisma, resetDatabase } from "../support/db.js";
import {
  contextFor,
  createAssignment,
  createHouse,
  createOwnerAccount,
  createReceiptUpload,
  createUser,
  recordingLogger,
} from "../support/factories.js";
import { race, run } from "../support/graphql.js";
import { fakeStorageGateway } from "../support/storage.js";
import { recordingStripeGateway } from "../support/stripe.js";

const ROUNDS = 5;
const CREATE = `mutation ($input: CreateReceiptInput!) { createReceipt(input: $input) { id hasFile } }`;
const PDF = Object.freeze({ contentType: "application/pdf", sizeBytes: 2048 });
const MS_PER_HOUR = 60 * 60 * 1000;
const MESSAGES = Object.freeze({
  FILE_ALREADY_ATTACHED: "This file is already attached to a receipt.",
  FILE_NOT_FOUND: "The uploaded file was not found. Request a new upload.",
});

async function lease(accountOptions = {}) {
  const [owner, tenant] = await Promise.all([createUser(), createUser()]);
  const account = await createOwnerAccount(owner, accountOptions);
  const house = await createHouse(account);
  const assignment = await createAssignment(house, tenant);
  return { owner, tenant, account, house, assignment };
}

function attach(tenant, assignment, storage, fileKey) {
  return () =>
    run(contextFor(tenant, { storageGateway: storage.gateway }), CREATE, {
      input: { tenantAssignmentId: assignment.id, amountCents: 1000, paidAt: "2026-11-01", fileKey },
    });
}

beforeEach(resetDatabase);

describe("concurrent receipt file attaches", () => {
  it("lets exactly one of two receipts claim the same file", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      await resetDatabase();
      const { tenant, assignment } = await lease();
      const storage = fakeStorageGateway();
      const upload = await createReceiptUpload(assignment, tenant, PDF);
      storage.put(upload.key, PDF);

      const outcomes = await race([
        attach(tenant, assignment, storage, upload.key),
        attach(tenant, assignment, storage, upload.key),
      ]);

      assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1, `round ${round}`);
      const refused = outcomes.find((outcome) => !outcome.ok);
      assert.deepEqual({ code: refused.code, message: refused.message }, { code: "CONFLICT", message: MESSAGES.FILE_ALREADY_ATTACHED });
      assert.equal(await prisma.receipt.count({ where: { receiptUploadId: upload.id } }), 1);
    }
  });

  it("never both attaches and deletes a file when the daily cleanup claims it at the same time", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      await resetDatabase();
      const { tenant, assignment } = await lease();
      const storage = fakeStorageGateway();
      const now = new Date();
      const upload = await createReceiptUpload(assignment, tenant, { ...PDF, createdAt: new Date(now.getTime() - 25 * MS_PER_HOUR) });
      storage.put(upload.key, PDF);

      const [attachOutcome] = await race([
        attach(tenant, assignment, storage, upload.key),
        () => runReceiptUploadCleanup({ prisma, storageGateway: storage.gateway, log: recordingLogger() }, { now }),
      ]);

      const row = await prisma.receiptUpload.findUnique({ where: { id: upload.id } });
      const receipts = await prisma.receipt.count({ where: { receiptUploadId: upload.id } });

      if (attachOutcome.ok) {
        assert.ok(row?.attachedAt, `round ${round}: attached receipt lost its upload row`);
        assert.equal(row.discardedAt, null);
        assert.ok(storage.objects.has(upload.key), `round ${round}: attached file was deleted`);
        assert.equal(receipts, 1);
      } else {
        assert.deepEqual({ code: attachOutcome.code, message: attachOutcome.message }, { code: "BAD_USER_INPUT", message: MESSAGES.FILE_NOT_FOUND });
        assert.equal(receipts, 0);
        assert.equal(row, null);
        assert.equal(storage.objects.has(upload.key), false);
      }
    }
  });

  it("serialises a file attach with the account deletion job without deadlocking", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      await resetDatabase();
      const now = new Date();
      const setup = await lease();
      const storage = fakeStorageGateway();
      const upload = await createReceiptUpload(setup.assignment, setup.tenant, PDF);
      storage.put(upload.key, PDF);
      // The guard passes on APPROVED; the account then becomes due for deletion before the
      // attach transaction starts, so the two transactions really compete for the House row.
      const deletion = () =>
        prisma.ownerAccount
          .update({
            where: { id: setup.account.id },
            data: { status: "PENDING_DELETION", statusBeforeDeletion: "APPROVED", deletionScheduledAt: new Date(now.getTime() - MS_PER_HOUR) },
          })
          .then(() =>
            runAccountDeletion(
              { prisma, billingGateway: recordingStripeGateway().gateway, storageGateway: storage.gateway, log: recordingLogger() },
              { now },
            ),
          );

      const [attachOutcome] = await race([attach(setup.tenant, setup.assignment, storage, upload.key), deletion]);

      const remaining = await prisma.receipt.count({ where: { tenantAssignment: { houseId: setup.house.id } } });
      assert.equal(remaining, 0, `round ${round}: a receipt survived the account deletion`);

      if (!attachOutcome.ok) {
        // FORBIDDEN when the guard already sees PENDING_DELETION; the others when the job wins
        // the House lock or deletes the object before the attach checks it.
        assert.ok(["FORBIDDEN", "CONFLICT", "NOT_FOUND", "BAD_USER_INPUT"].includes(attachOutcome.code), `round ${round}: ${attachOutcome.code}`);
      }
    }
  });
});
