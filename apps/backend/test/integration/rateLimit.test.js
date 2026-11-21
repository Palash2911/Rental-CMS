import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";

import { parse } from "graphql";

import { MAX_ROOT_FIELDS } from "../../src/lib/queryLimits.js";
import {
  enforceRateLimit,
  mutationRootFields,
  RATE_LIMIT_WINDOW_MS,
  RATE_LIMITS,
} from "../../src/lib/rateLimit.js";
import { resetDatabase } from "../support/db.js";
import { firebaseUid, recordingLogger } from "../support/factories.js";
import { postGraphql, startTestServer, tokenFor } from "../support/http.js";
import { redis, unreachableRedis } from "../support/redis.js";

const PING = "query { __typename }";
const LEAVE =
  "mutation ($id: ID!) { leaveAccount(ownerAccountId: $id) { id } }";
const CHECKOUT =
  "mutation ($id: ID!) { startCheckout(ownerAccountId: $id, plan: STARTER, interval: MONTH) { url } }";
const INVITE_MEMBER = `mutation ($id: ID!) { createMemberInvitation(ownerAccountId: $id, email: "a@example.test") { id } }`;
const LEAVE_REQUEST = `mutation ($id: ID!) { createLeaveRequest(input: { tenantAssignmentId: $id, requestedExitDate: "2099-01-01" }) { id } }`;
const EXPORT =
  "query ($id: ID!) { tenancyExport(tenantAssignmentId: $id) { generatedAt } }";
const MISSING_ACCOUNT = { id: "cjld2cjxh0000qzrmn831i7rn" };

const TOO_MANY_REQUESTS = "TOO_MANY_REQUESTS";
const HTTP_TOO_MANY_REQUESTS = 429;
const HTTP_OK = 200;
const HTTP_UNAUTHORIZED = 401;
const WINDOW_SECONDS = RATE_LIMIT_WINDOW_MS / 1000;

async function repeat(count, operation) {
  const results = [];

  for (let index = 0; index < count; index += 1) {
    results.push(await operation(index));
  }

  return results;
}

function assertAllOk(results, label) {
  for (const [index, result] of results.entries()) {
    assert.equal(
      result.status,
      HTTP_OK,
      `${label}: request ${index + 1} got ${result.status}`,
    );
  }
}

function assertTooManyRequests(result) {
  assert.equal(result.status, HTTP_TOO_MANY_REQUESTS);
  const [error] = result.body.errors;
  assert.equal(error.extensions.code, TOO_MANY_REQUESTS);

  const seconds = error.extensions.retryAfterSeconds;
  assert.ok(
    Number.isInteger(seconds) && seconds >= 1 && seconds <= WINDOW_SECONDS,
    `retryAfterSeconds ${seconds}`,
  );
  assert.equal(result.headers.get("retry-after"), String(seconds));
  assert.equal(
    error.message,
    `Too many requests. Try again in ${seconds} seconds.`,
  );
  assert.equal(error.extensions.http, undefined);
  return error;
}

function aliased(field, count, args) {
  return `mutation { ${Array.from({ length: count }, (_, index) => `m${index}: ${field}(${args}) { __typename }`).join(" ")} }`;
}

beforeEach(resetDatabase);

describe("anonymous limit (60 per minute per IP)", () => {
  it("allows 60 requests and answers the 61st with HTTP 429, TOO_MANY_REQUESTS and Retry-After", async () => {
    const { url } = await startTestServer();

    assertAllOk(
      await repeat(RATE_LIMITS.ANONYMOUS.limit, () => postGraphql(url, PING)),
      "anonymous",
    );
    assertTooManyRequests(await postGraphql(url, PING));
  });

  it("counts requests with a bad header or token against the IP too", async () => {
    const { url } = await startTestServer();

    const rejected = await repeat(RATE_LIMITS.ANONYMOUS.limit, (index) =>
      postGraphql(url, PING, {
        headers: {
          authorization: index % 2 ? "Basic abc" : "Bearer not-a-token",
        },
      }),
    );

    for (const result of rejected) {
      assert.equal(result.status, HTTP_UNAUTHORIZED);
    }

    assertTooManyRequests(
      await postGraphql(url, PING, { token: "not-a-token" }),
    );
    assertTooManyRequests(await postGraphql(url, PING));
  });

  it("starts a 60-second window on the first hit", async () => {
    const { url } = await startTestServer();
    await postGraphql(url, PING);

    const [key] = await redis.keys("ratelimit:ip:*");
    const remaining = await redis.pttl(key);

    assert.ok(
      remaining > 0 && remaining <= RATE_LIMIT_WINDOW_MS,
      `pttl ${remaining}`,
    );
  });
});

describe("signed-in limit (300 per minute per user)", () => {
  it("allows 300 requests per user and limits each user separately from the others and the IP", async () => {
    const { url } = await startTestServer();
    const [first, second] = [firebaseUid(), firebaseUid()];

    assertAllOk(
      await repeat(RATE_LIMITS.USER.limit, () =>
        postGraphql(url, PING, { token: tokenFor(first) }),
      ),
      "user",
    );
    assertTooManyRequests(
      await postGraphql(url, PING, { token: tokenFor(first) }),
    );

    assert.equal(
      (await postGraphql(url, PING, { token: tokenFor(second) })).status,
      HTTP_OK,
    );
    assert.equal((await postGraphql(url, PING)).status, HTTP_OK);
  });
});

describe("mutation limit (60 per minute per user)", () => {
  it("allows 60 mutations, refuses the 61st before it runs, and leaves queries open", async () => {
    const { url } = await startTestServer();
    const token = tokenFor(firebaseUid());

    const allowed = await repeat(RATE_LIMITS.MUTATION.limit, () =>
      postGraphql(url, LEAVE, { token, variables: MISSING_ACCOUNT }),
    );
    assertAllOk(allowed, "mutation");
    assert.equal(allowed[0].body.errors[0].extensions.code, "NOT_FOUND");

    const refused = await postGraphql(url, LEAVE, {
      token,
      variables: MISSING_ACCOUNT,
    });
    assertTooManyRequests(refused);
    assert.equal(refused.body.errors.length, 1);
    assert.equal(refused.body.data, undefined);

    assert.equal((await postGraphql(url, PING, { token })).status, HTTP_OK);
  });

  it("counts every root field, so aliases and fragments cannot run more mutations", async () => {
    const { url } = await startTestServer();
    const token = tokenFor(firebaseUid());
    const args = `ownerAccountId: "${MISSING_ACCOUNT.id}"`;

    // One operation may select at most MAX_ROOT_FIELDS fields (queryLimits.js), so the limit
    // is reached with several full operations; each still counts every aliased field.
    const perRequest = MAX_ROOT_FIELDS;
    const fullRequests = RATE_LIMITS.MUTATION.limit / perRequest;

    assertAllOk(
      await repeat(fullRequests, () =>
        postGraphql(url, aliased("leaveAccount", perRequest, args), { token }),
      ),
      "aliased mutations",
    );
    assertTooManyRequests(
      await postGraphql(url, aliased("leaveAccount", 1, args), { token }),
    );

    const fragment = `mutation { ...Leave } fragment Leave on Mutation { a: leaveAccount(${args}) { id } b: leaveAccount(${args}) { id } }`;
    assert.deepEqual(mutationRootFields(parse(fragment)), [
      "leaveAccount",
      "leaveAccount",
    ]);
  });

  it("does not count anonymous mutations per user; the IP limit covers them", async () => {
    const { url } = await startTestServer();

    const results = await repeat(RATE_LIMITS.ANONYMOUS.limit, () =>
      postGraphql(url, LEAVE, { variables: MISSING_ACCOUNT }),
    );

    assertAllOk(results, "anonymous mutation");
    assert.equal(results[0].body.errors[0].extensions.code, "UNAUTHENTICATED");
    assert.deepEqual(await redis.keys("ratelimit:mutation:*"), []);
  });
});

describe("sensitive mutation limit (10 per minute per user)", () => {
  it("shares one bucket across createInvitation, createMemberInvitation, startCheckout and openBillingPortal", async () => {
    const { url } = await startTestServer();
    const token = tokenFor(firebaseUid());

    assertAllOk(
      await repeat(RATE_LIMITS.SENSITIVE.limit, () =>
        postGraphql(url, CHECKOUT, { token, variables: MISSING_ACCOUNT }),
      ),
      "sensitive",
    );
    assertTooManyRequests(
      await postGraphql(url, CHECKOUT, { token, variables: MISSING_ACCOUNT }),
    );
    assertTooManyRequests(
      await postGraphql(url, INVITE_MEMBER, {
        token,
        variables: MISSING_ACCOUNT,
      }),
    );
    assertTooManyRequests(
      await postGraphql(url, LEAVE_REQUEST, {
        token,
        variables: MISSING_ACCOUNT,
      }),
    );

    assert.equal(
      (await postGraphql(url, LEAVE, { token, variables: MISSING_ACCOUNT }))
        .status,
      HTTP_OK,
    );
  });

  it("counts tenancyExport queries in the same bucket, but not against the mutation limit", async () => {
    const { url } = await startTestServer();
    const token = tokenFor(firebaseUid());

    const allowed = await repeat(RATE_LIMITS.SENSITIVE.limit, () =>
      postGraphql(url, EXPORT, { token, variables: MISSING_ACCOUNT }),
    );
    assertAllOk(allowed, "export");
    assert.equal(allowed[0].body.errors[0].extensions.code, "NOT_FOUND");
    assert.deepEqual(await redis.keys("ratelimit:mutation:*"), []);

    assertTooManyRequests(
      await postGraphql(url, EXPORT, { token, variables: MISSING_ACCOUNT }),
    );
    assertTooManyRequests(
      await postGraphql(url, CHECKOUT, { token, variables: MISSING_ACCOUNT }),
    );
    assert.equal((await postGraphql(url, PING, { token })).status, HTTP_OK);
  });

  it("does not count other queries against the sensitive bucket", async () => {
    const { url } = await startTestServer();
    const token = tokenFor(firebaseUid());

    assertAllOk(
      await repeat(RATE_LIMITS.SENSITIVE.limit + 1, () =>
        postGraphql(url, PING, { token }),
      ),
      "ping",
    );
    assert.deepEqual(await redis.keys("ratelimit:sensitive:*"), []);
  });

  it("counts aliased sensitive fields one by one", async () => {
    const { url } = await startTestServer();
    const token = tokenFor(firebaseUid());
    const args = `ownerAccountId: "${MISSING_ACCOUNT.id}"`;

    assertTooManyRequests(
      await postGraphql(
        url,
        aliased("openBillingPortal", RATE_LIMITS.SENSITIVE.limit + 1, args),
        { token },
      ),
    );
  });
});

describe("client IP", () => {
  it("ignores X-Forwarded-For unless TRUST_PROXY is set", async () => {
    const { url } = await startTestServer();

    assertAllOk(
      await repeat(RATE_LIMITS.ANONYMOUS.limit, (index) =>
        postGraphql(url, PING, {
          headers: { "x-forwarded-for": `203.0.113.${index + 1}` },
        }),
      ),
      "spoofed",
    );
    assertTooManyRequests(
      await postGraphql(url, PING, {
        headers: { "x-forwarded-for": "198.51.100.1" },
      }),
    );
  });

  it("with TRUST_PROXY, uses the last X-Forwarded-For entry, which the proxy appended", async () => {
    const { url } = await startTestServer({ trustProxy: true });
    const headers = (value) => ({ headers: { "x-forwarded-for": value } });

    assertAllOk(
      await repeat(RATE_LIMITS.ANONYMOUS.limit, (index) =>
        postGraphql(url, PING, headers(`10.0.0.${index}, 203.0.113.5`)),
      ),
      "proxied",
    );
    assertTooManyRequests(await postGraphql(url, PING, headers("203.0.113.5")));
    assert.equal(
      (await postGraphql(url, PING, headers("203.0.113.6"))).status,
      HTTP_OK,
    );
  });

  it("limits a whole IPv6 /64 as one client, so rotating addresses inside it does not help", async () => {
    const { url } = await startTestServer({ trustProxy: true });
    const headers = (value) => ({ headers: { "x-forwarded-for": value } });

    assertAllOk(
      await repeat(RATE_LIMITS.ANONYMOUS.limit, (index) =>
        postGraphql(
          url,
          PING,
          headers(`2001:db8:0:1::${(index + 1).toString(16)}`),
        ),
      ),
      "rotating /64",
    );
    assertTooManyRequests(
      await postGraphql(url, PING, headers("2001:db8:0:1:ffff:ffff:ffff:ffff")),
    );
    assert.equal(
      (await postGraphql(url, PING, headers("2001:db8:0:2::1"))).status,
      HTTP_OK,
    );
  });
});

describe("Stripe webhook", () => {
  it("is never rate limited", async () => {
    const { url, webhookCalls } = await startTestServer();

    await repeat(RATE_LIMITS.ANONYMOUS.limit, () => postGraphql(url, PING));
    assertTooManyRequests(await postGraphql(url, PING));

    const deliveries = await repeat(RATE_LIMITS.ANONYMOUS.limit + 10, () =>
      fetch(`${url}/webhooks/stripe`, { method: "POST", body: "{}" }),
    );

    for (const response of deliveries) {
      assert.equal(response.status, HTTP_OK);
      await response.body.cancel();
    }

    assert.equal(webhookCalls.length, RATE_LIMITS.ANONYMOUS.limit + 10);
  });
});

describe("Redis unavailable", () => {
  it("fails open: every request is served", async () => {
    const { url } = await startTestServer({ redis: unreachableRedis() });
    const token = tokenFor(firebaseUid());

    assertAllOk(
      await repeat(RATE_LIMITS.ANONYMOUS.limit + 5, () =>
        postGraphql(url, PING),
      ),
      "anonymous",
    );
    assertAllOk(
      await repeat(RATE_LIMITS.SENSITIVE.limit + 5, () =>
        postGraphql(url, CHECKOUT, { token, variables: MISSING_ACCOUNT }),
      ),
      "sensitive",
    );
  });

  it("logs each skipped check through the request logger", async () => {
    const log = recordingLogger();

    await enforceRateLimit({
      redis: unreachableRedis(),
      log,
      bucket: RATE_LIMITS.USER,
      id: "user-1",
    });

    assert.equal(log.entries.length, 1);
    const [{ level, args }] = log.entries;
    assert.equal(level, "warn");
    assert.equal(args[0].bucket, RATE_LIMITS.USER.name);
    assert.ok(args[0].err instanceof Error);
    assert.equal(args[1], "Rate limit skipped: Redis is unavailable.");
  });
});
