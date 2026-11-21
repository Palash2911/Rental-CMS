import { formatDate, link, renderLayout, subjectLine } from "./layout.js";
import { FRONTEND_PATHS, greeting } from "./paths.js";

/** To the PRIMARY three days before a trial ends (Stripe's trial_will_end). */
export function render({ recipientName, accountName, ownerAccountId, trialEnd }, { frontendUrl, originalRecipient }) {
  return {
    subject: subjectLine(`Your ${accountName} trial ends soon`),
    ...renderLayout({
      heading: "Your free trial is ending",
      paragraphs: [
        greeting(recipientName),
        `The free trial for ${accountName} ends on ${formatDate(trialEnd)}. Your plan continues automatically if a payment method is on file; otherwise the account becomes read-only.`,
      ],
      action: {
        label: "Review billing",
        url: link(frontendUrl, FRONTEND_PATHS.ACCOUNTS, ownerAccountId, FRONTEND_PATHS.BILLING),
      },
      originalRecipient,
    }),
  };
}
