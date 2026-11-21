import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { beforeEach, describe, it } from "node:test";

import { prisma, resetDatabase } from "../support/db.js";
import {
  addMember,
  createAssignment,
  createHouse,
  createInvitation,
  createIssue,
  createLeaveRequest,
  createMemberInvitation,
  createOwnerAccount,
  createReceipt,
  createUser,
} from "../support/factories.js";

const MIGRATION = new URL(
  "../../prisma/migrations/20261121090000_activity_log_owner_account/migration.sql",
  import.meta.url,
);
const MISSING_ACCOUNT_ID = "cjld2cjxh0000qzrmn831i7rn";

/** The migration's backfill UPDATE statements, in file order, without comments. */
async function backfillStatements() {
  const sql = await readFile(MIGRATION, "utf8");

  // Comments go first: some contain semicolons.
  return sql
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.startsWith("UPDATE"));
}

async function runBackfill() {
  for (const statement of await backfillStatements()) {
    await prisma.$executeRawUnsafe(statement);
  }
}

function unscopedLog(entityType, entityId, metadata = {}) {
  return prisma.activityLog.create({
    data: { entityType, entityId, action: "CREATED", ownerAccountId: null, metadata },
  });
}

async function ownerAccountOf(log) {
  const row = await prisma.activityLog.findUnique({ where: { id: log.id }, select: { ownerAccountId: true } });
  return row.ownerAccountId;
}

beforeEach(resetDatabase);

describe("activity_log_owner_account backfill", () => {
  it("resolves the account of every entity type whose row still exists", async () => {
    const [owner, tenant, coOwner] = await Promise.all([createUser(), createUser(), createUser()]);
    const account = await createOwnerAccount(owner);
    const decoy = await createOwnerAccount(await createUser());
    await createHouse(decoy);
    const house = await createHouse(account);
    const invitation = await createInvitation(house, owner);
    const assignment = await createAssignment(house, tenant);
    const profile = await prisma.tenantProfile.findUnique({ where: { userId: tenant.id } });
    const member = await addMember(account, coOwner);
    const memberInvitation = await createMemberInvitation(account, owner);
    const subscription = await prisma.subscription.findUnique({ where: { ownerAccountId: account.id } });

    const logs = await Promise.all([
      unscopedLog("OwnerAccount", account.id),
      unscopedLog("House", house.id),
      unscopedLog("Invitation", invitation.id),
      unscopedLog("TenantAssignment", assignment.id),
      unscopedLog("Receipt", (await createReceipt(assignment)).id),
      unscopedLog("Issue", (await createIssue(assignment)).id),
      unscopedLog("LeaveRequest", (await createLeaveRequest(assignment)).id),
      unscopedLog("MemberInvitation", memberInvitation.id),
      unscopedLog("OwnerAccountMember", member.id),
      unscopedLog("Subscription", subscription.id),
      unscopedLog("Subscription", account.id),
      unscopedLog("TenantProfile", profile.id, { invitationId: invitation.id }),
    ]);

    await runBackfill();

    for (const log of logs) {
      assert.equal(await ownerAccountOf(log), account.id, `${log.entityType} ${log.entityId}`);
    }
  });

  it("falls back to metadata.ownerAccountId for deleted entities and leaves the rest NULL", async () => {
    const account = await createOwnerAccount(await createUser());

    const removedMember = await unscopedLog("OwnerAccountMember", "cgonemember1", { ownerAccountId: account.id });
    const deletedHouse = await unscopedLog("House", "cgonehouse01");
    const unknownAccount = await unscopedLog("House", "cgonehouse02", { ownerAccountId: MISSING_ACCOUNT_ID });

    await runBackfill();

    assert.equal(await ownerAccountOf(removedMember), account.id);
    assert.equal(await ownerAccountOf(deletedHouse), null);
    assert.equal(await ownerAccountOf(unknownAccount), null);
  });

  it("never overwrites an ownerAccountId that is already set", async () => {
    const account = await createOwnerAccount(await createUser());
    const other = await createOwnerAccount(await createUser());
    const house = await createHouse(account);
    const log = await prisma.activityLog.create({
      data: { entityType: "House", entityId: house.id, action: "CREATED", ownerAccountId: other.id },
    });

    await runBackfill();

    assert.equal(await ownerAccountOf(log), other.id);
  });
});
