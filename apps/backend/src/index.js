import { NoSchemaIntrospectionCustomRule } from "graphql";
import { createYoga } from "graphql-yoga";
import { createServer } from "node:http";

import {
  hasLiveSuperAdminClaim,
  verifyIdToken,
} from "./firebase/identity.js";
import { createContextFactory } from "./graphql/context.js";
import { schema } from "./graphql/rootSchema.js";
import { config } from "./lib/config.js";
import prisma from "./prisma.js";
import { createStripeClient, createStripeGateway } from "./stripe/gateway.js";
import {
  createStripeWebhookHandler,
  STRIPE_WEBHOOK_PATH,
} from "./stripe/webhook.js";

const PORT = config.port;

const billingGateway = createStripeGateway(
  createStripeClient(config.stripeSecretKey),
);

const handleStripeWebhook = createStripeWebhookHandler({
  prisma,
  gateway: billingGateway,
  webhookSecret: config.stripeWebhookSecret,
});

// Deny by default: only development exposes GraphiQL and introspection; test and production keep both off.
const isDevelopment = config.isDevelopment;

const disableIntrospection = {
  onValidate({ addValidationRule }) {
    addValidationRule(NoSchemaIntrospectionCustomRule);
  },
};

const yoga = createYoga({
  schema,
  context: createContextFactory({
    prisma,
    verifyIdToken,
    hasLiveSuperAdminClaim,
    billingGateway,
  }),
  maskedErrors: { isDev: isDevelopment },
  graphiql: isDevelopment,
  plugins: isDevelopment ? [] : [disableIntrospection],
});

function requestPath(request) {
  return new URL(request.url, "http://localhost").pathname;
}

// The Stripe webhook is served outside Yoga so its raw body reaches signature verification
// unchanged. Every other request goes to Yoga.
const server = createServer((request, response) => {
  if (requestPath(request) === STRIPE_WEBHOOK_PATH) {
    return handleStripeWebhook(request, response);
  }

  return yoga(request, response);
});

server.listen(PORT, () => {
  console.info(
    `Server is running on http://localhost:${PORT}${yoga.graphqlEndpoint}`,
  );
});

async function shutdown(signal) {
  console.info(`${signal} received, shutting down...`);
  server.close(async () => {
    await prisma.$disconnect();
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
