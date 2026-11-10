export const userTypeDefs = `
  type User {
    id: ID!
    email: String!
    name: String
    createdAt: String!
  }

  extend type Query {
    me: User!
  }
`;
