import { createSchema } from "graphql-yoga";

export const schema = createSchema({
  typeDefs: `
      type Query {
        health: String!
      }
    `,
  resolvers: {
    Query: {
      health: () => "Backend is alive",
    },
  },
});
