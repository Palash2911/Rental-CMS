import { createServer } from "node:http";

import { Queue } from "bullmq";

import { createApp } from "./app.js";
import { createEmailNotifier, EMAIL_QUEUE } from "./email/queue.js";
import {
  hasLiveSuperAdminClaim,
  verifyIdToken,
} from "./firebase/identity.js";
import { config } from "./lib/config.js";
import prisma from "./prisma.js";
import { closeRedisClient, createRedisClient } from "./redis.js";
import { createStorageClient, createStorageGateway } from "./storage/gateway.js";
import { createStripeClient, createStripeGateway } from "./stripe/gateway.js";
import { createStripeWebhookHandler } from "./stripe/webhook.js";

const PORT = config.port;

const billingGateway = createStripeGateway(
  createStripeClient(config.stripeSecretKey),
);

const storageGateway = createStorageGateway(createStorageClient(config.s3), {
  bucket: config.s3.bucket,
});

// Deny by default: only development exposes GraphiQL and introspection; test and production keep both off.
const isDevelopment = config.isDevelopment;

// Connection errors repeat while Redis is down (ioredis keeps reconnecting); requests carry
// on, failing open, and each one also logs through its request logger.
const redis = createRedisClient(config.redisUrl, {
  onError: (error) => app.yoga.log.warn({ err: error }, "Redis connection error."),
});

// The API only adds email jobs; the worker sends them. Producing on the shared fail-fast
// client (no offline queue) is what BullMQ recommends for a Queue, and keeps a Redis outage
// from holding requests (the notifier also bounds each add).
const emailQueue = new Queue(EMAIL_QUEUE, { connection: redis });
const notifier = createEmailNotifier(emailQueue, {
  warn: (...args) => app.yoga.log.warn(...args),
});

const handleStripeWebhook = createStripeWebhookHandler({
  prisma,
  gateway: billingGateway,
  notifier,
  webhookSecret: config.stripeWebhookSecret,
});

const app = createApp({
  contextDependencies: {
    prisma,
    verifyIdToken,
    hasLiveSuperAdminClaim,
    billingGateway,
    storageGateway,
    notifier,
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
    await emailQueue.close();
    await Promise.all([prisma.$disconnect(), closeRedisClient(redis)]);
    process.exit(0);
  });

  setTimeout(() => process.exit(1), 10_000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
