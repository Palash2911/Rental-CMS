import { link, renderLayout, subjectLine } from "./layout.js";
import { FRONTEND_PATHS, greeting } from "./paths.js";

/** To the PRIMARY when billing makes an APPROVED account read-only. */
export function render({ recipientName, accountName, ownerAccountId }, { frontendUrl, originalRecipient }) {
  return {
    subject: subjectLine(`${accountName} is now read-only`),
    ...renderLayout({
      heading: "Your account is read-only",
      paragraphs: [
        greeting(recipientName),
        `${accountName} has no active subscription, so it is read-only: you and your tenants can still view everything, but nothing can be changed.`,
        "Subscribe to restore full access. Accounts that stay read-only for 30 days are scheduled for deletion.",
      ],
      action: {
        label: "Choose a plan",
        url: link(frontendUrl, FRONTEND_PATHS.ACCOUNTS, ownerAccountId, FRONTEND_PATHS.BILLING),
      },
      originalRecipient,
    }),
  };
}
