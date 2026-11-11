import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseConfig } from "../../src/lib/config.js";

const SECRET_URL = "postgresql://user:SuperSecretPassword@db.example.test/app_test";

function validEnv(overrides = {}) {
  return {
    NODE_ENV: "test",
    DATABASE_URL: SECRET_URL,
    GOOGLE_APPLICATION_CREDENTIALS: "./service-account.json",
    ...overrides,
  };
}

function configError(env) {
  try {
    parseConfig(env);
  } catch (error) {
    return error.message;
  }

  return assert.fail("Expected parseConfig to throw");
}

describe("parseConfig", () => {
  it("returns a frozen config with defaults", () => {
    const config = parseConfig(validEnv());

    assert.equal(Object.isFrozen(config), true);
    assert.equal(config.port, 9000);
    assert.equal(config.nodeEnv, "test");
    assert.equal(config.isDevelopment, false);
    assert.equal(config.isProduction, false);
  });

  it("reports a missing required variable by name", () => {
    const message = configError(validEnv({ DATABASE_URL: undefined }));

    assert.match(message, /DATABASE_URL is required/);
  });

  it("treats a blank value as unset", () => {
    const message = configError(validEnv({ DATABASE_URL: "" }));

    assert.match(message, /DATABASE_URL is required/);
  });

  it("rejects a non-Postgres DATABASE_URL", () => {
    const message = configError(validEnv({ DATABASE_URL: "mysql://user:pw@host/db" }));

    assert.match(message, /DATABASE_URL must be a postgres:\/\/ or postgresql:\/\/ URL/);
  });

  it("rejects an invalid NODE_ENV and PORT", () => {
    const message = configError(validEnv({ NODE_ENV: "staging", PORT: "70000" }));

    assert.match(message, /NODE_ENV must be one of development, production, test/);
    assert.match(message, /PORT must be an integer from 1 to 65535/);
  });

  it("requires exactly one Firebase credential", () => {
    const neither = configError(validEnv({ GOOGLE_APPLICATION_CREDENTIALS: undefined }));
    const both = configError(validEnv({ FIREBASE_SERVICE_ACCOUNT_JSON: "{}" }));

    assert.match(neither, /exactly one is required/);
    assert.match(both, /set only one, not both/);
  });

  it("refuses the auth emulator outside development", () => {
    for (const NODE_ENV of ["test", "production"]) {
      const message = configError(validEnv({ NODE_ENV, FIREBASE_AUTH_EMULATOR_HOST: "localhost:9099" }));
      assert.match(message, /FIREBASE_AUTH_EMULATOR_HOST must not be set unless NODE_ENV is development/);
    }
  });

  it("allows the auth emulator in development", () => {
    const config = parseConfig(validEnv({ NODE_ENV: "development", FIREBASE_AUTH_EMULATOR_HOST: "localhost:9099" }));

    assert.equal(config.isDevelopment, true);
  });

  it("never includes variable values in the error", () => {
    const message = configError(validEnv({ PORT: "SuperSecretPassword", FIREBASE_SERVICE_ACCOUNT_JSON: "{\"private_key\":\"SuperSecretPassword\"}" }));

    assert.doesNotMatch(message, /SuperSecretPassword/);
  });
});
