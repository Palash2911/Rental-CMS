import { formatDate, link, renderLayout, subjectLine } from "./layout.js";
import { FRONTEND_PATHS, greeting } from "./paths.js";

const REASONS = Object.freeze({
  OWNER_REQUEST: "You asked for the account to be deleted.",
  ADMIN_REQUEST: "A Rental CMS administrator scheduled the deletion.",
  BILLING_GRACE: "The account has been read-only for more than 30 days without a subscription.",
});

/** To the PRIMARY when an account is scheduled for deletion, for any of the three reasons. */
export function render(
  { recipientName, accountName, ownerAccountId, deletionScheduledAt, reason },
  { frontendUrl, originalRecipient },
) {
  const cancel =
    reason === "ADMIN_REQUEST"
      ? "Contact support if you think this is a mistake."
      : "You can cancel the deletion from the account settings until then.";

  return {
    subject: subjectLine(`${accountName} is scheduled for deletion`),
    ...renderLayout({
      heading: "Your account is scheduled for deletion",
      paragraphs: [
        greeting(recipientName),
        `${accountName} and all its data will be deleted on ${formatDate(deletionScheduledAt)}.`,
        REASONS[reason] ?? "",
        cancel,
      ].filter(Boolean),
      action: { label: "Open account", url: link(frontendUrl, FRONTEND_PATHS.ACCOUNTS, ownerAccountId) },
      originalRecipient,
    }),
  };
}
