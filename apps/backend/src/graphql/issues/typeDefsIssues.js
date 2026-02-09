export const issueTypeDefs = `
  type Issue {
    id: ID!
    tenantAssignmentId: ID!
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
  }

  extend type Query {
    issuesByAssignment(tenantAssignmentId: ID!): [Issue!]!
  }

  extend type Mutation {
    createIssue(
      tenantAssignmentId: ID!
      title: String!
      description: String!
    ): Issue!

    updateIssueStatus(
      id: ID!
      status: IssueStatus!
    ): Issue!
  }
`;
