import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseConfig } from "../../src/lib/config.js";

const SECRET_URL = "postgresql://user:SuperSecretPassword@db.example.test/app_test";

function validEnv(overrides = {}) {
  return {
    NODE_ENV: "test",
    DATABASE_URL: SECRET_URL,
    GOOGLE_APPLICATION_CREDENTIALS: "./service-account.json",
    STRIPE_SECRET_KEY: "sk_test_SuperSecretStripeKey",
    STRIPE_WEBHOOK_SECRET: "whsec_SuperSecretSigningSecret",
    STRIPE_CHECKOUT_SUCCESS_URL: "http://localhost:3000/billing?checkout=success",
    STRIPE_CHECKOUT_CANCEL_URL: "http://localhost:3000/billing?checkout=cancel",
    STRIPE_PORTAL_RETURN_URL: "http://localhost:3000/billing",
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

  it("requires every Stripe variable", () => {
    const names = [
      "STRIPE_SECRET_KEY",
      "STRIPE_WEBHOOK_SECRET",
      "STRIPE_CHECKOUT_SUCCESS_URL",
      "STRIPE_CHECKOUT_CANCEL_URL",
      "STRIPE_PORTAL_RETURN_URL",
    ];
    const message = configError(validEnv(Object.fromEntries(names.map((name) => [name, undefined]))));

    for (const name of names) {
      assert.match(message, new RegExp(`${name} is required`));
    }
  });

  it("validates the format of the Stripe key, signing secret and redirect URLs", () => {
    const message = configError(validEnv({
      STRIPE_SECRET_KEY: "pk_test_publishable",
      STRIPE_WEBHOOK_SECRET: "secret",
      STRIPE_CHECKOUT_SUCCESS_URL: "ftp://example.test/success",
      STRIPE_CHECKOUT_CANCEL_URL: "not a url",
      STRIPE_PORTAL_RETURN_URL: "javascript:alert(1)",
    }));

    assert.match(message, /STRIPE_SECRET_KEY must be a Stripe secret or restricted key/);
    assert.match(message, /STRIPE_WEBHOOK_SECRET must be a Stripe webhook signing secret/);
    assert.match(message, /STRIPE_CHECKOUT_SUCCESS_URL must be an http:\/\/ or https:\/\/ URL/);
    assert.match(message, /STRIPE_CHECKOUT_CANCEL_URL must be an http:\/\/ or https:\/\/ URL/);
    assert.match(message, /STRIPE_PORTAL_RETURN_URL must be an http:\/\/ or https:\/\/ URL/);
  });

  it("accepts restricted keys and exposes the Stripe settings", () => {
    const config = parseConfig(validEnv({ STRIPE_SECRET_KEY: "rk_test_Restricted" }));

    assert.equal(config.stripeSecretKey, "rk_test_Restricted");
    assert.equal(config.stripeWebhookSecret, "whsec_SuperSecretSigningSecret");
    assert.equal(config.stripeCheckoutSuccessUrl, "http://localhost:3000/billing?checkout=success");
    assert.equal(config.stripeCheckoutCancelUrl, "http://localhost:3000/billing?checkout=cancel");
    assert.equal(config.stripePortalReturnUrl, "http://localhost:3000/billing");
  });

  it("refuses a live Stripe key outside production and allows it in production", () => {
    for (const NODE_ENV of ["development", "test"]) {
      const message = configError(validEnv({ NODE_ENV, STRIPE_SECRET_KEY: "sk_live_SuperSecretLiveKey" }));
      assert.match(message, /STRIPE_SECRET_KEY must be a test-mode key unless NODE_ENV is production/);
      assert.doesNotMatch(message, /SuperSecretLiveKey/);
    }

    assert.equal(parseConfig(validEnv({ NODE_ENV: "production", STRIPE_SECRET_KEY: "rk_live_Key" })).isProduction, true);
  });

  it("never includes variable values in the error", () => {
    const message = configError(validEnv({ PORT: "SuperSecretPassword", FIREBASE_SERVICE_ACCOUNT_JSON: "{\"private_key\":\"SuperSecretPassword\"}" }));

    assert.doesNotMatch(message, /SuperSecretPassword/);
  });
});
