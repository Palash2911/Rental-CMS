import { formatDate, link, renderLayout, subjectLine } from "./layout.js";
import { FRONTEND_PATHS } from "./paths.js";

/** To the invitee of a tenant invitation. */
export function render({ houseName, accountName, leaseStartDate, leaseEndDate, expiresAt }, { frontendUrl, originalRecipient }) {
  const facts = [
    { label: "Property", value: houseName },
    { label: "Lease starts", value: formatDate(leaseStartDate) },
    ...(leaseEndDate ? [{ label: "Lease ends", value: formatDate(leaseEndDate) }] : []),
    { label: "Invitation expires", value: formatDate(expiresAt) },
  ];

  return {
    subject: subjectLine(`${accountName} invited you to rent ${houseName}`),
    ...renderLayout({
      heading: "You have been invited to a tenancy",
      paragraphs: [
        `${accountName} has invited you to join ${houseName} as a tenant.`,
        "Sign in with this email address to accept or decline the invitation.",
      ],
      facts,
      action: { label: "View invitation", url: link(frontendUrl, FRONTEND_PATHS.INVITATIONS) },
      originalRecipient,
    }),
  };
}
