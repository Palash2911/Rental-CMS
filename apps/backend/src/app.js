import { NoSchemaIntrospectionCustomRule } from "graphql";
import { createYoga } from "graphql-yoga";

import { createContextFactory } from "./graphql/context.js";
import { schema } from "./graphql/rootSchema.js";
import { createRateLimitPlugin } from "./lib/rateLimit.js";
import { STRIPE_WEBHOOK_PATH } from "./stripe/webhook.js";

const disableIntrospection = {
  onValidate({ addValidationRule }) {
    addValidationRule(NoSchemaIntrospectionCustomRule);
  },
};

function requestPath(request) {
  return new URL(request.url, "http://localhost").pathname;
}

/**
 * Builds the Yoga server and the node:http request listener. Dependencies are injected so
 * tests run the same wiring as index.js with fakes for Firebase, Stripe and the webhook.
 * `contextDependencies` goes to createContextFactory (which validates it); `logging` is
 * passed to createYoga unchanged (omitted in production, so Yoga's default logger is used).
 */
export function createApp({ contextDependencies, handleStripeWebhook, isDevelopment, logging }) {
  // Deny by default: only development exposes GraphiQL and introspection; test and production keep both off.
  const plugins = [createRateLimitPlugin()];

  if (!isDevelopment) {
    plugins.push(disableIntrospection);
  }

  const yoga = createYoga({
    schema,
    context: createContextFactory(contextDependencies),
    maskedErrors: { isDev: isDevelopment },
    graphiql: isDevelopment,
    plugins,
    ...(logging === undefined ? {} : { logging }),
  });

  // The Stripe webhook is served outside Yoga so its raw body reaches signature verification
  // unchanged. Every other request goes to Yoga.
  // Being outside Yoga also keeps it out of the rate limit: Stripe retries are never refused.
  function handleRequest(request, response) {
    if (requestPath(request) === STRIPE_WEBHOOK_PATH) {
      return handleStripeWebhook(request, response);
    }

    return yoga(request, response);
  }

  return { yoga, handleRequest };
}
