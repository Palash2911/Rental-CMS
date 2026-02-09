export const tenantAssignmentTypeDefs = `
  type TenantAssignment {
    id: ID!
    tenantProfileId: ID!
    houseId: ID!
    status: TenantAssignmentStatus!
    leaseStartDate: String!
    leaseEndDate: String
    actualExitDate: String
    deletionScheduledAt: String
    createdAt: String!
  }

  enum TenantAssignmentStatus {
    ACTIVE
    NOTICE_PERIOD
    EXITED
  }

  extend type Query {
    tenantAssignmentsByHouse(houseId: ID!): [TenantAssignment!]!
    tenantAssignment(id: ID!): TenantAssignment
  }

  extend type Mutation {
    createTenantAssignment(
      tenantProfileId: ID!
      houseId: ID!
      leaseStartDate: String!
    ): TenantAssignment!

    exitTenantAssignment(id: ID!): TenantAssignment!
  }
`;
