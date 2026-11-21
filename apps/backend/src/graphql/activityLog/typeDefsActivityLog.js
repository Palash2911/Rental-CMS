export const activityLogTypeDefs = `
  type ActivityLogEntry {
    id: ID!
    action: String!
    entityType: String!
    entityId: ID!
    actorName: String
    createdAt: DateTime!
  }

  type ActivityLogPage {
    items: [ActivityLogEntry!]!
    pageInfo: PageInfo!
  }

  type AdminActivityLogEntry {
    id: ID!
    ownerAccountId: ID
    action: String!
    entityType: String!
    entityId: ID!
    performedByUserId: ID
    actorName: String
    metadata: JSON
    createdAt: DateTime!
  }

  type AdminActivityLogPage {
    items: [AdminActivityLogEntry!]!
    pageInfo: PageInfo!
  }

  input AdminActivityLogFilter {
    ownerAccountId: ID
    entityType: String
    entityId: ID
    performedByUserId: ID
  }

  extend type Query {
    activityLogByAccount(
      ownerAccountId: ID!
      entityType: String
      first: Int
      after: String
    ): ActivityLogPage!
    adminActivityLog(filter: AdminActivityLogFilter, first: Int, after: String): AdminActivityLogPage!
  }
`;
