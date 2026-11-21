import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { schema } from "../../src/graphql/rootSchema.js";
import { prisma, resetDatabase } from "../support/db.js";
import {
  addMember,
  contextFor,
  createAssignment,
  createHouse,
  createOwnerAccount,
  createReceipt,
  createUser,
} from "../support/factories.js";
import { expectData, expectError, run } from "../support/graphql.js";

const FIELDS = "id tenantAssignmentId amountCents currency paidAt note createdAt";
const CREATE = `mutation ($input: CreateReceiptInput!) { createReceipt(input: $input) { ${FIELDS} } }`;
const GET = `query ($id: ID!) { receipt(id: $id) { ${FIELDS} } }`;
const BY_ASSIGNMENT = `query ($tenantAssignmentId: ID!, $first: Int, $after: String) { receiptsByAssignment(tenantAssignmentId: $tenantAssignmentId, first: $first, after: $after) { items { id } pageInfo { nextCursor hasNextPage } } }`;

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MESSAGES = Object.freeze({
  NOT_ACTIVE: "This tenant assignment is no longer active.",
  ACCESS_NOT_ALLOWED: "This action is not available to you.",
  STATUS_NOT_ALLOWED: "This action is not available for the owner account in its current state.",
  NOT_FOUND: "Tenant assignment not found.",
  RECEIPT_NOT_FOUND: "Receipt not found.",
  CURRENCY: "Use a three-letter uppercase currency code, such as AUD.",
  PAID_AT_FUTURE: "The payment date cannot be in the future.",
  INVALID_DATE: "Enter a valid calendar date as YYYY-MM-DD.",
  YEAR_OUT_OF_RANGE: "Dates must fall between 2000 and 2100.",
});

async function lease({ accountStatus = "APPROVED", assignmentStatus = "ACTIVE" } = {}) {
  const [owner, coOwner, tenant] = await Promise.all([createUser(), createUser(), createUser()]);
  const account = await createOwnerAccount(owner, { status: accountStatus });
  await addMember(account, coOwner);
  const house = await createHouse(account);
  const assignment = await createAssignment(house, tenant, { status: assignmentStatus });
  return { owner, coOwner, tenant, account, house, assignment };
}

/** The UTC calendar date `offsetDays` from today, as YYYY-MM-DD. */
function utcDate(offsetDays) {
  return new Date(Date.now() + offsetDays * MS_PER_DAY).toISOString().slice(0, 10);
}

function input(assignment, overrides = {}) {
  return { tenantAssignmentId: assignment.id, amountCents: 125_000, paidAt: "2026-11-01", ...overrides };
}

function create(user, assignment, overrides) {
  return run(contextFor(user), CREATE, { input: input(assignment, overrides) });
}

/** The Date scalar's error for paidAt, as graphql-js prefixes it during variable coercion. */
function paidAtScalarMessage(message) {
  return `Variable "$input" has invalid value at .paidAt: ${message}`;
}

function fieldErrors(error) {
  return error.extensions.fieldErrors.map((entry) => ({ ...entry }));
}

beforeEach(resetDatabase);

describe("createReceipt", () => {
  it("records the receipt for the tenant, defaults the currency to AUD and logs it", async () => {
    const { tenant, assignment } = await lease();
    const receipt = expectData(await create(tenant, assignment, { note: "  Paid by transfer  " })).createReceipt;

    assert.equal(receipt.tenantAssignmentId, assignment.id);
    assert.equal(receipt.amountCents, 125_000);
    assert.equal(receipt.currency, "AUD");
    assert.equal(receipt.paidAt, "2026-11-01");
    assert.equal(receipt.note, "Paid by transfer");
    assert.ok(Date.parse(receipt.createdAt));

    const logs = await prisma.activityLog.findMany({ where: { entityId: receipt.id } });
    assert.equal(logs.length, 1);
    assert.equal(logs[0].entityType, "Receipt");
    assert.equal(logs[0].action, "CREATED");
    assert.equal(logs[0].performedByUserId, tenant.id);
    assert.deepEqual(logs[0].metadata, {
      tenantAssignmentId: assignment.id,
      amountCents: 125_000,
      currency: "AUD",
      paidAt: "2026-11-01",
    });
  });

  it("works on a NOTICE_PERIOD assignment", async () => {
    const { tenant, assignment } = await lease({ assignmentStatus: "NOTICE_PERIOD" });

    expectData(await create(tenant, assignment));
  });

  it("gives CONFLICT on an EXITED assignment and writes nothing", async () => {
    const { tenant, assignment } = await lease({ assignmentStatus: "EXITED" });

    expectError(await create(tenant, assignment), "CONFLICT", MESSAGES.NOT_ACTIVE);
    assert.equal(await prisma.receipt.count(), 0);
    assert.equal(await prisma.activityLog.count({ where: { entityType: "Receipt" } }), 0);
  });

  it("gives FORBIDDEN to owners and NOT_FOUND to strangers", async () => {
    const { owner, coOwner, assignment } = await lease();

    for (const user of [owner, coOwner]) {
      expectError(await create(user, assignment), "FORBIDDEN", MESSAGES.ACCESS_NOT_ALLOWED);
    }

    expectError(await create(await createUser(), assignment), "NOT_FOUND", MESSAGES.NOT_FOUND);
    assert.equal(await prisma.receipt.count(), 0);
  });

  it("gives FORBIDDEN to the tenant unless the account is APPROVED", async () => {
    for (const accountStatus of ["PENDING", "BLOCKED", "PENDING_DELETION"]) {
      const { tenant, assignment } = await lease({ accountStatus });
      expectError(await create(tenant, assignment), "FORBIDDEN", MESSAGES.STATUS_NOT_ALLOWED);
    }

    assert.equal(await prisma.receipt.count(), 0);
    assert.equal(await prisma.activityLog.count({ where: { entityType: "Receipt" } }), 0);
  });

  it("accepts amountCents from 1 to 10,000,000 and refuses 0 and 10,000,001", async () => {
    const { tenant, assignment } = await lease();

    for (const amountCents of [1, 10_000_000]) {
      assert.equal(expectData(await create(tenant, assignment, { amountCents })).createReceipt.amountCents, amountCents);
    }

    for (const amountCents of [0, -1, 10_000_001]) {
      const error = expectError(await create(tenant, assignment, { amountCents }), "BAD_USER_INPUT");
      assert.deepEqual(fieldErrors(error).map((entry) => entry.path), ["input.amountCents"]);
    }

    assert.equal(await prisma.receipt.count(), 2);
  });

  it("refuses a decimal amountCents during GraphQL coercion, before any resolver runs", async () => {
    const { tenant, assignment } = await lease();
    const result = await create(tenant, assignment, { amountCents: 100.5 });

    // Variable coercion errors come from graphql-js itself and carry no extensions.code.
    assert.equal(result.errors?.length, 1);
    assert.match(result.errors[0].message, /Int cannot represent non-integer value/);
    assert.equal(result.data, undefined);
    assert.equal(await prisma.receipt.count(), 0);
  });

  it("accepts a three-letter uppercase currency and defaults a null one to AUD", async () => {
    const { tenant, assignment } = await lease();

    assert.equal(expectData(await create(tenant, assignment, { currency: "USD" })).createReceipt.currency, "USD");
    assert.equal(expectData(await create(tenant, assignment, { currency: null })).createReceipt.currency, "AUD");
  });

  it("refuses a currency that is not three uppercase letters", async () => {
    const { tenant, assignment } = await lease();

    for (const currency of ["aud", "AU", "AUDD", "A1D", "", " AUD"]) {
      const error = expectError(await create(tenant, assignment, { currency }), "BAD_USER_INPUT");
      assert.deepEqual(fieldErrors(error), [{ path: "input.currency", message: MESSAGES.CURRENCY }]);
    }
  });

  it("accepts paidAt up to today UTC plus one day and refuses two days ahead", async () => {
    const { tenant, assignment } = await lease();

    for (const offset of [-30, 0, 1]) {
      const paidAt = utcDate(offset);
      assert.equal(expectData(await create(tenant, assignment, { paidAt })).createReceipt.paidAt, paidAt);
    }

    for (const offset of [2, 365]) {
      const error = expectError(await create(tenant, assignment, { paidAt: utcDate(offset) }), "BAD_USER_INPUT");
      assert.deepEqual(fieldErrors(error), [{ path: "input.paidAt", message: MESSAGES.PAID_AT_FUTURE }]);
    }
  });

  it("refuses impossible and malformed paidAt dates in the Date scalar", async () => {
    const { tenant, assignment } = await lease();

    for (const paidAt of ["2026-02-30", "2025-02-29", "2026-13-01", "2026-11-1", "01/11/2026", "2026-11-01T00:00:00Z", ""]) {
      const result = await create(tenant, assignment, { paidAt });
      expectError(result, "BAD_USER_INPUT", paidAtScalarMessage(MESSAGES.INVALID_DATE));
      assert.equal(result.data, undefined);
    }

    assert.equal(await prisma.receipt.count(), 0);
  });

  it("accepts paidAt from the year 2000 and refuses earlier years", async () => {
    const { tenant, assignment } = await lease();

    assert.equal(expectData(await create(tenant, assignment, { paidAt: "2000-01-01" })).createReceipt.paidAt, "2000-01-01");
    expectError(await create(tenant, assignment, { paidAt: "1999-12-31" }), "BAD_USER_INPUT", paidAtScalarMessage(MESSAGES.YEAR_OUT_OF_RANGE));
  });

  it("refuses paidAt after the year 2100", async () => {
    const { tenant, assignment } = await lease();

    expectError(await create(tenant, assignment, { paidAt: "2101-01-01" }), "BAD_USER_INPUT", paidAtScalarMessage(MESSAGES.YEAR_OUT_OF_RANGE));
  });

  it("trims the note, keeps a missing note as null, and caps it at 500 characters", async () => {
    const { tenant, assignment } = await lease();

    assert.equal(expectData(await create(tenant, assignment)).createReceipt.note, null);
    assert.equal(expectData(await create(tenant, assignment, { note: null })).createReceipt.note, null);
    assert.equal(expectData(await create(tenant, assignment, { note: "x".repeat(500) })).createReceipt.note.length, 500);
    assert.equal(expectData(await create(tenant, assignment, { note: ` ${"x".repeat(500)} ` })).createReceipt.note.length, 500);

    for (const note of ["   ", "x".repeat(501)]) {
      const error = expectError(await create(tenant, assignment, { note }), "BAD_USER_INPUT");
      assert.deepEqual(fieldErrors(error).map((entry) => entry.path), ["input.note"]);
    }
  });

  it("writes no receipt and no log row when validation fails", async () => {
    const { tenant, assignment } = await lease();

    expectError(await create(tenant, assignment, { amountCents: 0, currency: "x", paidAt: "nope" }), "BAD_USER_INPUT");
    assert.equal(await prisma.receipt.count(), 0);
    assert.equal(await prisma.activityLog.count({ where: { entityType: "Receipt" } }), 0);
  });
});

describe("receipt immutability", () => {
  it("the schema has no mutation that changes or removes a receipt, or its file", () => {
    const mutations = Object.keys(schema.getMutationType().getFields());

    assert.deepEqual(mutations.filter((name) => /receipt/i.test(name)).sort(), ["createReceipt", "requestReceiptUpload"]);
  });

  it("the Receipt type has no fileUrl field", async () => {
    assert.equal(schema.getType("Receipt").getFields().fileUrl, undefined);

    const { tenant, assignment } = await lease();
    const receipt = await createReceipt(assignment);
    const result = await run(contextFor(tenant), `query ($id: ID!) { receipt(id: $id) { fileUrl } }`, { id: receipt.id });
    assert.ok(result.errors?.length);
  });
});

describe("receipt and receiptsByAssignment", () => {
  const cases = [
    { accountStatus: "APPROVED", owner: true, tenant: true },
    { accountStatus: "PENDING_DELETION", owner: true, tenant: true },
    { accountStatus: "BLOCKED", owner: false, tenant: true },
    { accountStatus: "PENDING", owner: false, tenant: false },
  ];

  for (const { accountStatus, owner: ownerAllowed, tenant: tenantAllowed } of cases) {
    it(`on a ${accountStatus} account: owners ${ownerAllowed ? "read" : "are refused"}, the tenant ${tenantAllowed ? "reads" : "is refused"}`, async () => {
      const { owner, coOwner, tenant, assignment } = await lease({ accountStatus });
      const receipt = await createReceipt(assignment, { note: "October rent" });

      for (const [user, allowed] of [[owner, ownerAllowed], [coOwner, ownerAllowed], [tenant, tenantAllowed]]) {
        const single = await run(contextFor(user), GET, { id: receipt.id });
        const list = await run(contextFor(user), BY_ASSIGNMENT, { tenantAssignmentId: assignment.id });

        if (allowed) {
          assert.deepEqual(structuredClone(expectData(single).receipt), {
            id: receipt.id,
            tenantAssignmentId: assignment.id,
            amountCents: 50_000,
            currency: "AUD",
            paidAt: "2026-11-01",
            note: "October rent",
            createdAt: receipt.createdAt.toISOString(),
          });
          assert.deepEqual(expectData(list).receiptsByAssignment.items.map((item) => item.id), [receipt.id]);
        } else {
          expectError(single, "FORBIDDEN", MESSAGES.STATUS_NOT_ALLOWED);
          expectError(list, "FORBIDDEN", MESSAGES.STATUS_NOT_ALLOWED);
        }
      }
    });
  }

  it("lets the tenant read after the assignment has EXITED", async () => {
    const { tenant, assignment } = await lease({ assignmentStatus: "EXITED" });
    const receipt = await createReceipt(assignment);

    assert.equal(expectData(await run(contextFor(tenant), GET, { id: receipt.id })).receipt.id, receipt.id);
  });

  it("gives NOT_FOUND to strangers and for a missing receipt", async () => {
    const { owner, assignment } = await lease();
    const receipt = await createReceipt(assignment);
    const stranger = await createUser();

    expectError(await run(contextFor(stranger), GET, { id: receipt.id }), "NOT_FOUND", MESSAGES.RECEIPT_NOT_FOUND);
    expectError(await run(contextFor(stranger), BY_ASSIGNMENT, { tenantAssignmentId: assignment.id }), "NOT_FOUND", MESSAGES.NOT_FOUND);
    expectError(await run(contextFor(owner), GET, { id: "cjld2cjxh0000qzrmn831i7rn" }), "NOT_FOUND", MESSAGES.RECEIPT_NOT_FOUND);
  });

  it("lists only the assignment's receipts, newest first, paged", async () => {
    const { tenant, house, assignment } = await lease();
    const other = await createAssignment(house, await createUser());
    await createReceipt(other);

    const base = Date.parse("2026-11-10T00:00:00.000Z");
    const receipts = [];
    for (let index = 0; index < 5; index += 1) {
      receipts.push(await createReceipt(assignment, { createdAt: new Date(base + index * 60_000) }));
    }

    const seen = [];
    let after = null;
    let pages = 0;
    do {
      const page = expectData(await run(contextFor(tenant), BY_ASSIGNMENT, { tenantAssignmentId: assignment.id, first: 2, after })).receiptsByAssignment;
      seen.push(...page.items.map((item) => item.id));
      after = page.pageInfo.nextCursor;
      assert.equal(page.pageInfo.hasNextPage, after !== null);
      pages += 1;
    } while (after);

    assert.equal(pages, 3);
    assert.deepEqual(seen, receipts.map((receipt) => receipt.id).reverse());
  });

  it("refuses an invalid cursor and an out-of-range page size", async () => {
    const { tenant, assignment } = await lease();

    for (const variables of [{ after: "%%%" }, { first: 0 }, { first: 101 }]) {
      expectError(await run(contextFor(tenant), BY_ASSIGNMENT, { tenantAssignmentId: assignment.id, ...variables }), "BAD_USER_INPUT");
    }
  });
});
