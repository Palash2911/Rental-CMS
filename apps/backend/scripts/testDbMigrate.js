import { spawn } from "node:child_process";
import path from "node:path";

import { assertTestEnvironment } from "../test/support/safety.js";

const PRISMA_BIN = path.resolve(import.meta.dirname, "..", "node_modules", ".bin", "prisma");
const MIGRATE_ARGS = Object.freeze(["migrate", "deploy"]);

function run() {
  try {
    // DIRECT_URL is required here: prisma.config.ts loads .env through dotenv, which only
    // fills unset variables, so a missing DIRECT_URL would silently fall back to the
    // development database.
    assertTestEnvironment(process.env, { requireDirectUrl: true });
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }

  console.info("Applying migrations to the test database (prisma migrate deploy)...");

  const child = spawn(PRISMA_BIN, MIGRATE_ARGS, {
    env: process.env,
    stdio: "inherit",
  });

  child.on("error", (error) => {
    console.error(`Could not start the Prisma CLI: ${error.message}`);
    process.exit(1);
  });

  child.on("exit", (code) => {
    process.exit(code ?? 1);
  });
}

run();
