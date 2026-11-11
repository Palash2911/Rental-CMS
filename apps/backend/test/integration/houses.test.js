import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { prisma, resetDatabase } from "../support/db.js";
import {
  addMember,
  contextFor,
  createAssignment,
  createHouse,
  createOwnerAccount,
  createUser,
} from "../support/factories.js";
import { expectData, expectError, run } from "../support/graphql.js";

const FIELDS = "id ownerAccountId name location maxTenants status createdAt updatedAt";
const CREATE = `mutation ($input: CreateHouseInput!) { createHouse(input: $input) { ${FIELDS} } }`;
const UPDATE = `mutation ($input: UpdateHouseInput!) { updateHouse(input: $input) { ${FIELDS} } }`;
const GET = `query ($id: ID!) { house(id: $id) { ${FIELDS} } }`;
const LIST = `query ($ownerAccountId: ID!, $first: Int, $after: String) { houses(ownerAccountId: $ownerAccountId, first: $first, after: $after) { items { id } pageInfo { nextCursor hasNextPage } } }`;

function houseInput(account, overrides = {}) {
  return { ownerAccountId: account.id, name: "Unit 4", location: "12 King St", maxTenants: 3, ...overrides };
}

function activityFor(entityId) {
  return prisma.activityLog.findMany({ where: { entityId }, orderBy: { createdAt: "asc" } });
}

async function ownerWithHouse({ accountStatus = "APPROVED", ...houseOptions } = {}) {
  const owner = await createUser();
  const account = await createOwnerAccount(owner, { status: accountStatus });
  const house = await createHouse(account, houseOptions);
  return { owner, account, house };
}

beforeEach(resetDatabase);

describe("createHouse", () => {
  it("creates a VACANT house and logs it", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner);
    const house = expectData(await run(contextFor(owner), CREATE, { input: houseInput(account, { name: "  Unit 4  " }) })).createHouse;

    assert.equal(house.status, "VACANT");
    assert.equal(house.name, "Unit 4");
    assert.equal((await activityFor(house.id))[0].action, "CREATED");
  });

  it("is allowed on PENDING and APPROVED accounts, for PRIMARY and CO_OWNER", async () => {
    const [owner, coOwner] = await Promise.all([createUser(), createUser()]);

    for (const status of ["PENDING", "APPROVED"]) {
      const account = await createOwnerAccount(owner, { status });
      await addMember(account, coOwner);

      expectData(await run(contextFor(owner), CREATE, { input: houseInput(account) }));
      expectData(await run(contextFor(coOwner), CREATE, { input: houseInput(account) }));
    }
  });

  it("gives FORBIDDEN on BLOCKED and PENDING_DELETION accounts", async () => {
    const owner = await createUser();

    for (const status of ["BLOCKED", "PENDING_DELETION"]) {
      const account = await createOwnerAccount(owner, { status });
      expectError(await run(contextFor(owner), CREATE, { input: houseInput(account) }), "FORBIDDEN");
    }
  });

  it("gives NOT_FOUND to a non-member", async () => {
    const [owner, stranger] = await Promise.all([createUser(), createUser()]);
    const account = await createOwnerAccount(owner);

    expectError(await run(contextFor(stranger), CREATE, { input: houseInput(account) }), "NOT_FOUND");
  });

  it("validates name, location and maxTenants", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner);
    const invalid = [
      { name: " " },
      { name: "x".repeat(101) },
      { location: "x".repeat(201) },
      { maxTenants: 0 },
      { maxTenants: 51 },
    ];

    for (const overrides of invalid) {
      expectError(await run(contextFor(owner), CREATE, { input: houseInput(account, overrides) }), "BAD_USER_INPUT");
    }
  });
});

describe("reading houses", () => {
  it("house returns the house to members of PENDING, APPROVED and PENDING_DELETION accounts", async () => {
    for (const accountStatus of ["PENDING", "APPROVED", "PENDING_DELETION"]) {
      const { owner, house } = await ownerWithHouse({ accountStatus });
      assert.equal(expectData(await run(contextFor(owner), GET, { id: house.id })).house.id, house.id);
    }
  });

  it("house gives FORBIDDEN on a BLOCKED account and NOT_FOUND to a non-member", async () => {
    const blocked = await ownerWithHouse({ accountStatus: "BLOCKED" });
    const open = await ownerWithHouse();

    expectError(await run(contextFor(blocked.owner), GET, { id: blocked.house.id }), "FORBIDDEN");
    expectError(await run(contextFor(blocked.owner), GET, { id: open.house.id }), "NOT_FOUND");
  });

  it("houses lists only the account's houses, newest first, paginated", async () => {
    const { owner, account, house: first } = await ownerWithHouse();
    const second = await createHouse(account, { name: "Unit 2" });
    const third = await createHouse(account, { name: "Unit 3" });
    await ownerWithHouse();

    const page1 = expectData(await run(contextFor(owner), LIST, { ownerAccountId: account.id, first: 2 })).houses;
    const page2 = expectData(
      await run(contextFor(owner), LIST, { ownerAccountId: account.id, first: 2, after: page1.pageInfo.nextCursor }),
    ).houses;

    assert.deepEqual(
      [...page1.items, ...page2.items].map((item) => item.id),
      [third.id, second.id, first.id],
    );
    assert.equal(page2.pageInfo.hasNextPage, false);
  });
});

describe("updateHouse", () => {
  it("requires at least one field", async () => {
    const { owner, house } = await ownerWithHouse();

    expectError(await run(contextFor(owner), UPDATE, { input: { id: house.id } }), "BAD_USER_INPUT");
  });

  it("updates fields and logs them with from and to values", async () => {
    const { owner, house } = await ownerWithHouse();
    const updated = expectData(
      await run(contextFor(owner), UPDATE, { input: { id: house.id, name: "Renamed", maxTenants: 4 } }),
    ).updateHouse;

    assert.equal(updated.name, "Renamed");
    assert.equal(updated.maxTenants, 4);

    const log = (await activityFor(house.id)).at(-1);
    assert.equal(log.action, "UPDATED");
    assert.deepEqual(log.metadata, { name: { from: "Unit 1", to: "Renamed" }, maxTenants: { from: 3, to: 4 } });
  });

  it("returns the house without writing or logging when nothing changes", async () => {
    const { owner, house } = await ownerWithHouse();

    expectData(await run(contextFor(owner), UPDATE, { input: { id: house.id, name: house.name } }));
    assert.equal((await activityFor(house.id)).length, 0);
  });

  it("makes a house with no active assignments INACTIVE and logs STATUS_CHANGED", async () => {
    const { owner, house } = await ownerWithHouse();
    await createAssignment(house, await createUser(), { status: "EXITED" });

    const updated = expectData(await run(contextFor(owner), UPDATE, { input: { id: house.id, inactive: true } })).updateHouse;

    assert.equal(updated.status, "INACTIVE");
    assert.equal((await activityFor(house.id)).at(-1).action, "STATUS_CHANGED");
  });

  it("refuses INACTIVE while an ACTIVE or NOTICE_PERIOD assignment exists", async () => {
    for (const status of ["ACTIVE", "NOTICE_PERIOD"]) {
      const { owner, house } = await ownerWithHouse();
      await createAssignment(house, await createUser(), { status });

      expectError(
        await run(contextFor(owner), UPDATE, { input: { id: house.id, inactive: true } }),
        "CONFLICT",
        "A house with active tenant assignments cannot be made inactive.",
      );
    }
  });

  it("clearing INACTIVE sets VACANT", async () => {
    const { owner, house } = await ownerWithHouse({ status: "INACTIVE" });
    const updated = expectData(await run(contextFor(owner), UPDATE, { input: { id: house.id, inactive: false } })).updateHouse;

    assert.equal(updated.status, "VACANT");
  });

  it("inactive true on an INACTIVE house is a no-op", async () => {
    const { owner, house } = await ownerWithHouse({ status: "INACTIVE" });

    expectData(await run(contextFor(owner), UPDATE, { input: { id: house.id, inactive: true } }));
    assert.equal((await activityFor(house.id)).length, 0);
  });

  it("never sets maxTenants below the active assignment count", async () => {
    const { owner, house } = await ownerWithHouse({ maxTenants: 3 });
    await createAssignment(house, await createUser());
    await createAssignment(house, await createUser(), { status: "NOTICE_PERIOD" });
    await createAssignment(house, await createUser(), { status: "EXITED" });

    expectError(
      await run(contextFor(owner), UPDATE, { input: { id: house.id, maxTenants: 1 } }),
      "CONFLICT",
      "maxTenants cannot be lower than the number of active tenant assignments.",
    );
    assert.equal(expectData(await run(contextFor(owner), UPDATE, { input: { id: house.id, maxTenants: 2 } })).updateHouse.maxTenants, 2);
  });

  it("cannot set OCCUPIED or VACANT directly", async () => {
    const { owner, house } = await ownerWithHouse();
    const result = await run(contextFor(owner), UPDATE, { input: { id: house.id, status: "OCCUPIED" } });

    assert.ok(result.errors?.length);
  });

  it("is allowed for CO_OWNER on PENDING accounts and refused on BLOCKED ones", async () => {
    const { owner, account, house } = await ownerWithHouse({ accountStatus: "PENDING" });
    const coOwner = await createUser();
    await addMember(account, coOwner);

    expectData(await run(contextFor(coOwner), UPDATE, { input: { id: house.id, name: "By co-owner" } }));

    await prisma.ownerAccount.update({ where: { id: account.id }, data: { status: "BLOCKED" } });
    expectError(await run(contextFor(owner), UPDATE, { input: { id: house.id, name: "Blocked" } }), "FORBIDDEN");
  });

  it("serializes a concurrent INACTIVE change and maxTenants change under the house lock", async () => {
    const { owner, house } = await ownerWithHouse({ maxTenants: 3 });
    const results = await Promise.all([
      run(contextFor(owner), UPDATE, { input: { id: house.id, inactive: true } }),
      run(contextFor(owner), UPDATE, { input: { id: house.id, maxTenants: 5 } }),
    ]);

    results.forEach(expectData);
    const stored = await prisma.house.findUnique({ where: { id: house.id } });
    assert.equal(stored.status, "INACTIVE");
    assert.equal(stored.maxTenants, 5);
  });
});
