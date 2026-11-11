import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { assertTestEnvironment } from "../support/safety.js";

const TEST_URL = "postgresql://user:SuperSecretPassword@db.example.test/rental_cms_test";
const DEV_URL = "postgresql://user:SuperSecretPassword@db.example.test/rental_cms";

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
    assert.doesNotThrow(() =>
      assertTestEnvironment({ NODE_ENV: "test", DATABASE_URL: TEST_URL, DIRECT_URL: TEST_URL }),
    );
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
