export const tenancyExportTypeDefs = `
  type TenancyExportAssignment {
    id: ID!
    houseId: ID!
    houseName: String!
    status: TenantAssignmentStatus!
    leaseStartDate: Date!
    leaseEndDate: Date
    plannedExitDate: Date
    actualExitDate: DateTime
  }

  type TenancyExport {
    assignment: TenancyExportAssignment!
    receipts: [Receipt!]!
    issues: [Issue!]!
    leaveRequests: [LeaveRequest!]!
    generatedAt: DateTime!
  }

  extend type Query {
    tenancyExport(tenantAssignmentId: ID!): TenancyExport!
  }
`;
