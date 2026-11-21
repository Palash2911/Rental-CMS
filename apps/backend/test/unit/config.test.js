import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { parseConfig } from "../../src/lib/config.js";

const SECRET_URL =
  "postgresql://user:SuperSecretPassword@db.example.test/app_test";

function validEnv(overrides = {}) {
  return {
    NODE_ENV: "test",
    DATABASE_URL: SECRET_URL,
    GOOGLE_APPLICATION_CREDENTIALS: "./service-account.json",
    STRIPE_SECRET_KEY: "sk_test_SuperSecretStripeKey",
    STRIPE_WEBHOOK_SECRET: "whsec_SuperSecretSigningSecret",
    STRIPE_CHECKOUT_SUCCESS_URL:
      "http://localhost:3000/billing?checkout=success",
    STRIPE_CHECKOUT_CANCEL_URL: "http://localhost:3000/billing?checkout=cancel",
    STRIPE_PORTAL_RETURN_URL: "http://localhost:3000/billing",
    REDIS_URL: "redis://:SuperSecretPassword@127.0.0.1:6379/0",
    S3_ENDPOINT: "https://account-id.r2.cloudflarestorage.com",
    S3_REGION: "auto",
    S3_ACCESS_KEY_ID: "SuperSecretAccessKeyId",
    S3_SECRET_ACCESS_KEY: "SuperSecretAccessKey",
    S3_BUCKET: "rental-cms-receipts",
    RESEND_API_KEY: "re_SuperSecretResendKey",
    EMAIL_FROM: "Rental CMS <notifications@example.test>",
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
    const message = configError(
      validEnv({ DATABASE_URL: "mysql://user:pw@host/db" }),
    );

    assert.match(
      message,
      /DATABASE_URL must be a postgres:\/\/ or postgresql:\/\/ URL/,
    );
  });

  it("rejects an invalid NODE_ENV and PORT", () => {
    const message = configError(
      validEnv({ NODE_ENV: "staging", PORT: "70000" }),
    );

    assert.match(
      message,
      /NODE_ENV must be one of development, production, test/,
    );
    assert.match(message, /PORT must be an integer from 1 to 65535/);
  });

  it("requires exactly one Firebase credential", () => {
    const neither = configError(
      validEnv({ GOOGLE_APPLICATION_CREDENTIALS: undefined }),
    );
    const both = configError(validEnv({ FIREBASE_SERVICE_ACCOUNT_JSON: "{}" }));

    assert.match(neither, /exactly one is required/);
    assert.match(both, /set only one, not both/);
  });

  it("refuses the auth emulator outside development", () => {
    for (const NODE_ENV of ["test", "production"]) {
      const message = configError(
        validEnv({ NODE_ENV, FIREBASE_AUTH_EMULATOR_HOST: "localhost:9099" }),
      );
      assert.match(
        message,
        /FIREBASE_AUTH_EMULATOR_HOST must not be set unless NODE_ENV is development/,
      );
    }
  });

  it("allows the auth emulator in development", () => {
    const config = parseConfig(
      validEnv({
        NODE_ENV: "development",
        FIREBASE_AUTH_EMULATOR_HOST: "localhost:9099",
      }),
    );

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
    const message = configError(
      validEnv(Object.fromEntries(names.map((name) => [name, undefined]))),
    );

    for (const name of names) {
      assert.match(message, new RegExp(`${name} is required`));
    }
  });

  it("validates the format of the Stripe key, signing secret and redirect URLs", () => {
    const message = configError(
      validEnv({
        STRIPE_SECRET_KEY: "pk_test_publishable",
        STRIPE_WEBHOOK_SECRET: "secret",
        STRIPE_CHECKOUT_SUCCESS_URL: "ftp://example.test/success",
        STRIPE_CHECKOUT_CANCEL_URL: "not a url",
        STRIPE_PORTAL_RETURN_URL: "javascript:alert(1)",
      }),
    );

    assert.match(
      message,
      /STRIPE_SECRET_KEY must be a Stripe secret or restricted key/,
    );
    assert.match(
      message,
      /STRIPE_WEBHOOK_SECRET must be a Stripe webhook signing secret/,
    );
    assert.match(
      message,
      /STRIPE_CHECKOUT_SUCCESS_URL must be an http:\/\/ or https:\/\/ URL/,
    );
    assert.match(
      message,
      /STRIPE_CHECKOUT_CANCEL_URL must be an http:\/\/ or https:\/\/ URL/,
    );
    assert.match(
      message,
      /STRIPE_PORTAL_RETURN_URL must be an http:\/\/ or https:\/\/ URL/,
    );
  });

  it("accepts restricted keys and exposes the Stripe settings", () => {
    const config = parseConfig(
      validEnv({ STRIPE_SECRET_KEY: "rk_test_Restricted" }),
    );

    assert.equal(config.stripeSecretKey, "rk_test_Restricted");
    assert.equal(config.stripeWebhookSecret, "whsec_SuperSecretSigningSecret");
    assert.equal(
      config.stripeCheckoutSuccessUrl,
      "http://localhost:3000/billing?checkout=success",
    );
    assert.equal(
      config.stripeCheckoutCancelUrl,
      "http://localhost:3000/billing?checkout=cancel",
    );
    assert.equal(config.stripePortalReturnUrl, "http://localhost:3000/billing");
  });

  it("refuses a live Stripe key outside production and allows it in production", () => {
    for (const NODE_ENV of ["development", "test"]) {
      const message = configError(
        validEnv({ NODE_ENV, STRIPE_SECRET_KEY: "sk_live_SuperSecretLiveKey" }),
      );
      assert.match(
        message,
        /STRIPE_SECRET_KEY must be a test-mode key unless NODE_ENV is production/,
      );
      assert.doesNotMatch(message, /SuperSecretLiveKey/);
    }

    assert.equal(
      parseConfig(
        validEnv({
          NODE_ENV: "production",
          FRONTEND_URL: "https://app.example.test",
          STRIPE_SECRET_KEY: "rk_live_Key",
        }),
      ).isProduction,
      true,
    );
  });

  it("refuses a test Stripe key in production, where test cards would buy real access", () => {
    for (const STRIPE_SECRET_KEY of [
      "sk_test_SuperSecretTestKey",
      "rk_test_SuperSecretTestKey",
    ]) {
      const message = configError(
        validEnv({
          NODE_ENV: "production",
          FRONTEND_URL: "https://app.example.test",
          STRIPE_SECRET_KEY,
        }),
      );
      assert.match(
        message,
        /STRIPE_SECRET_KEY must be a live-mode key when NODE_ENV is production/,
      );
      assert.doesNotMatch(message, /SuperSecretTestKey/);
    }

    for (const NODE_ENV of ["development", "test"]) {
      assert.equal(
        parseConfig(validEnv({ NODE_ENV, STRIPE_SECRET_KEY: "sk_test_Key" }))
          .nodeEnv,
        NODE_ENV,
      );
    }
  });

  it("never includes variable values in the error", () => {
    const message = configError(
      validEnv({
        PORT: "SuperSecretPassword",
        FIREBASE_SERVICE_ACCOUNT_JSON: '{"private_key":"SuperSecretPassword"}',
      }),
    );

    assert.doesNotMatch(message, /SuperSecretPassword/);
  });

  it("requires a redis:// or rediss:// REDIS_URL", () => {
    assert.match(
      configError(validEnv({ REDIS_URL: undefined })),
      /REDIS_URL is required/,
    );
    assert.match(
      configError(validEnv({ REDIS_URL: "http://127.0.0.1:6379" })),
      /REDIS_URL must be a redis:\/\/ or rediss:\/\/ URL/,
    );
    assert.doesNotMatch(
      configError(validEnv({ REDIS_URL: "http://:SuperSecretPassword@x" })),
      /SuperSecretPassword/,
    );

    assert.equal(
      parseConfig(validEnv()).redisUrl,
      "redis://:SuperSecretPassword@127.0.0.1:6379/0",
    );
    assert.equal(
      parseConfig(validEnv({ REDIS_URL: "rediss://cache.example.test:6380/0" }))
        .redisUrl,
      "rediss://cache.example.test:6380/0",
    );
  });

  it("trusts X-Forwarded-For only when TRUST_PROXY is exactly true", () => {
    assert.equal(parseConfig(validEnv()).trustProxy, false);
    assert.equal(parseConfig(validEnv({ TRUST_PROXY: "" })).trustProxy, false);
    assert.equal(
      parseConfig(validEnv({ TRUST_PROXY: "false" })).trustProxy,
      false,
    );
    assert.equal(
      parseConfig(validEnv({ TRUST_PROXY: "true" })).trustProxy,
      true,
    );
    assert.match(
      configError(validEnv({ TRUST_PROXY: "yes" })),
      /TRUST_PROXY must be "true" or "false"/,
    );
  });

  it("requires all five S3 variables and exposes them as a frozen s3 group", () => {
    const { s3 } = parseConfig(validEnv());

    assert.equal(Object.isFrozen(s3), true);
    assert.deepEqual(
      { ...s3 },
      {
        endpoint: "https://account-id.r2.cloudflarestorage.com",
        region: "auto",
        accessKeyId: "SuperSecretAccessKeyId",
        secretAccessKey: "SuperSecretAccessKey",
        bucket: "rental-cms-receipts",
      },
    );

    for (const name of [
      "S3_ENDPOINT",
      "S3_REGION",
      "S3_ACCESS_KEY_ID",
      "S3_SECRET_ACCESS_KEY",
      "S3_BUCKET",
    ]) {
      assert.match(
        configError(validEnv({ [name]: undefined })),
        new RegExp(`${name} is required`),
      );
      assert.match(
        configError(validEnv({ [name]: "" })),
        new RegExp(`${name} is required`),
      );
    }
  });

  it("validates the S3 endpoint, region and bucket formats without echoing values", () => {
    assert.match(
      configError(validEnv({ S3_ENDPOINT: "ftp://storage.example.test" })),
      /S3_ENDPOINT must be an http:\/\/ or https:\/\/ URL/,
    );
    assert.match(
      configError(validEnv({ S3_REGION: "Auto Region" })),
      /S3_REGION must be a region name/,
    );
    assert.match(
      configError(validEnv({ S3_BUCKET: "Bad_Bucket" })),
      /S3_BUCKET must be a valid bucket name/,
    );
    assert.match(
      configError(validEnv({ S3_SECRET_ACCESS_KEY: "x".repeat(257) })),
      /S3_SECRET_ACCESS_KEY must be 1 to 256 characters/,
    );
    assert.doesNotMatch(
      configError(validEnv({ S3_ACCESS_KEY_ID: "SuperSecret".repeat(30) })),
      /SuperSecret/,
    );
    assert.equal(
      parseConfig(
        validEnv({
          S3_ENDPOINT: "http://127.0.0.1:9000",
          S3_REGION: "us-east-1",
        }),
      ).s3.region,
      "us-east-1",
    );
  });

  it("requires a Resend key and a sender, and exposes them as a frozen email group", () => {
    const { email } = parseConfig(validEnv());

    assert.equal(Object.isFrozen(email), true);
    assert.deepEqual(
      { ...email },
      {
        resendApiKey: "re_SuperSecretResendKey",
        from: "Rental CMS <notifications@example.test>",
        devRedirect: null,
      },
    );
    assert.match(
      configError(validEnv({ RESEND_API_KEY: undefined })),
      /RESEND_API_KEY is required/,
    );
    assert.match(
      configError(validEnv({ RESEND_API_KEY: "sk_test_x" })),
      /RESEND_API_KEY must be a Resend API key/,
    );
    assert.doesNotMatch(
      configError(validEnv({ RESEND_API_KEY: "SuperSecretWrongKey" })),
      /SuperSecretWrongKey/,
    );
    assert.match(
      configError(validEnv({ EMAIL_FROM: undefined })),
      /EMAIL_FROM is required/,
    );
  });

  it("accepts a bare or named sender address and refuses anything else", () => {
    assert.equal(
      parseConfig(validEnv({ EMAIL_FROM: "notifications@example.test" })).email
        .from,
      "notifications@example.test",
    );

    for (const from of [
      "Rental CMS",
      "Rental CMS <not-an-address>",
      "a@b.test\r\nBcc: x@y.test",
      "<a@b.test>",
    ]) {
      assert.match(
        configError(validEnv({ EMAIL_FROM: from })),
        /EMAIL_FROM must be an email address or "Name <address>"/,
        from,
      );
    }
  });

  it("accepts EMAIL_DEV_REDIRECT outside production and refuses it in production", () => {
    assert.equal(
      parseConfig(validEnv({ EMAIL_DEV_REDIRECT: "me@example.test" })).email
        .devRedirect,
      "me@example.test",
    );
    assert.equal(
      parseConfig(
        validEnv({
          NODE_ENV: "development",
          EMAIL_DEV_REDIRECT: "me@example.test",
        }),
      ).email.devRedirect,
      "me@example.test",
    );
    assert.match(
      configError(validEnv({ EMAIL_DEV_REDIRECT: "not an email" })),
      /EMAIL_DEV_REDIRECT must be an email address/,
    );
    assert.match(
      configError(
        validEnv({
          NODE_ENV: "production",
          FRONTEND_URL: "https://app.example.test",
          EMAIL_DEV_REDIRECT: "me@example.test",
        }),
      ),
      /EMAIL_DEV_REDIRECT must not be set when NODE_ENV is production/,
    );
  });

  it("defaults FRONTEND_URL to localhost outside production and requires it in production", () => {
    assert.equal(parseConfig(validEnv()).frontendUrl, "http://localhost:3000");
    assert.equal(
      parseConfig(validEnv({ NODE_ENV: "development" })).frontendUrl,
      "http://localhost:3000",
    );
    assert.equal(
      parseConfig(validEnv({ FRONTEND_URL: "https://app.example.test/" }))
        .frontendUrl,
      "https://app.example.test",
    );
    assert.match(
      configError(validEnv({ NODE_ENV: "production" })),
      /FRONTEND_URL is required when NODE_ENV is production/,
    );
    assert.match(
      configError(validEnv({ FRONTEND_URL: "javascript:alert(1)" })),
      /FRONTEND_URL must be an http:\/\/ or https:\/\/ URL/,
    );
  });
});
