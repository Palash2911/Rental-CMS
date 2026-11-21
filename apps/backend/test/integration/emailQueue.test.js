import assert from "node:assert/strict";
import { once } from "node:events";
import { after, beforeEach, describe, it } from "node:test";

import { Queue, Worker } from "bullmq";

import { tenantInvitationEmail } from "../../src/email/events.js";
import { EMAIL_FAILURES, EmailDeliveryError } from "../../src/email/gateway.js";
import { createEmailProcessor } from "../../src/email/processor.js";
import { createEmailNotifier, EMAIL_JOB_OPTIONS, EMAIL_QUEUE } from "../../src/email/queue.js";
import { closeRedisClient, createWorkerRedisClient } from "../../src/redis.js";
import { prisma, resetDatabase } from "../support/db.js";
import { fakeEmailGateway } from "../support/email.js";
import { createHouse, createInvitation, createOwnerAccount, createUser, recordingLogger } from "../support/factories.js";
import { redis, unreachableRedis } from "../support/redis.js";

// Producer on the API's shared fail-fast client, consumer on a worker client, both on the
// test Redis database 15 that resetDatabase() flushes.
const connection = createWorkerRedisClient(process.env.REDIS_URL, { onError: () => {} });
const queue = new Queue(EMAIL_QUEUE, { connection: redis });
const workers = [];

after(async () => {
  await Promise.all(workers.map((worker) => worker.close()));
  await queue.close();
  await closeRedisClient(connection);
});

async function invitationEmail() {
  const owner = await createUser();
  const account = await createOwnerAccount(owner, { name: "Harbour Rentals" });
  const house = await createHouse(account, { name: "Unit 4" });
  const invitation = await createInvitation(house, owner, { email: "invitee@example.test" });
  return tenantInvitationEmail({ invitationId: invitation.id });
}

function startWorker(email) {
  let worker;
  worker = new Worker(
    EMAIL_QUEUE,
    createEmailProcessor({
      prisma,
      emailGateway: email.gateway,
      from: "Rental CMS <notifications@example.test>",
      frontendUrl: "https://app.example.test",
      log: recordingLogger(),
      rateLimit: (ms) => worker.rateLimit(ms),
    }),
    { connection, concurrency: 1 },
  );
  workers.push(worker);
  return worker;
}

beforeEach(resetDatabase);

describe("email queue", () => {
  it("queues each email once under its key with exponential backoff, dropping a duplicate enqueue", async () => {
    const email = await invitationEmail();
    const notifier = createEmailNotifier(queue, recordingLogger());

    await notifier.enqueue([email]);
    await notifier.enqueue([email]);

    const job = await queue.getJob(email.key);
    assert.equal(job.id, email.key);
    assert.equal(job.name, email.type);
    assert.deepEqual(job.data, email.data);
    assert.equal(job.opts.attempts, EMAIL_JOB_OPTIONS.attempts);
    assert.deepEqual(job.opts.backoff, { type: "exponential", delay: 30_000 });
    assert.equal((await queue.getJobCounts("waiting")).waiting, 1);
  });

  it("fails open when Redis is down: the caller carries on and a warning names the email, not the address", async () => {
    const email = await invitationEmail();
    const log = recordingLogger();
    const downQueue = new Queue(EMAIL_QUEUE, { connection: unreachableRedis() });
    const started = Date.now();

    await createEmailNotifier(downQueue, log).enqueue([email]);

    assert.ok(Date.now() - started < 3000, "enqueue should give up quickly");
    assert.equal(log.entries[0].level, "warn");
    assert.equal(log.entries[0].args[0].emailKey, email.key);
    assert.doesNotMatch(JSON.stringify(log.entries), /invitee@example\.test/);
  });

  it("sends a queued email through a real worker after a rate limit, with one idempotency key", async () => {
    const email = await invitationEmail();
    const gateway = fakeEmailGateway([
      new EmailDeliveryError(EMAIL_FAILURES.RATE_LIMITED, { errorName: "rate_limit_exceeded", retryAfterMs: 100 }),
    ]);
    const worker = startWorker(gateway);
    const completed = once(worker, "completed");

    await createEmailNotifier(queue, recordingLogger()).enqueue([email]);
    const [job, result] = await completed;

    assert.deepEqual(result, { sent: true, alreadySent: false });
    assert.equal(job.id, email.key);
    assert.deepEqual(gateway.sent.map((sent) => sent.idempotencyKey), [email.key, email.key]);
    assert.equal(gateway.sent[1].to, "invitee@example.test");
  });

  it("fails a permanently refused email on its first attempt, without retrying", async () => {
    const email = await invitationEmail();
    const gateway = fakeEmailGateway([new EmailDeliveryError(EMAIL_FAILURES.PERMANENT, { errorName: "validation_error" })]);
    const worker = startWorker(gateway);
    const failed = once(worker, "failed");

    await createEmailNotifier(queue, recordingLogger()).enqueue([email]);
    const [job] = await failed;

    assert.equal(job.attemptsMade, 1);
    assert.equal(gateway.sent.length, 1);
    assert.equal(await (await queue.getJob(email.key)).getState(), "failed");
  });
});
