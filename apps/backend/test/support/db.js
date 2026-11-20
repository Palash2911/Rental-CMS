import { after } from "node:test";

import { resetRedis } from "./redis.js";
import { assertTestEnvironment } from "./safety.js";

assertTestEnvironment();

// Imported only after the safety check, so no Prisma client exists for a non-test database.
const { default: prisma } = await import("../../src/prisma.js");

const MIGRATIONS_TABLE = "_prisma_migrations";

let truncateStatement = null;

function quoteIdentifier(name) {
  return `"${name.replaceAll('"', '""')}"`;
}

async function buildTruncateStatement() {
  const rows = await prisma.$queryRaw`
    SELECT tablename FROM pg_tables
    WHERE schemaname = current_schema() AND tablename <> ${MIGRATIONS_TABLE}`;
  const tables = rows.map((row) => quoteIdentifier(row.tablename)).join(", ");
  return `TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`;
}

/** Empties every application table in the test database. Call at the start of each test. */
export async function resetDatabase() {
  assertTestEnvironment();
  truncateStatement ??= await buildTruncateStatement();
  await prisma.$executeRawUnsafe(truncateStatement);
  // Redis database 15 holds the user cache and rate limit counters; they must not outlive
  // the rows they describe.
  await resetRedis();
}

/**
 * The test Prisma client, except that the `$transaction` calls numbered in `failingCalls`
 * (1-based, in call order) reject with `error` without running. For "one account fails,
 * the rest continue" tests of the jobs.
 */
export function prismaFailingTransactions(failingCalls, error = new Error("Injected transaction failure")) {
  let calls = 0;

  return new Proxy(prisma, {
    get(target, property) {
      if (property !== "$transaction") {
        return Reflect.get(target, property);
      }

      return (...args) => {
        calls += 1;
        return failingCalls.includes(calls) ? Promise.reject(error) : target.$transaction(...args);
      };
    },
  });
}

after(() => prisma.$disconnect());

export { prisma };
