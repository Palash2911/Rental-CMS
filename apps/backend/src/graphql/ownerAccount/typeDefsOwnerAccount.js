export const ownerAccountTypeDefs = `
  type OwnerAccount {
    id: ID!
    name: String!
    status: OwnerAccountStatus!
    createdAt: String!
    updatedAt: String!
  }

  enum OwnerAccountStatus {
    PENDING
    APPROVED
    BLOCKED
    PENDING_DELETION
  }

  extend type Query {
    myOwnerAccounts: [OwnerAccount!]!
    ownerAccount(id: ID!): OwnerAccount
  }

  extend type Mutation {
    createOwnerAccount(name: String!): OwnerAccount!
    updateOwnerAccount(id: ID!, name: String!): OwnerAccount!
    scheduleOwnerAccountDeletion(id: ID!): Boolean!
  }
`;
