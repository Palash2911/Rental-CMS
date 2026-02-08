import { createSchema } from "graphql-yoga";

import { houseResolvers } from "./house/resolversHouse.js";
import { houseTypeDefs } from "./house/typeDefsHouse.js";
import { ownerAccountResolvers } from "./ownerAccount/resolversOwnerAccount.js";
import { ownerAccountTypeDefs } from "./ownerAccount/typeDefsOwnerAccount.js";

const baseTypeDefs = `
  type Query
  type Mutation
`;

export const schema = createSchema({
  typeDefs: [baseTypeDefs, ownerAccountTypeDefs, houseTypeDefs],
  resolvers: [ownerAccountResolvers, houseResolvers],
});
