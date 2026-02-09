import { createYoga } from "graphql-yoga";
import { createServer } from "node:http";
import { createContext } from "./graphql/context.js";
import { schema } from "./graphql/rootSchema.js";

const yoga = createYoga({
  schema,
  context: createContext,
  maskedErrors: false,
});

const server = createServer(yoga);

server.listen(9000, () => {
  console.info("Server is running on http://localhost:9000/graphql");
});
