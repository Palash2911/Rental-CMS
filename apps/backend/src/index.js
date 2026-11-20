import { createServer } from "node:http";

import { createApp } from "./app.js";
import {
  hasLiveSuperAdminClaim,
  verifyIdToken,
} from "./firebase/identity.js";
import { config } from "./lib/config.js";
import prisma from "./prisma.js";
import { closeRedisClient, createRedisClient } from "./redis.js";
import { createStripeClient, createStripeGateway } from "./stripe/gateway.js";
import { createStripeWebhookHandler } from "./stripe/webhook.js";

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

// Connection errors repeat while Redis is down (ioredis keeps reconnecting); requests carry
// on, failing open, and each one also logs through its request logger.
const redis = createRedisClient(config.redisUrl, {
  onError: (error) => app.yoga.log.warn({ err: error }, "Redis connection error."),
});

const app = createApp({
  contextDependencies: {
    prisma,
    verifyIdToken,
    hasLiveSuperAdminClaim,
    billingGateway,
    redis,
    trustProxy: config.trustProxy,
  },
  handleStripeWebhook,
  isDevelopment,
});

const server = createServer(app.handleRequest);

server.listen(PORT, () => {
  console.info(
    `Server is running on http://localhost:${PORT}${app.yoga.graphqlEndpoint}`,
  );
});

async function shutdown(signal) {
  console.info(`${signal} received, shutting down...`);
  server.close(async () => {
    await Promise.all([prisma.$disconnect(), closeRedisClient(redis)]);
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
