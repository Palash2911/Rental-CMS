import { readdir } from "node:fs/promises";
import path from "node:path";

import { assertTestEnvironment } from "./support/safety.js";

const MIGRATIONS_DIR = path.resolve(import.meta.dirname, "..", "prisma", "migrations");
const NOT_MIGRATED_MESSAGE =
  "The test database is not fully migrated. Run `yarn test:db:migrate` from apps/backend.";

async function migrationFolderCount() {
  const entries = await readdir(MIGRATIONS_DIR, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).length;
}

async function appliedMigrationCount(prisma) {
  try {
    const rows = await prisma.$queryRaw`
      SELECT count(*)::int AS count FROM "_prisma_migrations"
      WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
    return rows[0].count;
  } catch {
    return 0;
  }
}

/** Runs once before any test file: refuses non-test databases and unmigrated schemas. */
export async function globalSetup() {
  assertTestEnvironment();

  const { default: prisma } = await import("../src/prisma.js");

  try {
    const [expected, applied] = await Promise.all([
      migrationFolderCount(),
      appliedMigrationCount(prisma),
    ]);

    if (applied < expected) {
      throw new Error(`${NOT_MIGRATED_MESSAGE} (${applied} of ${expected} applied)`);
    }
  } finally {
    await prisma.$disconnect();
  }
}
