import { createSchema } from "graphql-yoga";

import { scalarResolvers, scalarTypeDefs } from "../lib/scalars.js";
import { billingResolvers } from "./billing/resolversBilling.js";
import { billingTypeDefs } from "./billing/typeDefsBilling.js";
import { houseResolvers } from "./house/resolversHouse.js";
import { houseTypeDefs } from "./house/typeDefsHouse.js";
import { invitationResolvers } from "./invitation/resolversInvitation.js";
import { invitationTypeDefs } from "./invitation/typeDefsInvitation.js";
import { issueResolvers } from "./issues/resolversIssues.js";
import { issueTypeDefs } from "./issues/typeDefsIssues.js";
import { leaveRequestResolvers } from "./leaveRequest/resolversLeaveRequest.js";
import { leaveRequestTypeDefs } from "./leaveRequest/typeDefsLeaveRequest.js";
import { memberResolvers } from "./member/resolversMember.js";
import { memberTypeDefs } from "./member/typeDefsMember.js";
import { ownerAccountResolvers } from "./ownerAccount/resolversOwnerAccount.js";
import { ownerAccountTypeDefs } from "./ownerAccount/typeDefsOwnerAccount.js";
import { receiptResolvers } from "./receipts/resolversReceipts.js";
import { receiptTypeDefs } from "./receipts/typeDefsReceipts.js";
import { tenantResolvers } from "./tenant/resolversTenant.js";
import { tenantTypeDefs } from "./tenant/typeDefsTenant.js";
import { tenantAssignmentResolvers } from "./tenantAssignment/resolversTenantAssignment.js";
import { tenantAssignmentTypeDefs } from "./tenantAssignment/typeDefsTenantAssignment.js";
import { userResolvers } from "./user/resolversUser.js";
import { userTypeDefs } from "./user/typeDefsUser.js";

const baseTypeDefs = `
  type Query
  type Mutation

  type PageInfo {
    nextCursor: String
    hasNextPage: Boolean!
  }
`;

export const schema = createSchema({
  typeDefs: [
    baseTypeDefs,
    scalarTypeDefs,
    userTypeDefs,
    ownerAccountTypeDefs,
    houseTypeDefs,
    tenantAssignmentTypeDefs,
    tenantTypeDefs,
    invitationTypeDefs,
    receiptTypeDefs,
    issueTypeDefs,
    billingTypeDefs,
    memberTypeDefs,
    leaveRequestTypeDefs,
  ],
  resolvers: [
    scalarResolvers,
    userResolvers,
    ownerAccountResolvers,
    houseResolvers,
    tenantResolvers,
    tenantAssignmentResolvers,
    invitationResolvers,
    receiptResolvers,
    issueResolvers,
    billingResolvers,
    memberResolvers,
    leaveRequestResolvers,
  ],
});
