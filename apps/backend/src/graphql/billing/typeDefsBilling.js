export const billingTypeDefs = `
  "The account's effective plan. ENTERPRISE is set by a super admin and has no Stripe price."
  enum BillingPlan {
    STARTER
    GROWTH
    PRO
    ENTERPRISE
  }

  "Plans that can be bought through Stripe Checkout."
  enum CheckoutPlan {
    STARTER
    GROWTH
    PRO
  }

  enum BillingInterval {
    MONTH
    YEAR
  }

  "FULL: every write allowed. SETUP: PENDING account before payment. READ_ONLY: only billing and account deletion."
  enum BillingAccess {
    FULL
    SETUP
    READ_ONLY
  }

  type OwnerAccountBilling {
    plan: BillingPlan
    interval: BillingInterval
    "Stripe's subscription status (trialing, active, past_due, canceled, unpaid, ...), or null."
    status: String
    trialEnd: DateTime
    currentPeriodEnd: DateTime
    cancelAtPeriodEnd: Boolean!
    access: BillingAccess!
    readOnly: Boolean!
    readOnlySince: DateTime
    "ACTIVE and NOTICE_PERIOD tenant assignments across the account."
    activeTenants: Int!
    "Null when the plan has no tenant limit (ENTERPRISE)."
    tenantLimit: Int
    enterprise: Boolean!
    trialAvailable: Boolean!
  }

  extend type OwnerAccount {
    billing: OwnerAccountBilling!
  }

  type BillingRedirect {
    url: String!
  }

  extend type Mutation {
    startCheckout(
      ownerAccountId: ID!
      plan: CheckoutPlan!
      interval: BillingInterval!
    ): BillingRedirect!
    openBillingPortal(ownerAccountId: ID!): BillingRedirect!
    setEnterprisePlan(ownerAccountId: ID!): OwnerAccount!
    clearEnterprisePlan(ownerAccountId: ID!): OwnerAccount!
  }
`;
