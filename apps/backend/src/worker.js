import { Queue, Worker } from "bullmq";
import { Logger } from "graphql-yoga";

import { createJobProcessor, MAINTENANCE_QUEUE, registerJobSchedulers } from "./jobs/scheduler.js";
import { config } from "./lib/config.js";
import prisma from "./prisma.js";
import { closeRedisClient, createWorkerRedisClient } from "./redis.js";
import { createStripeClient, createStripeGateway } from "./stripe/gateway.js";

// Jobs process one at a time per worker; a second worker only adds failover, because each
// scheduled job is enqueued once.
const WORKER_CONCURRENCY = 1;
const SHUTDOWN_TIMEOUT_MS = 30_000;

// The same logger the API uses (Yoga re-exports it from @graphql-hive/logger).
const log = new Logger();

const connection = createWorkerRedisClient(config.redisUrl, {
  onError: (error) => log.warn({ err: error }, "Redis connection error."),
});

const billingGateway = createStripeGateway(createStripeClient(config.stripeSecretKey));

const queue = new Queue(MAINTENANCE_QUEUE, { connection });
await registerJobSchedulers(queue);

const worker = new Worker(
  MAINTENANCE_QUEUE,
  createJobProcessor({ prisma, billingGateway, log }),
  { connection, concurrency: WORKER_CONCURRENCY },
);

worker.on("failed", (job, error) => {
  log.error({ err: error, job: job?.name, jobId: job?.id }, "Maintenance job failed.");
});

log.info({ queue: MAINTENANCE_QUEUE }, "Worker started.");

// worker.close() waits for the running job to finish, so an account is never left halfway
// (each account is one transaction anyway).
async function shutdown(signal) {
  log.info({ signal }, "Worker shutting down.");
  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();

  await worker.close();
  await queue.close();
  await Promise.all([prisma.$disconnect(), closeRedisClient(connection)]);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
