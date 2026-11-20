import { once } from "node:events";
import { after } from "node:test";

import { closeRedisClient, createRedisClient } from "../../src/redis.js";
import { assertTestEnvironment, TEST_REDIS_DB } from "./safety.js";

assertTestEnvironment();

// Nothing listens on port 1, so this client behaves like Redis being down: with no offline
// queue every command rejects at once.
const UNREACHABLE_REDIS_URL = `redis://127.0.0.1:1/${TEST_REDIS_DB}`;
const SELECTED_DB_PATTERN = /(?:^|\s)db=(\d+)(?:\s|$)/;
const READY_STATUS = "ready";
const READY_TIMEOUT_MS = 5_000;

const ignoreError = () => {};

/** The shared test client, on Redis database 15 only. */
export const redis = createRedisClient(process.env.REDIS_URL, { onError: ignoreError });

const unreachableClients = [];

// Asks the server which database this connection is on, so a flush can never run against
// another index even if the URL check were bypassed.
async function assertSelectedTestDb() {
  const info = await redis.call("CLIENT", "INFO");
  const selected = Number(SELECTED_DB_PATTERN.exec(info)?.[1]);

  if (selected !== TEST_REDIS_DB) {
    throw new Error(`Refusing to flush Redis: the connection is not on database ${TEST_REDIS_DB}.`);
  }
}

// The client has no offline queue, so commands sent before the first connection completes
// would be rejected; tests wait for it instead.
async function waitUntilReady() {
  if (redis.status === READY_STATUS) {
    return;
  }

  try {
    await once(redis, READY_STATUS, { signal: AbortSignal.timeout(READY_TIMEOUT_MS) });
  } catch {
    throw new Error("Redis at REDIS_URL is not reachable. Start it with `docker compose up -d` from docker/.");
  }
}

/** Empties Redis database 15. Called by resetDatabase() before each test. */
export async function resetRedis() {
  assertTestEnvironment();
  await waitUntilReady();
  await assertSelectedTestDb();
  await redis.flushdb();
}

/** A client whose every command fails, standing in for a Redis outage. Closed after the file. */
export function unreachableRedis() {
  const client = createRedisClient(UNREACHABLE_REDIS_URL, { onError: ignoreError });
  unreachableClients.push(client);
  return client;
}

after(async () => {
  for (const client of unreachableClients) {
    client.disconnect();
  }

  await closeRedisClient(redis);
});
