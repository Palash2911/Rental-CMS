import {
  ACCOUNT_STATUSES,
  requireAssignmentAccess,
  requireReceiptAccess,
} from "../../lib/auth.js";
import { validate } from "../../lib/validate.js";
import {
  createReceiptSchema,
  receiptIdSchema,
  receiptsByAssignmentSchema,
} from "./schemasReceipts.js";
import * as receiptService from "./serviceReceipts.js";

const READ_ACCESS = Object.freeze({
  owner: { statuses: ACCOUNT_STATUSES.MEMBER_TENANT_READ },
  tenant: { statuses: ACCOUNT_STATUSES.TENANT_READ },
});

const TENANT_WRITE_ACCESS = Object.freeze({
  tenant: { statuses: ACCOUNT_STATUSES.TENANT_WRITE },
});

export const receiptResolvers = {
  Query: {
    // owner OR the tenant who owns the assignment can read
    receiptsByAssignment: async (_parent, args, context) => {
      await requireAssignmentAccess(context, args.tenantAssignmentId, READ_ACCESS);
      const input = validate(receiptsByAssignmentSchema, args);
      return receiptService.listReceiptsByAssignment(context, input);
    },

    receipt: async (_parent, args, context) => {
      const { receipt } = await requireReceiptAccess(context, args.id, READ_ACCESS);
      validate(receiptIdSchema, args);
      return receiptService.toPublicReceipt(receipt);
    },
  },

  Mutation: {
    createReceipt: async (_parent, args, context) => {
      const { user } = await requireAssignmentAccess(
        context,
        args.input.tenantAssignmentId,
        TENANT_WRITE_ACCESS,
      );
      const { input } = validate(createReceiptSchema, args);
      return receiptService.createReceipt(context, { ...input, actorId: user.id });
    },
  },
};
