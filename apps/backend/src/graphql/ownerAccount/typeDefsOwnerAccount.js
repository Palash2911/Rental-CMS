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

  type OwnerAccountPage {
    items: [OwnerAccount!]!
    pageInfo: PageInfo!
  }

  extend type Query {
    myOwnerAccounts(first: Int, after: String): OwnerAccountPage!
    ownerAccount(id: ID!): OwnerAccount!
    adminOwnerAccounts(
      status: OwnerAccountStatus
      first: Int
      after: String
    ): OwnerAccountPage!
  }

  extend type Mutation {
    createOwnerAccount(name: String!): OwnerAccount!
    updateOwnerAccount(id: ID!, name: String!): OwnerAccount!
    scheduleOwnerAccountDeletion(id: ID!): OwnerAccount!
    cancelOwnerAccountDeletion(id: ID!): OwnerAccount!
    approveOwnerAccount(id: ID!): OwnerAccount!
    blockOwnerAccount(id: ID!, reason: String): OwnerAccount!
    unblockOwnerAccount(id: ID!): OwnerAccount!
    adminScheduleOwnerAccountDeletion(id: ID!): OwnerAccount!
    adminCancelOwnerAccountDeletion(id: ID!): OwnerAccount!
  }
`;
