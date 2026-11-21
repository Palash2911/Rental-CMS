import { Queue, Worker } from "bullmq";
import { Logger } from "graphql-yoga";

import { createEmailClient, createEmailGateway } from "./email/gateway.js";
import { createEmailProcessor } from "./email/processor.js";
import { createEmailNotifier, EMAIL_QUEUE } from "./email/queue.js";
import { createJobProcessor, MAINTENANCE_QUEUE, registerJobSchedulers } from "./jobs/scheduler.js";
import { config } from "./lib/config.js";
import prisma from "./prisma.js";
import { closeRedisClient, createRedisClient, createWorkerRedisClient } from "./redis.js";
import { createStorageClient, createStorageGateway } from "./storage/gateway.js";
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
const storageGateway = createStorageGateway(createStorageClient(config.s3), {
  bucket: config.s3.bucket,
});

const emailGateway = createEmailGateway(createEmailClient(config.email.resendApiKey));
// Jobs enqueue emails like the API does: on a fail-fast client (no offline queue), which also
// carries the rateLimitHit command the daily email budget counts with. The blocking worker
// connection above retries forever and has neither.
const producerRedis = createRedisClient(config.redisUrl, {
  onError: (error) => log.warn({ err: error }, "Redis connection error."),
});
const emailQueue = new Queue(EMAIL_QUEUE, { connection: producerRedis });
const notifier = createEmailNotifier({ queue: emailQueue, redis: producerRedis, log });

const queue = new Queue(MAINTENANCE_QUEUE, { connection });
await registerJobSchedulers(queue);

const worker = new Worker(
  MAINTENANCE_QUEUE,
  createJobProcessor({ prisma, billingGateway, storageGateway, notifier, log }),
  { connection, concurrency: WORKER_CONCURRENCY },
);

worker.on("failed", (job, error) => {
  log.error({ err: error, job: job?.name, jobId: job?.id }, "Maintenance job failed.");
});

// One send at a time, at most one per second: well under Resend's per-second limit, and a
// 429 still pauses the queue through rateLimit (processor.js).
const EMAIL_RATE = Object.freeze({ max: 1, duration: 1000 });

const emailWorker = new Worker(
  EMAIL_QUEUE,
  createEmailProcessor({
    prisma,
    emailGateway,
    from: config.email.from,
    devRedirect: config.email.devRedirect,
    frontendUrl: config.frontendUrl,
    log,
    rateLimit: (ms) => emailQueue.rateLimit(ms),
  }),
  { connection, concurrency: WORKER_CONCURRENCY, limiter: EMAIL_RATE },
);

emailWorker.on("failed", (job, error) => {
  log.warn({ err: error, emailType: job?.name, emailKey: job?.id, attemptsMade: job?.attemptsMade }, "Email job attempt failed.");
});

log.info({ queues: [MAINTENANCE_QUEUE, EMAIL_QUEUE], emailDevRedirect: config.email.devRedirect !== null }, "Worker started.");

// worker.close() waits for the running job to finish, so an account is never left halfway
// (each account is one transaction anyway).
async function shutdown(signal) {
  log.info({ signal }, "Worker shutting down.");
  setTimeout(() => process.exit(1), SHUTDOWN_TIMEOUT_MS).unref();

  await Promise.all([worker.close(), emailWorker.close()]);
  await Promise.all([queue.close(), emailQueue.close()]);
  await Promise.all([prisma.$disconnect(), closeRedisClient(connection), closeRedisClient(producerRedis)]);
  process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
