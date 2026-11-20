import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertTestEnvironment } from "../support/safety.js";

const TEST_URL = "postgresql://user:SuperSecretPassword@db.example.test/rental_cms_test";
const DEV_URL = "postgresql://user:SuperSecretPassword@db.example.test/rental_cms";
const REDIS_TEST_URL = "redis://:SuperSecretPassword@127.0.0.1:6379/15";

function testEnv(overrides = {}) {
  return { NODE_ENV: "test", DATABASE_URL: TEST_URL, REDIS_URL: REDIS_TEST_URL, ...overrides };
}

function refusal(env, options) {
  try {
    assertTestEnvironment(env, options);
  } catch (error) {
    return error.message;
  }

  return assert.fail("Expected the safety check to refuse");
}

describe("test database safety check", () => {
  it("allows NODE_ENV test with a database ending in _test", () => {
    assert.doesNotThrow(() => assertTestEnvironment(testEnv({ DIRECT_URL: TEST_URL })));
  });

  it("allows only Redis database 15", () => {
    assert.doesNotThrow(() => assertTestEnvironment(testEnv()));
    assert.doesNotThrow(() => assertTestEnvironment(testEnv({ REDIS_URL: "rediss://cache.example.test:6380/15" })));

    for (const url of [
      "redis://127.0.0.1:6379",
      "redis://127.0.0.1:6379/",
      "redis://127.0.0.1:6379/0",
      "redis://127.0.0.1:6379/1",
      "redis://127.0.0.1:6379/150",
      "redis://127.0.0.1:6379/15/",
      "redis://127.0.0.1:6379/15?db=0",
      "http://127.0.0.1:6379/15",
      "not a url",
    ]) {
      assert.match(refusal(testEnv({ REDIS_URL: url })), /REDIS_URL must be a redis:\/\/ URL selecting database 15/, url);
    }

    assert.match(refusal(testEnv({ REDIS_URL: undefined })), /REDIS_URL is not set/);
  });

  it("never includes the Redis URL in the message", () => {
    assert.doesNotMatch(refusal(testEnv({ REDIS_URL: "redis://:SuperSecretPassword@127.0.0.1:6379/0" })), /SuperSecretPassword/);
  });

  it("refuses when NODE_ENV is not test", () => {
    assert.match(refusal({ NODE_ENV: "development", DATABASE_URL: TEST_URL }), /NODE_ENV must be "test"/);
  });

  it("refuses a database name that does not end in _test", () => {
    assert.match(refusal({ NODE_ENV: "test", DATABASE_URL: DEV_URL }), /DATABASE_URL must name a database ending in "_test"/);
  });

  it("refuses a _test suffix that appears only outside the database name", () => {
    const url = "postgresql://user_test:pw@host_test.example/rental_cms?options=x_test";

    assert.match(refusal({ NODE_ENV: "test", DATABASE_URL: url }), /DATABASE_URL/);
  });

  it("checks DIRECT_URL whenever it is set", () => {
    assert.match(
      refusal({ NODE_ENV: "test", DATABASE_URL: TEST_URL, DIRECT_URL: DEV_URL }),
      /DIRECT_URL must name a database ending in "_test"/,
    );
  });

  it("requires DIRECT_URL for migrations", () => {
    assert.match(
      refusal({ NODE_ENV: "test", DATABASE_URL: TEST_URL }, { requireDirectUrl: true }),
      /DIRECT_URL is not set/,
    );
  });

  it("refuses a missing or unparsable DATABASE_URL", () => {
    assert.match(refusal({ NODE_ENV: "test" }), /DATABASE_URL is not set/);
    assert.match(refusal({ NODE_ENV: "test", DATABASE_URL: "not a url" }), /DATABASE_URL must name/);
  });

  it("never includes URL values in the message", () => {
    assert.doesNotMatch(refusal({ NODE_ENV: "test", DATABASE_URL: DEV_URL }), /SuperSecretPassword/);
  });
});
