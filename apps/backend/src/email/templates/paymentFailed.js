import { link, renderLayout, subjectLine } from "./layout.js";
import { FRONTEND_PATHS, greeting } from "./paths.js";

/** To the PRIMARY when Stripe reports a failed invoice payment. */
export function render({ recipientName, accountName, ownerAccountId }, { frontendUrl, originalRecipient }) {
  return {
    subject: subjectLine(`Payment failed for ${accountName}`),
    ...renderLayout({
      heading: "We could not take your payment",
      paragraphs: [
        greeting(recipientName),
        `The latest payment for ${accountName} failed. Update your payment method to keep full access; Stripe will try again.`,
      ],
      action: {
        label: "Update payment method",
        url: link(frontendUrl, FRONTEND_PATHS.ACCOUNTS, ownerAccountId, FRONTEND_PATHS.BILLING),
      },
      originalRecipient,
    }),
  };
}
