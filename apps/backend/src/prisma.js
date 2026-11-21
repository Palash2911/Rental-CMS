import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "./generated/prisma/client.ts";
import { config } from "./lib/config.js";

// Bounded so a slow query or a database hiccup cannot hold every connection. pg's default is
// 10 connections with no connect timeout.
const POOL = Object.freeze({
  max: 10,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
  // Client-side backstop: the query's promise rejects after this long. The server-side
  // statement_timeout is set on the database role instead (docs/architecture.md, Neon setup):
  // pg sends a statement_timeout option as a startup parameter, which Neon's transaction-mode
  // PgBouncer would carry over to other clients sharing the server connection.
  query_timeout: 10_000,
});

const adapter = new PrismaPg({ connectionString: config.databaseUrl, ...POOL });

const createPrismaClient = () => {
  return new PrismaClient({ adapter });
};

const globalForPrisma = globalThis;

const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (!config.isProduction) {
  globalForPrisma.prisma = prisma;
}

export default prisma;
