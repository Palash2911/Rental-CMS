import { createYoga } from "graphql-yoga";
import { createServer } from "node:http";
import { schema } from "./graphql/schema.js";
import prisma from "./prisma.js";

const yoga = createYoga({
  schema,
  context: () => ({
    prisma,
  }),
});

const server = createServer(yoga);

server.listen(4000, () => {
  console.info("Server is running on http://localhost:4000/graphql");
});
