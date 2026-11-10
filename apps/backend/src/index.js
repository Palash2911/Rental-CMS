import { NoSchemaIntrospectionCustomRule } from "graphql";
import { createYoga } from "graphql-yoga";
import { createServer } from "node:http";

import { createContext } from "./graphql/context.js";
import { schema } from "./graphql/rootSchema.js";
import prisma from "./prisma.js";

const PORT = Number(process.env.PORT ?? 9000);

// Deny by default: a host with NODE_ENV unset or mistyped keeps both off.
const isDevelopment = process.env.NODE_ENV === "development";

const disableIntrospection = {
  onValidate({ addValidationRule }) {
    addValidationRule(NoSchemaIntrospectionCustomRule);
  },
};

const yoga = createYoga({
  schema,
  context: createContext,
  maskedErrors: true,
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
