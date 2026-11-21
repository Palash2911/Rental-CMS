export const receiptTypeDefs = `
  type Receipt {
    id: ID!
    tenantAssignmentId: ID!
    amountCents: Int!
    currency: String!
    paidAt: Date!
    note: String
    hasFile: Boolean!
    createdAt: DateTime!
  }

  type ReceiptPage {
    items: [Receipt!]!
    pageInfo: PageInfo!
  }

  type ReceiptUploadTicket {
    uploadUrl: String!
    fileKey: String!
    contentType: String!
    sizeBytes: Int!
    expiresAt: DateTime!
  }

  type ReceiptFileUrl {
    url: String!
    expiresAt: DateTime!
  }

  input CreateReceiptInput {
    tenantAssignmentId: ID!
    amountCents: Int!
    currency: String
    paidAt: Date!
    note: String
    fileKey: String
  }

  input RequestReceiptUploadInput {
    tenantAssignmentId: ID!
    contentType: String!
    sizeBytes: Int!
  }

  extend type Query {
    receiptsByAssignment(tenantAssignmentId: ID!, first: Int, after: String): ReceiptPage!
    receipt(id: ID!): Receipt!
    receiptFileUrl(receiptId: ID!): ReceiptFileUrl
  }

  extend type Mutation {
    createReceipt(input: CreateReceiptInput!): Receipt!
    requestReceiptUpload(input: RequestReceiptUploadInput!): ReceiptUploadTicket!
  }
`;
