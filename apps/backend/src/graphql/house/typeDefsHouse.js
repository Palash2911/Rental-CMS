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

  extend type Query {
    houses(ownerAccountId: ID!): [House!]!
    house(id: ID!): House
  }

  extend type Mutation {
    createHouse(
      ownerAccountId: ID!
      name: String!
      location: String!
      maxTenants: Int!
    ): House!

    updateHouse(
      id: ID!
      name: String
      location: String
      maxTenants: Int
      status: HouseStatus
    ): House!
  }
`;
