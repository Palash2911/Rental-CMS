import "dotenv/config";
import { defineConfig, env } from "prisma/config";

export default defineConfig({
  schema: "prisma/schema.prisma",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // The CLI (migrate, introspect) needs a direct, non-pooled connection.
    // The runtime client connects through the PrismaPg adapter with DATABASE_URL (src/prisma.js).
    url: env("DIRECT_URL"),
  },
});
