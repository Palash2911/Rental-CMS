import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import {
  USER_CACHE_KEY_PREFIX,
  USER_CACHE_TTL_SECONDS,
} from "../../src/graphql/user/serviceUser.js";
import { prisma, resetDatabase } from "../support/db.js";
import {
  contextFor,
  createUser,
  firebaseUid,
  recordingLogger,
  tokenContext,
  uniqueEmail,
} from "../support/factories.js";
import { expectData, expectError, run } from "../support/graphql.js";
import { redis, unreachableRedis } from "../support/redis.js";

const ME = "query { me { id email name } }";
const SUSPENDED = "This account has been suspended.";

function keyFor(user) {
  return `${USER_CACHE_KEY_PREFIX}${user.id}`;
}

async function cachedEntry(user) {
  const value = await redis.get(keyFor(user));
  return value === null ? null : JSON.parse(value);
}

// A token without a name claim, so a request never syncs the name and only reads.
function readerContext(user, options = {}) {
  return contextFor(user, { name: null, ...options });
}

beforeEach(resetDatabase);

describe("user cache", () => {
  it("misses, reads the database, then caches the row for 60 seconds", async () => {
    const user = await createUser({ name: "Ada" });
    assert.equal(await cachedEntry(user), null);

    expectData(await run(readerContext(user), ME));

    assert.deepEqual(await cachedEntry(user), {
      id: user.id,
      email: user.email,
      name: "Ada",
      isBlocked: false,
      createdAt: user.createdAt.toISOString(),
    });
    const ttl = await redis.ttl(keyFor(user));
    assert.ok(ttl > 0 && ttl <= USER_CACHE_TTL_SECONDS, `ttl ${ttl}`);
  });

  it("serves a hit from Redis without reading the database", async () => {
    const user = await createUser({ name: "Ada" });
    expectData(await run(readerContext(user), ME));
    await prisma.user.update({ where: { id: user.id }, data: { name: "Changed in the database" } });

    const cached = expectData(await run(readerContext(user), ME));
    assert.equal(cached.me.name, "Ada");

    await redis.del(keyFor(user));
    const fresh = expectData(await run(readerContext(user), ME));
    assert.equal(fresh.me.name, "Changed in the database");
  });

  it("invalidates the entry when a token syncs a new name or verified email", async () => {
    const user = await createUser({ name: "Ada" });
    expectData(await run(readerContext(user), ME));

    const renamed = expectData(await run(contextFor(user, { name: "Ada Lovelace" }), ME));
    assert.equal(renamed.me.name, "Ada Lovelace");
    assert.equal(await cachedEntry(user), null);

    expectData(await run(readerContext(user), ME));
    assert.equal((await cachedEntry(user)).name, "Ada Lovelace");

    const email = uniqueEmail("moved");
    const moved = expectData(await run(readerContext(user, { email }), ME));
    assert.equal(moved.me.email, email);
    assert.equal(await cachedEntry(user), null);
    assert.equal((await prisma.user.findUnique({ where: { id: user.id } })).email, email);
  });

  it("invalidates after first sign-in creates the row", async () => {
    const userId = firebaseUid();
    const email = uniqueEmail();
    await redis.set(`${USER_CACHE_KEY_PREFIX}${userId}`, "stale");

    expectData(await run(tokenContext({ userId, email, name: "New" }), ME));

    assert.equal(await redis.get(`${USER_CACHE_KEY_PREFIX}${userId}`), null);
  });

  it("applies a block made directly in the database only once the entry expires", async () => {
    const user = await createUser();
    expectData(await run(readerContext(user), ME));
    await prisma.user.update({ where: { id: user.id }, data: { isBlocked: true } });

    expectData(await run(readerContext(user), ME));

    await redis.del(keyFor(user));
    expectError(await run(readerContext(user), ME), "FORBIDDEN", SUSPENDED);
    assert.equal((await cachedEntry(user)).isBlocked, true);
    expectError(await run(readerContext(user), ME), "FORBIDDEN", SUSPENDED);
  });

  it("treats an entry that does not parse, or belongs to another user, as a miss", async () => {
    const user = await createUser({ name: "Ada" });
    const other = { id: firebaseUid(), email: uniqueEmail(), name: "Other", isBlocked: false, createdAt: new Date().toISOString() };

    for (const value of ["not json", JSON.stringify({ id: user.id }), JSON.stringify(other)]) {
      await redis.set(keyFor(user), value);

      const data = expectData(await run(readerContext(user), ME));

      assert.deepEqual({ ...data.me }, { id: user.id, email: user.email, name: "Ada" });
      assert.equal((await cachedEntry(user)).id, user.id);
    }
  });

  it("falls back to the database silently when Redis is unavailable", async () => {
    const user = await createUser({ name: "Ada" });
    const log = recordingLogger();
    const offline = unreachableRedis();

    const read = expectData(await run(readerContext(user, { redis: offline, log }), ME));
    assert.equal(read.me.name, "Ada");

    const renamed = expectData(await run(contextFor(user, { name: "Ada Lovelace", redis: offline, log }), ME));
    assert.equal(renamed.me.name, "Ada Lovelace");
    assert.equal((await prisma.user.findUnique({ where: { id: user.id } })).name, "Ada Lovelace");

    await prisma.user.update({ where: { id: user.id }, data: { isBlocked: true } });
    expectError(await run(readerContext(user, { redis: offline, log }), ME), "FORBIDDEN", SUSPENDED);

    assert.deepEqual(log.entries, []);
  });
});
