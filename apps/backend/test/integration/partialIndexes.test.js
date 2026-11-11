import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { ConflictError, isUniqueViolation, mapPrismaError } from "../../src/lib/errors.js";
import { prisma, resetDatabase } from "../support/db.js";
import {
  createAssignment,
  createHouse,
  createInvitation,
  createOwnerAccount,
  createUser,
  uniqueEmail,
} from "../support/factories.js";

const LEASE_START = new Date("2026-01-01T00:00:00.000Z");

async function expectUniqueViolation(promise) {
  await assert.rejects(promise, (error) => {
    assert.equal(isUniqueViolation(error), true, `expected P2002, got ${error.code ?? error.name}`);
    assert.ok(mapPrismaError(error) instanceof ConflictError);
    return true;
  });
}

async function houseWithOwner() {
  const owner = await createUser();
  const house = await createHouse(await createOwnerAccount(owner));
  return { owner, house };
}

function insertAssignment(tenantProfileId, houseId, status) {
  return prisma.tenantAssignment.create({
    data: { tenantProfileId, houseId, status, leaseStartDate: LEASE_START },
  });
}

beforeEach(resetDatabase);

describe("one pending invitation per house and email (partial unique index)", () => {
  it("rejects a second PENDING row for the same house and email", async () => {
    const { owner, house } = await houseWithOwner();
    const email = uniqueEmail();
    await createInvitation(house, owner, { email });

    await expectUniqueViolation(createInvitation(house, owner, { email }));
  });

  it("allows any number of answered rows next to one PENDING row", async () => {
    const { owner, house } = await houseWithOwner();
    const email = uniqueEmail();

    for (const status of ["REVOKED", "DECLINED", "ACCEPTED", "REVOKED"]) {
      await createInvitation(house, owner, { email, status, respondedAt: new Date() });
    }
    await createInvitation(house, owner, { email });

    assert.equal(await prisma.invitation.count({ where: { houseId: house.id, email } }), 5);
  });

  it("allows the same email PENDING on different houses", async () => {
    const { owner, house } = await houseWithOwner();
    const other = await createHouse(await createOwnerAccount(owner));
    const email = uniqueEmail();

    await createInvitation(house, owner, { email });
    await createInvitation(other, owner, { email });
  });
});

describe("one active lease per tenant per house (partial unique index)", () => {
  for (const [first, second] of [["ACTIVE", "ACTIVE"], ["ACTIVE", "NOTICE_PERIOD"], ["NOTICE_PERIOD", "NOTICE_PERIOD"]]) {
    it(`rejects ${second} next to ${first} for the same tenant and house`, async () => {
      const { house } = await houseWithOwner();
      const tenant = await createUser();
      const existing = await createAssignment(house, tenant, { status: first });

      await expectUniqueViolation(insertAssignment(existing.tenantProfileId, house.id, second));
    });
  }

  it("allows any number of EXITED rows next to one active row", async () => {
    const { house } = await houseWithOwner();
    const tenant = await createUser();
    const exited = await createAssignment(house, tenant, { status: "EXITED" });

    await insertAssignment(exited.tenantProfileId, house.id, "EXITED");
    await insertAssignment(exited.tenantProfileId, house.id, "ACTIVE");

    assert.equal(await prisma.tenantAssignment.count({ where: { houseId: house.id } }), 3);
  });

  it("allows the same tenant active on different houses", async () => {
    const { house } = await houseWithOwner();
    const { house: other } = await houseWithOwner();
    const tenant = await createUser();
    const existing = await createAssignment(house, tenant);

    await insertAssignment(existing.tenantProfileId, other.id, "ACTIVE");
  });
});
