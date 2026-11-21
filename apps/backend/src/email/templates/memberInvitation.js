import { formatDate, link, renderLayout, subjectLine } from "./layout.js";
import { FRONTEND_PATHS } from "./paths.js";

/** To the invitee of a co-owner invitation. */
export function render({ accountName, inviterName, expiresAt }, { frontendUrl, originalRecipient }) {
  const inviter = inviterName ?? "The account owner";

  return {
    subject: subjectLine(`Join ${accountName} as a co-owner`),
    ...renderLayout({
      heading: "You have been invited as a co-owner",
      paragraphs: [
        `${inviter} has invited you to help manage ${accountName}.`,
        "Sign in with this email address to accept or decline the invitation.",
      ],
      facts: [{ label: "Invitation expires", value: formatDate(expiresAt) }],
      action: { label: "View invitation", url: link(frontendUrl, FRONTEND_PATHS.MEMBER_INVITATIONS) },
      originalRecipient,
    }),
  };
}
