import { formatDate, link, renderLayout, subjectLine } from "./layout.js";
import { FRONTEND_PATHS, greeting } from "./paths.js";

const APPROVED = "APPROVED";

/** To the tenant when an owner approves or rejects their leave request. */
export function render(
  { tenantName, houseName, status, requestedExitDate, tenantAssignmentId },
  { frontendUrl, originalRecipient },
) {
  const approved = status === APPROVED;
  const outcome = approved ? "approved" : "rejected";
  const next = approved
    ? "Your lease is now in its notice period, ending on the date below."
    : "Your lease continues as before. Contact your landlord or agent if you have questions.";

  return {
    subject: subjectLine(`Your leave request for ${houseName} was ${outcome}`),
    ...renderLayout({
      heading: `Leave request ${outcome}`,
      paragraphs: [greeting(tenantName), `Your request to leave ${houseName} was ${outcome}.`, next],
      facts: [{ label: approved ? "Planned exit date" : "Requested exit date", value: formatDate(requestedExitDate) }],
      action: { label: "View your tenancy", url: link(frontendUrl, FRONTEND_PATHS.TENANCIES, tenantAssignmentId) },
      originalRecipient,
    }),
  };
}
