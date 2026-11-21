import { formatDate, link, renderLayout, subjectLine } from "./layout.js";
import { FRONTEND_PATHS, greeting } from "./paths.js";

/** To each owner (PRIMARY and CO_OWNER) when a tenant asks to leave. */
export function render(
  { recipientName, tenantName, houseName, houseId, requestedExitDate, reason },
  { frontendUrl, originalRecipient },
) {
  const tenant = tenantName ?? "A tenant";

  return {
    subject: subjectLine(`Leave request for ${houseName}`),
    ...renderLayout({
      heading: "A tenant has asked to leave",
      paragraphs: [
        greeting(recipientName),
        `${tenant} has asked to end their lease at ${houseName}. Approve or reject the request in Rental CMS.`,
      ],
      facts: [
        { label: "Requested exit date", value: formatDate(requestedExitDate) },
        ...(reason ? [{ label: "Reason", value: reason }] : []),
      ],
      action: {
        label: "Review leave request",
        url: link(frontendUrl, FRONTEND_PATHS.HOUSES, houseId, FRONTEND_PATHS.LEAVE_REQUESTS),
      },
      originalRecipient,
    }),
  };
}
