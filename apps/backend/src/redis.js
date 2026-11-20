import { Redis } from "ioredis";

// Redis only backs the rate limit and the user cache, both of which fail open. Commands must
// therefore fail fast instead of queueing or retrying while Redis is down, so an outage adds
// at most COMMAND_TIMEOUT_MS to a request and never takes the API down.
const COMMAND_TIMEOUT_MS = 500;
const CONNECT_TIMEOUT_MS = 2_000;
const MAX_RETRIES_PER_REQUEST = 1;
const MAX_RECONNECT_DELAY_MS = 2_000;
const RECONNECT_STEP_MS = 100;

const RATE_LIMIT_HIT_COMMAND = "rateLimitHit";

// One atomic step of a fixed-window counter: adds ARGV[1] to the key, starts the window
// (ARGV[2] ms) on the first hit, and returns the new count and the window's remaining ms.
// The PTTL check also repairs a key that somehow lost its expiry.
const RATE_LIMIT_HIT_SCRIPT = `
local count = redis.call('INCRBY', KEYS[1], ARGV[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[2])
  ttl = tonumber(ARGV[2])
end
return {count, ttl}
`;

function reconnectDelay(attempt) {
  return Math.min(attempt * RECONNECT_STEP_MS, MAX_RECONNECT_DELAY_MS);
}

/**
 * Creates the shared Redis client for the API: no offline queue and short timeouts, so
 * commands reject quickly while Redis is unreachable. `onError` receives connection errors
 * (ioredis keeps reconnecting in the background). Adds the `rateLimitHit(key, amount,
 * windowMs)` command, run as a cached Lua script (EVALSHA).
 */
export function createRedisClient(url, { onError } = {}) {
  const client = new Redis(url, {
    enableOfflineQueue: false,
    commandTimeout: COMMAND_TIMEOUT_MS,
    connectTimeout: CONNECT_TIMEOUT_MS,
    maxRetriesPerRequest: MAX_RETRIES_PER_REQUEST,
    retryStrategy: reconnectDelay,
  });

  client.defineCommand(RATE_LIMIT_HIT_COMMAND, {
    numberOfKeys: 1,
    lua: RATE_LIMIT_HIT_SCRIPT,
  });

  if (onError) {
    client.on("error", onError);
  }

  return client;
}

/** Closes a client, waiting for pending replies when connected and dropping it otherwise. */
export async function closeRedisClient(client) {
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
}
