export const userTypeDefs = `
  type User {
    id: ID!
    email: String!
    name: String
    createdAt: DateTime!
  }

  extend type Query {
    me: User!
  }
`;
