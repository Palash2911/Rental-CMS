import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  MAX_PENDING_UPLOADS_PER_ASSIGNMENT,
  RECEIPT_FILE_MAX_BYTES,
} from "../../src/graphql/receipts/receiptFiles.js";
import { prisma, resetDatabase } from "../support/db.js";
import {
  addMember,
  contextFor,
  createAssignment,
  createHouse,
  createOwnerAccount,
  createReceipt,
  createReceiptUpload,
  createUser,
} from "../support/factories.js";
import { expectData, expectError, run } from "../support/graphql.js";
import { fakeStorageGateway } from "../support/storage.js";

const REQUEST = `mutation ($input: RequestReceiptUploadInput!) {
  requestReceiptUpload(input: $input) { uploadUrl fileKey contentType sizeBytes expiresAt }
}`;
const CREATE = `mutation ($input: CreateReceiptInput!) { createReceipt(input: $input) { id hasFile } }`;
const FILE_URL = `query ($id: ID!) { receiptFileUrl(receiptId: $id) { url expiresAt } }`;
const RECEIPT = `query ($id: ID!) { receipt(id: $id) { id hasFile } }`;

const MESSAGES = Object.freeze({
  NOT_ACTIVE: "This tenant assignment is no longer active.",
  ACCESS_NOT_ALLOWED: "This action is not available to you.",
  STATUS_NOT_ALLOWED: "This action is not available for the owner account in its current state.",
  READ_ONLY: "This owner account is read-only until its billing is resolved.",
  NOT_FOUND: "Tenant assignment not found.",
  RECEIPT_NOT_FOUND: "Receipt not found.",
  FILE_TYPE: "Upload a PDF, JPEG or PNG file.",
  FILE_SIZE: "The file must be between 1 byte and 10 MB.",
  FILE_KEY: "Invalid file key.",
  TOO_MANY: "This tenant assignment has too many files waiting to be attached. Attach or wait for them to expire.",
  FILE_NOT_FOUND: "The uploaded file was not found. Request a new upload.",
  FILE_NOT_FOR_ASSIGNMENT: "This file does not belong to this tenant assignment.",
  FILE_MISMATCH: "The uploaded file does not match the requested type or size.",
  FILE_ALREADY_ATTACHED: "This file is already attached to a receipt.",
});

const PDF = Object.freeze({ contentType: "application/pdf", sizeBytes: 2048 });
const MS_PER_SECOND = 1000;

async function lease({ accountStatus = "APPROVED", billing, assignmentStatus = "ACTIVE" } = {}) {
  const [owner, tenant] = await Promise.all([createUser(), createUser()]);
  const account = await createOwnerAccount(owner, { status: accountStatus, ...(billing === undefined ? {} : { billing }) });
  const house = await createHouse(account);
  const assignment = await createAssignment(house, tenant, { status: assignmentStatus });
  return { owner, tenant, account, house, assignment };
}

function requestUpload(user, assignment, storage, file = PDF) {
  return run(contextFor(user, { storageGateway: storage.gateway }), REQUEST, {
    input: { tenantAssignmentId: assignment.id, ...file },
  });
}

function createWithFile(user, assignment, storage, fileKey, overrides = {}) {
  return run(contextFor(user, { storageGateway: storage.gateway }), CREATE, {
    input: { tenantAssignmentId: assignment.id, amountCents: 1000, paidAt: "2026-11-01", fileKey, ...overrides },
  });
}

/** Requests an upload through the API and stores a matching object, as the browser would. */
async function uploaded(tenant, assignment, storage, file = PDF) {
  const ticket = expectData(await requestUpload(tenant, assignment, storage, file)).requestReceiptUpload;
  storage.put(ticket.fileKey, file);
  return ticket;
}

function fieldErrors(error) {
  return error.extensions.fieldErrors.map((entry) => ({ ...entry }));
}

beforeEach(resetDatabase);

describe("requestReceiptUpload", () => {
  it("records the upload under the assignment's prefix and returns a URL locked to type, size and 10 minutes", async () => {
    const { tenant, account, assignment } = await lease();
    const storage = fakeStorageGateway();
    const before = Date.now();

    const ticket = expectData(await requestUpload(tenant, assignment, storage)).requestReceiptUpload;

    assert.match(ticket.fileKey, new RegExp(`^receipts/${account.id}/${assignment.id}/[0-9a-f-]{36}\\.pdf$`));
    assert.equal(ticket.contentType, "application/pdf");
    assert.equal(ticket.sizeBytes, 2048);
    assert.deepEqual(storage.callsTo("presignUpload").map((call) => call.args), [
      { key: ticket.fileKey, contentType: "application/pdf", sizeBytes: 2048, expiresInSeconds: 600 },
    ]);
    assert.equal(ticket.uploadUrl.includes(ticket.fileKey), true);

    const expiresIn = Date.parse(ticket.expiresAt) - before;
    assert.ok(expiresIn > 590 * MS_PER_SECOND && expiresIn <= 601 * MS_PER_SECOND, `expires in ${expiresIn} ms`);

    const row = await prisma.receiptUpload.findUnique({ where: { key: ticket.fileKey } });
    assert.deepEqual(
      { ownerAccountId: row.ownerAccountId, tenantAssignmentId: row.tenantAssignmentId, requestedByUserId: row.requestedByUserId, contentType: row.contentType, sizeBytes: row.sizeBytes, attachedAt: row.attachedAt },
      { ownerAccountId: account.id, tenantAssignmentId: assignment.id, requestedByUserId: tenant.id, contentType: "application/pdf", sizeBytes: 2048, attachedAt: null },
    );

    const [log] = await prisma.activityLog.findMany({ where: { entityId: row.id } });
    assert.equal(log.action, "UPLOAD_REQUESTED");
    assert.equal(log.ownerAccountId, account.id);
    assert.deepEqual(log.metadata, { tenantAssignmentId: assignment.id, contentType: "application/pdf", sizeBytes: 2048 });
  });

  it("accepts JPEG and PNG with their extensions, and exactly 10 MB", async () => {
    const { tenant, assignment } = await lease();
    const storage = fakeStorageGateway();

    const jpeg = expectData(await requestUpload(tenant, assignment, storage, { contentType: "image/jpeg", sizeBytes: RECEIPT_FILE_MAX_BYTES })).requestReceiptUpload;
    const png = expectData(await requestUpload(tenant, assignment, storage, { contentType: "image/png", sizeBytes: 1 })).requestReceiptUpload;

    assert.ok(jpeg.fileKey.endsWith(".jpg"));
    assert.ok(png.fileKey.endsWith(".png"));
  });

  it("refuses other content types and sizes outside 1 byte to 10 MB, before writing anything", async () => {
    const { tenant, assignment } = await lease();
    const storage = fakeStorageGateway();

    for (const file of [
      { contentType: "text/html", sizeBytes: 100, path: "input.contentType", message: MESSAGES.FILE_TYPE },
      { contentType: "image/gif", sizeBytes: 100, path: "input.contentType", message: MESSAGES.FILE_TYPE },
      { contentType: "application/pdf", sizeBytes: 0, path: "input.sizeBytes", message: MESSAGES.FILE_SIZE },
      { contentType: "application/pdf", sizeBytes: RECEIPT_FILE_MAX_BYTES + 1, path: "input.sizeBytes", message: MESSAGES.FILE_SIZE },
    ]) {
      const error = expectError(
        await requestUpload(tenant, assignment, storage, { contentType: file.contentType, sizeBytes: file.sizeBytes }),
        "BAD_USER_INPUT",
      );
      assert.deepEqual(fieldErrors(error), [{ path: file.path, message: file.message }], file.contentType);
    }

    assert.equal(await prisma.receiptUpload.count(), 0);
    assert.equal(storage.calls.length, 0);
  });

  it("allows a NOTICE_PERIOD assignment and refuses an EXITED one with CONFLICT", async () => {
    const notice = await lease({ assignmentStatus: "NOTICE_PERIOD" });
    const exited = await lease({ assignmentStatus: "EXITED" });
    const storage = fakeStorageGateway();

    expectData(await requestUpload(notice.tenant, notice.assignment, storage));
    expectError(await requestUpload(exited.tenant, exited.assignment, storage), "CONFLICT", MESSAGES.NOT_ACTIVE);
  });

  it("is for the tenant only: FORBIDDEN to owner members, NOT_FOUND to strangers", async () => {
    const { owner, account, assignment } = await lease();
    const [coOwner, stranger] = await Promise.all([createUser(), createUser()]);
    await addMember(account, coOwner);
    const storage = fakeStorageGateway();

    expectError(await requestUpload(owner, assignment, storage), "FORBIDDEN", MESSAGES.ACCESS_NOT_ALLOWED);
    expectError(await requestUpload(coOwner, assignment, storage), "FORBIDDEN", MESSAGES.ACCESS_NOT_ALLOWED);
    expectError(await requestUpload(stranger, assignment, storage), "NOT_FOUND", MESSAGES.NOT_FOUND);
  });

  for (const accountStatus of ["PENDING", "BLOCKED", "PENDING_DELETION"]) {
    it(`gives FORBIDDEN while the account is ${accountStatus}`, async () => {
      const { tenant, assignment } = await lease({ accountStatus });

      expectError(await requestUpload(tenant, assignment, fakeStorageGateway()), "FORBIDDEN", MESSAGES.STATUS_NOT_ALLOWED);
    });
  }

  it("gives FORBIDDEN while billing makes the account read-only", async () => {
    const { tenant, assignment } = await lease({ billing: null });

    expectError(await requestUpload(tenant, assignment, fakeStorageGateway()), "FORBIDDEN", MESSAGES.READ_ONLY);
  });

  it(`refuses a new upload once ${MAX_PENDING_UPLOADS_PER_ASSIGNMENT} are waiting to be attached`, async () => {
    const { tenant, assignment } = await lease();

    for (let index = 0; index < MAX_PENDING_UPLOADS_PER_ASSIGNMENT; index += 1) {
      await createReceiptUpload(assignment, tenant);
    }

    await createReceiptUpload(assignment, tenant, { attachedAt: new Date() });
    await createReceiptUpload(assignment, tenant, { discardedAt: new Date() });

    expectError(await requestUpload(tenant, assignment, fakeStorageGateway()), "CONFLICT", MESSAGES.TOO_MANY);
  });
});

describe("createReceipt with a file", () => {
  it("attaches a matching uploaded file once: hasFile is true and the upload is marked attached", async () => {
    const { tenant, assignment } = await lease();
    const storage = fakeStorageGateway();
    const ticket = await uploaded(tenant, assignment, storage);

    const receipt = expectData(await createWithFile(tenant, assignment, storage, ticket.fileKey)).createReceipt;

    assert.equal(receipt.hasFile, true);
    const stored = await prisma.receipt.findUnique({ where: { id: receipt.id }, select: { receiptUpload: { select: { key: true, attachedAt: true } } } });
    assert.equal(stored.receiptUpload.key, ticket.fileKey);
    assert.ok(stored.receiptUpload.attachedAt);
    assert.deepEqual(storage.callsTo("headObject").map((call) => call.args.key), [ticket.fileKey]);

    const [log] = await prisma.activityLog.findMany({ where: { entityId: receipt.id } });
    assert.equal(log.metadata.contentType, "application/pdf");
    assert.equal(log.metadata.sizeBytes, 2048);
  });

  it("gives CONFLICT when the same file is attached a second time, and leaves one receipt", async () => {
    const { tenant, assignment } = await lease();
    const storage = fakeStorageGateway();
    const ticket = await uploaded(tenant, assignment, storage);
    expectData(await createWithFile(tenant, assignment, storage, ticket.fileKey));

    expectError(await createWithFile(tenant, assignment, storage, ticket.fileKey), "CONFLICT", MESSAGES.FILE_ALREADY_ATTACHED);
    assert.equal(await prisma.receipt.count(), 1);
  });

  it("gives BAD_USER_INPUT when nothing was uploaded", async () => {
    const { tenant, assignment } = await lease();
    const storage = fakeStorageGateway();
    const ticket = expectData(await requestUpload(tenant, assignment, storage)).requestReceiptUpload;

    const error = expectError(await createWithFile(tenant, assignment, storage, ticket.fileKey), "BAD_USER_INPUT", MESSAGES.FILE_NOT_FOUND);
    assert.deepEqual(fieldErrors(error), [{ path: "input.fileKey", message: MESSAGES.FILE_NOT_FOUND }]);
    assert.equal(await prisma.receipt.count(), 0);
  });

  for (const [label, stored] of [
    ["a larger file", { contentType: "application/pdf", sizeBytes: 4096 }],
    ["a smaller file", { contentType: "application/pdf", sizeBytes: 10 }],
    ["another content type", { contentType: "image/png", sizeBytes: 2048 }],
  ]) {
    it(`gives BAD_USER_INPUT when the stored object is ${label} than requested`, async () => {
      const { tenant, assignment } = await lease();
      const storage = fakeStorageGateway();
      const ticket = expectData(await requestUpload(tenant, assignment, storage)).requestReceiptUpload;
      storage.put(ticket.fileKey, stored);

      expectError(await createWithFile(tenant, assignment, storage, ticket.fileKey), "BAD_USER_INPUT", MESSAGES.FILE_MISMATCH);
      assert.equal(await prisma.receipt.count(), 0);
      assert.equal((await prisma.receiptUpload.findUnique({ where: { key: ticket.fileKey } })).attachedAt, null);
    });
  }

  it("gives BAD_USER_INPUT for a file from another assignment of the same tenant, or another account", async () => {
    const { tenant, account, assignment } = await lease();
    const otherHouse = await createHouse(account);
    const sibling = await createAssignment(otherHouse, tenant);
    const elsewhere = await lease();
    const storage = fakeStorageGateway();
    const siblingFile = await uploaded(tenant, sibling, storage);
    const foreignFile = await uploaded(elsewhere.tenant, elsewhere.assignment, storage);

    expectError(await createWithFile(tenant, assignment, storage, siblingFile.fileKey), "BAD_USER_INPUT", MESSAGES.FILE_NOT_FOR_ASSIGNMENT);
    expectError(await createWithFile(tenant, assignment, storage, foreignFile.fileKey), "BAD_USER_INPUT", MESSAGES.FILE_NOT_FOR_ASSIGNMENT);
    assert.equal(storage.callsTo("headObject").length, 0);
    assert.equal(await prisma.receipt.count(), 0);
  });

  it("gives BAD_USER_INPUT for a well-formed key nobody requested, a discarded upload, and a malformed key", async () => {
    const { tenant, account, assignment } = await lease();
    const storage = fakeStorageGateway();
    const unknownKey = `receipts/${account.id}/${assignment.id}/0f8fad5b-d9cb-469f-a165-70867728950e.pdf`;
    storage.put(unknownKey, PDF);
    const discarded = await createReceiptUpload(assignment, tenant, { discardedAt: new Date() });
    storage.put(discarded.key, PDF);

    expectError(await createWithFile(tenant, assignment, storage, unknownKey), "BAD_USER_INPUT", MESSAGES.FILE_NOT_FOUND);
    expectError(await createWithFile(tenant, assignment, storage, discarded.key), "BAD_USER_INPUT", MESSAGES.FILE_NOT_FOUND);

    for (const key of ["../etc/passwd", `receipts/${account.id}/${assignment.id}/x.pdf`, `receipts/${account.id}/${assignment.id}/0f8fad5b-d9cb-469f-a165-70867728950e.exe`]) {
      const error = expectError(await createWithFile(tenant, assignment, storage, key), "BAD_USER_INPUT");
      assert.deepEqual(fieldErrors(error), [{ path: "input.fileKey", message: MESSAGES.FILE_KEY }], key);
    }
  });

  it("refuses the file on an assignment that exited after the upload, and keeps it unattached", async () => {
    const { tenant, assignment } = await lease();
    const storage = fakeStorageGateway();
    const ticket = await uploaded(tenant, assignment, storage);
    await prisma.tenantAssignment.update({ where: { id: assignment.id }, data: { status: "EXITED" } });

    expectError(await createWithFile(tenant, assignment, storage, ticket.fileKey), "CONFLICT", MESSAGES.NOT_ACTIVE);
    assert.equal((await prisma.receiptUpload.findUnique({ where: { key: ticket.fileKey } })).attachedAt, null);
  });

  it("saves nothing when storage cannot be reached during the check", async () => {
    const { tenant, assignment } = await lease();
    const storage = fakeStorageGateway();
    const ticket = await uploaded(tenant, assignment, storage);
    storage.fail("headObject");

    const result = await createWithFile(tenant, assignment, storage, ticket.fileKey);

    assert.ok(result.errors?.length);
    assert.equal(result.errors[0].extensions?.code, undefined);
    assert.equal(await prisma.receipt.count(), 0);
  });

  it("creates a receipt without a file without touching storage", async () => {
    const { tenant, assignment } = await lease();

    const receipt = expectData(await run(contextFor(tenant), CREATE, {
      input: { tenantAssignmentId: assignment.id, amountCents: 1000, paidAt: "2026-11-01" },
    })).createReceipt;

    assert.equal(receipt.hasFile, false);
  });
});

describe("receiptFileUrl", () => {
  async function receiptWithFile(options) {
    const setup = await lease(options);
    const upload = await createReceiptUpload(setup.assignment, setup.tenant, { attachedAt: new Date() });
    const receipt = await createReceipt(setup.assignment, { receiptUploadId: upload.id });
    return { ...setup, upload, receipt };
  }

  function fileUrl(user, receipt, storage) {
    return run(contextFor(user, { storageGateway: storage.gateway }), FILE_URL, { id: receipt.id });
  }

  it("gives the tenant and owner members a 5-minute download URL", async () => {
    const { owner, tenant, upload, receipt } = await receiptWithFile();
    const storage = fakeStorageGateway();
    const before = Date.now();

    for (const user of [tenant, owner]) {
      const link = expectData(await fileUrl(user, receipt, storage)).receiptFileUrl;
      assert.ok(link.url.includes(upload.key));
      const expiresIn = Date.parse(link.expiresAt) - before;
      assert.ok(expiresIn > 290 * MS_PER_SECOND && expiresIn <= 301 * MS_PER_SECOND, `expires in ${expiresIn} ms`);
    }

    assert.deepEqual(storage.callsTo("presignDownload").map((call) => call.args), [
      { key: upload.key, expiresInSeconds: 300 },
      { key: upload.key, expiresInSeconds: 300 },
    ]);
  });

  it("is null for a receipt without a file, and Receipt.hasFile says so", async () => {
    const { tenant, assignment } = await lease();
    const plain = await createReceipt(assignment);
    const storage = fakeStorageGateway();

    assert.equal(expectData(await fileUrl(tenant, plain, storage)).receiptFileUrl, null);
    assert.equal(expectData(await run(contextFor(tenant), RECEIPT, { id: plain.id })).receipt.hasFile, false);
    assert.equal(storage.calls.length, 0);
  });

  for (const accountStatus of ["BLOCKED", "PENDING_DELETION"]) {
    it(`keeps the tenant's access while the account is ${accountStatus}`, async () => {
      const { tenant, receipt } = await receiptWithFile({ accountStatus });

      expectData(await fileUrl(tenant, receipt, fakeStorageGateway()));
    });
  }

  it("keeps access on a read-only account, for the tenant and for owners", async () => {
    const { owner, tenant, receipt } = await receiptWithFile({ billing: null });

    expectData(await fileUrl(tenant, receipt, fakeStorageGateway()));
    expectData(await fileUrl(owner, receipt, fakeStorageGateway()));
  });

  it("gives owners FORBIDDEN while the account is BLOCKED, and strangers NOT_FOUND", async () => {
    const { owner, receipt } = await receiptWithFile({ accountStatus: "BLOCKED" });
    const stranger = await createUser();

    expectError(await fileUrl(owner, receipt, fakeStorageGateway()), "FORBIDDEN", MESSAGES.STATUS_NOT_ALLOWED);
    expectError(await fileUrl(stranger, receipt, fakeStorageGateway()), "NOT_FOUND", MESSAGES.RECEIPT_NOT_FOUND);
  });

  it("never exposes the storage key on Receipt", async () => {
    const { tenant, receipt } = await receiptWithFile();

    const result = await run(contextFor(tenant), `query ($id: ID!) { receipt(id: $id) { fileKey } }`, { id: receipt.id });

    assert.match(result.errors[0].message, /Cannot query field "fileKey"/);
    assert.equal(expectData(await run(contextFor(tenant), RECEIPT, { id: receipt.id })).receipt.hasFile, true);
  });
});
