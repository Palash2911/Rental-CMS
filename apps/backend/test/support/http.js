import { createServer } from "node:http";
import { after } from "node:test";

import { createApp } from "../../src/app.js";
import { HTTP_STATUS, UnauthenticatedError } from "../../src/lib/errors.js";
import { prisma } from "./db.js";
import { redis as testRedis } from "./redis.js";
import { recordingNotifier } from "./email.js";
import { unexpectedStorageGateway } from "./storage.js";
import { unexpectedStripeGateway } from "./stripe.js";

const LOOPBACK = "127.0.0.1";
const TOKEN_PREFIX = "uid:";
const EMAIL_DOMAIN = "example.test";
const WEBHOOK_RESPONSE = Object.freeze({ received: true, fake: true });

const servers = [];

// Tokens are "uid:<id>": the stand-in verifier accepts them as that Firebase UID with a
// verified email, and rejects anything else like firebase-admin rejects a bad token.
async function fakeVerifyIdToken(token) {
  if (!token.startsWith(TOKEN_PREFIX)) {
    throw new UnauthenticatedError("Invalid or expired token.", {
      httpStatus: HTTP_STATUS.UNAUTHORIZED,
    });
  }

  const uid = token.slice(TOKEN_PREFIX.length);
  return {
    uid,
    email: `${uid.toLowerCase()}@${EMAIL_DOMAIN}`,
    email_verified: true,
  };
}

/** The bearer token the test server accepts for `userId`. */
export function tokenFor(userId) {
  return `${TOKEN_PREFIX}${userId}`;
}

/**
 * Starts the real app (createApp: Yoga, the rate limit, the webhook route) on an ephemeral
 * loopback port, with stand-ins for Firebase, Stripe and the webhook handler. Returns
 * `{ url, webhookCalls }`. Servers close after the test file.
 */
export async function startTestServer({
  redis = testRedis,
  trustProxy = false,
} = {}) {
  const webhookCalls = [];

  const app = createApp({
    contextDependencies: {
      prisma,
      verifyIdToken: fakeVerifyIdToken,
      hasLiveSuperAdminClaim: async () => false,
      billingGateway: unexpectedStripeGateway(),
      storageGateway: unexpectedStorageGateway(),
      notifier: recordingNotifier(),
      redis,
      trustProxy,
    },
    handleStripeWebhook: (request, response) => {
      webhookCalls.push(request.url);
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(WEBHOOK_RESPONSE));
    },
    isDevelopment: false,
    // Yoga logs a line per request at its default level; the suite asserts on logging
    // through recordingLogger instead.
    logging: false,
  });

  const server = createServer(app.handleRequest);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, LOOPBACK, resolve));

  return { url: `http://${LOOPBACK}:${server.address().port}`, webhookCalls };
}

/**
 * POSTs a GraphQL operation to the test server. Returns `{ status, headers, body }`.
 * Pass `token` for a signed-in request and `headers` for extra request headers.
 */
export async function postGraphql(
  url,
  query,
  { token, headers = {}, variables } = {},
) {
  const response = await fetch(`${url}/graphql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    body: JSON.stringify({ query, variables }),
  });

  return {
    status: response.status,
    headers: response.headers,
    body: await response.json(),
  };
}

after(async () => {
  await Promise.all(
    servers.map((server) => new Promise((resolve) => server.close(resolve))),
  );
});
