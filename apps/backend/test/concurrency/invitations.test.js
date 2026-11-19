import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { prisma, resetDatabase } from "../support/db.js";
import {
  contextFor,
  createAssignment,
  createHouse,
  createInvitation,
  createOwnerAccount,
  createUser,
} from "../support/factories.js";
import { race, run } from "../support/graphql.js";

const ROUNDS = 5;
const ACCEPT = `mutation ($id: ID!) { acceptInvitation(id: $id) { id status } }`;
const REVOKE = `mutation ($id: ID!) { revokeInvitation(id: $id) { id status } }`;
const MESSAGES = Object.freeze({
  HOUSE_FULL: "This house has no free tenant places.",
  NOT_PENDING: "This invitation is no longer pending.",
});

function activeCount(house) {
  return prisma.tenantAssignment.count({ where: { houseId: house.id, status: { in: ["ACTIVE", "NOTICE_PERIOD"] } } });
}

async function houseRow(house) {
  return prisma.house.findUnique({ where: { id: house.id } });
}

function invitationRow(invitation) {
  return prisma.invitation.findUnique({ where: { id: invitation.id } });
}

beforeEach(resetDatabase);

describe("concurrent acceptInvitation", () => {
  it("lets exactly one of two accepts take the last free place", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const owner = await createUser();
      const house = await createHouse(await createOwnerAccount(owner), { maxTenants: 2 });
      await createAssignment(house, await createUser());
      const [first, second] = await Promise.all([createUser(), createUser()]);
      const invitations = await Promise.all([
        createInvitation(house, owner, { email: first.email }),
        createInvitation(house, owner, { email: second.email }),
      ]);

      const outcomes = await race([
        () => run(contextFor(first), ACCEPT, { id: invitations[0].id }),
        () => run(contextFor(second), ACCEPT, { id: invitations[1].id }),
      ]);

      const winners = outcomes.filter((outcome) => outcome.ok);
      const losers = outcomes.filter((outcome) => !outcome.ok);
      assert.equal(winners.length, 1, `round ${round}`);
      assert.deepEqual(losers.map(({ code, message }) => ({ code, message })), [{ code: "CONFLICT", message: MESSAGES.HOUSE_FULL }]);

      assert.equal(await activeCount(house), 2);
      assert.equal((await houseRow(house)).status, "OCCUPIED");

      const loserIndex = outcomes.findIndex((outcome) => !outcome.ok);
      assert.equal((await invitationRow(invitations[loserIndex])).status, "PENDING");
      assert.equal((await invitationRow(invitations[1 - loserIndex])).status, "ACCEPTED");
    }
  });
});

describe("revokeInvitation racing acceptInvitation", () => {
  it("lets exactly one win and leaves the invitation and assignments consistent", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const [owner, invitee] = await Promise.all([createUser(), createUser()]);
      const house = await createHouse(await createOwnerAccount(owner));
      const invitation = await createInvitation(house, owner, { email: invitee.email });

      const [accept, revoke] = await race([
        () => run(contextFor(invitee), ACCEPT, { id: invitation.id }),
        () => run(contextFor(owner), REVOKE, { id: invitation.id }),
      ]);

      assert.equal(Number(accept.ok) + Number(revoke.ok), 1, `round ${round}`);
      const loser = accept.ok ? revoke : accept;
      assert.equal(loser.code, "CONFLICT");
      assert.equal(loser.message, MESSAGES.NOT_PENDING);

      const stored = await invitationRow(invitation);
      const assignments = await prisma.tenantAssignment.findMany({ where: { houseId: house.id } });

      if (accept.ok) {
        assert.equal(stored.status, "ACCEPTED");
        assert.equal(assignments.length, 1);
        assert.equal(stored.acceptedAssignmentId, assignments[0].id);
        assert.equal((await houseRow(house)).status, "OCCUPIED");
      } else {
        assert.equal(stored.status, "REVOKED");
        assert.equal(stored.acceptedAssignmentId, null);
        assert.equal(assignments.length, 0);
        assert.equal(await prisma.tenantProfile.count({ where: { userId: invitee.id } }), 0);
        assert.equal((await houseRow(house)).status, "VACANT");
      }

      const responses = await prisma.activityLog.count({ where: { entityId: invitation.id, action: { in: ["ACCEPTED", "REVOKED"] } } });
      assert.equal(responses, 1);
    }
  });
});
