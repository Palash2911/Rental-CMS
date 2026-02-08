import { createSchema } from "graphql-yoga";

export const schema = createSchema({
  typeDefs: `
    type User {
      id: ID!
      email: String!
      name: String
    }

    type Query {
      users: [User!]!
    }
  `,

  resolvers: {
    Query: {
      users: async (_, __, context) => {
        return context.prisma.user.findMany();
      },
    },
  },
});
