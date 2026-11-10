import { NoSchemaIntrospectionCustomRule } from "graphql";
import { createYoga } from "graphql-yoga";
import { createServer } from "node:http";

import { createContext } from "./graphql/context.js";
import { schema } from "./graphql/rootSchema.js";
import { config } from "./lib/config.js";
import prisma from "./prisma.js";

const PORT = config.port;

// Deny by default: only development exposes GraphiQL and introspection; test and production keep both off.
const isDevelopment = config.isDevelopment;

const disableIntrospection = {
  onValidate({ addValidationRule }) {
    addValidationRule(NoSchemaIntrospectionCustomRule);
  },
};

const yoga = createYoga({
  schema,
  context: createContext,
  maskedErrors: { isDev: isDevelopment },
  graphiql: isDevelopment,
  plugins: isDevelopment ? [] : [disableIntrospection],
});

const server = createServer(yoga);

server.listen(PORT, () => {
  console.info(
    `Server is running on http://localhost:${PORT}${yoga.graphqlEndpoint}`,
  );
});

async function shutdown(signal) {
  console.info(`${signal} received, shutting down...`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
