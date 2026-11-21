import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { Prisma } from "../../src/generated/prisma/client.ts";
import { READ_ONLY_MESSAGE } from "../../src/lib/entitlement.js";
import { prisma, resetDatabase } from "../support/db.js";
import {
  addMember,
  contextFor,
  createMemberInvitation,
  createOwnerAccount,
  createUser,
  recordingLogger,
  setBilling,
  uniqueEmail,
} from "../support/factories.js";
import { expectData, expectError, run } from "../support/graphql.js";
import { recordingStripeGateway } from "../support/stripe.js";

const MEMBER_FIELDS = "id name email role joinedAt";
const INVITATION_FIELDS =
  "id ownerAccountId ownerAccountName email status expired expiresAt respondedAt createdAt updatedAt";

const MEMBERS = `query ($ownerAccountId: ID!, $first: Int, $after: String) {
  membersByAccount(ownerAccountId: $ownerAccountId, first: $first, after: $after) { items { ${MEMBER_FIELDS} } pageInfo { nextCursor hasNextPage } } }`;
const ACCOUNT_INVITATIONS = `query ($ownerAccountId: ID!, $status: InvitationStatus) {
  memberInvitationsByAccount(ownerAccountId: $ownerAccountId, status: $status) { items { id status email } } }`;
const MY_INVITATIONS = `query { myMemberInvitations { items { id ownerAccountName } } }`;
const INVITE = `mutation ($ownerAccountId: ID!, $email: String!) { createMemberInvitation(ownerAccountId: $ownerAccountId, email: $email) { ${INVITATION_FIELDS} } }`;
const REVOKE = `mutation ($id: ID!) { revokeMemberInvitation(id: $id) { id status respondedAt } }`;
const ACCEPT = `mutation ($id: ID!) { acceptMemberInvitation(id: $id) { ${MEMBER_FIELDS} } }`;
const DECLINE = `mutation ($id: ID!) { declineMemberInvitation(id: $id) { id status respondedAt } }`;
const REMOVE = `mutation ($ownerAccountId: ID!, $memberId: ID!) { removeMember(ownerAccountId: $ownerAccountId, memberId: $memberId) { ${MEMBER_FIELDS} } }`;
const LEAVE = `mutation ($ownerAccountId: ID!) { leaveAccount(ownerAccountId: $ownerAccountId) { ${MEMBER_FIELDS} } }`;
const TRANSFER = `mutation ($ownerAccountId: ID!, $newPrimaryMemberId: ID!) {
  transferOwnership(ownerAccountId: $ownerAccountId, newPrimaryMemberId: $newPrimaryMemberId) {
    previousPrimary { email role } newPrimary { email role } } }`;
const ACCOUNT = `query ($id: ID!) { ownerAccount(id: $id) { id } }`;
const PORTAL = `mutation ($ownerAccountId: ID!) { openBillingPortal(ownerAccountId: $ownerAccountId) { url } }`;

const MESSAGES = Object.freeze({
  ROLE_NOT_ALLOWED:
    "Your role on this owner account does not allow this action.",
  STATUS_NOT_ALLOWED:
    "This action is not available for the owner account in its current state.",
  OWNER_ACCOUNT_NOT_FOUND: "Owner account not found.",
  INVITATION_NOT_FOUND: "Invitation not found.",
  MEMBER_NOT_FOUND: "Member not found.",
  ALREADY_MEMBER:
    "This email address already belongs to a member of this owner account.",
  YOU_ARE_MEMBER: "You are already a member of this owner account.",
  ALREADY_INVITED:
    "This email address already has a pending invitation for this owner account.",
  MEMBER_LIMIT: "An owner account can have at most 10 members.",
  PENDING_LIMIT:
    "An owner account can have at most 20 pending member invitations.",
  NOT_PENDING: "This invitation is no longer pending.",
  EXPIRED: "This invitation has expired.",
  PRIMARY_CANNOT_BE_REMOVED: "The primary owner cannot be removed.",
  PRIMARY_CANNOT_LEAVE:
    "The primary owner cannot leave the owner account. Transfer ownership first.",
  ALREADY_PRIMARY: "You are already the primary owner of this owner account.",
  NEW_PRIMARY_LIMIT:
    "The new primary owner already owns the maximum of 5 owner accounts.",
  NO_CUSTOMER:
    "This account has no billing details yet. Start a subscription first.",
});

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const MISSING_ID = "cjld2cjxh0000qzrmn831i7rn";
const CANCELED = Object.freeze({
  plan: "STARTER",
  interval: "MONTH",
  stripeStatus: "canceled",
});
const PAST = () => new Date(Date.now() - 60 * 1000);
const STRIPE_CUSTOMER_ID = "cus_test_transfer";

function as(user) {
  return contextFor(user);
}

function membershipOf(account, user) {
  return prisma.ownerAccountMember.findUnique({
    where: {
      userId_ownerAccountId: { userId: user.id, ownerAccountId: account.id },
    },
  });
}

async function memberIdOf(account, user) {
  return (await membershipOf(account, user)).id;
}

/** Variables for TRANSFER making `user`'s membership the new PRIMARY of `account`. */
async function transferTo(account, user) {
  return {
    ownerAccountId: account.id,
    newPrimaryMemberId: await memberIdOf(account, user),
  };
}

function storedInvitation(invitation) {
  return prisma.memberInvitation.findUnique({ where: { id: invitation.id } });
}

function logsFor(entityId) {
  return prisma.activityLog.findMany({
    where: { entityId },
    orderBy: { createdAt: "asc" },
  });
}

// An account with a PRIMARY owner and one CO_OWNER.
async function teamFixture(options = {}) {
  const [owner, coOwner] = await Promise.all([createUser(), createUser()]);
  const account = await createOwnerAccount(owner, options);
  await addMember(account, coOwner);
  return { owner, coOwner, account };
}

async function fillMembers(account, total) {
  const current = await prisma.ownerAccountMember.count({
    where: { ownerAccountId: account.id },
  });

  for (let index = current; index < total; index += 1) {
    await addMember(account, await createUser());
  }
}

beforeEach(resetDatabase);

describe("membersByAccount", () => {
  it("lists every member with name, email, role and joinedAt, newest first, to any member", async () => {
    const { owner, coOwner, account } = await teamFixture();

    for (const reader of [owner, coOwner]) {
      const data = expectData(
        await run(as(reader), MEMBERS, { ownerAccountId: account.id }),
      );
      const items = data.membersByAccount.items.map((item) => ({ ...item }));
      assert.deepEqual(
        items.map((item) => [item.id, item.role]),
        [
          [await memberIdOf(account, coOwner), "CO_OWNER"],
          [await memberIdOf(account, owner), "PRIMARY"],
        ],
      );
      assert.equal(Object.hasOwn(items[0], "userId"), false);
      assert.equal(items[1].email, owner.email);
      assert.equal(items[1].name, owner.name);
      assert.match(items[0].joinedAt, /^\d{4}-\d{2}-\d{2}T/);
    }
  });

  it("paginates", async () => {
    const { owner, account } = await teamFixture();

    const first = expectData(
      await run(as(owner), MEMBERS, { ownerAccountId: account.id, first: 1 }),
    ).membersByAccount;
    assert.equal(first.items.length, 1);
    assert.equal(first.pageInfo.hasNextPage, true);

    const second = expectData(
      await run(as(owner), MEMBERS, {
        ownerAccountId: account.id,
        first: 1,
        after: first.pageInfo.nextCursor,
      }),
    ).membersByAccount;
    assert.equal(second.items.length, 1);
    assert.equal(second.pageInfo.hasNextPage, false);
    assert.notEqual(second.items[0].id, first.items[0].id);
  });

  it("stays readable for PENDING_DELETION and read-only accounts", async () => {
    const owner = await createUser();
    const deleting = await createOwnerAccount(owner, {
      status: "PENDING_DELETION",
    });
    const readOnly = await createOwnerAccount(owner, { billing: CANCELED });

    expectData(await run(as(owner), MEMBERS, { ownerAccountId: deleting.id }));
    expectData(await run(as(owner), MEMBERS, { ownerAccountId: readOnly.id }));
  });

  it("gives NOT_FOUND to a non-member and FORBIDDEN on a BLOCKED account", async () => {
    const { owner, account } = await teamFixture();
    const blocked = await createOwnerAccount(owner, { status: "BLOCKED" });

    expectError(
      await run(as(await createUser()), MEMBERS, {
        ownerAccountId: account.id,
      }),
      "NOT_FOUND",
      MESSAGES.OWNER_ACCOUNT_NOT_FOUND,
    );
    expectError(
      await run(as(owner), MEMBERS, { ownerAccountId: blocked.id }),
      "FORBIDDEN",
      MESSAGES.STATUS_NOT_ALLOWED,
    );
  });
});

describe("memberInvitationsByAccount", () => {
  it("lists the account's invitations to the PRIMARY member, with a status filter", async () => {
    const { owner, account } = await teamFixture();
    const pending = await createMemberInvitation(account, owner);
    const revoked = await createMemberInvitation(account, owner, {
      status: "REVOKED",
      respondedAt: new Date(),
    });

    const all = expectData(
      await run(as(owner), ACCOUNT_INVITATIONS, { ownerAccountId: account.id }),
    );
    assert.deepEqual(
      all.memberInvitationsByAccount.items.map((item) => item.id).sort(),
      [pending.id, revoked.id].sort(),
    );

    const filtered = expectData(
      await run(as(owner), ACCOUNT_INVITATIONS, {
        ownerAccountId: account.id,
        status: "PENDING",
      }),
    );
    assert.deepEqual(
      filtered.memberInvitationsByAccount.items.map((item) => item.id),
      [pending.id],
    );
  });

  it("is PRIMARY only and hidden from non-members", async () => {
    const { coOwner, account } = await teamFixture();

    expectError(
      await run(as(coOwner), ACCOUNT_INVITATIONS, {
        ownerAccountId: account.id,
      }),
      "FORBIDDEN",
      MESSAGES.ROLE_NOT_ALLOWED,
    );
    expectError(
      await run(as(await createUser()), ACCOUNT_INVITATIONS, {
        ownerAccountId: account.id,
      }),
      "NOT_FOUND",
    );
  });
});

describe("myMemberInvitations", () => {
  it("lists only pending, unexpired invitations to my email from accounts I could join", async () => {
    const owner = await createUser();
    const invitee = await createUser({ email: uniqueEmail("Mixed.Case") });
    const email = invitee.email.toLowerCase();
    const approved = await createOwnerAccount(owner, {
      name: "Approved Rentals",
    });
    const pendingAccount = await createOwnerAccount(owner, {
      status: "PENDING",
      name: "Pending Rentals",
    });
    const blocked = await createOwnerAccount(owner, { status: "BLOCKED" });
    const deleting = await createOwnerAccount(owner, {
      status: "PENDING_DELETION",
    });

    const listed = await Promise.all([
      createMemberInvitation(approved, owner, { email }),
      createMemberInvitation(pendingAccount, owner, { email }),
    ]);
    await Promise.all([
      createMemberInvitation(blocked, owner, { email }),
      createMemberInvitation(deleting, owner, { email }),
      createMemberInvitation(approved, owner, {
        email,
        status: "DECLINED",
        respondedAt: new Date(),
      }),
      createMemberInvitation(await createOwnerAccount(owner), owner, {
        email,
        expiresAt: PAST(),
      }),
      createMemberInvitation(approved, owner),
    ]);

    const data = expectData(await run(as(invitee), MY_INVITATIONS));
    assert.deepEqual(
      data.myMemberInvitations.items.map((item) => item.id).sort(),
      listed.map((item) => item.id).sort(),
    );
  });
});

describe("createMemberInvitation", () => {
  it("lets the PRIMARY member invite by normalised email, with a 14-day expiry and a log", async () => {
    const { owner, account } = await teamFixture({ name: "Harbour Rentals" });
    const before = Date.now();

    const data = expectData(
      await run(as(owner), INVITE, {
        ownerAccountId: account.id,
        email: "  New.Person@Example.TEST ",
      }),
    );
    const invitation = data.createMemberInvitation;

    assert.equal(invitation.email, "new.person@example.test");
    assert.equal(invitation.status, "PENDING");
    assert.equal(invitation.expired, false);
    assert.equal(invitation.ownerAccountName, "Harbour Rentals");
    assert.equal(invitation.respondedAt, null);
    const expiresIn = new Date(invitation.expiresAt).getTime() - before;
    assert.ok(Math.abs(expiresIn - 14 * MS_PER_DAY) < 60 * 1000);

    const [log] = await logsFor(invitation.id);
    assert.equal(log.action, "CREATED");
    assert.equal(log.entityType, "MemberInvitation");
    assert.equal(log.performedByUserId, owner.id);
  });

  it("is refused on a PENDING account, even with a paid plan, because it emails an outside address", async () => {
    const owner = await createUser();
    const unpaid = await createOwnerAccount(owner, {
      status: "PENDING",
      billing: null,
    });
    const paid = await createOwnerAccount(owner, { status: "PENDING" });

    for (const account of [unpaid, paid]) {
      expectError(
        await run(as(owner), INVITE, {
          ownerAccountId: account.id,
          email: uniqueEmail(),
        }),
        "FORBIDDEN",
        MESSAGES.STATUS_NOT_ALLOWED,
      );
    }

    assert.equal(await prisma.memberInvitation.count(), 0);
  });

  it("refuses a CO_OWNER, a non-member, a BLOCKED, a PENDING_DELETION and a read-only account", async () => {
    const { owner, coOwner, account } = await teamFixture();
    const email = uniqueEmail();
    const cases = [
      [as(coOwner), account, "FORBIDDEN", MESSAGES.ROLE_NOT_ALLOWED],
      [
        as(await createUser()),
        account,
        "NOT_FOUND",
        MESSAGES.OWNER_ACCOUNT_NOT_FOUND,
      ],
      [
        as(owner),
        await createOwnerAccount(owner, { status: "BLOCKED" }),
        "FORBIDDEN",
        MESSAGES.STATUS_NOT_ALLOWED,
      ],
      [
        as(owner),
        await createOwnerAccount(owner, { status: "PENDING_DELETION" }),
        "FORBIDDEN",
        MESSAGES.STATUS_NOT_ALLOWED,
      ],
      [
        as(owner),
        await createOwnerAccount(owner, { billing: CANCELED }),
        "FORBIDDEN",
        READ_ONLY_MESSAGE,
      ],
    ];

    for (const [context, target, code, message] of cases) {
      expectError(
        await run(context, INVITE, { ownerAccountId: target.id, email }),
        code,
        message,
      );
    }

    assert.equal(await prisma.memberInvitation.count(), 0);
  });

  it("refuses an email that already belongs to a member, in any casing, including the inviter's own", async () => {
    const { owner, account } = await teamFixture();
    const member = await createUser({ email: uniqueEmail("Existing.Member") });
    await addMember(account, member);

    for (const email of [member.email.toUpperCase(), owner.email]) {
      expectError(
        await run(as(owner), INVITE, { ownerAccountId: account.id, email }),
        "CONFLICT",
        MESSAGES.ALREADY_MEMBER,
      );
    }
  });

  it("refuses a second unexpired pending invitation and supersedes an expired one", async () => {
    const { owner, account } = await teamFixture();
    const email = uniqueEmail();
    const live = await createMemberInvitation(account, owner, { email });

    expectError(
      await run(as(owner), INVITE, { ownerAccountId: account.id, email }),
      "CONFLICT",
      MESSAGES.ALREADY_INVITED,
    );

    await prisma.memberInvitation.update({
      where: { id: live.id },
      data: { expiresAt: PAST() },
    });
    const data = expectData(
      await run(as(owner), INVITE, { ownerAccountId: account.id, email }),
    );

    assert.notEqual(data.createMemberInvitation.id, live.id);
    const old = await storedInvitation(live);
    assert.equal(old.status, "REVOKED");
    assert.ok(old.respondedAt instanceof Date);
    const [log] = await logsFor(live.id);
    assert.equal(log.action, "REVOKED");
    assert.equal(log.metadata.reason, "EXPIRED_SUPERSEDED");
  });

  it("refuses at the member cap of 10", async () => {
    const { owner, account } = await teamFixture();
    await fillMembers(account, 9);
    expectData(
      await run(as(owner), INVITE, {
        ownerAccountId: account.id,
        email: uniqueEmail(),
      }),
    );

    await fillMembers(account, 10);
    expectError(
      await run(as(owner), INVITE, {
        ownerAccountId: account.id,
        email: uniqueEmail(),
      }),
      "CONFLICT",
      MESSAGES.MEMBER_LIMIT,
    );
  });

  it("refuses beyond 20 unexpired pending invitations, not counting expired ones", async () => {
    const { owner, account } = await teamFixture();

    for (let index = 0; index < 19; index += 1) {
      await createMemberInvitation(account, owner);
    }

    await createMemberInvitation(account, owner, { expiresAt: PAST() });
    expectData(
      await run(as(owner), INVITE, {
        ownerAccountId: account.id,
        email: uniqueEmail(),
      }),
    );
    expectError(
      await run(as(owner), INVITE, {
        ownerAccountId: account.id,
        email: uniqueEmail(),
      }),
      "CONFLICT",
      MESSAGES.PENDING_LIMIT,
    );
  });

  it("rejects an invalid email and an invalid account id", async () => {
    const { owner, account } = await teamFixture();

    expectError(
      await run(as(owner), INVITE, {
        ownerAccountId: account.id,
        email: "not-an-email",
      }),
      "BAD_USER_INPUT",
    );
    expectError(
      await run(as(owner), INVITE, {
        ownerAccountId: "not a cuid",
        email: uniqueEmail(),
      }),
      "NOT_FOUND",
    );
  });
});

describe("revokeMemberInvitation", () => {
  it("lets the PRIMARY member revoke a pending invitation and logs it", async () => {
    const { owner, account } = await teamFixture();
    const invitation = await createMemberInvitation(account, owner);

    const data = expectData(
      await run(as(owner), REVOKE, { id: invitation.id }),
    );

    assert.equal(data.revokeMemberInvitation.status, "REVOKED");
    assert.ok(data.revokeMemberInvitation.respondedAt);
    const [log] = await logsFor(invitation.id);
    assert.deepEqual(
      [log.action, log.metadata.toStatus],
      ["REVOKED", "REVOKED"],
    );
  });

  it("refuses a CO_OWNER and a read-only account, and hides it from non-members", async () => {
    const { owner, coOwner, account } = await teamFixture();
    const invitation = await createMemberInvitation(account, owner);
    const readOnly = await createOwnerAccount(owner, { billing: CANCELED });
    const readOnlyInvitation = await createMemberInvitation(readOnly, owner);

    expectError(
      await run(as(coOwner), REVOKE, { id: invitation.id }),
      "FORBIDDEN",
      MESSAGES.ROLE_NOT_ALLOWED,
    );
    expectError(
      await run(as(await createUser()), REVOKE, { id: invitation.id }),
      "NOT_FOUND",
      MESSAGES.INVITATION_NOT_FOUND,
    );
    expectError(
      await run(as(owner), REVOKE, { id: MISSING_ID }),
      "NOT_FOUND",
      MESSAGES.INVITATION_NOT_FOUND,
    );
    expectError(
      await run(as(owner), REVOKE, { id: readOnlyInvitation.id }),
      "FORBIDDEN",
      READ_ONLY_MESSAGE,
    );
    assert.equal((await storedInvitation(invitation)).status, "PENDING");
  });

  it("refuses an invitation that is no longer pending or has expired", async () => {
    const { owner, account } = await teamFixture();
    const accepted = await createMemberInvitation(account, owner, {
      status: "ACCEPTED",
      respondedAt: new Date(),
    });
    const expired = await createMemberInvitation(account, owner, {
      expiresAt: PAST(),
    });

    expectError(
      await run(as(owner), REVOKE, { id: accepted.id }),
      "CONFLICT",
      MESSAGES.NOT_PENDING,
    );
    expectError(
      await run(as(owner), REVOKE, { id: expired.id }),
      "CONFLICT",
      MESSAGES.EXPIRED,
    );
  });
});

describe("acceptMemberInvitation", () => {
  it("makes the invitee a CO_OWNER, marks the invitation ACCEPTED and logs both", async () => {
    const owner = await createUser();
    const invitee = await createUser({ email: uniqueEmail("Mixed.Invitee") });
    const account = await createOwnerAccount(owner);
    const invitation = await createMemberInvitation(account, owner, {
      email: invitee.email.toLowerCase(),
    });

    const data = expectData(
      await run(as(invitee), ACCEPT, { id: invitation.id }),
    );

    assert.equal(
      data.acceptMemberInvitation.id,
      await memberIdOf(account, invitee),
    );
    assert.equal(data.acceptMemberInvitation.role, "CO_OWNER");
    assert.equal(data.acceptMemberInvitation.email, invitee.email);
    const member = await membershipOf(account, invitee);
    assert.equal(member.id, data.acceptMemberInvitation.id);

    const stored = await storedInvitation(invitation);
    assert.equal(stored.status, "ACCEPTED");
    assert.ok(stored.respondedAt instanceof Date);

    const [invitationLog] = await logsFor(invitation.id);
    assert.equal(invitationLog.action, "ACCEPTED");
    assert.equal(invitationLog.metadata.memberId, member.id);
    const [memberLog] = await logsFor(member.id);
    assert.equal(memberLog.entityType, "OwnerAccountMember");
    assert.equal(memberLog.action, "CREATED");
    assert.deepEqual(memberLog.metadata, {
      ownerAccountId: account.id,
      userId: invitee.id,
      role: "CO_OWNER",
      memberInvitationId: invitation.id,
    });

    expectData(await run(as(invitee), ACCOUNT, { id: account.id }));
  });

  it("gives NOT_FOUND to anyone whose email does not match, and for a missing id", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner);
    const invitation = await createMemberInvitation(account, owner);

    expectError(
      await run(as(await createUser()), ACCEPT, { id: invitation.id }),
      "NOT_FOUND",
      MESSAGES.INVITATION_NOT_FOUND,
    );
    expectError(
      await run(as(owner), ACCEPT, { id: invitation.id }),
      "NOT_FOUND",
      MESSAGES.INVITATION_NOT_FOUND,
    );
    expectError(
      await run(as(owner), ACCEPT, { id: MISSING_ID }),
      "NOT_FOUND",
      MESSAGES.INVITATION_NOT_FOUND,
    );
    assert.equal((await storedInvitation(invitation)).status, "PENDING");
  });

  it("refuses an expired or no longer pending invitation", async () => {
    const [owner, invitee] = await Promise.all([createUser(), createUser()]);
    const account = await createOwnerAccount(owner);
    const expired = await createMemberInvitation(account, owner, {
      email: invitee.email,
      expiresAt: PAST(),
    });
    const declined = await createMemberInvitation(
      await createOwnerAccount(owner),
      owner,
      {
        email: invitee.email,
        status: "DECLINED",
        respondedAt: new Date(),
      },
    );

    expectError(
      await run(as(invitee), ACCEPT, { id: expired.id }),
      "CONFLICT",
      MESSAGES.EXPIRED,
    );
    expectError(
      await run(as(invitee), ACCEPT, { id: declined.id }),
      "CONFLICT",
      MESSAGES.NOT_PENDING,
    );
    assert.equal(
      await prisma.ownerAccountMember.count({ where: { userId: invitee.id } }),
      0,
    );
  });

  it("refuses someone who is already a member", async () => {
    const { owner, coOwner, account } = await teamFixture();
    const invitation = await createMemberInvitation(account, owner, {
      email: coOwner.email,
    });

    expectError(
      await run(as(coOwner), ACCEPT, { id: invitation.id }),
      "CONFLICT",
      MESSAGES.YOU_ARE_MEMBER,
    );
    assert.equal((await storedInvitation(invitation)).status, "PENDING");
  });

  it("re-checks the member cap at accept", async () => {
    const [owner, invitee] = await Promise.all([createUser(), createUser()]);
    const account = await createOwnerAccount(owner);
    const invitation = await createMemberInvitation(account, owner, {
      email: invitee.email,
    });
    await fillMembers(account, 10);

    expectError(
      await run(as(invitee), ACCEPT, { id: invitation.id }),
      "CONFLICT",
      MESSAGES.MEMBER_LIMIT,
    );
    assert.equal((await storedInvitation(invitation)).status, "PENDING");
  });

  it("refuses a BLOCKED, PENDING_DELETION or read-only account and allows a PENDING one", async () => {
    const owner = await createUser();
    const cases = [
      [{ status: "BLOCKED" }, "FORBIDDEN", MESSAGES.STATUS_NOT_ALLOWED],
      [
        { status: "PENDING_DELETION" },
        "FORBIDDEN",
        MESSAGES.STATUS_NOT_ALLOWED,
      ],
      [{ billing: CANCELED }, "FORBIDDEN", READ_ONLY_MESSAGE],
    ];

    for (const [options, code, message] of cases) {
      const invitee = await createUser();
      const invitation = await createMemberInvitation(
        await createOwnerAccount(owner, options),
        owner,
        { email: invitee.email },
      );
      expectError(
        await run(as(invitee), ACCEPT, { id: invitation.id }),
        code,
        message,
      );
    }

    const invitee = await createUser();
    const pending = await createOwnerAccount(owner, {
      status: "PENDING",
      billing: null,
    });
    const invitation = await createMemberInvitation(pending, owner, {
      email: invitee.email,
    });
    expectData(await run(as(invitee), ACCEPT, { id: invitation.id }));
  });
});

describe("declineMemberInvitation", () => {
  it("lets the invitee decline, in any account state", async () => {
    const owner = await createUser();

    for (const options of [{}, { billing: CANCELED }, { status: "BLOCKED" }]) {
      const invitee = await createUser();
      const invitation = await createMemberInvitation(
        await createOwnerAccount(owner, options),
        owner,
        { email: invitee.email },
      );

      const data = expectData(
        await run(as(invitee), DECLINE, { id: invitation.id }),
      );

      assert.equal(data.declineMemberInvitation.status, "DECLINED");
      const [log] = await logsFor(invitation.id);
      assert.deepEqual(
        [log.action, log.performedByUserId],
        ["DECLINED", invitee.id],
      );
    }
  });

  it("gives NOT_FOUND to another email and CONFLICT when no longer pending", async () => {
    const [owner, invitee] = await Promise.all([createUser(), createUser()]);
    const account = await createOwnerAccount(owner);
    const invitation = await createMemberInvitation(account, owner, {
      email: invitee.email,
    });

    expectError(
      await run(as(owner), DECLINE, { id: invitation.id }),
      "NOT_FOUND",
      MESSAGES.INVITATION_NOT_FOUND,
    );
    expectData(await run(as(invitee), DECLINE, { id: invitation.id }));
    expectError(
      await run(as(invitee), DECLINE, { id: invitation.id }),
      "CONFLICT",
      MESSAGES.NOT_PENDING,
    );
  });
});

describe("removeMember", () => {
  it("lets the PRIMARY member remove a CO_OWNER, who loses access", async () => {
    const { owner, coOwner, account } = await teamFixture();
    const member = await membershipOf(account, coOwner);

    const data = expectData(
      await run(as(owner), REMOVE, {
        ownerAccountId: account.id,
        memberId: member.id,
      }),
    );

    assert.equal(data.removeMember.id, member.id);
    assert.equal(data.removeMember.email, coOwner.email);
    assert.equal(data.removeMember.role, "CO_OWNER");
    assert.equal(await membershipOf(account, coOwner), null);
    const [log] = await logsFor(member.id);
    assert.equal(log.action, "REMOVED");
    assert.equal(log.performedByUserId, owner.id);
    assert.deepEqual(log.metadata, {
      ownerAccountId: account.id,
      userId: coOwner.id,
      role: "CO_OWNER",
    });
    expectError(
      await run(as(coOwner), ACCOUNT, { id: account.id }),
      "NOT_FOUND",
    );
  });

  it("never removes the PRIMARY member", async () => {
    const { owner, account } = await teamFixture();

    expectError(
      await run(as(owner), REMOVE, {
        ownerAccountId: account.id,
        memberId: await memberIdOf(account, owner),
      }),
      "FORBIDDEN",
      MESSAGES.PRIMARY_CANNOT_BE_REMOVED,
    );
    assert.ok(await membershipOf(account, owner));
  });

  it("is PRIMARY only", async () => {
    const { owner, coOwner, account } = await teamFixture();
    const other = await createUser();
    await addMember(account, other);

    for (const target of [other, owner]) {
      expectError(
        await run(as(coOwner), REMOVE, {
          ownerAccountId: account.id,
          memberId: await memberIdOf(account, target),
        }),
        "FORBIDDEN",
        MESSAGES.ROLE_NOT_ALLOWED,
      );
    }
    assert.ok(await membershipOf(account, other));
  });

  it("gives NOT_FOUND for a missing membership or one of another account", async () => {
    const { owner, account } = await teamFixture();
    const elsewhere = await teamFixture();

    for (const memberId of [
      MISSING_ID,
      await memberIdOf(elsewhere.account, elsewhere.coOwner),
    ]) {
      expectError(
        await run(as(owner), REMOVE, { ownerAccountId: account.id, memberId }),
        "NOT_FOUND",
        MESSAGES.MEMBER_NOT_FOUND,
      );
    }
    assert.ok(await membershipOf(elsewhere.account, elsewhere.coOwner));
  });

  it("is allowed on a read-only account and refused on a BLOCKED one", async () => {
    const readOnly = await teamFixture({ billing: CANCELED });
    const blocked = await teamFixture({ status: "BLOCKED" });

    expectData(
      await run(as(readOnly.owner), REMOVE, {
        ownerAccountId: readOnly.account.id,
        memberId: await memberIdOf(readOnly.account, readOnly.coOwner),
      }),
    );
    assert.equal(await membershipOf(readOnly.account, readOnly.coOwner), null);
    expectError(
      await run(as(blocked.owner), REMOVE, {
        ownerAccountId: blocked.account.id,
        memberId: await memberIdOf(blocked.account, blocked.coOwner),
      }),
      "FORBIDDEN",
      MESSAGES.STATUS_NOT_ALLOWED,
    );
  });

  it("rejects a malformed membership id, including a Firebase UID", async () => {
    const { owner, coOwner, account } = await teamFixture();

    for (const memberId of ["bad id!", coOwner.id]) {
      expectError(
        await run(as(owner), REMOVE, { ownerAccountId: account.id, memberId }),
        "BAD_USER_INPUT",
      );
    }
  });
});

describe("leaveAccount", () => {
  it("lets a CO_OWNER leave and logs it", async () => {
    const { coOwner, account } = await teamFixture();
    const member = await membershipOf(account, coOwner);

    const data = expectData(
      await run(as(coOwner), LEAVE, { ownerAccountId: account.id }),
    );

    assert.equal(data.leaveAccount.id, member.id);
    assert.equal(await membershipOf(account, coOwner), null);
    const [log] = await logsFor(member.id);
    assert.deepEqual([log.action, log.performedByUserId], ["LEFT", coOwner.id]);
  });

  it("never lets the PRIMARY member leave", async () => {
    const { owner, account } = await teamFixture();

    expectError(
      await run(as(owner), LEAVE, { ownerAccountId: account.id }),
      "FORBIDDEN",
      MESSAGES.PRIMARY_CANNOT_LEAVE,
    );
    assert.ok(await membershipOf(account, owner));
  });

  it("gives NOT_FOUND to a non-member", async () => {
    const { account } = await teamFixture();

    expectError(
      await run(as(await createUser()), LEAVE, { ownerAccountId: account.id }),
      "NOT_FOUND",
      MESSAGES.OWNER_ACCOUNT_NOT_FOUND,
    );
  });

  it("is allowed on a read-only account, like scheduling the account's deletion", async () => {
    const { coOwner, account } = await teamFixture({ billing: CANCELED });

    const data = expectData(
      await run(as(coOwner), LEAVE, { ownerAccountId: account.id }),
    );

    assert.equal(data.leaveAccount.email, coOwner.email);
    assert.equal(await membershipOf(account, coOwner), null);
  });

  it("refuses on a BLOCKED or PENDING_DELETION account", async () => {
    for (const status of ["BLOCKED", "PENDING_DELETION"]) {
      const { coOwner, account } = await teamFixture({ status });

      expectError(
        await run(as(coOwner), LEAVE, { ownerAccountId: account.id }),
        "FORBIDDEN",
        MESSAGES.STATUS_NOT_ALLOWED,
      );
      assert.ok(await membershipOf(account, coOwner));
    }
  });
});

describe("transferOwnership", () => {
  it("swaps the roles in one step, logs it and moves billing with ownership", async () => {
    const { owner, coOwner, account } = await teamFixture();

    const data = expectData(
      await run(as(owner), TRANSFER, {
        ...(await transferTo(account, coOwner)),
      }),
    );

    assert.deepEqual(
      { ...data.transferOwnership.previousPrimary },
      { email: owner.email, role: "CO_OWNER" },
    );
    assert.deepEqual(
      { ...data.transferOwnership.newPrimary },
      { email: coOwner.email, role: "PRIMARY" },
    );
    assert.equal((await membershipOf(account, owner)).role, "CO_OWNER");
    assert.equal((await membershipOf(account, coOwner)).role, "PRIMARY");
    assert.equal(
      await prisma.ownerAccountMember.count({
        where: { ownerAccountId: account.id, role: "PRIMARY" },
      }),
      1,
    );

    const [log] = (await logsFor(account.id)).filter(
      (entry) => entry.action === "OWNERSHIP_TRANSFERRED",
    );
    assert.equal(log.performedByUserId, owner.id);
    assert.deepEqual(log.metadata, {
      fromUserId: owner.id,
      toUserId: coOwner.id,
    });

    expectError(
      await run(as(owner), PORTAL, { ownerAccountId: account.id }),
      "FORBIDDEN",
      MESSAGES.ROLE_NOT_ALLOWED,
    );
    expectError(
      await run(as(coOwner), PORTAL, { ownerAccountId: account.id }),
      "CONFLICT",
      MESSAGES.NO_CUSTOMER,
    );
    expectError(
      await run(as(owner), INVITE, {
        ownerAccountId: account.id,
        email: uniqueEmail(),
      }),
      "FORBIDDEN",
      MESSAGES.ROLE_NOT_ALLOWED,
    );
    expectData(await run(as(owner), LEAVE, { ownerAccountId: account.id }));
  });

  it("updates the Stripe customer's email to the new PRIMARY's email", async () => {
    const { owner, coOwner, account } = await teamFixture();
    await setBilling(account, { stripeCustomerId: STRIPE_CUSTOMER_ID });
    const stripe = recordingStripeGateway();

    expectData(
      await run(
        contextFor(owner, { billingGateway: stripe.gateway }),
        TRANSFER,
        {
          ...(await transferTo(account, coOwner)),
        },
      ),
    );

    assert.deepEqual(stripe.calls, [
      {
        name: "updateCustomerEmail",
        args: [{ customerId: STRIPE_CUSTOMER_ID, email: coOwner.email }],
      },
    ]);
    const failures = await prisma.activityLog.count({
      where: { action: "CUSTOMER_EMAIL_SYNC_FAILED" },
    });
    assert.equal(failures, 0);
  });

  it("still transfers when the Stripe update fails, and logs the failure for a retry", async () => {
    const { owner, coOwner, account } = await teamFixture();
    await setBilling(account, { stripeCustomerId: STRIPE_CUSTOMER_ID });
    const stripe = recordingStripeGateway({
      overrides: {
        async updateCustomerEmail() {
          throw Object.assign(new Error("Stripe is unavailable"), {
            type: "StripeConnectionError",
          });
        },
      },
    });

    const data = expectData(
      await run(
        contextFor(owner, { billingGateway: stripe.gateway }),
        TRANSFER,
        {
          ...(await transferTo(account, coOwner)),
        },
      ),
    );

    assert.equal(data.transferOwnership.newPrimary.email, coOwner.email);
    assert.equal((await membershipOf(account, coOwner)).role, "PRIMARY");

    const [log] = await prisma.activityLog.findMany({
      where: { action: "CUSTOMER_EMAIL_SYNC_FAILED" },
    });
    assert.deepEqual(
      [log.entityType, log.entityId, log.performedByUserId],
      ["Subscription", account.id, owner.id],
    );
    assert.deepEqual(log.metadata, {
      ownerAccountId: account.id,
      stripeCustomerId: STRIPE_CUSTOMER_ID,
      primaryUserId: coOwner.id,
      errorType: "StripeConnectionError",
    });
  });

  it("still succeeds when the failure log cannot be written, and reports it to the request logger", async () => {
    const { owner, coOwner, account } = await teamFixture();
    await setBilling(account, { stripeCustomerId: STRIPE_CUSTOMER_ID });
    const stripe = recordingStripeGateway({
      overrides: {
        async updateCustomerEmail() {
          throw new Error("Stripe is unavailable");
        },
      },
    });
    const logWriteError = new Error("Database unavailable");
    let transactions = 0;
    // The transfer's own transaction runs normally; the failure log's transaction fails.
    const failingLogPrisma = new Proxy(prisma, {
      get(target, property) {
        if (property !== "$transaction") {
          return Reflect.get(target, property);
        }

        return (...args) => {
          transactions += 1;
          return transactions === 1
            ? target.$transaction(...args)
            : Promise.reject(logWriteError);
        };
      },
    });
    const log = recordingLogger();

    const data = expectData(
      await run(
        {
          ...contextFor(owner, { billingGateway: stripe.gateway, log }),
          prisma: failingLogPrisma,
        },
        TRANSFER,
        {
          ...(await transferTo(account, coOwner)),
        },
      ),
    );

    assert.equal(data.transferOwnership.newPrimary.email, coOwner.email);
    assert.equal((await membershipOf(account, coOwner)).role, "PRIMARY");
    assert.equal(
      await prisma.activityLog.count({
        where: { action: "CUSTOMER_EMAIL_SYNC_FAILED" },
      }),
      0,
    );

    assert.equal(log.entries.length, 1);
    const [{ level, args }] = log.entries;
    const [attributes, message] = args;
    assert.equal(level, "error");
    assert.deepEqual(attributes, {
      err: logWriteError,
      ownerAccountId: account.id,
      primaryUserId: coOwner.id,
    });
    assert.equal(
      message,
      "Could not record CUSTOMER_EMAIL_SYNC_FAILED after an ownership transfer.",
    );
  });

  it("makes no Stripe call for an account without a Stripe customer", async () => {
    const { owner, coOwner, account } = await teamFixture();
    const stripe = recordingStripeGateway();

    expectData(
      await run(
        contextFor(owner, { billingGateway: stripe.gateway }),
        TRANSFER,
        {
          ...(await transferTo(account, coOwner)),
        },
      ),
    );

    assert.deepEqual(stripe.calls, []);
  });

  it("makes no Stripe call when the transfer is refused", async () => {
    const { owner, account } = await teamFixture();
    await setBilling(account, { stripeCustomerId: STRIPE_CUSTOMER_ID });
    const stripe = recordingStripeGateway();

    expectError(
      await run(
        contextFor(owner, { billingGateway: stripe.gateway }),
        TRANSFER,
        {
          ...(await transferTo(account, owner)),
        },
      ),
      "CONFLICT",
      MESSAGES.ALREADY_PRIMARY,
    );
    assert.deepEqual(stripe.calls, []);
  });

  it("requires the target to be a member and not the caller", async () => {
    const { owner, account } = await teamFixture();

    const elsewhere = await teamFixture();

    for (const newPrimaryMemberId of [
      MISSING_ID,
      await memberIdOf(elsewhere.account, elsewhere.coOwner),
    ]) {
      expectError(
        await run(as(owner), TRANSFER, {
          ownerAccountId: account.id,
          newPrimaryMemberId,
        }),
        "NOT_FOUND",
        MESSAGES.MEMBER_NOT_FOUND,
      );
    }
    expectError(
      await run(as(owner), TRANSFER, {
        ...(await transferTo(account, owner)),
      }),
      "CONFLICT",
      MESSAGES.ALREADY_PRIMARY,
    );
  });

  it("is PRIMARY only", async () => {
    const { owner, coOwner, account } = await teamFixture();

    expectError(
      await run(as(coOwner), TRANSFER, {
        ...(await transferTo(account, coOwner)),
      }),
      "FORBIDDEN",
      MESSAGES.ROLE_NOT_ALLOWED,
    );
    assert.equal((await membershipOf(account, owner)).role, "PRIMARY");
  });

  it("applies the 5-primary-accounts cap to the new PRIMARY", async () => {
    const { owner, coOwner, account } = await teamFixture();

    for (let index = 0; index < 4; index += 1) {
      await createOwnerAccount(coOwner);
    }

    const second = await createOwnerAccount(owner);
    await addMember(second, coOwner);

    expectData(
      await run(as(owner), TRANSFER, {
        ...(await transferTo(account, coOwner)),
      }),
    );
    expectError(
      await run(as(owner), TRANSFER, await transferTo(second, coOwner)),
      "CONFLICT",
      MESSAGES.NEW_PRIMARY_LIMIT,
    );
    assert.equal((await membershipOf(second, owner)).role, "PRIMARY");
  });

  it("refuses on a read-only, BLOCKED or PENDING_DELETION account", async () => {
    const cases = [
      [{ billing: CANCELED }, READ_ONLY_MESSAGE],
      [{ status: "BLOCKED" }, MESSAGES.STATUS_NOT_ALLOWED],
      [{ status: "PENDING_DELETION" }, MESSAGES.STATUS_NOT_ALLOWED],
    ];

    for (const [options, message] of cases) {
      const { owner, coOwner, account } = await teamFixture(options);
      expectError(
        await run(as(owner), TRANSFER, {
          ...(await transferTo(account, coOwner)),
        }),
        "FORBIDDEN",
        message,
      );
    }
  });
});

describe("database constraints", () => {
  it("allows at most one PRIMARY per account", async () => {
    const { coOwner, account } = await teamFixture();

    await assert.rejects(
      prisma.ownerAccountMember.updateMany({
        where: { ownerAccountId: account.id, userId: coOwner.id },
        data: { role: "PRIMARY" },
      }),
      (error) =>
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002",
    );
  });

  it("allows one PENDING member invitation per account and email, and more once it is answered", async () => {
    const owner = await createUser();
    const account = await createOwnerAccount(owner);
    const email = uniqueEmail();
    const first = await createMemberInvitation(account, owner, { email });

    await assert.rejects(
      createMemberInvitation(account, owner, { email }),
      (error) =>
        error instanceof Prisma.PrismaClientKnownRequestError &&
        error.code === "P2002",
    );

    await prisma.memberInvitation.update({
      where: { id: first.id },
      data: { status: "REVOKED" },
    });
    await createMemberInvitation(account, owner, { email });
  });
});
