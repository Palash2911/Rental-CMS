export const receiptTypeDefs = `
  type Receipt {
    id: ID!
    tenantAssignmentId: ID!
    amount: Float!
    paidAt: String!
    fileUrl: String!
    createdAt: String!
  }

  extend type Query {
    receiptsByAssignment(tenantAssignmentId: ID!): [Receipt!]!
  }

  extend type Mutation {
    uploadReceipt(
      tenantAssignmentId: ID!
      amount: Float!
      paidAt: String!
      fileUrl: String!
    ): Receipt!
  }
`;
