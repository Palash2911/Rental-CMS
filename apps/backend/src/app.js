import { NoSchemaIntrospectionCustomRule } from "graphql";
import { createYoga } from "graphql-yoga";

import { createContextFactory } from "./graphql/context.js";
import { schema } from "./graphql/rootSchema.js";
import {
  createQueryLimitsPlugin,
  MAX_REQUEST_BODY_BYTES,
} from "./lib/queryLimits.js";
import { createRateLimitPlugin } from "./lib/rateLimit.js";
import { STRIPE_WEBHOOK_PATH } from "./stripe/webhook.js";

const CORS_METHODS = Object.freeze(["POST", "GET", "OPTIONS"]);
const HSTS_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;
const FORWARDED_PROTO_HEADER = "x-forwarded-proto";
const HTTPS = "https";

// Every response carries personal data or nothing useful to cache, and is never framed or
// sniffed. HSTS is added only when the request really arrived over TLS.
const SECURITY_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
});

const disableIntrospection = {
  onValidate({ addValidationRule }) {
    addValidationRule(NoSchemaIntrospectionCustomRule);
  },
};

function requestPath(request) {
  return new URL(request.url, "http://localhost").pathname;
}

// X-Forwarded-Proto is client-controlled unless a trusted proxy set it, the same rule as
// X-Forwarded-For in lib/rateLimit.js.
function isTls(request, trustProxy) {
  if (request.socket?.encrypted) {
    return true;
  }

  return trustProxy && request.headers[FORWARDED_PROTO_HEADER] === HTTPS;
}

function setSecurityHeaders(request, response, trustProxy) {
  for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
    response.setHeader(name, value);
  }

  if (isTls(request, trustProxy)) {
    response.setHeader(
      "Strict-Transport-Security",
      `max-age=${HSTS_MAX_AGE_SECONDS}; includeSubDomains`,
    );
  }
}

/**
 * Builds the Yoga server and the node:http request listener. Dependencies are injected so
 * tests run the same wiring as index.js with fakes for Firebase, Stripe and the webhook.
 * `contextDependencies` goes to createContextFactory (which validates it); `logging` is
 * passed to createYoga unchanged (omitted in production, so Yoga's default logger is used).
 */
// `frontendUrl` is the one origin CORS allows: the API takes bearer tokens, never cookies,
// so credentials stay off.
export function createApp({
  contextDependencies,
  handleStripeWebhook,
  isDevelopment,
  frontendUrl,
  logging,
}) {
  // Deny by default: only development exposes GraphiQL and introspection; test and production keep both off.
  const plugins = [
    createRateLimitPlugin(),
    createQueryLimitsPlugin({ hideSuggestions: !isDevelopment }),
  ];

  if (!isDevelopment) {
    plugins.push(disableIntrospection);
  }

  const yoga = createYoga({
    schema,
    context: createContextFactory(contextDependencies),
    maskedErrors: { isDev: isDevelopment },
    graphiql: isDevelopment,
    maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
    cors: {
      origin: [frontendUrl],
      credentials: false,
      methods: [...CORS_METHODS],
    },
    plugins,
    ...(logging === undefined ? {} : { logging }),
  });

  const trustProxy = contextDependencies.trustProxy === true;

  // The Stripe webhook is served outside Yoga so its raw body reaches signature verification
  // unchanged. Every other request goes to Yoga.
  // Being outside Yoga also keeps it out of the rate limit: Stripe retries are never refused.
  function handleRequest(request, response) {
    setSecurityHeaders(request, response, trustProxy);

    if (requestPath(request) === STRIPE_WEBHOOK_PATH) {
      return handleStripeWebhook(request, response);
    }

    return yoga(request, response);
  }

  return { yoga, handleRequest };
}
