import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { prisma, resetDatabase } from "../support/db.js";
import {
  addMember,
  contextFor,
  createMemberInvitation,
  createOwnerAccount,
  createUser,
} from "../support/factories.js";
import { race, run } from "../support/graphql.js";

const ROUNDS = 5;
const MAX_MEMBERS = 10;
const ACCEPT = `mutation ($id: ID!) { acceptMemberInvitation(id: $id) { id } }`;
const REMOVE = `mutation ($ownerAccountId: ID!, $memberId: ID!) { removeMember(ownerAccountId: $ownerAccountId, memberId: $memberId) { id } }`;
const TRANSFER = `mutation ($ownerAccountId: ID!, $newPrimaryMemberId: ID!) {
  transferOwnership(ownerAccountId: $ownerAccountId, newPrimaryMemberId: $newPrimaryMemberId) { newPrimary { id } } }`;
const CREATE_ACCOUNT = `mutation ($name: String!) { createOwnerAccount(name: $name) { id } }`;

const MESSAGES = Object.freeze({
  MEMBER_LIMIT: "An owner account can have at most 10 members.",
  ROLE_NOT_ALLOWED: "Your role on this owner account does not allow this action.",
  MEMBER_NOT_FOUND: "Member not found.",
  NEW_PRIMARY_LIMIT: "The new primary owner already owns the maximum of 5 owner accounts.",
  PRIMARY_LIMIT: "You can be the primary owner of at most 5 owner accounts.",
});

function primariesOf(account) {
  return prisma.ownerAccountMember.findMany({
    where: { ownerAccountId: account.id, role: "PRIMARY" },
    select: { userId: true },
  });
}

function membershipOf(account, user) {
  return prisma.ownerAccountMember.findUnique({
    where: { userId_ownerAccountId: { userId: user.id, ownerAccountId: account.id } },
  });
}

function outcomeShape({ ok, code, message }) {
  return ok ? { ok } : { ok, code, message };
}

beforeEach(resetDatabase);

describe("concurrent acceptMemberInvitation", () => {
  it("lets exactly one of two accepts take the last member place", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const owner = await createUser();
      const account = await createOwnerAccount(owner);

      for (let index = 1; index < MAX_MEMBERS - 1; index += 1) {
        await addMember(account, await createUser());
      }

      const [first, second] = await Promise.all([createUser(), createUser()]);
      const invitations = await Promise.all([
        createMemberInvitation(account, owner, { email: first.email }),
        createMemberInvitation(account, owner, { email: second.email }),
      ]);

      const outcomes = await race([
        () => run(contextFor(first), ACCEPT, { id: invitations[0].id }),
        () => run(contextFor(second), ACCEPT, { id: invitations[1].id }),
      ]);

      assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1, `round ${round}`);
      assert.deepEqual(
        outcomes.filter((outcome) => !outcome.ok).map(outcomeShape),
        [{ ok: false, code: "CONFLICT", message: MESSAGES.MEMBER_LIMIT }],
      );
      assert.equal(await prisma.ownerAccountMember.count({ where: { ownerAccountId: account.id } }), MAX_MEMBERS);

      const loser = outcomes.findIndex((outcome) => !outcome.ok);
      assert.equal((await prisma.memberInvitation.findUnique({ where: { id: invitations[loser].id } })).status, "PENDING");
    }
  });
});

describe("transferOwnership racing removeMember", () => {
  it("keeps exactly one PRIMARY whichever wins", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const [owner, coOwner] = await Promise.all([createUser(), createUser()]);
      const account = await createOwnerAccount(owner);
      const membership = await addMember(account, coOwner);

      const [transfer, removal] = await race([
        () => run(contextFor(owner), TRANSFER, { ownerAccountId: account.id, newPrimaryMemberId: membership.id }),
        () => run(contextFor(owner), REMOVE, { ownerAccountId: account.id, memberId: membership.id }),
      ]);

      assert.equal(Number(transfer.ok) + Number(removal.ok), 1, `round ${round}`);
      const primaries = await primariesOf(account);
      assert.equal(primaries.length, 1);

      if (transfer.ok) {
        assert.deepEqual(outcomeShape(removal), { ok: false, code: "FORBIDDEN", message: MESSAGES.ROLE_NOT_ALLOWED });
        assert.equal(primaries[0].userId, coOwner.id);
        assert.equal((await membershipOf(account, owner)).role, "CO_OWNER");
      } else {
        assert.deepEqual(outcomeShape(transfer), { ok: false, code: "NOT_FOUND", message: MESSAGES.MEMBER_NOT_FOUND });
        assert.equal(primaries[0].userId, owner.id);
        assert.equal(await membershipOf(account, coOwner), null);
      }
    }
  });
});

describe("two concurrent transferOwnership calls", () => {
  it("lets exactly one through and leaves one PRIMARY", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const [owner, first, second] = await Promise.all([createUser(), createUser(), createUser()]);
      const account = await createOwnerAccount(owner);
      const memberships = [await addMember(account, first), await addMember(account, second)];

      const outcomes = await race(
        memberships.map((membership) => () =>
          run(contextFor(owner), TRANSFER, { ownerAccountId: account.id, newPrimaryMemberId: membership.id }),
        ),
      );

      assert.equal(outcomes.filter((outcome) => outcome.ok).length, 1, `round ${round}`);
      assert.deepEqual(
        outcomes.filter((outcome) => !outcome.ok).map(outcomeShape),
        [{ ok: false, code: "FORBIDDEN", message: MESSAGES.ROLE_NOT_ALLOWED }],
      );

      const winnerMemberId = outcomes.find((outcome) => outcome.ok).data.transferOwnership.newPrimary.id;
      const winner = memberships.find((membership) => membership.id === winnerMemberId).userId;
      assert.deepEqual(await primariesOf(account), [{ userId: winner }]);
      assert.equal((await membershipOf(account, owner)).role, "CO_OWNER");
      assert.equal(await prisma.activityLog.count({ where: { entityId: account.id, action: "OWNERSHIP_TRANSFERRED" } }), 1);
    }
  });
});

describe("transferOwnership racing the new PRIMARY's createOwnerAccount", () => {
  it("never lets the new PRIMARY exceed 5 primary accounts", async () => {
    for (let round = 0; round < ROUNDS; round += 1) {
      const [owner, coOwner] = await Promise.all([createUser(), createUser()]);
      const account = await createOwnerAccount(owner);
      const membership = await addMember(account, coOwner);

      for (let index = 0; index < 4; index += 1) {
        await createOwnerAccount(coOwner);
      }

      const [transfer, create] = await race([
        () => run(contextFor(owner), TRANSFER, { ownerAccountId: account.id, newPrimaryMemberId: membership.id }),
        () => run(contextFor(coOwner), CREATE_ACCOUNT, { name: "Fifth Rentals" }),
      ]);

      assert.equal(Number(transfer.ok) + Number(create.ok), 1, `round ${round}`);
      const loser = transfer.ok ? create : transfer;
      assert.equal(loser.code, "CONFLICT");
      assert.ok([MESSAGES.NEW_PRIMARY_LIMIT, MESSAGES.PRIMARY_LIMIT].includes(loser.message));
      assert.equal(await prisma.ownerAccountMember.count({ where: { userId: coOwner.id, role: "PRIMARY" } }), 5);
      assert.equal((await primariesOf(account)).length, 1);
    }
  });
});
