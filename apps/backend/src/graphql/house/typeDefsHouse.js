export const houseTypeDefs = `
  type House {
    id: ID!
    name: String!
    location: String!
    maxTenants: Int!
    status: HouseStatus!
    ownerAccountId: ID!
    createdAt: String!
    updatedAt: String!
  }

  enum HouseStatus {
    VACANT
    OCCUPIED
    INACTIVE
  }

  type HousePage {
    items: [House!]!
    pageInfo: PageInfo!
  }

  input CreateHouseInput {
    ownerAccountId: ID!
    name: String!
    location: String!
    maxTenants: Int!
  }

  input UpdateHouseInput {
    id: ID!
    name: String
    location: String
    maxTenants: Int
    inactive: Boolean
  }

  extend type Query {
    houses(ownerAccountId: ID!, first: Int, after: String): HousePage!
    house(id: ID!): House!
  }

  extend type Mutation {
    createHouse(input: CreateHouseInput!): House!
    updateHouse(input: UpdateHouseInput!): House!
  }
`;
