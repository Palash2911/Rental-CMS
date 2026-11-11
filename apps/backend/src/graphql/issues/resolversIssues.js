import {
  ACCESS_TYPES,
  ACCOUNT_STATUSES,
  requireAssignmentAccess,
  requireHouseAccess,
  requireIssueAccess,
} from "../../lib/auth.js";
import { validate } from "../../lib/validate.js";
import {
  createIssueSchema,
  issueIdSchema,
  issuesByAssignmentSchema,
  issuesByHouseSchema,
  updateIssueStatusSchema,
} from "./schemasIssues.js";
import * as issueService from "./serviceIssues.js";

const READ_ACCESS = Object.freeze({
  owner: { statuses: ACCOUNT_STATUSES.MEMBER_TENANT_READ },
  tenant: { statuses: ACCOUNT_STATUSES.TENANT_READ },
});

const TENANT_WRITE_ACCESS = Object.freeze({
  tenant: { statuses: ACCOUNT_STATUSES.TENANT_WRITE },
});

const STATUS_WRITE_ACCESS = Object.freeze({
  owner: { statuses: ACCOUNT_STATUSES.MEMBER_TENANT_WRITE },
  tenant: { statuses: ACCOUNT_STATUSES.TENANT_WRITE },
});

function actorRoles({ accessAs, tenantAccess }) {
  const roles = [];

  if (accessAs === ACCESS_TYPES.OWNER) {
    roles.push(issueService.ISSUE_ACTOR_ROLES.OWNER);
  }

  if (tenantAccess) {
    roles.push(issueService.ISSUE_ACTOR_ROLES.TENANT);
  }

  return roles;
}

export const issueResolvers = {
  Query: {
    issue: async (_parent, args, context) => {
      const { issue } = await requireIssueAccess(context, args.id, READ_ACCESS);
      validate(issueIdSchema, args);
      return issueService.toPublicIssue(issue);
    },

    issuesByAssignment: async (_parent, args, context) => {
      await requireAssignmentAccess(context, args.tenantAssignmentId, READ_ACCESS);
      const input = validate(issuesByAssignmentSchema, args);
      return issueService.listIssuesByAssignment(context, input);
    },

    // owners only
    issuesByHouse: async (_parent, args, context) => {
      await requireHouseAccess(context, args.houseId, {
        statuses: ACCOUNT_STATUSES.MEMBER_TENANT_READ,
      });
      const input = validate(issuesByHouseSchema, args);
      return issueService.listIssuesByHouse(context, input);
    },
  },

  Mutation: {
    createIssue: async (_parent, args, context) => {
      const { user, assignment } = await requireAssignmentAccess(
        context,
        args.input.tenantAssignmentId,
        TENANT_WRITE_ACCESS,
      );
      const { input } = validate(createIssueSchema, args);
      return issueService.createIssue(context, {
        ...input,
        houseId: assignment.houseId,
        actorId: user.id,
      });
    },

    updateIssueStatus: async (_parent, args, context) => {
      const access = await requireIssueAccess(
        context,
        args.input.id,
        STATUS_WRITE_ACCESS,
      );
      const { input } = validate(updateIssueStatusSchema, args);
      return issueService.updateIssueStatus(context, {
        ...input,
        actorId: access.user.id,
        actorRoles: actorRoles(access),
        tenantAssignmentId: access.issue.tenantAssignmentId,
      });
    },
  },
};
