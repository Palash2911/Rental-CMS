export const tenantAssignmentTypeDefs = `
  type TenantAssignment {
    id: ID!
    tenantProfileId: ID!
    houseId: ID!
    status: TenantAssignmentStatus!
    leaseStartDate: Date!
    leaseEndDate: Date
    plannedExitDate: Date
    actualExitDate: DateTime
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  enum TenantAssignmentStatus {
    ACTIVE
    NOTICE_PERIOD
    EXITED
  }

  type TenantAssignmentPage {
    items: [TenantAssignment!]!
    pageInfo: PageInfo!
  }

  extend type Query {
    tenantAssignment(id: ID!): TenantAssignment!
    tenantAssignmentsByHouse(houseId: ID!, first: Int, after: String): TenantAssignmentPage!
    myTenantAssignments(first: Int, after: String): TenantAssignmentPage!
  }

  extend type Mutation {
    exitTenantAssignment(id: ID!): TenantAssignment!
  }
`;
