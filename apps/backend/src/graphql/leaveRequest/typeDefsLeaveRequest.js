export const leaveRequestTypeDefs = `
  type LeaveRequest {
    id: ID!
    tenantAssignmentId: ID!
    houseId: ID!
    status: LeaveRequestStatus!
    requestedExitDate: Date!
    reason: String
    respondedAt: DateTime
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  enum LeaveRequestStatus {
    PENDING
    APPROVED
    REJECTED
    WITHDRAWN
  }

  type LeaveRequestPage {
    items: [LeaveRequest!]!
    pageInfo: PageInfo!
  }

  input CreateLeaveRequestInput {
    tenantAssignmentId: ID!
    requestedExitDate: Date!
    reason: String
  }

  extend type Query {
    leaveRequestsByAssignment(
      tenantAssignmentId: ID!
      status: LeaveRequestStatus
      first: Int
      after: String
    ): LeaveRequestPage!
    leaveRequestsByHouse(
      houseId: ID!
      status: LeaveRequestStatus
      first: Int
      after: String
    ): LeaveRequestPage!
  }

  extend type Mutation {
    createLeaveRequest(input: CreateLeaveRequestInput!): LeaveRequest!
    withdrawLeaveRequest(id: ID!): LeaveRequest!
    approveLeaveRequest(id: ID!): LeaveRequest!
    rejectLeaveRequest(id: ID!): LeaveRequest!
    giveNotice(tenantAssignmentId: ID!, plannedExitDate: Date!): TenantAssignment!
    withdrawNotice(tenantAssignmentId: ID!): TenantAssignment!
  }
`;
