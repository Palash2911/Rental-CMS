import { link, renderLayout, subjectLine } from "./layout.js";
import { FRONTEND_PATHS, greeting } from "./paths.js";

/** To the tenant when an owner withdraws the notice on their lease. */
export function render({ tenantName, houseName, tenantAssignmentId }, { frontendUrl, originalRecipient }) {
  return {
    subject: subjectLine(`Notice withdrawn for your lease at ${houseName}`),
    ...renderLayout({
      heading: "The notice on your lease was withdrawn",
      paragraphs: [
        greeting(tenantName),
        `Your landlord or agent has withdrawn the notice on your lease at ${houseName}. The lease is active again with no planned exit date.`,
      ],
      action: { label: "View your tenancy", url: link(frontendUrl, FRONTEND_PATHS.TENANCIES, tenantAssignmentId) },
      originalRecipient,
    }),
  };
}
