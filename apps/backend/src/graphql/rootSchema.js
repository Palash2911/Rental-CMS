import { createSchema } from "graphql-yoga";

import { houseResolvers } from "./house/resolversHouse.js";
import { houseTypeDefs } from "./house/typeDefsHouse.js";
import { ownerAccountResolvers } from "./ownerAccount/resolversOwnerAccount.js";
import { ownerAccountTypeDefs } from "./ownerAccount/typeDefsOwnerAccount.js";
import { tenantResolvers } from "./tenant/resolversTenant.js";
import { tenantTypeDefs } from "./tenant/typeDefsTenant.js";
import { tenantAssignmentResolvers } from "./tenantAssignment/resolversTenantAssignment.js";
import { tenantAssignmentTypeDefs } from "./tenantAssignment/typeDefsTenantAssignment.js";

const baseTypeDefs = `
  type Query
  type Mutation
`;

export const schema = createSchema({
  typeDefs: [
    baseTypeDefs,
    ownerAccountTypeDefs,
    houseTypeDefs,
    tenantAssignmentTypeDefs,
    tenantTypeDefs,
  ],
  resolvers: [
    ownerAccountResolvers,
    houseResolvers,
    tenantResolvers,
    tenantAssignmentResolvers,
  ],
});
