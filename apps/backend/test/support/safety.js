const TEST_NODE_ENV = "test";
export const TEST_DATABASE_SUFFIX = "_test";
export const TEST_REDIS_DB = 15;

const REDIS_PROTOCOL = /^rediss?:$/;
const REDIS_DB_QUERY_PARAM = "db";

// Only the URL path may pick the database: ioredis also reads a `db` query parameter, so a
// URL carrying one is refused rather than trusting which of the two wins.
function redisProblem(env) {
  const value = env.REDIS_URL;

  if (!value) {
    return "REDIS_URL is not set";
  }

  let url;

  try {
    url = new URL(value);
  } catch {
    url = null;
  }

  const selectsTestDb =
    url !== null &&
    REDIS_PROTOCOL.test(url.protocol) &&
    url.pathname === `/${TEST_REDIS_DB}` &&
    !url.searchParams.has(REDIS_DB_QUERY_PARAM);

  return selectsTestDb
    ? null
    : `REDIS_URL must be a redis:// URL selecting database ${TEST_REDIS_DB} (ending in /${TEST_REDIS_DB})`;
}

function databaseName(url) {
  try {
    return decodeURIComponent(new URL(url).pathname.slice(1));
  } catch {
    return null;
  }
}

function urlProblem(env, name) {
  const value = env[name];

  if (!value) {
    return `${name} is not set`;
  }

  const database = databaseName(value);

  if (!database || !database.endsWith(TEST_DATABASE_SUFFIX)) {
    return `${name} must name a database ending in "${TEST_DATABASE_SUFFIX}"`;
  }

  return null;
}

/**
 * Throws unless NODE_ENV is "test" and DATABASE_URL (and DIRECT_URL when required or set)
 * names a database ending in "_test". Run before anything touches a database, so the suite
 * and the test migration can never reach the development or production database.
 * The message names variables only, never their values.
 */
// It also requires REDIS_URL to select Redis database 15 (TEST_REDIS_DB), so flushing between
// tests can never empty the development or production Redis database.
export function assertTestEnvironment(env = process.env, { requireDirectUrl = false } = {}) {
  const problems = [];

  if (env.NODE_ENV !== TEST_NODE_ENV) {
    problems.push(`NODE_ENV must be "${TEST_NODE_ENV}"`);
  }

  problems.push(urlProblem(env, "DATABASE_URL"));

  if (requireDirectUrl || env.DIRECT_URL) {
    problems.push(urlProblem(env, "DIRECT_URL"));
  }

  problems.push(redisProblem(env));

  const failures = problems.filter(Boolean);

  if (failures.length > 0) {
    throw new Error(
      `Refusing to touch the database: this is not a test environment.\n- ${failures.join("\n- ")}\nCheck apps/backend/.env.test, and that no shell variable overrides it.`,
    );
  }
}
