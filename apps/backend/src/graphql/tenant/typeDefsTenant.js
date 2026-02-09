export const tenantTypeDefs = `
  type TenantProfile {
    id: ID!
    userId: ID!
    createdAt: String!
  }

  extend type Query {
    tenantProfile(id: ID!): TenantProfile
    tenantProfilesByOwner(ownerAccountId: ID!): [TenantProfile!]!
  }

  extend type Mutation {
    createTenantProfile(userId: ID!): TenantProfile!
  }
`;
