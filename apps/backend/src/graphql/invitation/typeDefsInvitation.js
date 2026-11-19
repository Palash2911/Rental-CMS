export const invitationTypeDefs = `
  type Invitation {
    id: ID!
    houseId: ID!
    houseName: String!
    ownerAccountName: String!
    email: String!
    status: InvitationStatus!
    expired: Boolean!
    leaseStartDate: Date!
    leaseEndDate: Date
    expiresAt: DateTime!
    respondedAt: DateTime
    acceptedAssignmentId: ID
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  enum InvitationStatus {
    PENDING
    ACCEPTED
    DECLINED
    REVOKED
  }

  type InvitationPage {
    items: [Invitation!]!
    pageInfo: PageInfo!
  }

  input CreateInvitationInput {
    houseId: ID!
    email: String!
    leaseStartDate: Date!
    leaseEndDate: Date
  }

  extend type Query {
    invitationsByHouse(
      houseId: ID!
      status: InvitationStatus
      first: Int
      after: String
    ): InvitationPage!
    myInvitations(first: Int, after: String): InvitationPage!
  }

  extend type Mutation {
    createInvitation(input: CreateInvitationInput!): Invitation!
    revokeInvitation(id: ID!): Invitation!
    acceptInvitation(id: ID!): TenantAssignment!
    declineInvitation(id: ID!): Invitation!
  }
`;
