import assert from "node:assert/strict";
import { describe, it } from "node:test";

import * as accountReadOnly from "../../src/email/templates/accountReadOnly.js";
import * as deletionScheduled from "../../src/email/templates/deletionScheduled.js";
import { escapeHtml, subjectLine } from "../../src/email/templates/layout.js";
import * as leaveRequestResponded from "../../src/email/templates/leaveRequestResponded.js";
import * as leaveRequestSubmitted from "../../src/email/templates/leaveRequestSubmitted.js";
import * as memberInvitation from "../../src/email/templates/memberInvitation.js";
import * as noticeGiven from "../../src/email/templates/noticeGiven.js";
import * as noticeWithdrawn from "../../src/email/templates/noticeWithdrawn.js";
import * as paymentFailed from "../../src/email/templates/paymentFailed.js";
import * as tenantInvitation from "../../src/email/templates/tenantInvitation.js";
import * as trialEnding from "../../src/email/templates/trialEnding.js";

const HOSTILE = `<script>alert("x")</script> & 'quoted' <img src=x onerror=y>`;
const OPTIONS = Object.freeze({ frontendUrl: "https://app.example.test", originalRecipient: null });

// Every user-supplied value in every template set to something hostile.
const CASES = Object.freeze([
  [tenantInvitation, { houseName: HOSTILE, accountName: HOSTILE, leaseStartDate: "2027-01-01", leaseEndDate: "2027-12-31", expiresAt: "2026-12-05T00:00:00.000Z" }],
  [memberInvitation, { accountName: HOSTILE, inviterName: HOSTILE, expiresAt: "2026-12-05T00:00:00.000Z" }],
  [leaveRequestSubmitted, { recipientName: HOSTILE, tenantName: HOSTILE, houseName: HOSTILE, houseId: "chouse0001", requestedExitDate: "2027-06-30", reason: HOSTILE }],
  [leaveRequestResponded, { tenantName: HOSTILE, houseName: HOSTILE, status: "APPROVED", requestedExitDate: "2027-06-30", tenantAssignmentId: "cassign001" }],
  [noticeGiven, { tenantName: HOSTILE, houseName: HOSTILE, plannedExitDate: "2027-06-30", tenantAssignmentId: "cassign001" }],
  [noticeWithdrawn, { tenantName: HOSTILE, houseName: HOSTILE, tenantAssignmentId: "cassign001" }],
  [trialEnding, { recipientName: HOSTILE, accountName: HOSTILE, ownerAccountId: "cacct0001", trialEnd: "2026-11-24T00:00:00.000Z" }],
  [paymentFailed, { recipientName: HOSTILE, accountName: HOSTILE, ownerAccountId: "cacct0001" }],
  [accountReadOnly, { recipientName: HOSTILE, accountName: HOSTILE, ownerAccountId: "cacct0001" }],
  [deletionScheduled, { recipientName: HOSTILE, accountName: HOSTILE, ownerAccountId: "cacct0001", deletionScheduledAt: "2026-12-21T00:00:00.000Z", reason: "OWNER_REQUEST" }],
]);

describe("email templates", () => {
  for (const [template, values] of CASES) {
    const name = Object.keys(values).join(",");

    it(`escapes every user-supplied value in HTML (${name})`, () => {
      const { html } = template.render(values, OPTIONS);

      assert.doesNotMatch(html, /<script\b|<img\b|\sonerror="/i);
      assert.ok(html.includes("&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;quoted&#39;"));
    });

    it(`has a single-line subject, a plain-text part, an app link and no external resources (${name})`, () => {
      const { subject, html, text } = template.render(values, OPTIONS);

      assert.ok(subject.length > 0 && subject.length <= 200);
      assert.doesNotMatch(subject, /[\r\n]/);
      assert.ok(text.length > 0);
      assert.doesNotMatch(text, /<p>|<a /);
      assert.ok(text.includes("https://app.example.test/"));
      assert.doesNotMatch(html, /<img\b|<script\b|<link\b|\ssrc="|url\(/i);
      const hosts = [...html.matchAll(/https?:\/\/([^/"'\s<&]+)/g)].map((match) => match[1]);
      assert.deepEqual([...new Set(hosts)], ["app.example.test"]);
    });
  }

  it("shows the original recipient on a development redirect, in both parts", () => {
    const { html, text } = paymentFailed.render(
      { recipientName: "Priya", accountName: "Acme", ownerAccountId: "cacct0001" },
      { frontendUrl: "https://app.example.test", originalRecipient: "priya<b>@example.test" },
    );

    assert.ok(html.includes("this email was meant for priya&lt;b&gt;@example.test"));
    assert.ok(text.startsWith("[Development redirect: this email was meant for priya<b>@example.test]"));
  });

  it("encodes ids in links and formats dates in UTC", () => {
    const { html, text } = noticeGiven.render(
      { tenantName: "Sam", houseName: "Unit 1", plannedExitDate: "2027-06-30", tenantAssignmentId: "a/b?c" },
      OPTIONS,
    );

    assert.ok(text.includes("https://app.example.test/tenancies/a%2Fb%3Fc"));
    assert.ok(html.includes("30 June 2027"));
  });

  it("says approved or rejected and adapts the date label", () => {
    const base = { tenantName: "Sam", houseName: "Unit 1", requestedExitDate: "2027-06-30", tenantAssignmentId: "cassign001" };

    assert.match(leaveRequestResponded.render({ ...base, status: "APPROVED" }, OPTIONS).text, /was approved[\s\S]*Planned exit date: 30 June 2027/);
    assert.match(leaveRequestResponded.render({ ...base, status: "REJECTED" }, OPTIONS).text, /was rejected[\s\S]*Requested exit date: 30 June 2027/);
  });
});

describe("layout helpers", () => {
  it("escapes the five HTML special characters", () => {
    assert.equal(escapeHtml(`&<>"'`), "&amp;&lt;&gt;&quot;&#39;");
    assert.equal(escapeHtml(null), "");
  });

  it("keeps subjects to one line of at most 200 characters", () => {
    assert.equal(subjectLine("a\r\nBcc: x@y.test"), "a Bcc: x@y.test");
    assert.equal(subjectLine("x".repeat(300)).length, 200);
  });
});
