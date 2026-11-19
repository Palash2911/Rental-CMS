export const memberTypeDefs = `
  enum OwnerMemberRole {
    PRIMARY
    CO_OWNER
  }

  type OwnerAccountMember {
    id: ID!
    userId: ID!
    name: String
    email: String!
    role: OwnerMemberRole!
    joinedAt: DateTime!
  }

  type OwnerAccountMemberPage {
    items: [OwnerAccountMember!]!
    pageInfo: PageInfo!
  }

  type MemberInvitation {
    id: ID!
    ownerAccountId: ID!
    ownerAccountName: String!
    email: String!
    status: InvitationStatus!
    expired: Boolean!
    expiresAt: DateTime!
    respondedAt: DateTime
    createdAt: DateTime!
    updatedAt: DateTime!
  }

  type MemberInvitationPage {
    items: [MemberInvitation!]!
    pageInfo: PageInfo!
  }

  type OwnershipTransfer {
    previousPrimary: OwnerAccountMember!
    newPrimary: OwnerAccountMember!
  }

  extend type Query {
    membersByAccount(ownerAccountId: ID!, first: Int, after: String): OwnerAccountMemberPage!
    memberInvitationsByAccount(
      ownerAccountId: ID!
      status: InvitationStatus
      first: Int
      after: String
    ): MemberInvitationPage!
    myMemberInvitations(first: Int, after: String): MemberInvitationPage!
  }

  extend type Mutation {
    createMemberInvitation(ownerAccountId: ID!, email: String!): MemberInvitation!
    revokeMemberInvitation(id: ID!): MemberInvitation!
    acceptMemberInvitation(id: ID!): OwnerAccountMember!
    declineMemberInvitation(id: ID!): MemberInvitation!
    removeMember(ownerAccountId: ID!, userId: ID!): OwnerAccountMember!
    leaveAccount(ownerAccountId: ID!): OwnerAccountMember!
    transferOwnership(ownerAccountId: ID!, newPrimaryUserId: ID!): OwnershipTransfer!
  }
`;
