export const issueTypeDefs = `
  type Issue {
    id: ID!
    tenantAssignmentId: ID!
    houseId: ID!
    title: String!
    description: String!
    status: IssueStatus!
    createdAt: String!
    updatedAt: String!
  }

  enum IssueStatus {
    OPEN
    IN_PROGRESS
    RESOLVED
    CLOSED
  }

  type IssuePage {
    items: [Issue!]!
    pageInfo: PageInfo!
  }

  input CreateIssueInput {
    tenantAssignmentId: ID!
    title: String!
    description: String!
  }

  input UpdateIssueStatusInput {
    id: ID!
    status: IssueStatus!
  }

  extend type Query {
    issue(id: ID!): Issue!
    issuesByAssignment(
      tenantAssignmentId: ID!
      status: IssueStatus
      first: Int
      after: String
    ): IssuePage!
    issuesByHouse(
      houseId: ID!
      status: IssueStatus
      first: Int
      after: String
    ): IssuePage!
  }

  extend type Mutation {
    createIssue(input: CreateIssueInput!): Issue!
    updateIssueStatus(input: UpdateIssueStatusInput!): Issue!
  }
`;
