const APP_NAME = "Rental CMS";
const SUBJECT_MAX_LENGTH = 200;
const HTML_ESCAPES = Object.freeze({
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
});
const HTML_SPECIAL = /[&<>"']/g;
const LINE_BREAKS = /[\r\n]+/g;
const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g;

/** Escapes a value for HTML text and attribute positions. Every user-supplied value goes through it. */
export function escapeHtml(value) {
  return String(value ?? "").replace(HTML_SPECIAL, (character) => HTML_ESCAPES[character]);
}

// Text parts carry no markup, so they need no HTML escaping, but control characters are
// dropped so a stored value cannot forge lines or terminal sequences.
function cleanText(value) {
  return String(value ?? "").replace(CONTROL_CHARACTERS, "");
}

/** One line, no line breaks, at most SUBJECT_MAX_LENGTH characters. */
export function subjectLine(value) {
  return cleanText(value).replace(LINE_BREAKS, " ").trim().slice(0, SUBJECT_MAX_LENGTH);
}

/** A calendar date (YYYY-MM-DD or a Date) as "1 November 2026", in UTC. */
export function formatDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return date.toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
}

/** `frontendUrl` plus `path`, with every dynamic segment URI-encoded. */
export function link(frontendUrl, ...segments) {
  return `${frontendUrl}/${segments.map((segment) => encodeURIComponent(segment)).join("/")}`;
}

function htmlFacts(facts) {
  if (facts.length === 0) {
    return "";
  }

  const rows = facts
    .map(
      ({ label, value }) =>
        `<tr><td style="padding:4px 12px 4px 0;color:#555555;">${escapeHtml(label)}</td><td style="padding:4px 0;">${escapeHtml(value)}</td></tr>`,
    )
    .join("");

  return `<table role="presentation" style="border-collapse:collapse;margin:16px 0;">${rows}</table>`;
}

function htmlRedirectNotice(originalRecipient) {
  if (!originalRecipient) {
    return "";
  }

  return `<p style="padding:8px 12px;background:#fff4ce;border:1px solid #e6c200;">Development redirect: this email was meant for ${escapeHtml(originalRecipient)}.</p>`;
}

function textRedirectNotice(originalRecipient) {
  return originalRecipient
    ? [`[Development redirect: this email was meant for ${cleanText(originalRecipient)}]`, ""]
    : [];
}

/**
 * Renders the shared layout: a heading, paragraphs, optional facts (label and value rows)
 * and one action link. Inline styles only, no images, scripts or tracking.
 * `originalRecipient` adds the development redirect notice. Returns `{ html, text }`.
 */
export function renderLayout({ heading, paragraphs, facts = [], action = null, originalRecipient = null }) {
  const htmlParagraphs = paragraphs.map((paragraph) => `<p>${escapeHtml(paragraph)}</p>`).join("");
  const htmlAction = action
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(action.url)}" style="background:#1f2937;color:#ffffff;padding:10px 16px;border-radius:4px;text-decoration:none;">${escapeHtml(action.label)}</a></p><p style="font-size:13px;color:#555555;">Or open this link: ${escapeHtml(action.url)}</p>`
    : "";

  const html = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(heading)}</title></head>`,
    '<body style="margin:0;padding:24px;font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.5;color:#1f2937;">',
    htmlRedirectNotice(originalRecipient),
    `<h1 style="font-size:20px;">${escapeHtml(heading)}</h1>`,
    htmlParagraphs,
    htmlFacts(facts),
    htmlAction,
    `<p style="font-size:13px;color:#555555;">${escapeHtml(APP_NAME)}</p>`,
    "</body></html>",
  ].join("");

  const text = [
    ...textRedirectNotice(originalRecipient),
    cleanText(heading),
    "",
    ...paragraphs.flatMap((paragraph) => [cleanText(paragraph), ""]),
    ...facts.map(({ label, value }) => `${cleanText(label)}: ${cleanText(value)}`),
    ...(facts.length > 0 ? [""] : []),
    ...(action ? [`${cleanText(action.label)}: ${action.url}`, ""] : []),
    APP_NAME,
  ].join("\n");

  return { html, text };
}
