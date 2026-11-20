import assert from "node:assert/strict";
import { after, beforeEach, describe, it } from "node:test";

import { Queue } from "bullmq";

import {
  createJobProcessor,
  JOB_SCHEDULES,
  MAINTENANCE_QUEUE,
  registerJobSchedulers,
} from "../../src/jobs/scheduler.js";
import { closeRedisClient, createWorkerRedisClient } from "../../src/redis.js";
import { prisma, resetDatabase } from "../support/db.js";
import { recordingLogger } from "../support/factories.js";
import { unexpectedStripeGateway } from "../support/stripe.js";

// The worker's own client, on the same test Redis database 15 as the suite (REDIS_URL passed
// the safety check when support/db.js was imported).
const connection = createWorkerRedisClient(process.env.REDIS_URL, { onError: () => {} });
const queue = new Queue(MAINTENANCE_QUEUE, { connection });

after(async () => {
  await queue.close();
  await closeRedisClient(connection);
});

function schedulerSummary(schedulers) {
  return schedulers
    .map(({ key, name, pattern, tz }) => ({ key, name, pattern, tz }))
    .sort((a, b) => a.key.localeCompare(b.key));
}

const EXPECTED = JOB_SCHEDULES.map(({ name, pattern }) => ({ key: name, name, pattern, tz: "UTC" })).sort((a, b) =>
  a.key.localeCompare(b.key),
);

beforeEach(resetDatabase);

describe("worker wiring", () => {
  it("registers one daily UTC scheduler per job, idempotently", async () => {
    await registerJobSchedulers(queue);
    await registerJobSchedulers(queue);

    const schedulers = await queue.getJobSchedulers();

    assert.deepEqual(schedulerSummary(schedulers), EXPECTED);
    assert.deepEqual(EXPECTED.map(({ key }) => key), ["accountDeletion", "billingGrace", "cleanup"]);
  });

  it("removes a scheduler that is no longer listed", async () => {
    await queue.upsertJobScheduler("retiredJob", { pattern: "0 5 * * *", tz: "UTC" }, { name: "retiredJob" });

    await registerJobSchedulers(queue);

    assert.deepEqual(schedulerSummary(await queue.getJobSchedulers()), EXPECTED);
  });

  it("dispatches a job by name to its service and refuses an unknown name", async () => {
    const log = recordingLogger();
    const processJob = createJobProcessor({ prisma, billingGateway: unexpectedStripeGateway(), log });

    const summary = await processJob({ id: "1", name: "cleanup" });

    assert.deepEqual(summary, { job: "cleanup", tenantInvitations: 0, memberInvitations: 0, stripeEvents: 0 });
    assert.equal(log.entries[0].level, "info");
    await assert.rejects(processJob({ id: "2", name: "notAJob" }), /Unknown maintenance job/);
  });
});
