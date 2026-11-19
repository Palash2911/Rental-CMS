import {
  ACCOUNT_STATUSES,
  requireOwnerMember,
  requireSuperAdmin,
  ROLES,
} from "../../lib/auth.js";
import { batchLoaderFor } from "../../lib/batchLoader.js";
import { validate } from "../../lib/validate.js";
import { billingAccountIdSchema, startCheckoutSchema } from "./schemasBilling.js";
import * as billingService from "./serviceBilling.js";

// Only the PRIMARY member manages billing. It stays available while the account is
// read-only, since paying is how a read-only account gets its access back.
const BILLING_ACCESS = Object.freeze({
  roles: ROLES.PRIMARY_ONLY,
  statuses: ACCOUNT_STATUSES.MEMBER_BILLING,
  allowReadOnly: true,
});

const BILLING_LOADER = "ownerAccountBilling";

export const billingResolvers = {
  OwnerAccount: {
    billing: (account, _args, context) =>
      batchLoaderFor(context, BILLING_LOADER, (ids) =>
        billingService.loadBillingByAccount(context.prisma, ids),
      ).load(account.id),
  },

  Mutation: {
    startCheckout: async (_parent, args, context) => {
      const { user, ownerAccount } = await requireOwnerMember(
        context,
        args.ownerAccountId,
        BILLING_ACCESS,
      );
      const input = validate(startCheckoutSchema, args);
      return billingService.startCheckout(context, {
        ...input,
        actorId: user.id,
        actorEmail: user.email,
        accountName: ownerAccount.name,
      });
    },

    openBillingPortal: async (_parent, args, context) => {
      await requireOwnerMember(context, args.ownerAccountId, BILLING_ACCESS);
      const input = validate(billingAccountIdSchema, args);
      return billingService.openBillingPortal(context, input);
    },

    setEnterprisePlan: async (_parent, args, context) => {
      const user = await requireSuperAdmin(context);
      const input = validate(billingAccountIdSchema, args);
      return billingService.setEnterprise(context, {
        ...input,
        actorId: user.id,
        enterprise: true,
      });
    },

    clearEnterprisePlan: async (_parent, args, context) => {
      const user = await requireSuperAdmin(context);
      const input = validate(billingAccountIdSchema, args);
      return billingService.setEnterprise(context, {
        ...input,
        actorId: user.id,
        enterprise: false,
      });
    },
  },
};
