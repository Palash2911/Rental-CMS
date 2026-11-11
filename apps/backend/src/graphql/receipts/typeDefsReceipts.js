export const receiptTypeDefs = `
  type Receipt {
    id: ID!
    tenantAssignmentId: ID!
    amountCents: Int!
    currency: String!
    paidAt: String!
    note: String
    createdAt: String!
  }

  type ReceiptPage {
    items: [Receipt!]!
    pageInfo: PageInfo!
  }

  input CreateReceiptInput {
    tenantAssignmentId: ID!
    amountCents: Int!
    currency: String
    paidAt: String!
    note: String
  }

  extend type Query {
    receiptsByAssignment(tenantAssignmentId: ID!, first: Int, after: String): ReceiptPage!
    receipt(id: ID!): Receipt!
  }

  extend type Mutation {
    createReceipt(input: CreateReceiptInput!): Receipt!
  }
`;
