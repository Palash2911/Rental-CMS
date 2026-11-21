import { formatDate, link, renderLayout, subjectLine } from "./layout.js";
import { FRONTEND_PATHS, greeting } from "./paths.js";

/** To the tenant when an owner gives notice on their lease. */
export function render(
  { tenantName, houseName, plannedExitDate, tenantAssignmentId },
  { frontendUrl, originalRecipient },
) {
  return {
    subject: subjectLine(`Notice given for your lease at ${houseName}`),
    ...renderLayout({
      heading: "Notice has been given on your lease",
      paragraphs: [
        greeting(tenantName),
        `Your landlord or agent has given notice on your lease at ${houseName}. The lease is now in its notice period.`,
      ],
      facts: [{ label: "Planned exit date", value: formatDate(plannedExitDate) }],
      action: { label: "View your tenancy", url: link(frontendUrl, FRONTEND_PATHS.TENANCIES, tenantAssignmentId) },
      originalRecipient,
    }),
  };
}
