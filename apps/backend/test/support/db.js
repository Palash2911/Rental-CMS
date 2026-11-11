import { after } from "node:test";

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
}

after(() => prisma.$disconnect());

export { prisma };
