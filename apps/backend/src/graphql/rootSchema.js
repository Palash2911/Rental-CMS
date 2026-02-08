import { createSchema } from "graphql-yoga";

import { ownerAccountResolvers } from "./ownerAccount/resolversOwnerAccount.js";
import { ownerAccountTypeDefs } from "./ownerAccount/typeDefsOwnerAccount.js";

const baseTypeDefs = `
  type Query
  type Mutation
`;

export const schema = createSchema({
  typeDefs: [baseTypeDefs, ownerAccountTypeDefs],
  resolvers: [ownerAccountResolvers],
});
