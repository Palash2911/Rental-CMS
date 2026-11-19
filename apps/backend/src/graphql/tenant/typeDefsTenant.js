export const tenantTypeDefs = `
  type TenantProfile {
    id: ID!
    name: String
    email: String!
    createdAt: DateTime!
  }

  type TenantProfilePage {
    items: [TenantProfile!]!
    pageInfo: PageInfo!
  }

  extend type Query {
    tenantProfile(id: ID!): TenantProfile!
    tenantProfilesByOwner(ownerAccountId: ID!, first: Int, after: String): TenantProfilePage!
  }
`;
