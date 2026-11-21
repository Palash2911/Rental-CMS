import assert from "node:assert/strict";
import { request as httpRequest } from "node:http";
import { beforeEach, describe, it } from "node:test";

import {
  MAX_QUERY_TOKENS,
  MAX_REQUEST_BODY_BYTES,
  MAX_ROOT_FIELDS,
} from "../../src/lib/queryLimits.js";
import { resetDatabase } from "../support/db.js";
import { firebaseUid } from "../support/factories.js";
import {
  postGraphql,
  startTestServer,
  TEST_FRONTEND_URL,
  tokenFor,
} from "../support/http.js";

const HTTP_PAYLOAD_TOO_LARGE = 413;
const HTTP_OK = 200;
const INTROSPECTION = "query { __schema { queryType { name } } }";
const MISSPELLED = "query { mee { id } }";

/** Sends `chunks` with chunked transfer encoding (no Content-Length); resolves `{ status }`. */
function postChunked(url, chunks) {
  return new Promise((resolve, reject) => {
    const target = new URL(`${url}/graphql`);
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: target.pathname,
        method: "POST",
        headers: { "content-type": "application/json" },
      },
      (response) => {
        response.resume();
        response.on("end", () => resolve({ status: response.statusCode }));
      },
    );
    // The server may answer 413 and close before every chunk is written.
    request.on("error", (error) =>
      error.code === "EPIPE" || error.code === "ECONNRESET"
        ? resolve({ status: HTTP_PAYLOAD_TOO_LARGE })
        : reject(error),
    );

    for (const chunk of chunks) {
      request.write(chunk);
    }

    request.end();
  });
}

function messages(result) {
  return (result.body.errors ?? []).map((error) => error.message).join(" | ");
}

beforeEach(resetDatabase);

describe("request body limit", () => {
  it(`answers 413 for a body over ${MAX_REQUEST_BODY_BYTES} bytes announced by Content-Length`, async () => {
    const { url } = await startTestServer();
    const padding = "x".repeat(MAX_REQUEST_BODY_BYTES + 1);

    const response = await fetch(`${url}/graphql`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        query: "query { __typename }",
        variables: { padding },
      }),
    });

    assert.equal(response.status, HTTP_PAYLOAD_TOO_LARGE);
  });

  it("answers 413 for a streamed body that grows past the limit without a Content-Length", async () => {
    const { url } = await startTestServer();
    const chunk = "x".repeat(16 * 1024);
    const chunks = [
      '{"query":"query { __typename }","variables":{"padding":"',
      ...Array(8).fill(chunk),
      '"}}',
    ];

    const { status } = await postChunked(url, chunks);

    assert.equal(status, HTTP_PAYLOAD_TOO_LARGE);
  });

  it("serves a body under the limit", async () => {
    const { url } = await startTestServer();

    const result = await postGraphql(url, "query { __typename }", {
      variables: { padding: "x".repeat(10 * 1024) },
    });

    assert.equal(result.status, HTTP_OK);
    assert.equal(result.body.data.__typename, "Query");
  });
});

describe("document limits", () => {
  it(`stops parsing a document with more than ${MAX_QUERY_TOKENS} tokens`, async () => {
    const { url } = await startTestServer();
    const query = `query { ${"__typename ".repeat(MAX_QUERY_TOKENS)} }`;

    const result = await postGraphql(url, query);

    assert.equal(result.body.data, undefined);
    assert.match(
      messages(result),
      new RegExp(`more than ${MAX_QUERY_TOKENS} tokens`),
    );
  });

  it(`refuses an operation with more than ${MAX_ROOT_FIELDS} root fields, counting aliases and fragments`, async () => {
    const { url } = await startTestServer();
    const token = tokenFor(firebaseUid());
    const aliases = Array.from(
      { length: MAX_ROOT_FIELDS },
      (_, index) => `a${index}: me { id }`,
    ).join(" ");
    const overByAlias = `query { ${aliases} b: me { id } }`;
    const overByFragment = `query { ...Extra ${aliases} } fragment Extra on Query { c: me { id } }`;
    const atLimit = `query { ${aliases} }`;

    for (const query of [overByAlias, overByFragment]) {
      const result = await postGraphql(url, query, { token });
      assert.equal(result.body.data, undefined);
      assert.match(
        messages(result),
        new RegExp(`at most ${MAX_ROOT_FIELDS} root fields`),
      );
    }

    const ok = await postGraphql(url, atLimit, { token });
    assert.doesNotMatch(messages(ok), /root fields/);
    assert.ok(ok.body.data);
  });

  it("does not count __typename toward the root field limit", async () => {
    const { url } = await startTestServer();
    const query = `query { ${Array.from({ length: MAX_ROOT_FIELDS + 5 }, (_, index) => `t${index}: __typename`).join(" ")} }`;

    const result = await postGraphql(url, query);

    assert.equal(result.body.errors, undefined);
  });
});

describe("introspection, GraphiQL and suggestions outside development", () => {
  it("refuses introspection", async () => {
    const { url } = await startTestServer();

    const result = await postGraphql(url, INTROSPECTION);

    assert.equal(result.body.data, undefined);
    assert.match(messages(result), /introspection/i);
  });

  it("serves no GraphiQL page to a browser", async () => {
    const { url } = await startTestServer();

    const response = await fetch(`${url}/graphql`, {
      headers: { accept: "text/html" },
    });
    const body = await response.text();

    assert.doesNotMatch(body, /graphiql/i);
  });

  it("leaves 'Did you mean' suggestions out of validation errors", async () => {
    const { url } = await startTestServer();

    const result = await postGraphql(url, MISSPELLED);

    assert.match(messages(result), /Cannot query field "mee"/);
    assert.doesNotMatch(messages(result), /Did you mean/);
  });

  it("in development, allows introspection, serves GraphiQL and keeps suggestions", async () => {
    const { url } = await startTestServer({ isDevelopment: true });

    const introspection = await postGraphql(url, INTROSPECTION);
    assert.equal(introspection.body.data.__schema.queryType.name, "Query");

    const page = await (
      await fetch(`${url}/graphql`, { headers: { accept: "text/html" } })
    ).text();
    assert.match(page, /graphiql/i);

    assert.match(
      messages(await postGraphql(url, MISSPELLED)),
      /Did you mean "me"/,
    );
  });
});

describe("CORS", () => {
  it("allows only FRONTEND_URL, without credentials, for POST, GET and OPTIONS", async () => {
    const { url } = await startTestServer();

    const preflight = await fetch(`${url}/graphql`, {
      method: "OPTIONS",
      headers: {
        origin: TEST_FRONTEND_URL,
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type, authorization",
      },
    });

    assert.equal(
      preflight.headers.get("access-control-allow-origin"),
      TEST_FRONTEND_URL,
    );
    assert.equal(
      preflight.headers.get("access-control-allow-credentials"),
      null,
    );
    assert.equal(
      preflight.headers.get("access-control-allow-methods"),
      "POST, GET, OPTIONS",
    );
  });

  it("never names another origin, so the browser blocks it", async () => {
    const { url } = await startTestServer();

    const result = await postGraphql(url, "query { __typename }", {
      headers: { origin: "https://evil.example.test" },
    });

    assert.notEqual(
      result.headers.get("access-control-allow-origin"),
      "https://evil.example.test",
    );
    assert.notEqual(result.headers.get("access-control-allow-origin"), "*");
    assert.equal(result.headers.get("access-control-allow-credentials"), null);
  });
});

describe("security headers", () => {
  it("sets nosniff, no-store and no-referrer on GraphQL and webhook responses, and no HSTS over plain HTTP", async () => {
    const { url } = await startTestServer();

    const graphqlResponse = await postGraphql(url, "query { __typename }");
    const webhookResponse = await fetch(`${url}/webhooks/stripe`, {
      method: "POST",
      body: "{}",
    });

    for (const headers of [graphqlResponse.headers, webhookResponse.headers]) {
      assert.equal(headers.get("x-content-type-options"), "nosniff");
      assert.equal(headers.get("cache-control"), "no-store");
      assert.equal(headers.get("referrer-policy"), "no-referrer");
      assert.equal(headers.get("strict-transport-security"), null);
    }
  });

  it("adds HSTS only when a trusted proxy reports HTTPS", async () => {
    const trusted = await startTestServer({ trustProxy: true });
    const untrusted = await startTestServer();
    const https = { "x-forwarded-proto": "https" };

    const viaTrusted = await postGraphql(trusted.url, "query { __typename }", {
      headers: https,
    });
    const viaUntrusted = await postGraphql(
      untrusted.url,
      "query { __typename }",
      { headers: https },
    );

    assert.match(
      viaTrusted.headers.get("strict-transport-security"),
      /^max-age=31536000; includeSubDomains$/,
    );
    assert.equal(viaUntrusted.headers.get("strict-transport-security"), null);
  });
});
