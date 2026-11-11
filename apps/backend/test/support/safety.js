const TEST_NODE_ENV = "test";
export const TEST_DATABASE_SUFFIX = "_test";

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
export function assertTestEnvironment(env = process.env, { requireDirectUrl = false } = {}) {
  const problems = [];

  if (env.NODE_ENV !== TEST_NODE_ENV) {
    problems.push(`NODE_ENV must be "${TEST_NODE_ENV}"`);
  }

  problems.push(urlProblem(env, "DATABASE_URL"));

  if (requireDirectUrl || env.DIRECT_URL) {
    problems.push(urlProblem(env, "DIRECT_URL"));
  }

  const failures = problems.filter(Boolean);

  if (failures.length > 0) {
    throw new Error(
      `Refusing to touch the database: this is not a test environment.\n- ${failures.join("\n- ")}\nCheck apps/backend/.env.test, and that no shell variable overrides it.`,
    );
  }
}
